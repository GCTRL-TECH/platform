"""Vision transcription (src/vision.py) and the image plumbing in llm_client.

- llm_client: `images` become OpenAI image_url parts on /v1 and `images` on Ollama;
  without images the bodies are byte-identical to before (parity for every caller).
- vision.prepare_image downsizes and returns JPEG base64.
- transcribe_image calls llm_client.complete with think=False and the image.
- extract_image_knowledge: vision + OCR appended; any failure → OCR; disabled → OCR
  only and the model is never called.
- file_handler: image extensions route to OCR; scanned-PDF pages use the page_hook
  first and Tesseract when it fails.
"""

import base64
import io
import sys
from unittest.mock import MagicMock, patch

import pytest
from PIL import Image

from src import llm_client, vision


def _png(w=64, h=32, color="white"):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()


# ── llm_client bodies ────────────────────────────────────────────────────────

class TestClientBodies:
    def test_v1_body_without_images_is_unchanged(self):
        assert llm_client._v1_body("p", "m", None, None) == llm_client._v1_body("p", "m", None, None, images=None)
        assert llm_client._v1_body("p", "m", None, None)["messages"][0]["content"] == "p"

    def test_v1_body_with_images_uses_content_parts(self):
        body = llm_client._v1_body("read this", "m", {"num_predict": 10}, False,
                                   images=[{"mime": "image/jpeg", "b64": "AAAA"}, {"mime": "image/png", "b64": "BBBB"}])
        content = body["messages"][0]["content"]
        assert content[0] == {"type": "text", "text": "read this"}
        assert content[1] == {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}}
        assert content[2]["image_url"]["url"] == "data:image/png;base64,BBBB"
        assert body["max_tokens"] == 10 and body["chat_template_kwargs"] == {"enable_thinking": False}

    def test_v1_body_ignores_empty_image_entries(self):
        body = llm_client._v1_body("p", "m", None, None, images=[None, {}, {"mime": "image/png"}])
        assert body["messages"][0]["content"] == "p"

    def test_ollama_body_images_field(self):
        assert "images" not in llm_client._ollama_body("p", "m", None, None)
        assert "images" not in llm_client._ollama_body("p", "m", None, None, images=[])
        body = llm_client._ollama_body("p", "m", {"temperature": 0}, False, images=[{"mime": "image/jpeg", "b64": "AAAA"}])
        assert body["images"] == ["AAAA"] and body["prompt"] == "p"

    def test_complete_forwards_images_to_the_v1_transport(self):
        seen = {}

        def fake_post(url, json=None, headers=None, timeout=None, allow_redirects=False):
            seen["url"] = url; seen["json"] = json
            class R:
                status_code = 200
                def raise_for_status(self): pass
                def json(self): return {"choices": [{"message": {"content": "TITLE: x"}}]}
            return R()

        with patch("src.llm_client.requests.post", side_effect=fake_post):
            out = llm_client.complete("p", "qwen", "http://h:8020/v1", "openai_compatible",
                                      api_key="k", think=False, images=[{"mime": "image/jpeg", "b64": "AAAA"}])
        assert out == "TITLE: x"
        assert seen["url"].endswith("/v1/chat/completions")
        assert seen["json"]["messages"][0]["content"][1]["type"] == "image_url"


# ── vision.prepare_image ─────────────────────────────────────────────────────

class TestPrepareImage:
    def test_downscales_and_returns_jpeg(self):
        mime, b64 = vision.prepare_image(_png(4000, 1000))
        assert mime == "image/jpeg"
        img = Image.open(io.BytesIO(base64.b64decode(b64)))
        assert img.format == "JPEG" and max(img.size) <= vision.MAX_SIDE and img.mode == "RGB"

    def test_small_image_keeps_size_and_flattens_alpha(self):
        buf = io.BytesIO(); Image.new("RGBA", (50, 40), (0, 0, 0, 0)).save(buf, format="PNG")
        mime, b64 = vision.prepare_image(buf.getvalue())
        img = Image.open(io.BytesIO(base64.b64decode(b64)))
        assert img.size == (50, 40) and img.mode == "RGB"

    def test_garbage_raises_value_error(self):
        with pytest.raises(ValueError):
            vision.prepare_image(b"not an image")


# ── vision.transcribe_image / extract_image_knowledge ────────────────────────

CTX = {"enabled": True, "kind": "openai_compatible", "base": "http://h:8020", "model": "qwen3.6-35b-a3b",
       "api_key": "k", "max_concurrency": 2}


