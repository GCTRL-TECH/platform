"""
Controlled relation vocabulary for KEX relation extraction.

A CLOSED set of ~32 canonical relations. The LLM must pick ONLY from this set
(or return nothing). This kills free-form garbage like
`is_used_as_second_brain_for`. Each canonical relation carries:
  - synonyms: alternative labels the LLM might emit, normalized to the canonical
  - head_types / tail_types: allowed coarse buckets for subject/object. Used by
    the deterministic validation layer to drop or flip obviously-wrong directions.
    An empty set means "any type allowed".

Coarse buckets mirror services/kex/src/config.py COARSE_TYPES:
  person, organization, location, technology, work, event, field, temporal,
  financial, quantity, other.

This is the PRODUCTION copy (source of truth). The offline eval harness keeps a
mirror at bench/kex/vocab.py; keep the two in sync when tuning the vocabulary.
"""

# canonical -> spec
RELATIONS: dict[str, dict] = {
    # ── founding / leadership / employment (person/org ↔ org) ──────────────
    "founded": {
        "synonyms": ["founder_of", "is_founder_of", "established", "created_company",
                     "started", "co_creator_of"],
        "head_types": {"person", "organization"},
        "tail_types": {"organization", "technology"},
        "desc": "X founded/created organization or product Y",
    },
    "co_founder_of": {
        "synonyms": ["cofounder_of", "co_founded", "is_co_founder_of"],
        "head_types": {"person"},
        "tail_types": {"organization", "technology"},
        "desc": "X is a co-founder of Y",
    },
    "ceo_of": {
        "synonyms": ["chief_executive_of", "is_ceo_of", "leads", "heads_company",
                     "chief_executive_officer_of"],
        "head_types": {"person"},
        "tail_types": {"organization"},
        "desc": "X is the CEO of organization Y",
    },
    "works_at": {
        "synonyms": ["works_for", "employed_by", "employee_of", "member_of_staff_of"],
        "head_types": {"person"},
        "tail_types": {"organization"},
        "desc": "X CURRENTLY works at organization Y (present tense, 'arbeitet bei', '2023 - present')",
    },
    "reports_to": {
        "synonyms": ["reports_into", "supervised_by", "managed_by", "answers_to"],
        "head_types": {"person"},
        "tail_types": {"person"},
        "desc": "X reports to / is supervised by person Y",
    },
    "manages": {
        "synonyms": ["supervises", "oversees", "manager_of", "leads_team"],
        "head_types": {"person"},
        "tail_types": {"person", "organization"},
        "desc": "X manages / supervises person or team Y",
    },
    "professor_at": {
        "synonyms": ["teaches_at", "is_professor_at", "faculty_at"],
        "head_types": {"person"},
        "tail_types": {"organization"},
        "desc": "X is a professor at university Y",
    },
    "heads": {
        "synonyms": ["leads_group", "is_head_of", "head_of", "directs", "chairs"],
        "head_types": {"person"},
        "tail_types": {"organization"},
        "desc": "X heads/leads research group or unit Y",
    },
    "member_of": {
        "synonyms": ["belongs_to", "is_member_of", "part_of_team"],
        "head_types": {"person"},
        "tail_types": {"organization"},
        "desc": "X is a member of organization Y",
    },

    # ── CV / résumé facts (person ↔ organization/field/location) ────────────
    # These cover the structured facts a CV states explicitly: where someone
    # worked or studied, their job title, the languages they speak, their
    # skills, degrees, and where they were born / live. Without these a CV
    # produces almost no relations (the document is a list of person-facts, not
    # narrative prose about organizations interacting).
    "worked_at": {
        "synonyms": ["work_at", "previously_at", "former_employer", "experience_at",
                     "position_at", "role_at"],
        "head_types": {"person"},
        "tail_types": {"organization"},
        "desc": "X PREVIOUSLY worked at organization Y (PAST employment only: 'previously', 'former', a closed date range; if current, use works_at) — NOT for current employees mentioned in past-tense narration (meeting minutes, memos: 'berichtete', 'presented')",
    },
    "studied_at": {
        "synonyms": ["student_at", "studied", "graduated_from", "alumnus_of",
                     "educated_at", "attended", "degree_from"],
        "head_types": {"person"},
        "tail_types": {"organization"},
        "desc": "X studied / earned a degree at school or university Y",
    },
    "has_role": {
        "synonyms": ["job_title", "title", "position", "role", "works_as",
                     "is_a", "serves_as", "holds_position"],
        "head_types": {"person"},
        "tail_types": {"field", "other"},
        "desc": "X holds the job title / role Y (e.g. Senior Developer, CTO)",
    },
    "has_degree": {
        "synonyms": ["degree", "holds_degree", "qualification", "earned_degree",
                     "graduated_with", "diploma"],
        "head_types": {"person"},
        "tail_types": {"field", "work", "other"},
        "desc": "X holds academic degree / qualification Y (e.g. BSc, MBA)",
    },
    "speaks": {
        "synonyms": ["speaks_language", "fluent_in", "language", "knows_language",
                     "proficient_in_language"],
        "head_types": {"person"},
        "tail_types": {"field"},
        "desc": "X speaks language Y",
    },
    "has_skill": {
        "synonyms": ["skill", "skilled_in", "proficient_in", "expert_in",
                     "knows", "competent_in", "experienced_in"],
        "head_types": {"person"},
        "tail_types": {"field", "technology", "other"},
        "desc": "X has skill / expertise Y (e.g. Python, project management)",
    },
    "born_in": {
        "synonyms": ["birthplace", "place_of_birth", "was_born_in", "native_of"],
        "head_types": {"person"},
        "tail_types": {"location"},
        "desc": "X was born in place Y",
    },
    "lived_in": {
        "synonyms": ["lives_in", "resides_in", "based_in_city", "moved_to",
                     "relocated_to"],
        "head_types": {"person"},
        "tail_types": {"location"},
        "desc": "X lives / lived in place Y",
    },

    # ── creation / development (person/org ↔ technology/work) ──────────────
    "develops": {
        "synonyms": ["develops", "is_developer_of", "develops_product", "maintains",
                     "produces", "creates_product", "develops_software", "develops_for"],
        "head_types": {"person", "organization"},
        "tail_types": {"technology", "work"},
        "desc": "X develops/maintains technology or product Y",
    },
    "created": {
        "synonyms": ["creator_of", "authored", "author_of", "invented", "is_creator_of",
                     "wrote", "designed"],
        "head_types": {"person", "organization"},
        "tail_types": {"technology", "work", "field"},
        "desc": "X created/authored Y (a work, tool, or framework)",
    },

    # ── composition / structure (technology/org ↔ technology/org) ──────────
    "part_of": {
        "synonyms": ["module_of", "component_of", "is_part_of", "belongs_to_system",
                     "subsystem_of", "is_module_of", "submodule_of"],
        "head_types": {"technology", "organization"},
        "tail_types": {"technology", "organization"},
        "desc": "X is a part/module/component of Y",
    },
    "spin_off_of": {
        "synonyms": ["spinoff_of", "is_spin_off_of", "derived_from_org"],
        "head_types": {"organization", "technology"},
        "tail_types": {"organization"},
        "desc": "X is a spin-off of organization Y",
    },

    # ── usage / dependency (technology ↔ technology) ──────────────────────
    "uses": {
        "synonyms": ["uses", "utilizes", "leverages", "depends_on", "powered_by",
                     "runs_on_tech", "relies_on", "consumes"],
        "head_types": {"technology", "organization"},
        "tail_types": {"technology"},
        "desc": "X uses technology Y as a dependency",
    },
    "built_with": {
        "synonyms": ["built_using", "implemented_in", "written_in", "made_with",
                     "based_on_tech", "built_on"],
        "head_types": {"technology"},
        "tail_types": {"technology", "field"},
        "desc": "X is built with technology or language Y",
    },
    "based_on": {
        "synonyms": ["based_upon", "is_based_on", "derived_from", "founded_on_concept"],
        "head_types": {"technology", "work", "field"},
        "tail_types": {"technology", "field", "work"},
        "desc": "X is based on architecture/approach Y",
    },
    "integrates_with": {
        "synonyms": ["integrates", "connects_to", "interfaces_with", "integration_with"],
        "head_types": {"technology"},
        "tail_types": {"technology", "organization"},
        "desc": "X integrates with system Y",
    },
    "calls": {
        "synonyms": ["invokes", "queries_service", "calls_service", "requests"],
        "head_types": {"technology"},
        "tail_types": {"technology"},
        "desc": "X calls/invokes service Y",
    },

    # ── data / storage (technology ↔ technology) ──────────────────────────
    "stores_data_in": {
        "synonyms": ["stores_in", "persists_to", "writes_to", "saves_to",
                     "stores_data", "stored_in"],
        "head_types": {"technology"},
        "tail_types": {"technology"},
        "desc": "X stores/writes data into store Y",
    },

    # ── hosting / location (technology/org ↔ technology/location) ──────────
    "hosted_on": {
        "synonyms": ["runs_on", "deployed_on", "hosted_at", "is_hosted_on",
                     "served_from"],
        "head_types": {"technology", "organization"},
        "tail_types": {"technology", "location"},
        "desc": "X is hosted/runs on infrastructure Y",
    },
    "located_in": {
        "synonyms": ["based_in", "is_located_in", "situated_in", "in_location"],
        "head_types": {"person", "organization", "technology"},
        "tail_types": {"location"},
        "desc": "X is located/based in place Y",
    },
    "reachable_at": {
        "synonyms": ["available_at", "hosted_at_domain", "accessible_at", "at_domain"],
        "head_types": {"technology", "organization"},
        "tail_types": {"location", "technology"},
        "desc": "X is reachable at address/domain Y",
    },

    # ── attributes / compliance (technology/org ↔ field) ──────────────────
    "complies_with": {
        "synonyms": ["compliant_with", "designed_for_standard", "conforms_to",
                     "aims_for", "certified_for", "ready_for"],
        "head_types": {"technology", "organization"},
        "tail_types": {"field"},
        "desc": "X complies with / aims for standard Y",
    },
    "supports": {
        "synonyms": ["supports", "provides_support_for", "enables", "implements"],
        "head_types": {"technology"},
        "tail_types": {"technology", "field"},
        "desc": "X supports capability or standard Y",
    },
    "provides": {
        "synonyms": ["offers", "exposes", "delivers", "provides_feature"],
        "head_types": {"technology", "organization"},
        "tail_types": {"technology", "field", "work"},
        "desc": "X provides/exposes feature Y",
    },
    "merges": {
        "synonyms": ["combines", "fuses", "unifies", "consolidates"],
        "head_types": {"technology"},
        "tail_types": {"technology", "field"},
        "desc": "X merges/combines Y",
    },

    # ── generic association (fallback for clearly-related but untyped) ─────
    "related_to": {
        "synonyms": ["associated_with", "linked_to", "connected_with"],
        "head_types": set(),
        "tail_types": set(),
        "desc": "X is related to Y (use only when no specific relation fits)",
    },
}

