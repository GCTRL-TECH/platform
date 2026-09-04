"""A transient LLM status (503/507/409/…) must NEVER mark the relex primary model
"dead" (`_relex_dead_primaries`) — the retry ladder inside llm_client absorbs it
and the same model answers on the next attempt. Also: `max_concurrency` threads
from extract_relations down to llm_client.complete."""

import json
from unittest.mock import patch

import requests


def _resp(status, payload):
    r = requests.Response()
    r.status_code = status
    r._content = json.dumps(payload).encode()
    r.url = "http://o/api/generate"
    r.reason = "x"
    return r


def _entities():
    return [
        {"text": "Alice", "label": "person", "coarse_type": "person"},
        {"text": "Acme", "label": "organization", "coarse_type": "organization"},
    ]


class TestRelexTransientNotDead:
    def test_507_then_ok_keeps_primary_alive(self, monkeypatch):
        from src import llm_client, relex
        from src.relex import RelationExtractor

        sleeps = []
        monkeypatch.setattr(llm_client, "_sleep", lambda s: sleeps.append(s))
        monkeypatch.delenv("GCTRL_LLM_RETRY_MAX", raising=False)
        monkeypatch.delenv("GCTRL_LLM_RETRY_BASE_MS", raising=False)
        relex._relex_dead_primaries.discard("qwen-transient")
        seq = [_resp(507, {"error": "memory pressure"}), _resp(200, {"response": "[]"})]
        with patch.object(RelationExtractor, "_model_installed", return_value=True), \
             patch("requests.post", side_effect=seq) as mock_post:
            ext = RelationExtractor()
            out = ext._call_ollama("p", ollama_base="http://o", model="qwen-transient", kind="ollama")
        assert out == "[]"
        assert mock_post.call_count == 2
        assert sleeps == [1.0]
        assert "qwen-transient" not in relex._relex_dead_primaries
        assert not ext.last_degraded

    def test_max_concurrency_threads_down_to_llm_client(self):
        from src.relex import RelationExtractor
        with patch("src.relex.llm_client") as mock_client:
            mock_client.complete.return_value = "[]"
            ext = RelationExtractor()
            ext.extract_relations(
                "Alice is the CEO of Acme.", _entities(),
                ollama_base="http://mlx:8020", model="q", kind="openai_compatible",
                api_key="k", max_concurrency=2,
            )
        assert mock_client.complete.called
        for c in mock_client.complete.call_args_list:
            assert c.kwargs.get("max_concurrency") == 2
