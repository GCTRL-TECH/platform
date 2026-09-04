"""fact_log routes through the runtime-aware llm_client (no more raw /api/generate)."""

from unittest.mock import patch

import requests


TEXT = ("The user changed the deadline from March 3 to March 10. " * 6).strip()
RAW = (
    "- The user changed the project deadline from March 3 to March 10.\n"
    "- The assistant suggested a weekly check-in on Mondays.\n"
)


def _http_error(status):
    r = requests.Response()
    r.status_code = status
    r._content = b"{}"
    r.url = "http://x"
    r.reason = "x"
    return requests.exceptions.HTTPError(response=r)


class TestFactLogRuntime:
    def test_non_ollama_uses_job_model_and_runtime_params(self):
        from src import config, fact_log
        with patch("src.fact_log.llm_client") as mock_client:
            mock_client.complete.return_value = RAW
            facts = fact_log.extract_facts(
                TEXT, ollama_base="http://mlx:8020/v1", model="qwen3.6-35b",
                kind="openai_compatible", api_key="k", max_concurrency=2,
            )
        assert len(facts) == 2
        assert mock_client.complete.call_count == 1
        args, kwargs = mock_client.complete.call_args
        assert args[1] == "qwen3.6-35b"
        assert args[2] == "http://mlx:8020/v1"
        assert args[3] == "openai_compatible"
        assert kwargs["api_key"] == "k"
        assert kwargs["options"] == {"temperature": 0.1}
        assert kwargs["think"] is config.FACT_LOG_THINK
        assert kwargs["max_concurrency"] == 2
        assert kwargs["timeout"] == 90

    def test_non_ollama_error_no_fallback_model(self):
        from src import fact_log
        with patch("src.fact_log.llm_client") as mock_client:
            mock_client.complete.side_effect = _http_error(500)
            out = fact_log.extract_facts(TEXT, ollama_base="http://mlx:8020", model="m",
                                         kind="openai_compatible")
        assert out == []
        assert mock_client.complete.call_count == 1

    def test_ollama_keeps_fact_log_model_and_404_falls_back(self, monkeypatch):
        from src import fact_log
        monkeypatch.setattr(fact_log, "FACT_LOG_MODEL", "fact-primary")
        monkeypatch.setattr(fact_log, "FACT_LOG_FALLBACK", "fact-fallback")
        with patch("src.fact_log.llm_client") as mock_client:
            mock_client.complete.side_effect = [_http_error(404), RAW]
            facts = fact_log.extract_facts(
                TEXT, ollama_base="http://o:11434", model="qwen-relex", kind="ollama",
            )
        assert len(facts) == 2
        models = [c.args[1] for c in mock_client.complete.call_args_list]
        assert models == ["fact-primary", "fact-fallback"]
        assert all(c.args[3] == "ollama" for c in mock_client.complete.call_args_list)

    def test_default_kind_is_ollama_with_config_base(self):
        from src import config, fact_log
        with patch("src.fact_log.llm_client") as mock_client:
            mock_client.complete.return_value = RAW
            fact_log.extract_facts(TEXT)
        args, _ = mock_client.complete.call_args
        assert args[2] == config.OLLAMA_BASE.rstrip("/")
        assert args[3] == "ollama"
