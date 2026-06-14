import os
import json
import httpx

OLLAMA_BASE = os.getenv("OLLAMA_BASE", "http://localhost:11434")
DEFAULT_MODEL = os.getenv("AUTO_CLASSIFY_MODEL", "llama3.2")

CLASSIFY_PROMPT = """Classify the following text according to ISO 27001 data classification.
Respond with EXACTLY ONE of these labels (no other text):
- PUBLIC (publicly available, no sensitivity)
- INTERNAL (internal business use only)
- CONFIDENTIAL (sensitive, limited distribution)
- STRICTLY_CONFIDENTIAL (highest sensitivity, executive/legal only)

Text: {text}

Classification:"""

async def auto_classify(text: str, model: str = DEFAULT_MODEL) -> str:
    """Return the ISO 27001 classification label for the given text.
    Falls back to 'INTERNAL' on any error."""
    try:
        snippet = text[:2000]  # Use first 2000 chars
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{OLLAMA_BASE}/api/generate",
                json={"model": model, "prompt": CLASSIFY_PROMPT.format(text=snippet), "stream": False}
            )
            resp.raise_for_status()
            data = resp.json()
            result = data.get("response", "").strip().upper()
            valid = {"PUBLIC", "INTERNAL", "CONFIDENTIAL", "STRICTLY_CONFIDENTIAL"}
            # Extract label even if model adds punctuation/context
            for label in valid:
                if label in result:
                    return label
    except Exception:
        pass
    return "INTERNAL"
