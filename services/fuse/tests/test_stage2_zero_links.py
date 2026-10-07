"""Zero LIMES links is an answer, not an outage.

Asgard, 07.10.2026: LIMES correctly found no pair in a small batch, the merger
read that as a failure and the full difflib fallback merged "Multiversum" /
"Musterfirma" at 0.55. Now only the strict short-name complement may add pairs;
the full fallback stays for a real engine failure.
"""

from src import merger as m


class FakeResolver:
    def __init__(self, links, last_error=None):
        self._links, self.last_error = links, last_error

    def is_healthy(self):
        return True

    def discover_links(self, **_):
        return self._links


ENTITIES = [
    {"uri": "u/mv", "name": "Multiversum", "type": "organization", "source_job": "a"},
    {"uri": "u/mf", "name": "Musterfirma", "type": "organization", "source_job": "b"},
    {"uri": "u/vw1", "name": "Volkswagen", "type": "organization", "source_job": "a"},
    {"uri": "u/vw2", "name": "Volkswgen", "type": "organization", "source_job": "b"},
]


def _merger(monkeypatch, resolver):
    mg = m.ThreeStageEntityMerger()
    mg._stage2_fell_back = False  # merge() sets it per run
    monkeypatch.setattr(m, "get_limes_client", lambda: resolver)
    monkeypatch.setattr(mg, "_collect_entities", lambda _jobs: [dict(e) for e in ENTITIES])
    return mg


def _pairs(links):
    return {tuple(sorted((l["source"], l["target"]))) for l in links}


def test_zero_links_keeps_only_strict_complement(monkeypatch):
    mg = _merger(monkeypatch, FakeResolver([]))
    links = mg._stage2_resolver(["a", "b"])
    assert ("u/mf", "u/mv") not in _pairs(links)      # what LIMES rejected stays apart
    assert ("u/vw1", "u/vw2") in _pairs(links)        # a real typo is still recovered
    assert mg._stage2_fell_back is False


def test_engine_failure_still_falls_back(monkeypatch):
    mg = _merger(monkeypatch, FakeResolver([], last_error="resolver job finished without result files"))
    links = mg._stage2_resolver(["a", "b"])
    assert mg._stage2_fell_back is True
    assert ("u/vw1", "u/vw2") in _pairs(links)
