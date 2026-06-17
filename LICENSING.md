# Ground Control (GCTRL) — Licensing

GCTRL is **dual-licensed**, the same model the bundled
[LIMES](https://github.com/dice-group/LIMES) uses:

1. **Open source — GNU AGPL v3** (see [`LICENSE`](./LICENSE)), free for everyone, or
2. **Commercial license** — for using GCTRL in a closed/proprietary product or a
   hosted service **without** the AGPL's copyleft obligations.

> This file explains the two options in plain language. The actual legal terms are
> the AGPL-3.0 text in [`LICENSE`](./LICENSE) and your signed Commercial License
> Agreement. This summary is **not legal advice**; where it and the license texts
> differ, the license texts govern.

---

## Option 1 — Open source (AGPL-3.0): free

You may **use, study, modify, and self-host** GCTRL at no cost — privately or inside
a company — under the GNU Affero General Public License v3. The core AGPL condition
is **copyleft**:

- If you **distribute** GCTRL (modified or not), you must pass on the **complete
  corresponding source** under the AGPL.
- If you **run a modified GCTRL as a network service** (e.g. offer it to users over
  a network — the "A" in AGPL), you must offer **those users** the complete source
  of your running version, including your modifications, under the AGPL.

In short: with AGPL you can do almost anything **as long as your own stack stays
open** under the same license.

## Option 2 — Commercial license: paid

If you do **not** want to comply with AGPL copyleft — for example you want to:

- embed GCTRL in a **proprietary / closed-source product**, or
- offer GCTRL (or a derivative) as a **hosted/SaaS service without publishing your
  source**, or
- ship modifications you want to **keep private**,

then you need a **commercial license**. It grants those rights and lifts the AGPL
copyleft obligations, in exchange for a fee.

**Getting a commercial license:** contact **fabio@5monti.com** with your use case.
Commercial use is also what the in-product license key / activation enforces.

---

## What you may / may not do — at a glance

| Use case | AGPL (free) | Commercial license |
|---|---|---|
| Private / personal use | ✅ | ✅ |
| Internal company use (self-hosted) | ✅ (under AGPL) | ✅ |
| Modify the code | ✅ — must share changes under AGPL when you distribute or network-serve | ✅ — may keep changes private |
| Offer GCTRL as a SaaS / network service | ✅ **only if** you publish your full running source (incl. your changes) under AGPL | ✅ without publishing source |
| Embed in a **closed-source** product | ❌ — would force AGPL onto your product → **needs commercial** | ✅ |
| Redistribute GCTRL | ✅ under AGPL (ship source + license) | per your commercial terms |
| Resell GCTRL as your own proprietary product | ❌ | ✅ (per commercial terms) |

**Plain version:** non-commercial and open self-hosting are free under AGPL.
Building a *proprietary* or *closed SaaS* business on GCTRL requires a commercial
license — because AGPL would otherwise force you to open your whole stack.

> Note: AGPL does not *forbid* commercial use outright — it forbids **closed**
> commercial use. A company that fully complies with the AGPL (publishes its
> source) may use GCTRL commercially for free. The commercial license exists for
> everyone who can't or won't do that.

---

## Third-party components

GCTRL bundles third-party software, most notably **LIMES (AGPL-3.0)**, which runs as
a separate, unmodified Docker container reached only over HTTP — see
[`docs/LICENSES.md`](./docs/LICENSES.md). LIMES being AGPL is fully compatible with
GCTRL being AGPL.

The `n8n-nodes-gctrl` connector package is published separately under the **MIT**
license to ease integration; that is intentional and independent of the platform's
AGPL/commercial dual license.
