import os

from . import llm_client

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

async def auto_classify(
    text: str,
    model: str = DEFAULT_MODEL,
    kind: str = "ollama",
    api_key=None,
    base=None,
) -> str:
    """Return the ISO 27001 classification label for the given text.
    Falls back to 'INTERNAL' on any error.

    `kind` selects the LLM backend ("ollama" | "openai" | "openai_compatible").
    `api_key` is forwarded to llm_client for OpenAI-compatible providers.
    `base` overrides the endpoint URL; when falsy falls back to OLLAMA_BASE so
    default kind="ollama" behaviour is preserved unchanged.
    Default kind="ollama" preserves existing behaviour.
    """
    resolved_base = (base or "").strip() or OLLAMA_BASE
    try:
        snippet = text[:2000]  # Use first 2000 chars
        result = await llm_client.acomplete(
            CLASSIFY_PROMPT.format(text=snippet),
            model,
            resolved_base,
            kind,
            api_key=api_key,
            timeout=30.0,
        )
        result = result.strip().upper()
        valid = {"PUBLIC", "INTERNAL", "CONFIDENTIAL", "STRICTLY_CONFIDENTIAL"}
        # Extract label even if model adds punctuation/context
        for label in valid:
            if label in result:
                return label
    except Exception:
        pass
    return "INTERNAL"
