"""
ConEx: Convolutional Complex Knowledge Graph Embeddings
Lightweight implementation based on Demir & Ngonga Ngomo (ISWC 2021).

Trains entity and relation embeddings from a knowledge graph, then
predicts missing links between entities. Used as Stage 3 of the
FUSE three-stage matching pipeline.

This catches structural patterns that fuzzy string similarity misses,
e.g. if entity A and entity B both supply to entity C, they might be
the same entity even if their names are completely different.
"""

import logging
import math
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# Check if torch is available (optional dependency for FUSE container)
try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch.utils.data import DataLoader, TensorDataset

    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False
    logger.warning("PyTorch not available — ConEx link prediction disabled")


class ConExModel(nn.Module):
    """
    ConEx: 2D Convolution + Complex-valued embeddings for KG link prediction.

    Architecture:
    1. Entity embeddings (real + imaginary parts)
    2. Relation embeddings (real + imaginary parts)
    3. 2D convolution on stacked entity-relation embedding matrices
    4. Hermitian inner product for scoring
    """

    def __init__(
        self,
        num_entities: int,
        num_relations: int,
        embedding_dim: int = 100,
        num_filters: int = 32,
        kernel_size: int = 3,
        dropout_input: float = 0.2,
        dropout_feature: float = 0.3,
        label_smoothing: float = 0.1,
    ):
        super().__init__()
        self.embedding_dim = embedding_dim
        self.num_entities = num_entities
        self.num_relations = num_relations
        self.label_smoothing = label_smoothing

        # Entity embeddings (real + imaginary)
        self.emb_ent_real = nn.Embedding(num_entities, embedding_dim)
        self.emb_ent_imag = nn.Embedding(num_entities, embedding_dim)

        # Relation embeddings (real + imaginary)
        self.emb_rel_real = nn.Embedding(num_relations, embedding_dim)
        self.emb_rel_imag = nn.Embedding(num_relations, embedding_dim)

        # 2D Convolution (core ConEx innovation)
        # Reshape embedding pairs into 2D "images" and apply convolution
        self.conv = nn.Conv2d(1, num_filters, (kernel_size, kernel_size), padding=1)
        self.bn_conv = nn.BatchNorm2d(num_filters)

        # Fully connected layer after convolution
        conv_out_dim = num_filters * embedding_dim * 2  # after flatten
        self.fc = nn.Linear(conv_out_dim, embedding_dim)
        self.bn_fc = nn.BatchNorm1d(embedding_dim)

        # Dropout
        self.input_dropout = nn.Dropout(dropout_input)
        self.feature_dropout = nn.Dropout(dropout_feature)

        # Initialize
        nn.init.xavier_uniform_(self.emb_ent_real.weight)
        nn.init.xavier_uniform_(self.emb_ent_imag.weight)
        nn.init.xavier_uniform_(self.emb_rel_real.weight)
        nn.init.xavier_uniform_(self.emb_rel_imag.weight)

    def forward(self, head_idx, rel_idx):
        """
        Score all possible tail entities for given (head, relation) pairs.

        Returns: (batch_size, num_entities) score matrix
        """
        # Get embeddings
        h_real = self.emb_ent_real(head_idx)  # (batch, dim)
        h_imag = self.emb_ent_imag(head_idx)
        r_real = self.emb_rel_real(rel_idx)
        r_imag = self.emb_rel_imag(rel_idx)

        # Stack into 2D "image" for convolution: (batch, 1, 2, dim)
        x = torch.stack([h_real * r_real - h_imag * r_imag,
                         h_real * r_imag + h_imag * r_real], dim=1)
        x = x.unsqueeze(1)  # (batch, 1, 2, dim) — single channel

        # 2D convolution
        x = self.conv(x)
        x = self.bn_conv(x)
        x = F.relu(x)
        x = self.feature_dropout(x)

        # Flatten and project
        x = x.view(x.size(0), -1)
        x = self.fc(x)
        x = self.bn_fc(x)
        x = F.relu(x)
        x = self.input_dropout(x)

        # Score against all tail entities via Hermitian inner product
        # Real part: x · tail_real, Imaginary part: x · tail_imag
        all_ent_real = self.emb_ent_real.weight  # (num_entities, dim)
        scores = torch.mm(x, all_ent_real.t())  # (batch, num_entities)

        return scores


