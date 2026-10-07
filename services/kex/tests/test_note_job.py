"""Lessons are stored as one whole chunk, without entity extraction, marked
so the hot/cold layer and the playbook query can find them."""

from src.note_job import lesson_content, run_note_job


class FakeStore:
    def __init__(self):
        self.calls = []

    def store_chunks(self, chunks, embeddings, job_id, user_id, **kw):
        self.calls.append((chunks, embeddings, job_id, user_id, kw))
        return len(chunks)


class FakeEmbedder:
    def __init__(self, vec):
        self.vec = vec

    def embed_batch(self, texts):
        return [self.vec for _ in texts]


META = {"lessonType": "pitfall", "title": "Prisma-Client nach Schemawechsel",
        "text": "Nach jeder Schemaaenderung npx prisma generate ausfuehren.",
        "evidence": "Login brach mit column does not exist"}


def test_lesson_text_carries_type_title_body_and_evidence():
    text = lesson_content(META)
    assert text.splitlines() == [
        "Lehre (Falle): Prisma-Client nach Schemawechsel",
        "Nach jeder Schemaaenderung npx prisma generate ausfuehren.",
        "Beleg: Login brach mit column does not exist",
    ]


def test_a_lesson_is_one_marked_chunk_without_entities():
    store = FakeStore()
    res = run_note_job({"job_id": "j1", "user_id": "u1", "kind": "lesson", "meta": META},
                       store, FakeEmbedder([0.1, 0.2]), {"id": None, "name": "PUBLIC", "rank": 0})
    assert res["status"] == "completed" and res["chunks"] == 1 and res["entities"] == 0
    chunks, embeddings, job_id, user_id, kw = store.calls[0]
    assert len(chunks) == 1 and chunks[0]["content"].startswith("Lehre (Falle)")
    assert kw["kind"] == "lesson" and kw["meta"] == META
    assert kw["entity_mentions"] == [[]]
    assert "warning" not in res


def test_missing_embedding_is_reported_and_empty_notes_are_skipped():
    store = FakeStore()
    res = run_note_job({"job_id": "j2", "kind": "lesson", "meta": META}, store, FakeEmbedder(None), None)
    assert "keyword search" in res["warning"]
    empty = run_note_job({"job_id": "j3", "kind": "note", "input": "  "}, FakeStore(), FakeEmbedder([1.0]), None)
    assert empty["chunks"] == 0
