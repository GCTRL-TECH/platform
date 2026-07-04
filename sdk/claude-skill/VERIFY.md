# VERIFY — GCTRL Skill Dogfood Eval

Purpose: prove that a cold-start agent with the skill installed (a) triggers retrieval at the right moments, (b) answers correctly from the knowledge base, and (c) stays within the context budget.

## Setup

- Fresh agent session (no prior conversation, no cached compilationId).
- Skill installed per README; MCP server connected with a KB-scoped token.
- The target knowledge base must actually contain the answers — fill the templates below with entities you KNOW were ingested (check via the portal or `list_graphs` + a manual `query` first). If the KB cannot answer a template, swap it for one it can; the eval measures agent behavior, not KB coverage.
- Record for every question: the tool calls made (names + count), the answer, and whether the answer matches ground truth.

## The 10 question templates

1. "Who is `<person>` and what do they own / are responsible for?"
2. "What is `<project/system>`? Give me the current status."
3. "Where is the file `<filename or document>` — where does it live / where did it come from?"
4. "What did we decide about `<topic>`, and when?"
5. "How is `<entity A>` related to `<entity B>`?"
6. "What does `<system/component>` depend on?" (or: "what touches `<component>`?")
7. "What do we know about `<customer/partner/external org>`?"
8. "Who should I ask about `<topic/area>`?"
9. "Give me a short readable summary of `<entity>` I can paste into a doc." (should reach for the wiki page or dossier, not raw chunks)
10. "We just concluded: `<one-sentence new fact or decision>`. Remember it." (write-back: must `store`/`create_extraction` into an explicit compilationId)

Questions 1–9 test read triggering + the ladder; question 10 tests the write-back habit.

## Scoring

Per question, three sub-scores:

**Trigger (0/1):** did the agent call at least one GCTRL tool before answering? (Q10: did it write?) An answer produced without any tool call scores 0 regardless of correctness.

**Correctness (0/1/2):**
- 2 — factually matches ground truth, states it plainly (no hedging on dossier-backed facts), cites source/provenance where the question asks for it.
- 1 — partially correct, or correct but hedged/vague, or correct without requested provenance.
- 0 — wrong, hallucinated, or a false "no information" when the KB contains the answer.

**Discipline (0/1):** answered within 3 tool calls AND did not bulk-dump (no `get_graph` with large limits, no pasting long raw chunk sets). For Q10: exactly one `list_graphs` (first write of the session) + one write call is the ideal shape.

## Pass criteria

- Trigger rate: 10/10. A single missed trigger is a fail — triggering is the skill's core job.
- Median tool calls per question: ≤ 3 (count reads for Q1–9; Q10 counts list_graphs + write).
- Correctness: total ≥ 15/20, with no 0-scores caused by hallucination (a 0 caused by genuinely missing KB data is excused if the agent said "not on record").
- Discipline: ≥ 8/10.

## Reporting

Log a table (question, tools called, call count, trigger, correctness, discipline, notes) plus the medians. Re-run after any change to SKILL.md wording — trigger phrasing is the sensitive part; small description edits can change the trigger rate materially.
