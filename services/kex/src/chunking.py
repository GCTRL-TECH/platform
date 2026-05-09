"""
Text chunker for KEX pipeline.

Splits document text into overlapping chunks at sentence boundaries.
Target chunk size is measured in characters. Overlap ensures context
continuity across chunk boundaries for retrieval.
"""

import re
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Sentence boundary pattern: end of sentence followed by whitespace or end of string.
# Matches: period/bang/question-mark + optional closing quote/paren + whitespace
_SENTENCE_END_RE = re.compile(r'(?<=[.!?])["\')]?\s+')
# Also split on double-newlines (paragraph breaks)
_PARA_BREAK_RE = re.compile(r'\n{2,}')


def _split_into_sentences(text: str) -> list[str]:
    """
    Split text into a list of sentence-like segments.
    Preserves the trailing whitespace so that offsets can be reconstructed.
    """
    # First split on paragraph breaks, then on sentence boundaries within each paragraph.
    sentences: list[str] = []
    # Use re.split but keep delimiters via capturing group is tricky; use finditer instead.
    # Strategy: find all split positions, then slice.
    split_positions: list[int] = [0]

    for m in _PARA_BREAK_RE.finditer(text):
        split_positions.append(m.start())
        split_positions.append(m.end())

    for m in _SENTENCE_END_RE.finditer(text):
        split_positions.append(m.end())

    split_positions = sorted(set(split_positions))
    split_positions.append(len(text))

    for i in range(len(split_positions) - 1):
        start = split_positions[i]
        end = split_positions[i + 1]
        segment = text[start:end]
        if segment.strip():
            sentences.append(segment)

    return sentences if sentences else [text]


class TextChunker:
    """
    Splits text into overlapping chunks at sentence boundaries.

    Parameters
    ----------
    chunk_size : int
        Target maximum size of each chunk in characters.
    overlap : int
        Number of characters of overlap to carry forward from the
        previous chunk (approximate — snaps to sentence boundary).
    """

    def __init__(self, chunk_size: int = 800, overlap: int = 100):
        self.chunk_size = chunk_size
        self.overlap = overlap

    def chunk(self, text: str) -> list[dict]:
        """
        Split *text* into overlapping chunks at sentence boundaries.

        Returns
        -------
        list[dict]
            Each dict has keys:
              - content       : str  — the chunk text
              - start_char    : int  — inclusive start offset in original text
              - end_char      : int  — exclusive end offset in original text
              - chunk_sequence: int  — 0-based index of chunk
        """
        if not text or not text.strip():
            return []

        sentences = _split_into_sentences(text)

        chunks: list[dict] = []
        current_sentences: list[str] = []
        current_start: int = 0
        current_len: int = 0

        # Track absolute position in original text for each sentence.
        # We reconstruct by walking through original text.
        sentence_positions: list[tuple[int, int]] = []
        pos = 0
        for sent in sentences:
            # Find where this sentence starts in the original text from current pos.
            idx = text.find(sent, pos)
            if idx == -1:
                # Fallback: just advance
                idx = pos
            sentence_positions.append((idx, idx + len(sent)))
            pos = idx + len(sent)

        # Hard safety cap to prevent any infinite-loop pathology.
        max_iterations = max(2048, len(sentences) * 4)
        iterations = 0

        chunk_sequence = 0
        i = 0

        while i < len(sentences):
            iterations += 1
            if iterations > max_iterations:
                logger.warning(
                    f"TextChunker: hit safety cap ({max_iterations}) — "
                    f"force-flushing remaining {len(sentences) - i} sentences as one chunk"
                )
                # Hard-stop: dump remainder and exit. Better one giant chunk than infinite loop.
                tail = "".join(sentences[i:])
                if tail.strip() and i < len(sentence_positions):
                    chunks.append({
                        "content": tail.strip(),
                        "start_char": sentence_positions[i][0],
                        "end_char": sentence_positions[-1][1],
                        "chunk_sequence": chunk_sequence,
                    })
                    chunk_sequence += 1
                current_sentences = []
                current_len = 0
                break

            sent = sentences[i]
            sent_len = len(sent)

            if current_len == 0:
                # Starting a new chunk — record where it begins
                current_start = sentence_positions[i][0]

            if current_len + sent_len <= self.chunk_size or current_len == 0:
                # Fits in current chunk (always take at least one sentence even if oversize)
                current_sentences.append(sent)
                current_len += sent_len
                i += 1
            else:
                # Flush current chunk
                chunk_text = "".join(current_sentences)
                chunk_end = sentence_positions[i - 1][1]
                chunks.append({
                    "content": chunk_text.strip(),
                    "start_char": current_start,
                    "end_char": chunk_end,
                    "chunk_sequence": chunk_sequence,
                })
                chunk_sequence += 1

                # Build overlap walking backwards. CRITICAL: cap overlap to half of chunk_size.
                # Without this cap, a long previous sentence makes overlap_len ≥ chunk_size,
                # so when the next iteration hits the same `else` branch (sentence still
                # doesn't fit AND current_len != 0), we loop forever without advancing `i`.
                overlap_cap = self.chunk_size // 2
                overlap_sentences: list[str] = []
                overlap_len = 0
                j = len(current_sentences) - 1
                while j >= 0 and overlap_len < self.overlap:
                    next_s = current_sentences[j]
                    if overlap_len + len(next_s) > overlap_cap:
                        break
                    overlap_sentences.insert(0, next_s)
                    overlap_len += len(next_s)
                    j -= 1

                if overlap_sentences:
                    overlap_start_idx = len(current_sentences) - len(overlap_sentences)
                    current_start = sentence_positions[i - len(current_sentences) + overlap_start_idx][0]
                else:
                    current_start = sentence_positions[i][0]

                current_sentences = overlap_sentences
                current_len = overlap_len

                # Defensive: if overlap is still big enough to block the upcoming sentence,
                # drop the overlap entirely so we are guaranteed to advance.
                if current_len > 0 and current_len + sent_len > self.chunk_size:
                    current_sentences = []
                    current_len = 0
                    current_start = sentence_positions[i][0]

        # Flush remaining sentences
        if current_sentences:
            chunk_text = "".join(current_sentences)
            chunk_end = sentence_positions[len(sentences) - 1][1]
            chunks.append({
                "content": chunk_text.strip(),
                "start_char": current_start,
                "end_char": chunk_end,
                "chunk_sequence": chunk_sequence,
            })

        # Filter empty chunks
        chunks = [c for c in chunks if c["content"]]

        logger.debug(f"TextChunker: {len(text)} chars -> {len(chunks)} chunks "
                     f"(size={self.chunk_size}, overlap={self.overlap})")
        return chunks


# ── Module-level singleton ────────────────────────────────────────────

_chunker: Optional[TextChunker] = None


def get_chunker(chunk_size: int = 2000, overlap: int = 200) -> TextChunker:
    """Return (and cache) a TextChunker instance."""
    global _chunker
    if _chunker is None:
        _chunker = TextChunker(chunk_size=chunk_size, overlap=overlap)
    return _chunker
