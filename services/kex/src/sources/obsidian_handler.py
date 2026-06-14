"""Obsidian local vault handler for GCTRL KEX service.

Fetches markdown notes from a local Obsidian vault via the
Obsidian Local REST API plugin (https://github.com/coddingtonbear/obsidian-local-rest-api).
The plugin runs on localhost with a self-signed TLS certificate.

TLS verification:
  The Obsidian Local REST API plugin generates its own self-signed CA.
  Export it from the plugin settings and set the env var:

    OBSIDIAN_CACERT=/path/to/obsidian-cert.pem

  If the var is not set, the session falls back to the system trust store
  (which will reject the self-signed cert unless you have already imported
  it there).  Setting OBSIDIAN_CACERT is strongly preferred over disabling
  TLS verification globally.
"""

import os
import re
import requests
import logging
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Path to the Obsidian Local REST API self-signed CA cert.
# Export it from the plugin's settings panel and point this env var at it.
_OBSIDIAN_CACERT = os.environ.get("OBSIDIAN_CACERT")  # None → use system trust store

# Obsidian Local REST API is always local, so the only legitimate vault hosts
# are loopback. This mirrors the api-rs `require_loopback_url` allowlist exactly.
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _require_loopback_url(vault_url: str) -> None:
    """Reject non-loopback vault URLs to prevent SSRF.

    Allowing arbitrary hosts would let a crafted ``vault_url`` probe internal
    services (cloud metadata at 169.254.169.254, other containers, private
    networks). The api-rs side validates at store time; re-validating here at
    fetch time closes the worker-side gap and defeats DNS-rebinding / TOCTOU
    between that check and this request. Loopback-only (not a private-range
    block) because Obsidian must reach localhost and nothing else.
    """
    host = (urlparse(vault_url).hostname or "").lower()
    if host not in _LOOPBACK_HOSTS:
        raise ValueError(
            f"vault_url must point to a loopback address (localhost / 127.0.0.1); got {host!r}"
        )


def _session(api_token: Optional[str]) -> requests.Session:
    sess = requests.Session()
    # Use the dedicated CA cert when available; fall back to system store.
    # Never set verify=False — that would allow MITM attacks even on localhost.
    sess.verify = _OBSIDIAN_CACERT if _OBSIDIAN_CACERT else True
    if api_token:
        sess.headers["Authorization"] = f"Bearer {api_token}"
    return sess


def probe_vault(vault_url: str, api_token: Optional[str]) -> dict:
    """Test connectivity to an Obsidian vault. Returns { ok, vault_name? }."""
    try:
        _require_loopback_url(vault_url)
        sess = _session(api_token)
        resp = sess.get(f"{vault_url}/", timeout=5)
        resp.raise_for_status()
        data = resp.json() if resp.content else {}
        return {"ok": True, "vault_name": data.get("vaultName")}
    except Exception as e:
        logger.warning("Obsidian probe failed: %s", e)
        return {"ok": False, "error": str(e)}


def list_vault_files(vault_url: str, api_token: Optional[str], folder: str = "") -> list[dict]:
    """List .md files in the vault, optionally filtered by folder prefix."""
    _require_loopback_url(vault_url)
    sess = _session(api_token)
    path = f"{vault_url}/vault/{folder}" if folder else f"{vault_url}/vault/"
    resp = sess.get(path, timeout=15)
    resp.raise_for_status()
    files = resp.json().get("files", [])
    return [f for f in files if isinstance(f, str) and f.endswith(".md")]


def fetch_note(vault_url: str, api_token: Optional[str], note_path: str) -> str:
    """Fetch a single note's content and return as plain text."""
    _require_loopback_url(vault_url)
    sess = _session(api_token)
    resp = sess.get(f"{vault_url}/vault/{note_path}", timeout=15)
    resp.raise_for_status()
    raw = resp.text
    return _md_to_text(raw)


def _md_to_text(md: str) -> str:
    """Strip Obsidian markdown to plain text for NER extraction."""
    # Remove YAML frontmatter
    md = re.sub(r"^---\n.*?\n---\n", "", md, flags=re.DOTALL)
    # Remove wiki embeds ![[...]]
    md = re.sub(r"!\[\[.*?\]\]", "", md)
    # Replace wiki links [[Page|alias]] or [[Page]] with just the text
    md = re.sub(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", lambda m: m.group(2) or m.group(1), md)
    # Remove heading markers
    md = re.sub(r"^#+\s+", "", md, flags=re.MULTILINE)
    # Remove bold/italic markers
    md = re.sub(r"\*{1,3}(.*?)\*{1,3}", r"\1", md)
    # Remove inline code
    md = re.sub(r"`+.*?`+", "", md, flags=re.DOTALL)
    # Remove URLs in markdown links [text](url) → text
    md = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", md)
    return md.strip()
