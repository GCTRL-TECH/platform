"""Recurring lessons: the same lesson proven in several projects.

When a team learns the same thing in three projects ("regenerate the Prisma
client after a schema change"), it is no longer a project detail but team
knowledge. This module finds such lessons so the API can promote ONE copy into
the account's team-lessons knowledge base, where every project's playbook can
draw from it.

A lesson counts when it is hot itself (proven by use in its own project) and
near-duplicates (cosine >= threshold) that are at least warm exist in enough
OTHER project knowledge bases. Similarity uses the vectors every lesson has
anyway, so no text-similarity extension is needed in Postgres.

CYTHON NOTE: unannotated locals/params on purpose (exact-type checks in the
compiled build).
"""

import logging

logger = logging.getLogger(__name__)


def group_recurring(hot, neighbours, info, min_projects=3, min_peer_heat=1.0):
    """Pure grouping.

    ``hot``: list of lesson ids that are hot (already filtered, hottest first).
    ``neighbours``: {lesson_id: [(other_id, score), ...]} — near-duplicates found
    by vector search (score already >= threshold, self excluded).
    ``info``: {lesson_id: {"compilations": set(...), "heat": float, "promoted": bool}}.

    Returns groups ``{"representative": id, "lessonIds": [...], "compilationIds": [...]}``
    for lessons whose cluster spans at least ``min_projects`` knowledge bases.
    A lesson already used in a group is not the start of another one; promoted
    copies never count as a project.
    """
    seen = set()
    groups = []
    for lid in hot:
        if lid in seen:
            continue
        me = info.get(lid)
        if not me or me.get("promoted"):
            continue
        members = [lid]
        comps = set(me.get("compilations") or ())
        for other, _score in neighbours.get(lid, ()):
            o = info.get(other)
            if not o or o.get("promoted") or other in seen:
                continue
            if float(o.get("heat") or 0.0) < min_peer_heat:
                continue
            members.append(other)
            comps |= set(o.get("compilations") or ())
        if len(comps) >= min_projects:
            seen.update(members)
            groups.append({
                "representative": lid,
                "lessonIds": members,
                "compilationIds": sorted(comps),
            })
    return groups
