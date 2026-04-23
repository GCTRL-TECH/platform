"""
URL Content Extractor for KEX Service
Uses trafilatura to fetch and clean web page content.
"""

import logging
from typing import Optional

import trafilatura

logger = logging.getLogger(__name__)


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

    # trafilatura.fetch_url handles HTTP downloading with a built-in timeout
    try:
        downloaded: Optional[bytes] = trafilatura.fetch_url(url)
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
