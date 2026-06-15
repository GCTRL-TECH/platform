"""
URL Content Extractor for KEX Service
Uses trafilatura to fetch and clean web page content.

Two entry points:
  * extract_from_url(url)         — single page (raises on failure).
  * crawl_website(url, ...)       — bounded, same-domain BFS crawl that returns
                                    the concatenated text + the list of crawled
                                    URLs. Per-page failures are skipped, never
                                    fatal.
"""

import ipaddress
import logging
import socket
from collections import deque
from typing import Optional
from urllib.parse import urldefrag, urljoin, urlparse

import requests
import trafilatura

logger = logging.getLogger(__name__)

# Hard upper bound on pages a single crawl job may fetch, regardless of the
# caller-supplied max_pages. Protects the worker from a runaway crawl.
_CRAWL_PAGE_CAP = 50
_CRAWL_DEPTH_CAP = 10

# ── SSRF protection ───────────────────────────────────────────────────
# The crawler fetches user-supplied URLs server-side, so it must never be tricked
# into reaching internal / loopback / link-local (cloud-metadata) addresses. We
# resolve every host and reject any non-public IP, and we follow redirects
# MANUALLY so each hop is re-validated (defeats DNS-rebinding and redirect bypass).
_FETCH_TIMEOUT = 20
_MAX_REDIRECTS = 5
_FETCH_HEADERS = {"User-Agent": "GCTRL-Crawler/1.0 (+https://gctrl.tech)"}