# Build reverse lookup: any synonym/canonical (normalized) -> canonical.
_SYNONYM_TO_CANON: dict[str, str] = {}
for _canon, _spec in RELATIONS.items():
    _SYNONYM_TO_CANON[_canon] = _canon
    for _syn in _spec["synonyms"]:
        _SYNONYM_TO_CANON[_syn.lower().strip()] = _canon


def normalize_relation(label: str) -> str | None:
    """Map a raw LLM relation label to a canonical relation, or None if unknown."""
    if not label:
        return None
    key = label.lower().strip().replace(" ", "_").replace("-", "_")
    # exact synonym/canonical hit
    if key in _SYNONYM_TO_CANON:
        return _SYNONYM_TO_CANON[key]
    # strip a leading "is_"/"was_"/"has_" and retry
    for prefix in ("is_", "was_", "has_", "a_", "the_"):
        if key.startswith(prefix) and key[len(prefix):] in _SYNONYM_TO_CANON:
            return _SYNONYM_TO_CANON[key[len(prefix):]]
    return None


def relation_names() -> list[str]:
    return list(RELATIONS.keys())


def type_ok(canon: str, head_coarse: str, tail_coarse: str) -> bool:
    """True if head/tail coarse types satisfy the relation's type constraints.
    Empty constraint set = wildcard. Unknown 'other' coarse type is permissive."""
    spec = RELATIONS.get(canon)
    if not spec:
        return False
    ht, tt = spec["head_types"], spec["tail_types"]
    head_ok = (not ht) or head_coarse in ht or head_coarse == "other"
    tail_ok = (not tt) or tail_coarse in tt or tail_coarse == "other"
    return head_ok and tail_ok


def vocab_prompt_block() -> str:
    """Render the controlled vocabulary as a compact prompt block."""
    lines = []
    for canon, spec in RELATIONS.items():
        lines.append(f"  {canon}: {spec['desc']}")
    return "\n".join(lines)