class TestTranscribe:
    def test_calls_complete_with_image_and_thinking_off(self):
        with patch("src.llm_client.complete", return_value="TITLE: board\nTEXT: Budget 2027 -> Miro Test 42") as m:
            out = vision.transcribe_image(_png(), "board.png", model="qwen", base="http://h:8020",
                                          kind="openai_compatible", api_key="k", max_concurrency=2)
        assert "Budget 2027" in out
        args, kwargs = m.call_args
        assert args[1:] == ("qwen", "http://h:8020", "openai_compatible")
        assert kwargs["think"] is False and kwargs["api_key"] == "k" and kwargs["max_concurrency"] == 2
        assert kwargs["images"][0]["mime"] == "image/jpeg" and kwargs["images"][0]["b64"]
        assert "board.png" in args[0] and "STRUCTURE" in args[0]

    def test_short_answer_is_an_error(self):
        with patch("src.llm_client.complete", return_value="ok"):
            with pytest.raises(ValueError):
                vision.transcribe_image(_png(), "x.png", model="m", base="http://h", kind="ollama")


class TestOrchestrator:
    def test_vision_plus_ocr_appended(self):
        with patch("src.llm_client.complete", return_value="TITLE: two boxes\nTEXT: Budget 2027\nSTRUCTURE: A -> B"):
            out = vision.extract_image_knowledge(_png(), "two.png", CTX, ocr=lambda b: "Budget 2027 Miro Test 42")
        assert out.startswith("TITLE: two boxes")
        assert "## OCR text (Tesseract)\nBudget 2027 Miro Test 42" in out

    def test_vision_ok_but_ocr_empty_or_failing_is_fine(self):
        with patch("src.llm_client.complete", return_value="TITLE: photo\nSUMMARY: a whiteboard with nothing on it"):
            def boom(b): raise ValueError("no text")
            out = vision.extract_image_knowledge(_png(), "x.png", CTX, ocr=boom)
        assert out.startswith("TITLE: photo") and "OCR text" not in out

    def test_vision_failure_falls_back_to_ocr(self):
        import requests
        with patch("src.llm_client.complete", side_effect=requests.exceptions.Timeout("slow")):
            out = vision.extract_image_knowledge(_png(), "x.png", CTX, ocr=lambda b: "ocr text")
        assert out == "ocr text"

    def test_short_transcript_falls_back_to_ocr(self):
        with patch("src.llm_client.complete", return_value="??"):
            out = vision.extract_image_knowledge(_png(), "x.png", CTX, ocr=lambda b: "ocr text")
        assert out == "ocr text"

    def test_disabled_never_calls_the_model(self):
        with patch("src.llm_client.complete") as m:
            out = vision.extract_image_knowledge(_png(), "x.png", {**CTX, "enabled": False}, ocr=lambda b: "ocr only")
            assert out == "ocr only"
            out2 = vision.extract_image_knowledge(_png(), "x.png", None, ocr=lambda b: "ocr only")
            assert out2 == "ocr only"
        m.assert_not_called()

    def test_page_hook_only_when_enabled(self):
        assert vision.page_hook_for({**CTX, "enabled": False}) is None
        assert vision.page_hook_for(None) is None
        hook = vision.page_hook_for(CTX)
        with patch("src.llm_client.complete", return_value="TITLE: page\nTEXT: hello world page one") as m:
            assert "hello world" in hook(_png(), 0, "scan.pdf")
        assert "scan.pdf (page 1)" in m.call_args[0][0]


# ── file_handler routing ─────────────────────────────────────────────────────

class TestFileHandlerRouting:
    def test_image_extensions_route_to_ocr(self):
        from src.sources import file_handler as fh
        with patch("src.sources.file_handler._extract_image_ocr", return_value="ocr!") as m:
            assert fh.extract_text(_png(), "application/octet-stream", filename="board.PNG") == "ocr!"
            assert fh.extract_text(_png(), "image/jpeg", filename="noext") == "ocr!"
        assert m.call_count == 2

    def test_scanned_pdf_uses_page_hook_then_tesseract(self):
        import fitz  # PyMuPDF
        from src.sources import file_handler as fh
        doc = fitz.open(); doc.new_page(); doc.new_page(); doc.new_page()
        pdf = doc.tobytes(); doc.close()
        calls = []

        def hook(png, page_num, filename):
            calls.append(page_num)
            if page_num == 1:
                raise RuntimeError("busy")
            return f"VISION page {page_num}"

        with patch.dict(sys.modules, {"pytesseract": sys.modules.get("pytesseract") or MagicMock()}), \
             patch("pytesseract.image_to_string", return_value="TESS") as tess, \
             patch.dict("os.environ", {"KEX_VISION_PDF_MAX_PAGES": "2"}):
            out = fh._ocr_pdf(pdf, page_hook=hook, filename="scan.pdf")
        assert calls == [0, 1]                      # page 2 is beyond the vision budget
        assert "VISION page 0" in out and "TESS" in out
        assert tess.call_count == 2                 # page 1 (hook failed) + page 2 (budget)
