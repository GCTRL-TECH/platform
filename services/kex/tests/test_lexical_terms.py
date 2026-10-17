"""OR-relaxation term selection for the lexical /search channel (src/lexical_terms.py).

Why it matters: an OR over every token of a long chat message matched most of the
corpus and took 5-14 s on Asgard (2026-10-17), the whole per-turn budget of Anvil's
KB lookup. The selection keeps the pass bounded and drops the stopwords that made
`ts_rank_cd` rank by "die"/"und" density.
"""
import pathlib
import re

from src import lexical_terms
from src.lexical_terms import MAX_OR_TERMS, or_relaxation_terms


class TestOrRelaxationTerms:
    def test_drops_german_and_english_stopwords(self):
        terms = or_relaxation_terms("Was ist der Stand und wie geht es mit the project weiter?")
        assert [t.lower() for t in terms] == ["project", "stand", "geht"]

    def test_single_content_word_still_yields_a_pass(self):
        # "Was ist DENA?": the strict AND pass needs "was" and "ist" in the chunk;
        # the OR pass must still search for the one word that carries the question.
        assert or_relaxation_terms("Was ist DENA?") == ["DENA"]

    def test_short_identifiers_survive_short_words_do_not(self):
        terms = or_relaxation_terms("KI im Q3 zu es ab")
        assert terms == ["KI", "Q3"]

    def test_dedupes_case_insensitively_first_spelling_wins(self):
        assert or_relaxation_terms("Redispatch redispatch REDISPATCH Satellit") == ["Redispatch", "Satellit"]

    def test_longest_first_ties_keep_appearance_order(self):
        assert or_relaxation_terms("Haus Baum Kurzantwort Garten") == ["Kurzantwort", "Garten", "Haus", "Baum"]

    def test_long_message_is_capped(self):
        words = [f"begriff{i:03d}" for i in range(200)]
        terms = or_relaxation_terms(" ".join(words))
        assert len(terms) == MAX_OR_TERMS
        assert terms == words[:MAX_OR_TERMS]  # equal length -> order of appearance

    def test_explicit_cap(self):
        assert or_relaxation_terms("alpha bravo charlie delta", max_terms=2) == ["charlie", "alpha"]

    def test_punctuation_splits_like_before(self):
        # Same tokenization as the old inline code: alphanumeric runs only.
        assert or_relaxation_terms("GCTRL-XR-7741, foo_bar") == ["GCTRL", "7741", "foo", "bar", "XR"]

    def test_empty_and_stopword_only_queries(self):
        assert or_relaxation_terms("") == []
        assert or_relaxation_terms(None) == []
        assert or_relaxation_terms("und die das ist es") == []

    def test_accepts_str_subclass(self):
        class S(str):
            pass
        assert or_relaxation_terms(S("Bahnfahrt Hamburg")) == ["Bahnfahrt", "Hamburg"]

    def test_stopwords_are_lowercase(self):
        assert all(w == w.lower() for w in lexical_terms.STOPWORDS)


class TestLexicalChannelWiring:
    """Source guard over main.py (not importable offline): the OR pass must go
    through the selector, not back to every raw token."""

    SRC = (pathlib.Path(__file__).resolve().parents[1] / "src" / "main.py").read_text(encoding="utf-8")

    def test_or_pass_uses_the_selector(self):
        m = re.search(r"^def _lexical_search\(.*?(?=^def |^@app\.|^class )", self.SRC, re.S | re.M)
        assert m, "_lexical_search not found"
        body = m.group(0)
        assert "lexical_terms.or_relaxation_terms(q)" in body
        assert 'params["q"] = " OR ".join(toks)' in body
        # The old inline tokenizer (every token, stopwords included) must not return.
        assert 'if len(t) >= 2))' not in body
