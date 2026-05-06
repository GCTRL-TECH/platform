"""
Semantic Resolver REST Client — communicates with the GCTRL Fusion Engine:
  POST /upload          — upload CSV files → returns uploadId
  POST /submit          — submit config → returns requestId
  GET  /status/{id}     — poll job status (code: 0=queued, 1=running, 2=done, -1=error)
  GET  /results/{id}    — list result files
  GET  /result/{id}/{f} — download result file
"""

import io
import logging
import re
import time
from typing import Optional

import requests

from . import config as cfg

logger = logging.getLogger(__name__)

RESOLVER_TIMEOUT = 60


class ResolverClient:
    def __init__(self, base_url: str = "http://resolver:8080") -> None:
        self.base_url = base_url.rstrip("/")

    def is_healthy(self) -> bool:
        try:
            resp = requests.get(f"{self.base_url}/", timeout=5)
            return resp.status_code == 200
        except Exception:
            return False

    def upload_csv(self, csv_content: str, filename: str = "data.csv") -> Optional[str]:
        """Upload CSV to resolver. Returns uploadId."""
        try:
            files = {"file": (filename, csv_content.encode("utf-8"), "text/csv")}
            resp = requests.post(f"{self.base_url}/upload", files=files, timeout=30)
            if resp.status_code == 200:
                data = resp.json()
                uploads = data.get("uploads", [])
                if uploads:
                    upload_id = uploads[0].get("uploadId", "")
                    logger.info(f"resolver upload: {filename} → {upload_id}")
                    return upload_id
            logger.warning(f"resolver upload failed: {resp.status_code} {resp.text[:200]}")
            return None
        except Exception as exc:
            logger.warning(f"resolver upload error: {exc}")
            return None

    def submit_config(self, config_xml: str) -> Optional[str]:
        """Submit XML config. Returns requestId."""
        try:
            files = {"config_file": ("config.xml", config_xml.encode("utf-8"), "text/xml")}
            resp = requests.post(f"{self.base_url}/submit", files=files, timeout=RESOLVER_TIMEOUT)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("success"):
                    request_id = str(data.get("requestId", ""))
                    logger.info(f"resolver submit OK: requestId={request_id}")
                    return request_id
                else:
                    logger.warning(f"resolver submit failed: {data}")
            else:
                logger.warning(f"resolver submit HTTP {resp.status_code}: {resp.text[:300]}")
            return None
        except Exception as exc:
            logger.warning(f"resolver submit error: {exc}")
            return None

    def wait_for_completion(self, request_id: str, max_wait: int = 120) -> bool:
        """Poll /status/{id} until done. Returns True if completed."""
        for _ in range(max_wait // 2):
            try:
                resp = requests.get(f"{self.base_url}/status/{request_id}", timeout=10)
                if resp.status_code == 200:
                    data = resp.json()
                    code = data.get("status", {}).get("code", -1)
                    if code == 2:  # done
                        logger.info(f"resolver job {request_id} completed")
                        return True
                    if code == -1:  # error
                        desc = data.get("status", {}).get("description", "unknown")
                        logger.warning(f"resolver job {request_id} failed: {desc}")
                        return False
                    # code 0 (queued) or 1 (running) — keep waiting
            except Exception:
                pass
            time.sleep(2)
        logger.warning(f"resolver job {request_id} timed out after {max_wait}s")
        return False

    def get_results(self, request_id: str) -> list[dict]:
        """Download result files and parse N3 triples."""
        try:
            resp = requests.get(f"{self.base_url}/results/{request_id}", timeout=10)
            if resp.status_code != 200:
                return []
            data = resp.json()
            files = data.get("availableFiles", [])
            if not files:
                logger.info(f"resolver job {request_id}: no result files")
                return []

            links = []
            for filename in files:
                try:
                    file_resp = requests.get(
                        f"{self.base_url}/result/{request_id}/{filename}", timeout=30
                    )
                    if file_resp.status_code == 200:
                        links.extend(self._parse_n3(file_resp.text))
                except Exception as exc:
                    logger.warning(f"resolver result download failed for {filename}: {exc}")
            return links
        except Exception as exc:
            logger.warning(f"resolver results fetch error: {exc}")
            return []

    def discover_links(
        self,
        source_entities: list[dict],
        target_entities: list[dict],
        metric: str = "trigrams(x.name, y.name)|0.80",
        acceptance_threshold: float = 0.85,
        review_threshold: float = 0.70,
    ) -> list[dict]:
        """
        Full flow: upload CSVs → build config → submit → wait → get results.
        """
        props = ["name", "type", "label"]

        source_csv = self._entities_to_csv(source_entities, props)
        target_csv = self._entities_to_csv(target_entities, props)

        source_id = self.upload_csv(source_csv, "source.csv")
        target_id = self.upload_csv(target_csv, "target.csv")
        if not source_id or not target_id:
            return []

        config_xml = self._build_config(
            source_id, target_id, props, metric,
            acceptance_threshold, review_threshold
        )

        request_id = self.submit_config(config_xml)
        if not request_id:
            return []

        if not self.wait_for_completion(request_id):
            return []

        return self.get_results(request_id)

    def _entities_to_csv(self, entities: list[dict], properties: list[str]) -> str:
        output = io.StringIO()
        header = ["uri"] + properties
        output.write(",".join(header) + "\n")
        for e in entities:
            row = [e.get("uri", "").replace(",", " ")]
            for prop in properties:
                val = str(e.get(prop, "")).replace(",", " ").replace("\n", " ")
                row.append(val)
            output.write(",".join(row) + "\n")
        return output.getvalue()

    def _build_config(
        self, source_id: str, target_id: str,
        properties: list[str], metric: str,
        acceptance_threshold: float, review_threshold: float,
    ) -> str:
        prop_src = "\n".join(f"    <PROPERTY>{p} AS lowercase</PROPERTY>" for p in properties)
        prop_tgt = "\n".join(f"    <PROPERTY>{p} AS lowercase</PROPERTY>" for p in properties)

        return f"""<?xml version="1.0" encoding="UTF-8"?>
<LIMES>
  <PREFIX><NAMESPACE>http://www.w3.org/2002/07/owl#</NAMESPACE><LABEL>owl</LABEL></PREFIX>
  <SOURCE>
    <ID>source</ID>
    <ENDPOINT>{source_id}</ENDPOINT>
    <VAR>?x</VAR>
    <PAGESIZE>-1</PAGESIZE>
    <TYPE>CSV</TYPE>
{prop_src}
  </SOURCE>
  <TARGET>
    <ID>target</ID>
    <ENDPOINT>{target_id}</ENDPOINT>
    <VAR>?y</VAR>
    <PAGESIZE>-1</PAGESIZE>
    <TYPE>CSV</TYPE>
{prop_tgt}
  </TARGET>
  <METRIC>{metric}</METRIC>
  <ACCEPTANCE>
    <THRESHOLD>{acceptance_threshold}</THRESHOLD>
    <FILE>accepted.nt</FILE>
    <RELATION>owl:sameAs</RELATION>
  </ACCEPTANCE>
  <REVIEW>
    <THRESHOLD>{review_threshold}</THRESHOLD>
    <FILE>review.nt</FILE>
    <RELATION>owl:sameAs</RELATION>
  </REVIEW>
  <EXECUTION>
    <REWRITER>default</REWRITER>
    <PLANNER>default</PLANNER>
    <ENGINE>default</ENGINE>
  </EXECUTION>
  <OUTPUT>N3</OUTPUT>
</LIMES>"""

    def _parse_n3(self, text: str) -> list[dict]:
        links = []
        for line in text.strip().split("\n"):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            match = re.match(r"<([^>]+)>\s+<([^>]+)>\s+<([^>]+)>\s*\.", line)
            if match:
                links.append({
                    "source": match.group(1),
                    "target": match.group(3),
                    "predicate": match.group(2),
                    "confidence": 1.0,
                    "method": "resolver",
                })
        logger.info(f"resolver: parsed {len(links)} links from N3")
        return links


_client: Optional[ResolverClient] = None

def get_limes_client() -> ResolverClient:
    global _client
    if _client is None:
        _client = ResolverClient(cfg.RESOLVER_URL)
    return _client