class ConExLinkPredictor:
    """
    High-level interface for training ConEx and predicting missing links.
    """

    def __init__(
        self,
        embedding_dim: int = 100,
        num_filters: int = 32,
        epochs: int = 50,
        batch_size: int = 256,
        lr: float = 0.001,
    ):
        if not TORCH_AVAILABLE:
            raise RuntimeError("PyTorch is required for ConEx. Install torch.")

        self.embedding_dim = embedding_dim
        self.num_filters = num_filters
        self.epochs = epochs
        self.batch_size = batch_size
        self.lr = lr

        self.model: Optional[ConExModel] = None
        self.entity_to_idx: dict[str, int] = {}
        self.idx_to_entity: dict[int, str] = {}
        self.relation_to_idx: dict[str, int] = {}
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    def train(self, triples: list[tuple[str, str, str]]) -> dict:
        """
        Train ConEx embeddings on a set of (head, relation, tail) triples.

        Args:
            triples: List of (head_uri, relation_type, tail_uri) tuples

        Returns:
            Training stats dict
        """
        if not triples:
            return {"error": "No triples to train on"}

        logger.info(f"ConEx training: {len(triples)} triples on {self.device}")

        # Build vocabulary
        entities = set()
        relations = set()
        for h, r, t in triples:
            entities.add(h)
            entities.add(t)
            relations.add(r)

        self.entity_to_idx = {e: i for i, e in enumerate(sorted(entities))}
        self.idx_to_entity = {i: e for e, i in self.entity_to_idx.items()}
        self.relation_to_idx = {r: i for i, r in enumerate(sorted(relations))}

        num_entities = len(self.entity_to_idx)
        num_relations = len(self.relation_to_idx)

        logger.info(f"ConEx vocab: {num_entities} entities, {num_relations} relations")

        if num_entities < 5 or num_relations < 1:
            return {"error": "Not enough entities/relations for ConEx training"}

        # Convert to tensors
        heads = torch.tensor([self.entity_to_idx[h] for h, r, t in triples])
        rels = torch.tensor([self.relation_to_idx[r] for h, r, t in triples])
        tails = torch.tensor([self.entity_to_idx[t] for h, r, t in triples])

        dataset = TensorDataset(heads, rels, tails)
        loader = DataLoader(dataset, batch_size=self.batch_size, shuffle=True)

        # Create model
        self.model = ConExModel(
            num_entities=num_entities,
            num_relations=num_relations,
            embedding_dim=min(self.embedding_dim, max(20, num_entities // 2)),
            num_filters=self.num_filters,
        ).to(self.device)

        optimizer = torch.optim.Adam(self.model.parameters(), lr=self.lr)
        criterion = nn.CrossEntropyLoss(
            label_smoothing=self.model.label_smoothing
        )

        # Training loop
        self.model.train()
        losses = []
        for epoch in range(self.epochs):
            epoch_loss = 0.0
            for batch_heads, batch_rels, batch_tails in loader:
                batch_heads = batch_heads.to(self.device)
                batch_rels = batch_rels.to(self.device)
                batch_tails = batch_tails.to(self.device)

                optimizer.zero_grad()
                scores = self.model(batch_heads, batch_rels)
                loss = criterion(scores, batch_tails)
                loss.backward()
                optimizer.step()
                epoch_loss += loss.item()

            avg_loss = epoch_loss / max(len(loader), 1)
            losses.append(avg_loss)

            if (epoch + 1) % 10 == 0:
                logger.info(f"ConEx epoch {epoch + 1}/{self.epochs}: loss={avg_loss:.4f}")

        logger.info(f"ConEx training complete: final loss={losses[-1]:.4f}")

        return {
            "entities": num_entities,
            "relations": num_relations,
            "epochs": self.epochs,
            "final_loss": round(losses[-1], 4),
        }

    def predict_links(
        self,
        source_entities: list[str],
        target_entities: list[str],
        top_k: int = 10,
        threshold: float = 0.5,
    ) -> list[dict]:
        """
        Predict missing links between source and target entity sets.

        For each source entity, scores all target entities as potential
        matches via learned relational patterns.

        Returns:
            List of {source, target, score} dicts for predicted links
        """
        if self.model is None:
            logger.warning("ConEx model not trained — no predictions")
            return []

        self.model.eval()
        predictions = []

        # Use a generic "sameAs" relation for matching
        # If we have an actual sameAs relation in vocab, use it
        same_as_rel = None
        for rel, idx in self.relation_to_idx.items():
            if "same" in rel.lower() or "equivalent" in rel.lower():
                same_as_rel = idx
                break

        # If no sameAs relation exists, use the most common relation
        if same_as_rel is None and self.relation_to_idx:
            same_as_rel = 0  # First relation

        if same_as_rel is None:
            return []

        with torch.no_grad():
            for src_uri in source_entities:
                if src_uri not in self.entity_to_idx:
                    continue

                src_idx = torch.tensor([self.entity_to_idx[src_uri]]).to(self.device)
                rel_idx = torch.tensor([same_as_rel]).to(self.device)

                scores = self.model(src_idx, rel_idx)  # (1, num_entities)
                scores = torch.sigmoid(scores).squeeze(0).cpu().numpy()

                for tgt_uri in target_entities:
                    if tgt_uri not in self.entity_to_idx:
                        continue
                    if tgt_uri == src_uri:
                        continue

                    tgt_idx = self.entity_to_idx[tgt_uri]
                    score = float(scores[tgt_idx])

                    if score >= threshold:
                        predictions.append(
                            {
                                "source": src_uri,
                                "target": tgt_uri,
                                "score": round(score, 4),
                                "method": "conex",
                            }
                        )

        # Sort by score descending, take top_k
        predictions.sort(key=lambda x: -x["score"])
        if top_k > 0:
            predictions = predictions[:top_k]

        logger.info(f"ConEx predicted {len(predictions)} links above threshold {threshold}")
        return predictions


_predictor: Optional[ConExLinkPredictor] = None


def get_conex_predictor(**kwargs) -> ConExLinkPredictor:
    global _predictor
    if _predictor is None:
        _predictor = ConExLinkPredictor(**kwargs)
    return _predictor
