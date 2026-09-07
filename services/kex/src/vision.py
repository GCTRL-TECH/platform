"""Vision transcription for image inputs — with the ONE model that is already loaded.

Images (screenshots, whiteboard photos, Miro board exports) and scanned PDF pages
are handed to the relation-extraction runtime as OpenAI ``image_url`` parts
(``llm_client.complete(..., images=[...])``) when the api-rs layer says the
runtime can see (``generation_vision`` in the job payload, v0.9.7). That flag is
only true when the relation model IS the globally loaded model on the same
server, so this never causes a second model to be loaded. Tesseract OCR stays the
fallback and — when vision succeeds — is appended so exact strings stay findable.

Cython rule (prod build): parameters that may receive None or a subclass are left
unannotated on purpose.
"""

from __future__ import annotations

import base64
import io
import logging
import os

logger = logging.getLogger(__name__)

# Long side after downscaling. Vision prefill is the expensive part on a shared local
# server; 1536 px keeps sticky-note text legible and a board under ~2k prompt tokens.
MAX_SIDE = int(os.environ.get("KEX_VISION_MAX_SIDE", "1536") or 1536)
JPEG_QUALITY = 85
# A transcript shorter than this is treated as a failed call (model refused / echoed).
MIN_TRANSCRIPT_CHARS = 20
IMAGE_TIMEOUT = int(os.environ.get("KEX_VISION_TIMEOUT", "120") or 120)
PAGE_TIMEOUT = int(os.environ.get("KEX_VISION_PAGE_TIMEOUT", "90") or 90)
# Scanned PDFs: pages transcribed by the model before OCR takes over (memory-flat:
# one image per call, sequential).
PDF_MAX_PAGES = int(os.environ.get("KEX_VISION_PDF_MAX_PAGES", "5") or 5)

TRANSCRIBE_PROMPT = (
    "You are transcribing an image into text for a knowledge base. File name: {name}.\n"
    "Answer in exactly these sections, plain text, no markdown tables:\n"
    "TITLE: one line.\n"
    "TYPE: one of photo | screenshot | diagram | whiteboard | sticky-note board | slide | "
    "scanned document | chart | other.\n"
    "TEXT: every legible word verbatim, in reading order, in the original language; write "
    "[unreadable] for parts you cannot read.\n"
    "STRUCTURE: for boards and diagrams — the board, then its groups/frames (title, colour), "
    "then the items (sticky notes, cards, shapes) one per line under their group, then every "
    "connection one per line as `A -> B (label)`. For documents: headings and their order.\n"
    "ENTITIES: people, organisations, products, places, dates, amounts — one per line.\n"
    "SUMMARY: 2-4 sentences on what the image shows.\n"
    "Never invent text that is not visible."
)


def prepare_image(data):
    """Bytes -> (mime, base64) of a downscaled RGB JPEG the runtime will accept.

    EXIF orientation is applied (phone photos), alpha/palette images are flattened on
    white, the long side is capped at MAX_SIDE. Raises ValueError for undecodable data.
    """
    from PIL import Image, ImageOps  # type: ignore

    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"not a decodable image: {exc}")
    try:
        img = ImageOps.exif_transpose(img)
    except Exception:  # noqa: BLE001 - orientation is best-effort
        pass
    if img.mode not in ("RGB", "L"):
        rgba = img.convert("RGBA")
        bg = Image.new("RGB", rgba.size, "white")
        bg.paste(rgba, mask=rgba.split()[-1])
        img = bg
    elif img.mode == "L":
        img = img.convert("RGB")
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return "image/jpeg", base64.b64encode(buf.getvalue()).decode("ascii")


def transcribe_image(data, filename, *, model, base, kind, api_key=None,
                     max_concurrency=None, timeout=None):
    """Ask the loaded model to transcribe + describe one image. Returns the text.

    Raises ValueError when the transcript is too short to be a real answer; lets
    transport errors (timeout, HTTP) propagate — the caller falls back to OCR.
    """
    from . import llm_client

    mime, b64 = prepare_image(data)
    prompt = TRANSCRIBE_PROMPT.format(name=(filename or "image"))
    text = llm_client.complete(
        prompt, model, base, kind,
        api_key=api_key,
        options={"temperature": 0, "num_predict": 4096},
        think=False,
        timeout=timeout or IMAGE_TIMEOUT,
        max_concurrency=max_concurrency,
        images=[{"mime": mime, "b64": b64}],
    )
    out = (text or "").strip()
    if len(out) < MIN_TRANSCRIPT_CHARS:
        raise ValueError(f"vision transcript too short ({len(out)} chars)")
    return out


def vision_enabled(ctx) -> bool:
    """True only when api-rs said the relation runtime may see images AND we know
    where to send them."""
    return bool(ctx) and ctx.get("enabled") is True and bool(ctx.get("model")) and bool(ctx.get("base"))


def extract_image_knowledge(data, filename, ctx, ocr):
    """Orchestrator for one image file.

    - vision enabled: transcript from the model; OCR text (if any) appended under an
      ``## OCR text (Tesseract)`` heading so exact strings stay searchable.
    - vision disabled / failed / too short: ``ocr(data)`` as before.
    ``ocr`` is the OCR callable (file_handler._extract_image_ocr) — injected so this
    module stays free of the parser's imports and tests can fake it.
    """
    if vision_enabled(ctx):
        try:
            transcript = transcribe_image(
                data, filename,
                model=ctx.get("model"), base=ctx.get("base"), kind=ctx.get("kind") or "ollama",
                api_key=ctx.get("api_key"), max_concurrency=ctx.get("max_concurrency"),
                timeout=IMAGE_TIMEOUT,
            )
        except Exception as exc:  # noqa: BLE001 - any failure → OCR
            logger.warning(f"vision transcription failed for {filename!r} → OCR fallback: {type(exc).__name__}: {exc}")
        else:
            logger.info(f"vision transcription ok for {filename!r}: {len(transcript)} chars")
            try:
                ocr_text = ocr(data)
            except Exception:  # noqa: BLE001 - OCR is a bonus once vision succeeded
                ocr_text = ""
            if ocr_text and ocr_text.strip():
                return f"{transcript}\n\n## OCR text (Tesseract)\n{ocr_text.strip()}"
            return transcript
    return ocr(data)


def page_hook_for(ctx):
    """A per-page transcriber for scanned PDFs (file_handler._ocr_pdf ``page_hook``),
    or None when vision is off. The hook raises on failure so the page falls back to
    Tesseract."""
    if not vision_enabled(ctx):
        return None

    def _hook(png_bytes, page_num, filename):
        return transcribe_image(
            png_bytes, f"{filename} (page {page_num + 1})",
            model=ctx.get("model"), base=ctx.get("base"), kind=ctx.get("kind") or "ollama",
            api_key=ctx.get("api_key"), max_concurrency=ctx.get("max_concurrency"),
            timeout=PAGE_TIMEOUT,
        )

    return _hook
