"""The wiki's playbook page mirrors the hot/cold layer: proven lessons per
type, hottest first; unproven ones as candidates; stable text for stable input."""

from src.distiller import build_playbook_body


def L(i, typ, heat, title, promoted=False, evidence=""):
    return {"id": f"{i:08d}-aaaa-bbbb-cccc-000000000000", "type": typ, "title": title,
            "text": f"Text {title}.", "evidence": evidence, "promoted": promoted,
            "heat": heat, "access": 1, "min_rank": 0}


def test_proven_lessons_are_grouped_pitfalls_first_and_candidates_last():
    body = build_playbook_body([
        L(1, "convention", 4.0, "Ordner englisch"),
        L(2, "pitfall", 6.0, "Prisma generieren", evidence="Login brach"),
        L(3, "recipe", 0.2, "Deploy in drei Schritten"),
    ], "2026-10-07T20:00:00+00:00")
    lines = body.splitlines()
    assert lines[0] == "# Playbook"
    assert body.index("## Fallen") < body.index("## Konventionen") < body.index("## Kandidaten")
    assert "*(Beleg: Login brach)*" in body
    assert "`[L-000000]`" in body
    assert "Deploy in drei Schritten" in body.split("## Kandidaten")[1]
    assert "2 bewährte Lehren · 1 Kandidaten" in body


def test_team_wide_lessons_are_marked_and_the_text_is_stable():
    lessons = [L(9, "decision", 2.0, "Englische Ordner", promoted=True)]
    a = build_playbook_body(lessons, "2026-10-07T20:00:00+00:00")
    b = build_playbook_body(lessons, "2026-10-08T09:00:00+00:00")
    assert "teamweit" in a
    assert a == b, "a timestamp must not change the page (content hash)"
