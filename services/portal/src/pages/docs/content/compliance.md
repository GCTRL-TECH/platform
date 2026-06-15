# Compliance & Data Sovereignty

GCTRL is designed for regulated and enterprise environments where *where your data lives* and *who touched it* are first-class questions. Three pillars carry that posture: a complete **audit trail**, **GDPR-aware** session and personalization handling, and **on-prem / local inference** so nothing leaves your network.

> **Posture note:** the design references below (ISO 27001-aware design, TISAX-readiness as a north star) describe GCTRL's engineering *posture and intent*. They are not a claim of formal certification or audit. Treat them as how the system is built to behave, not as a compliance attestation.

---

## Audit Trail

Every access to the knowledge graph is logged — **including every denied access.** Each entry records:

| Field | What it captures |
|-------|------------------|
| **Acting token** | Which API token (and its owner) made the request |
| **Action** | Read, write, query, search, merge, etc. |
| **Resource** | The entity, knowledge base, or graph touched |
| **Clearance used** | The effective clearance applied to the request |
| **Outcome** | `GRANTED` or `DENIED` |

Because denials are logged just as carefully as grants, the audit trail answers both "who saw this?" and "who *tried* to see this and was stopped?" — the second question is usually the one auditors care about.

The trail is **queryable and filterable** — by token, by action, by resource, by clearance, by outcome, and by time window — so you can reconstruct exactly what any token did, or surface every denied attempt against a sensitive compilation.

```text
Filter examples
  outcome = DENIED  AND  resource.kb = "ACME Specs"     → every blocked attempt
  token   = partner-acme  AND  action = write           → everything a colleague wrote
  clearance >= CONFIDENTIAL  AND  action = read          → all sensitive reads
```

See **Access Control & Multi-Tenancy** for how clearance and grants generate the outcomes that land in this trail.

---

## GDPR / DSGVO

GCTRL keeps personal and conversational data minimal by design, with explicit user control over anything that persists.

### Incognito query mode

Incognito mode keeps a query session **in browser memory only.** The session and its context are **never persisted server-side** — close the tab and it is gone. This is the default posture for sensitive or ad-hoc questions where no record should remain.

### Opt-in personalization profile

GCTRL can build a personalization profile to improve results over time, but:

- It is **opt-in** — off until the user explicitly enables it.
- It is built **only from standard-mode history** — incognito sessions never contribute to it, by construction.

### Right to be forgotten

A user can **erase their personalization profile** at any time. Right-to-be-forgotten removes the profile and the standard-mode history it was derived from, returning the user to a clean state.

| Mode | Stored server-side? | Feeds personalization? |
|------|---------------------|------------------------|
| Incognito | No — browser memory only | No |
| Standard | Yes | Only if personalization is opted in |
| Personalization profile | Yes, until erased | n/a — it *is* the profile |

---

## On-Prem & Local Inference

GCTRL runs **entirely on your own hardware.** With local **Ollama** providing inference:

- **No data leaves your network.** Prompts, documents, graph content, and answers all stay inside your perimeter.
- **Zero token cost.** Local inference means no per-token billing and no external API dependency.
- **Full data sovereignty.** You control the hardware, the storage volumes, and the model — there is no third party in the data path.

This is what makes the GDPR and audit posture credible end-to-end: it is not "we promise not to look," it is "the data physically never leaves." For self-hosting details and pointing GCTRL at native Ollama or your own model, see the Infrastructure settings and the **FAQ / Troubleshooting** page.

---

## Built for Regulated Environments

GCTRL's design posture targets enterprise and regulated use:

- **ISO 27001-aware design** — access control, audit logging, and least-privilege tokens are built in rather than bolted on.
- **TISAX-readiness as a north star** — the architecture is shaped with industrial/automotive information-security expectations in mind.
- **Data sovereignty by default** — on-prem deployment and local inference keep the entire data lifecycle inside your control.

Again: these describe how the system is engineered, not a formal certification. They are the design targets that explain *why* the audit trail, clearance model, and local-first architecture exist.

---

## See also

- **Access Control & Multi-Tenancy** — ownership, clearance ranks, grants, and KB-scoped tokens.
- **Benchmarks** — including the ~0 ms cost of enforcing access control on every query.
- **FAQ / Troubleshooting** — local Ollama, data locations, and what (never) goes to the cloud.
