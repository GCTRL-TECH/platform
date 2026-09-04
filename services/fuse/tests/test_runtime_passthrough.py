"""D8: the Ollama-only FUSE call sites (dossier summary, user-profile distill)
become runtime-aware — model/base/kind/api_key/max_concurrency flow from the
request objects down to `distiller._llm_complete` → `llm_client.complete`.
"""

from unittest.mock import MagicMock, patch


RUNTIME = {
    "model": "qwen3.6-35b",
    "ollama_base": "http://mlx:8020/v1",
    "kind": "openai_compatible",
    "api_key": "k",
    "max_concurrency": 2,
}


class TestDistillerLlmComplete:
    def test_passes_runtime_params_to_llm_client(self):
        from src import distiller
        with patch("src.distiller.llm_client") as mock_client:
            mock_client.complete.return_value = "  page  "
            out = distiller._llm_complete("p", **RUNTIME)
        assert out == "page"
        args, kwargs = mock_client.complete.call_args
        assert args == ("p", "qwen3.6-35b", "http://mlx:8020/v1", "openai_compatible")
        assert kwargs["api_key"] == "k"
        assert kwargs["max_concurrency"] == 2
        assert kwargs["timeout"] == distiller._LLM_TIMEOUT

    def test_defaults_unchanged(self):
        from src import distiller
        with patch("src.distiller.llm_client") as mock_client:
            mock_client.complete.return_value = "x"
            distiller._llm_complete("p")
        args, kwargs = mock_client.complete.call_args
        assert args == ("p", distiller.DISTILL_MODEL, distiller.OLLAMA_BASE, "ollama")
        assert kwargs["api_key"] is None
        assert kwargs["max_concurrency"] is None


class TestDossierSummaryRuntime:
    def _entity(self):
        return {"name": "Acme", "type": "organization", "neighbors": [], "facts": [], "source_jobs": []}

    def test_build_summary_forwards_runtime(self):
        from src import dossier
        with patch("src.dossier.distiller._llm_complete", return_value="Acme is a company.") as mock_llm:
            out = dossier._build_summary(self._entity(), None, **RUNTIME)
        assert out == "Acme is a company."
        _args, kwargs = mock_llm.call_args
        for k, v in RUNTIME.items():
            assert kwargs[k] == v, (k, kwargs)

    def test_build_summary_defaults_to_ollama(self):
        from src import dossier
        with patch("src.dossier.distiller._llm_complete", return_value="s") as mock_llm:
            dossier._build_summary(self._entity(), None)
        _args, kwargs = mock_llm.call_args
        assert kwargs["kind"] == "ollama"
        assert kwargs["model"] is None and kwargs["ollama_base"] is None
        assert kwargs["api_key"] is None and kwargs["max_concurrency"] is None

    def test_build_summary_llm_failure_falls_back(self):
        from src import dossier
        with patch("src.dossier.distiller._llm_complete", side_effect=RuntimeError("down")):
            out = dossier._build_summary(self._entity(), None, **RUNTIME)
        assert out.startswith("Acme (organization)")

    def test_build_dossier_for_name_threads_runtime(self):
        from src import dossier
        entity = dict(self._entity(), facts=[], uri=None)
        with patch("src.dossier._neo_driver", return_value=MagicMock()), \
             patch("src.dossier._pg_connect", return_value=MagicMock()), \
             patch("src.dossier._fetch_entity_facts", return_value=entity), \
             patch("src.dossier._resolve_origin_files", return_value=[]), \
             patch("src.dossier._upsert_dossier", return_value="created"), \
             patch("src.dossier._build_summary", return_value="sum") as mock_summary:
            res = dossier.build_dossier_for_name("u1", "Acme", **RUNTIME)
        assert res["summary"] == "sum"
        _args, kwargs = mock_summary.call_args
        for k, v in RUNTIME.items():
            assert kwargs[k] == v

    def test_build_dossier_for_name_scoped_threads_runtime(self):
        from src import dossier
        entity = dict(self._entity(), facts=[], uri=None, source_jobs=["j1"])
        with patch("src.dossier._neo_driver", return_value=MagicMock()), \
             patch("src.dossier._pg_connect", return_value=MagicMock()), \
             patch("src.dossier._fetch_entity_facts_scoped", return_value=entity), \
             patch("src.dossier._resolve_origin_files_scoped", return_value=[]), \
             patch("src.dossier._upsert_dossier", return_value="created"), \
             patch("src.dossier._build_summary", return_value="sum") as mock_summary:
            res = dossier.build_dossier_for_name_scoped("u1", "Acme", ["j1"], **RUNTIME)
        assert res["summary"] == "sum"
        _args, kwargs = mock_summary.call_args
        for k, v in RUNTIME.items():
            assert kwargs[k] == v

    def test_build_top_dossiers_threads_runtime(self):
        from src import dossier
        entity = dict(self._entity(), facts=[], uri=None)
        with patch("src.dossier._neo_driver", return_value=MagicMock()), \
             patch("src.dossier._pg_connect", return_value=MagicMock()), \
             patch("src.dossier._fetch_top_entity_names", return_value=["Acme"]), \
             patch("src.dossier._fetch_entity_facts", return_value=entity), \
             patch("src.dossier._resolve_origin_files", return_value=[]), \
             patch("src.dossier._upsert_dossier", return_value="updated"), \
             patch("src.dossier._build_summary", return_value="sum") as mock_summary:
            res = dossier.build_top_dossiers("c1", "u1", ["j1"], top_n=3, **RUNTIME)
        assert res["dossiers_built"] == 1
        _args, kwargs = mock_summary.call_args
        for k, v in RUNTIME.items():
            assert kwargs[k] == v


class TestUserProfileRuntime:
    def test_build_profile_forwards_runtime(self):
        from src import user_profile
        rows = [{"role": "user", "content": "I am a Rust developer.", "created_at": None}]
        raw = '{"facts": [{"category": "role", "fact": "Rust developer"}], "summary": "A Rust dev."}'
        with patch("src.user_profile._pg_connect", return_value=MagicMock()), \
             patch("src.user_profile._is_enabled", return_value=True), \
             patch("src.user_profile._fetch_standard_history", return_value=rows), \
             patch("src.user_profile._build_transcript", return_value="t"), \
             patch("src.user_profile._upsert_profile") as mock_upsert, \
             patch("src.user_profile.distiller._llm_complete", return_value=raw) as mock_llm:
            res = user_profile.build_profile("u1", **RUNTIME)
        assert res["action"] == "built"
        assert res["facts"] == [{"category": "role", "fact": "Rust developer"}]
        assert mock_upsert.called
        _args, kwargs = mock_llm.call_args
        for k, v in RUNTIME.items():
            assert kwargs[k] == v

    def test_build_profile_defaults_to_ollama(self):
        from src import user_profile
        rows = [{"role": "user", "content": "x", "created_at": None}]
        with patch("src.user_profile._pg_connect", return_value=MagicMock()), \
             patch("src.user_profile._is_enabled", return_value=True), \
             patch("src.user_profile._fetch_standard_history", return_value=rows), \
             patch("src.user_profile._build_transcript", return_value="t"), \
             patch("src.user_profile._upsert_profile"), \
             patch("src.user_profile.distiller._llm_complete", return_value='{"facts": [], "summary": ""}') as mock_llm:
            user_profile.build_profile("u1")
        _args, kwargs = mock_llm.call_args
        assert kwargs["kind"] == "ollama"
        assert kwargs["model"] is None and kwargs["ollama_base"] is None
