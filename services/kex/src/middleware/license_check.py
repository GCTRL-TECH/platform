import logging
import os

import httpx

# Overridable for non-default network layouts (consistent with api-rs's
# GCTRL_AGENT_URL); the compose default resolves the bundled agent container.
AGENT_URL = os.environ.get("GCTRL_AGENT_URL", "http://gctrl-agent:7070")

logger = logging.getLogger(__name__)

# Reason prefixes the agent marks as hold-able. Fallback for agents older than
# the `hold` response field — keep in sync with agent-rs server.rs handle_check.
_HOLD_REASON_PREFIXES = ("License not activated", "Required update pending")


class LicenseHoldError(PermissionError):
    """The license gate denied TRANSIENTLY (not activated / forced update pending).

    The job should be HELD and auto-resumed once the license recovers — never
    failed terminally. Business denials ("Insufficient credits") stay plain
    PermissionError and remain terminal: they need a human top-up decision.
    """


def check_credits(action: str, chars: int) -> dict:
    """
    Call gctrl-agent before starting a job.
    Returns {"allowed": True, "credits_spent": N} or raises:
      - LicenseHoldError for transient license-state denials (hold + resume),
      - PermissionError for business denials (terminal).
    Fails open if the agent is unreachable OR times out (grace mode) — a slow
    agent must degrade exactly like an absent one, not hard-fail jobs
    (httpx.TimeoutException is NOT a ConnectError subclass, which previously
    turned timeouts into terminal job failures).
    """
    try:
        resp = httpx.post(
            f"{AGENT_URL}/check",
            json={"action": action, "chars": chars},
            timeout=3.0,
        )
        data = resp.json()
        if not data.get("allowed"):
            reason = data.get("reason", "Credits check failed")
            hold = data.get("hold")
            if hold is None:  # pre-`hold` agent — classify by reason prefix
                hold = reason.startswith(_HOLD_REASON_PREFIXES)
            if hold:
                raise LicenseHoldError(reason)
            raise PermissionError(reason)
        # The agent's /check returns `credits` (the cost of this action), but
        # callers read `credits_spent`. Normalize so the key is ALWAYS present —
        # otherwise a reachable agent (active license) makes every job fail with
        # KeyError: 'credits_spent' (only the grace-mode path had the key).
        if "credits_spent" not in data:
            data["credits_spent"] = data.get("credits", 0)
        return data
    except (httpx.ConnectError, httpx.TimeoutException):
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
