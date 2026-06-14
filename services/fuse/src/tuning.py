"""
FUSE entity-resolution tuning seam.

The tuned ER recipe — per-type LIMES link specs, accept/review floors, field-mode
knobs, embedding cutoffs — is NOT in this public repo. It is delivered to licensed
deployments over the existing license heartbeat (signed with the license RS256
key) and cached by the local agent, which serves it at GET /tuning. This module
resolves the ACTIVE profile that `run_merge()` applies:

    1. GCTRL_TUNING_PROFILE_PATH  — a local JSON file (dev/team escape hatch; gitignored)
    2. the local agent            — GET http://gctrl-agent:7070/tuning  (3s timeout)
    3. bundled GENERIC defaults   — functional, conservative, always present

Fail-safe by design: ANY miss (no file, agent down/unreachable, empty/204, bad
JSON, missing license) silently yields the generic defaults and the merge
completes. A tuning miss is never an error and never blocks — it mirrors the
license_check "fail open / grace mode" posture. `load_tuning()` never raises.
"""

import json
import logging
import os
from typing import Optional

from . import config_builder

logger = logging.getLogger(__name__)

# Where the local agent serves the cached, signature-verified profile.
_AGENT_TUNING_URL = os.environ.get(
    "GCTRL_AGENT_TUNING_URL", "http://gctrl-agent:7070/tuning"
)
_AGENT_TIMEOUT_S = 3

# The bundled GENERIC profile — the conservative open-source baseline. Its shape
# mirrors run_merge()'s tunable params. The per-type metrics come from the
# config_builder generic snapshot (a single cosine-name family for every type).
GENERIC_PROFILE: dict = {
    "default_metrics": dict(config_builder.GENERIC_DEFAULT_METRICS),
    "threshold_accept": 0.85,
    "threshold_review": 0.55,
    "metric_overrides": {},
    "field_mode_config": {},      # empty → merger keeps its generic FIELD_* defaults
    "embedding_overrides": {},    # empty → embedding_match keeps its generic cutoffs
}


def _profile_from_payload(payload: dict) -> Optional[dict]:
    """Pull the `profile` object out of a {version, profile} payload (or accept a
    bare profile dict). Returns None when there's nothing usable."""
    if not isinstance(payload, dict):
        return None
    prof = payload.get("profile", payload)
    return prof if isinstance(prof, dict) and prof else None


def _from_file() -> Optional[dict]:
    """Dev/team escape hatch: a local JSON profile so the team runs at full quality
    without any agent/server. The file may be {version, profile} or a bare profile."""
    path = os.environ.get("GCTRL_TUNING_PROFILE_PATH")
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            prof = _profile_from_payload(json.load(fh))
        if prof:
            logger.info(f"[tuning] using local profile from {path}")
        return prof
    except Exception as exc:  # missing / unreadable / bad JSON → fall through
        logger.debug(f"[tuning] local profile {path} unavailable: {exc}")
        return None


def _from_agent() -> Optional[dict]:
    """Fetch the agent-cached (already signature-verified + license-bound) profile.
    204 / error / unreachable → None. Best-effort, never raises."""
    try:
        import requests  # local import so a missing dep never breaks import-time
        resp = requests.get(_AGENT_TUNING_URL, timeout=_AGENT_TIMEOUT_S)
        if resp.status_code != 200:
            return None
        prof = _profile_from_payload(resp.json())
        if prof:
            logger.info("[tuning] using license-delivered profile from local agent")
        return prof
    except Exception as exc:
        logger.debug(f"[tuning] agent tuning unavailable: {exc}")
        return None


def load_tuning() -> dict:
    """Resolve the ACTIVE tuning profile: generic defaults overlaid with the tuned
    profile when one is available (local file first, then the local agent). Always
    returns a complete profile; never raises. Shape:

        { default_metrics, metric_overrides, threshold_accept, threshold_review,
          field_mode_config, embedding_overrides }
    """
    tuned = _from_file()
    if tuned is None:
        tuned = _from_agent()

    # Start from a deep-ish copy of the generic baseline.
    profile: dict = {
        "default_metrics": dict(GENERIC_PROFILE["default_metrics"]),
        "threshold_accept": GENERIC_PROFILE["threshold_accept"],
        "threshold_review": GENERIC_PROFILE["threshold_review"],
        "metric_overrides": dict(GENERIC_PROFILE["metric_overrides"]),
        "field_mode_config": dict(GENERIC_PROFILE["field_mode_config"]),
        "embedding_overrides": dict(GENERIC_PROFILE["embedding_overrides"]),
    }
    if not tuned:
        return profile

    # Overlay tuned values (only when present), so a partial profile still merges
    # cleanly onto the generic baseline. default_metrics is merged per-type so a
    # tuned profile that omits a type keeps the generic spec for it.
    dm = profile["default_metrics"]
    dm.update(tuned.get("default_metrics") or {})
    profile["default_metrics"] = dm
    for key in ("threshold_accept", "threshold_review"):
        if tuned.get(key) is not None:
            try:
                profile[key] = float(tuned[key])
            except (TypeError, ValueError):
                pass
    for key in ("metric_overrides", "field_mode_config", "embedding_overrides"):
        val = tuned.get(key)
        if isinstance(val, dict) and val:
            profile[key] = dict(val)
    return profile
