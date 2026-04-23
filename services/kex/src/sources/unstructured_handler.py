"""
Unstructured.io integration for enhanced file extraction.
Provides OCR, table extraction, and support for 65+ file formats.

Supports two modes:
1. Local: uses unstructured library directly (requires system deps)
2. API: uses Unstructured API (cloud or self-hosted)

Falls back gracefully if unstructured is not available.
"""

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# ─── Configuration ────────────────────────────────────────────────────────────

UNSTRUCTURED_API_URL = os.environ.get("UNSTRUCTURED_API_URL", "")
UNSTRUCTURED_API_KEY = os.environ.get("UNSTRUCTURED_API_KEY", "")
USE_UNSTRUCTURED = os.environ.get("USE_UNSTRUCTURED", "auto")  # auto, local, api, disabled

# MIME types that unstructured handles better than our basic extractors
ENHANCED_MIMETYPES = {
    "application/pdf",  # OCR + table extraction
    "image/png",
    "image/jpeg",
    "image/tiff",
    "image/bmp",
    "image/gif",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/epub+zip",
    "application/rtf",
    "text/markdown",
    "text/html",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "message/rfc822",  # .eml email files
    "text/tab-separated-values",
    "application/x-rst",
    "text/org",
}

_unstructured_available: Optional[bool] = None


def is_available() -> bool:
    """Check if unstructured is available (local library or API)."""
    global _unstructured_available
    if _unstructured_available is not None:
        return _unstructured_available

    if USE_UNSTRUCTURED == "disabled":
        _unstructured_available = False
        return False

    if USE_UNSTRUCTURED == "api" or UNSTRUCTURED_API_URL:
        _unstructured_available = bool(UNSTRUCTURED_API_URL)
        return _unstructured_available

    # Try local import
    try:
        from unstructured.partition.auto import partition  # type: ignore
        _unstructured_available = True
        logger.info("Unstructured.io available (local library)")
    except ImportError:
        _unstructured_available = False
        logger.info("Unstructured.io not available (install 'unstructured' for 65+ format support)")

    return _unstructured_available


def should_use_unstructured(mimetype: str) -> bool:
    """Check if this mimetype would benefit from unstructured processing."""
    if not is_available():
        return False
    base_mime = mimetype.split(";")[0].strip().lower()
    return base_mime in ENHANCED_MIMETYPES


def extract_text(file_bytes: bytes, mimetype: str, filename: str = "document") -> str:
    """
    Extract text using unstructured.io.

    Args:
        file_bytes: Raw file content.
        mimetype: MIME type string.
        filename: Original filename (helps with format detection).

    Returns:
        Extracted text as a single string.

    Raises:
        RuntimeError: If extraction fails.
    """
    if UNSTRUCTURED_API_URL:
        return _extract_via_api(file_bytes, mimetype, filename)
    else:
        return _extract_locally(file_bytes, mimetype, filename)


def _extract_locally(file_bytes: bytes, mimetype: str, filename: str) -> str:
    """Extract using the local unstructured library."""
    try:
        import tempfile
        from unstructured.partition.auto import partition  # type: ignore

        # Write to temp file (unstructured works best with files)
        suffix = _get_extension(filename, mimetype)
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(file_bytes)
            tmp_path = tmp.name

        try:
            elements = partition(filename=tmp_path, content_type=mimetype)
            texts = [str(el) for el in elements if str(el).strip()]
            if not texts:
                raise RuntimeError("No text extracted from document")
            return "\n\n".join(texts)
        finally:
            os.unlink(tmp_path)

    except ImportError:
        raise RuntimeError("unstructured library not installed")
    except Exception as exc:
        raise RuntimeError(f"Unstructured extraction failed: {exc}")


def _extract_via_api(file_bytes: bytes, mimetype: str, filename: str) -> str:
    """Extract using the Unstructured API."""
    import requests

    headers = {}
    if UNSTRUCTURED_API_KEY:
        headers["unstructured-api-key"] = UNSTRUCTURED_API_KEY

    suffix = _get_extension(filename, mimetype)
    safe_filename = filename if "." in filename else f"{filename}{suffix}"

    try:
        resp = requests.post(
            f"{UNSTRUCTURED_API_URL}/general/v0/general",
            headers=headers,
            files={"files": (safe_filename, file_bytes, mimetype)},
            data={"strategy": "auto"},
            timeout=120,
        )

        if resp.status_code != 200:
            raise RuntimeError(f"Unstructured API error: {resp.status_code} {resp.text[:200]}")

        elements = resp.json()
        texts = [el.get("text", "") for el in elements if el.get("text", "").strip()]

        if not texts:
            raise RuntimeError("No text extracted from document via API")

        return "\n\n".join(texts)

    except requests.RequestException as exc:
        raise RuntimeError(f"Unstructured API request failed: {exc}")


def _get_extension(filename: str, mimetype: str) -> str:
    """Get file extension from filename or mimetype."""
    if "." in filename:
        return "." + filename.rsplit(".", 1)[-1].lower()

    mime_to_ext = {
        "application/pdf": ".pdf",
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/tiff": ".tiff",
        "text/html": ".html",
        "text/markdown": ".md",
        "application/rtf": ".rtf",
        "application/epub+zip": ".epub",
        "application/vnd.ms-excel": ".xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "application/vnd.ms-powerpoint": ".ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
        "message/rfc822": ".eml",
    }
    return mime_to_ext.get(mimetype.split(";")[0].strip().lower(), ".bin")