def _ip_is_blocked(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return bool(
        ip.is_private or ip.is_loopback or ip.is_link_local
        or ip.is_reserved or ip.is_multicast or ip.is_unspecified
    )


def _host_is_public(host: str) -> bool:
    """True only if the host resolves AND every resolved address is public."""
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False
    addrs = {info[4][0] for info in infos}
    return bool(addrs) and not any(_ip_is_blocked(a) for a in addrs)


def _assert_public(url: str) -> None:
    host = urlparse(url).hostname
    if not host or not _host_is_public(host):
        raise ValueError(f"URL host is not a public address (blocked for security): {url}")


def _safe_fetch_html(url: str) -> str:
    """Fetch a URL's HTML with SSRF protection: validate the host (and every
    redirect hop) resolves to a public address. Returns the HTML body as text."""
    current = url
    for _ in range(_MAX_REDIRECTS + 1):
        _assert_public(current)
        resp = requests.get(
            current, allow_redirects=False, timeout=_FETCH_TIMEOUT, headers=_FETCH_HEADERS
        )
        if resp.status_code in (301, 302, 303, 307, 308):
            location = resp.headers.get("Location")
            if not location:
                break
            current = urljoin(current, location)
            continue
        resp.raise_for_status()
        return resp.text
    raise ValueError(f"Too many redirects fetching {url}")


def extract_from_url(url: str) -> str:
    """
    Fetch a URL and extract its main textual content.

    Args:
        url: HTTP/HTTPS URL to fetch.

    Returns:
        Extracted main content as plain text.

    Raises:
        ValueError: If the URL cannot be fetched or yields no content.
    """
    url = url.strip()
    if not url:
        raise ValueError("URL is empty")

    if not url.startswith(("http://", "https://")):
        raise ValueError(f"Invalid URL scheme: {url}")

    logger.info(f"Fetching URL: {url}")

    # SSRF-safe fetch (validates host + every redirect hop is a public address).
    try:
        downloaded: Optional[str] = _safe_fetch_html(url)
    except Exception as exc:
        raise ValueError(f"Failed to fetch URL '{url}': {exc}") from exc

    if not downloaded:
        raise ValueError(f"No content returned from URL: {url}")

    text: Optional[str] = trafilatura.extract(
        downloaded,
        include_links=False,
        include_tables=True,
        include_comments=False,
        no_fallback=False,
    )

    if not text or not text.strip():
        raise ValueError(f"No extractable text found at URL: {url}")

    logger.info(f"Extracted {len(text)} chars from {url}")
    return text.strip()


# ── Bounded same-domain crawl ─────────────────────────────────────────


def _same_domain(seed_netloc: str, candidate: str) -> bool:
    """True when `candidate` is on the same registrable host as the seed.

    A simple netloc equality (case-insensitive, port-insensitive) — keeps the
    crawl strictly on the site the user asked for and never wanders off-domain.
    """
    try:
        cand_netloc = urlparse(candidate).netloc.lower()
    except Exception:
        return False
    seed = seed_netloc.lower()
    # Treat 'www.' as equivalent so the seed page and its canonical host match.
    return cand_netloc == seed or cand_netloc.lstrip("www.") == seed.lstrip("www.")


def _discover_links(downloaded: str, base_url: str, seed_netloc: str) -> list[str]:
    """Extract same-domain, http(s) links from an HTML page.

    Uses BeautifulSoup when available (robust), otherwise a regex fallback.
    Fragments are stripped and links are absolutised against `base_url`.
    """
    hrefs: list[str] = []
    try:
        from bs4 import BeautifulSoup  # type: ignore
        soup = BeautifulSoup(downloaded, "html.parser")
        for a in soup.find_all("a", href=True):
            hrefs.append(a["href"])
    except Exception:
        import re
        hrefs = re.findall(r'href=["\']([^"\']+)["\']', downloaded or "")

    out: list[str] = []
    seen: set[str] = set()
    for href in hrefs:
        if not href or href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        absolute = urldefrag(urljoin(base_url, href))[0]
        if not absolute.startswith(("http://", "https://")):
            continue
        if not _same_domain(seed_netloc, absolute):
            continue
        if absolute not in seen:
            seen.add(absolute)
            out.append(absolute)
    return out


def crawl_website(
    start_url: str,
    max_pages: int = 1,
    max_depth: int = 2,
) -> tuple[str, list[str]]:
    """Bounded, same-domain BFS crawl starting from `start_url`.

    Fetches the seed page, extracts its main text AND discovers same-domain
    links, then BFS-expands up to `max_pages` pages and `max_depth` levels. Pages
    that fail (timeout / non-HTML / no text) are SKIPPED — a single bad page
    never fails the whole crawl.

    Returns (concatenated_text, crawled_urls). When nothing extractable is
    found the text is empty (caller turns that into a clear "no extractable
    content" result, not a hard failure).

    When max_pages <= 1 this degrades to a single-page fetch (same behaviour as
    extract_from_url, but non-raising).
    """
    start_url = (start_url or "").strip()
    if not start_url.startswith(("http://", "https://")):
        raise ValueError(f"Invalid URL scheme: {start_url}")

    pages = max(1, min(int(max_pages or 1), _CRAWL_PAGE_CAP))
    depth_cap = max(0, min(int(max_depth or 0), _CRAWL_DEPTH_CAP))
    seed_netloc = urlparse(start_url).netloc

    visited: set[str] = set()
    crawled: list[str] = []
    texts: list[str] = []

    # BFS queue of (url, depth).
    queue: deque = deque()
    queue.append((urldefrag(start_url)[0], 0))

    while queue and len(crawled) < pages:
        url, depth = queue.popleft()
        if url in visited:
            continue
        visited.add(url)

        try:
            downloaded = _safe_fetch_html(url)
        except Exception as exc:
            logger.info(f"Crawl: skip {url} (fetch/blocked: {exc})")
            continue
        if not downloaded:
            logger.info(f"Crawl: skip {url} (no content)")
            continue

        try:
            text = trafilatura.extract(
                downloaded,
                include_links=False,
                include_tables=True,
                include_comments=False,
                no_fallback=False,
            )
        except Exception as exc:
            logger.info(f"Crawl: skip {url} (extract error: {exc})")
            text = None

        if text and text.strip():
            texts.append(f"# Source: {url}\n\n{text.strip()}")
            crawled.append(url)
            logger.info(f"Crawl: [{len(crawled)}/{pages}] {len(text)} chars from {url}")

        # Discover more links only if we still have depth + page budget.
        if depth < depth_cap and len(crawled) < pages and pages > 1:
            for link in _discover_links(downloaded, url, seed_netloc):
                if link not in visited:
                    queue.append((link, depth + 1))

    combined = "\n\n".join(texts)
    logger.info(f"Crawl complete: {len(crawled)} page(s), {len(combined)} chars total")
    return combined, crawled
