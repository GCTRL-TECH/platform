"""The worker must keep jobs.updated_at warm while a long merge runs: the
api-rs stale-job sweep fails every 'processing' job older than 5 minutes,
and a 16k-entity merge with ConEx takes longer than that (2026-10-23).
The beat only touches updated_at of a still-processing row: it must never
flip a cancelled or watchdog-failed job back to processing."""
import time
from unittest.mock import patch

from src import main


def test_heartbeat_bumps_processing_while_body_runs():
    with patch("src.main._touch_job") as upd:
        with main._job_heartbeat("job-1", interval_s=0.02):
            time.sleep(0.15)
        beats = [c for c in upd.call_args_list if c.args == ("job-1",)]
        assert len(beats) >= 3


def test_heartbeat_stops_after_body():
    with patch("src.main._touch_job") as upd:
        with main._job_heartbeat("job-2", interval_s=0.02):
            pass
        time.sleep(0.1)
        after = upd.call_count
        time.sleep(0.1)
        assert upd.call_count == after


def test_heartbeat_skips_unknown_job():
    with patch("src.main._touch_job") as upd:
        with main._job_heartbeat("unknown", interval_s=0.01):
            time.sleep(0.05)
        assert upd.call_count == 0
