"""Only the newest version of a re-uploaded file feeds the merge."""

from src.sources import split_latest


def test_superseded_version_is_dropped_latest_and_unversioned_kept():
    rows = [
        ("j-old", "doc-1", False, "/team/cv.pdf"),
        ("j-new", "doc-2", True, "/team/cv.pdf"),
        ("j-text", None, None, None),           # raw text store, no document
    ]
    kept, dropped = split_latest(rows, ["j-old", "j-new", "j-text"])
    assert kept == ["j-new", "j-text"]
    assert dropped == [{"job": "j-old", "path": "/team/cv.pdf"}]


def test_request_order_is_preserved_and_unknown_jobs_are_kept():
    rows = [("b", "doc", True, "/b.md")]
    kept, dropped = split_latest(rows, ["c", "b", "a"])
    assert kept == ["c", "b", "a"]
    assert dropped == []


def test_uuid_objects_match_text_ids():
    import uuid
    j = uuid.uuid4()
    rows = [(str(j), "doc", False, "/x.docx")]
    kept, dropped = split_latest(rows, [j, "other"])
    assert kept == ["other"]
    assert dropped[0]["job"] == str(j)
