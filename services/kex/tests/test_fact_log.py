"""fact_log routes through the runtime-aware llm_client (no more raw /api/generate)."""

from unittest.mock import patch

import requests


TEXT = ("USER: I moved the deadline from March 3 to March 10.\n"
        "ASSISTANT: Noted, I suggest a weekly check-in on Mondays.\n" * 4).strip()
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


DOC = (
    "Konfliktpruefung GCTRL-Quellenkorpus: Ergebnis KEINE Widersprueche. Das Korpus besteht "
    "aus Paraphrasen-Clustern desselben Produktselbstbilds. Einzelnes Unternehmens-KG gegen "
    "je Projekt isolierte Wissensspeicher sind verschiedene Use Cases (Enterprise-Memory vs. Agentur)."
)
DOC_RAW = (
    "- The user clarified that a single corporate KG and project-isolated stores are different use cases.\n"
    "- The corpus about GCTRL contains no contradictory statement pairs.\n"
    "- The assistant confirmed that the corpus consists of paraphrase clusters.\n"
)


class TestFactLogAttribution:
    """17.10.2026: an agent write-back (a plain note, no dialogue) came back as
    "[Fact] The user clarified ..." in the user's personal KB. Documents get the
    document prompt, and invented speech acts are dropped."""

    def test_is_conversation_needs_a_user_turn(self):
        from src import fact_log
        assert fact_log.is_conversation("[Conversation session 1]\n\nUSER (2023-05-01): hi there")
        assert fact_log.is_conversation("Jarvis-Gespraech.\nNutzer: Wer ist X?\nAnvil: X ist ...")
        assert not fact_log.is_conversation(DOC)
        assert not fact_log.is_conversation("Ergebnis: der Nutzer-Wunsch lautet ...")

    def test_document_uses_doc_prompt_and_drops_invented_speech_acts(self):
        from src import fact_log
        with patch("src.fact_log.llm_client") as mock_client:
            mock_client.complete.return_value = DOC_RAW
            facts = fact_log.extract_facts(DOC * 2)
        prompt = mock_client.complete.call_args.args[0]
        assert "document excerpt" in prompt and "conversation session" not in prompt
        assert facts == ["The corpus about GCTRL contains no contradictory statement pairs."]

    def test_conversation_keeps_user_attribution(self):
        from src import fact_log
        with patch("src.fact_log.llm_client") as mock_client:
            mock_client.complete.return_value = RAW
            facts = fact_log.extract_facts(TEXT)
        assert "conversation session" in mock_client.complete.call_args.args[0]
        assert len(facts) == 2

    def test_document_keeps_non_speech_user_facts(self):
        from src import fact_log
        out = fact_log.drop_ungrounded_attributions(
            ["The user account was created on 2026-10-01.", "The user clarified X is Y."], conversation=False)
        assert out == ["The user account was created on 2026-10-01."]
