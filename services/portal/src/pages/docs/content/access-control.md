# Access Control & Multi-Tenancy

GCTRL is built so that knowledge from many people can live in one graph **without** anyone seeing more than they are cleared to. Access control is enforced at three independent layers that compose: **user ownership**, **clearance ranks**, and **per-graph grants & KB-scoped tokens**. Every query passes through all three before a single triple is returned.

> **The enterprise point in one sentence:** when employees' individual knowledge is merged into one company knowledge graph, classification stays enforced - two people with different clearances querying the *same* merged graph each see only what they are cleared for.

---

## Layer 1 - User Ownership

Every record in GCTRL is scoped to its owner. Entities, relations, source documents, extractions, and knowledge bases all carry an owner identity, and the default visibility boundary is "your own data."

- A user's queries resolve against records they own plus records explicitly shared with them (see Layer 3).
- Ownership is the baseline tenant boundary: without an ownership or grant match, a record is simply not in the result set - it is never partially redacted, it is absent.
- This makes multi-tenancy the default rather than an add-on. A fresh user starts fully isolated.

Ownership answers *"whose data is this?"* Clearance answers *"how sensitive is it?"* The two are orthogonal and both must pass.

---

## Layer 2 - Clearance Ranks

Clearance is a **numeric classification level** carried by both data and callers. Higher rank means broader visibility.

| Level | Rank | Typical use |
|-------|-----:|-------------|
| `PUBLIC` | 0 | Open reference data, shareable facts |
| `INTERNAL` | 1 | Day-to-day company knowledge |
| `CONFIDENTIAL` | 2 | Sensitive business data, limited audience |
| `RESTRICTED` | 3 | Highly sensitive, need-to-know |

### How it is enforced

- **Every entity carries a minimum-clearance tag.** A `CONFIDENTIAL` entity requires the caller to hold at least `CONFIDENTIAL` clearance.
- **Queries only return what the caller is cleared to see.** Results are filtered by clearance at query time - anything above the caller's rank never enters the response. The caller cannot tell a higher-classified record exists.
- **API tokens carry a clearance ceiling, capped at the user's own clearance.** A token can be issued *at or below* its owner's clearance, never above it. You cannot mint a token more privileged than yourself.

This is what makes a merged graph safe. Picture two analysts querying the same unified company graph:

| Caller | Clearance | Sees |
|--------|-----------|------|
| Analyst A | `INTERNAL` (1) | `PUBLIC` + `INTERNAL` facts only |
| Analyst B | `RESTRICTED` (3) | `PUBLIC` → `RESTRICTED`, the full picture |

Same graph, same query, two different result sets - enforced by the engine, not by trusting the client.

### Custom classification levels

The four levels above are the default scheme. Organizations can define their **own classification levels** (names and numeric ranks) to mirror an existing information-classification policy - for example adding a `SECRET` tier above `RESTRICTED`, or renaming tiers to match internal taxonomy. The numeric ordering is what the engine enforces; the labels are yours.

---

## Layer 3 - Per-Graph Grants & KB-Scoped Tokens

Layers 1 and 2 define a baseline. Layer 3 is how you deliberately open access - narrowly.

### Per-graph grants

A token can be **granted access to specific knowledge bases** (compilations) that it would not otherwise see. A grant is targeted: it names the knowledge base and the access it confers.

- A grant can optionally **raise the clearance for just that one graph**. Example: a token sits at `INTERNAL` globally, but a grant lets it read one specific `CONFIDENTIAL` compilation - without raising its clearance anywhere else.
- Grants are additive and explicit. Nothing is shared implicitly.

### KB-scoped colleague tokens

A **KB-scoped colleague token** is locked to a set of knowledge bases. It can **only see and write the knowledge bases it has been granted** - nothing outside that scope exists for it, regardless of clearance.

- Ideal for a contractor, partner, or teammate who should work inside one or two compilations and never browse the wider graph.
- Scope applies to **reads and writes**: a colleague token can contribute new knowledge into its granted KBs, but cannot reach into others.
- Combined with a clearance ceiling, you get a token that is *both* narrow in scope (which graphs) and bounded in sensitivity (which records within them).

---

## Creating a Scoped Token

Go to **Settings → Access Control** and create a token with the three controls layered together:

1. **Clearance ceiling** - pick the maximum classification this token may read. It is automatically capped at your own clearance; you cannot exceed it.
2. **Per-graph grants** - add one or more knowledge bases this token may access. For each grant, optionally set a **raised clearance** that applies only to that graph.
3. **KB-scoping** - toggle the token to *scoped* mode so it can only see and write the granted knowledge bases and nothing else (a colleague token).

```text
Settings → Access Control → New Token

  Name:               partner-acme-readwrite
  Clearance ceiling:  INTERNAL            (capped at your clearance)
  Mode:               KB-scoped            (only granted KBs visible)
  Per-graph grants:
    - KB "ACME Pilot"        access: read + write
    - KB "ACME Specs"        access: read   clearance: CONFIDENTIAL (this graph only)
```

The result above is a colleague token that can read and write inside *ACME Pilot*, read *ACME Specs* at a raised `CONFIDENTIAL` clearance for that graph only, and see nothing else in the system.

---

## How the Layers Compose

For any request, GCTRL grants access only if **all** of the following hold:

1. **Ownership or grant** - the caller owns the record, or a per-graph grant covers it.
2. **Scope** - if the token is KB-scoped, the record's knowledge base is in scope.
3. **Clearance** - the caller's effective clearance for that record (global ceiling, or per-graph raised clearance) meets the record's minimum-clearance tag.

Fail any layer and the record is absent from the result - not redacted, not flagged. Every grant and every denial is recorded in the audit trail.

---

## See also

- **Compliance & Data Sovereignty** - how every access and denial is logged, GDPR posture, and on-prem inference.
- **FAQ / Troubleshooting** - connecting agents with scoped tokens, infrastructure settings.
