import logging

import httpx

AGENT_URL = "http://gctrl-agent:7070"

logger = logging.getLogger(__name__)


def check_credits(action: str, chars: int) -> dict:
    """
    Call gctrl-agent before starting a job.
    Returns {"allowed": True, "credits_spent": N} or raises PermissionError.
    Fails open if agent is unreachable (grace mode).
    """
    try:
        resp = httpx.post(
            f"{AGENT_URL}/check",
            json={"action": action, "chars": chars},
            timeout=3.0,
        )
        data = resp.json()
        if not data.get("allowed"):
            raise PermissionError(data.get("reason", "Credits check failed"))
        return data
    except httpx.ConnectError:
        logger.warning("gctrl-agent unreachable — operating in grace mode")
        return {"allowed": True, "credits_spent": 0}


def report_usage(action: str, chars_processed: int, credits_spent: int) -> None:
    """Report actual usage after job completes (best-effort)."""
    try:
        httpx.post(
            f"{AGENT_URL}/report",
            json={"action": action, "chars_processed": chars_processed, "credits_spent": credits_spent},
            timeout=3.0,
        )
    except Exception:
        pass
