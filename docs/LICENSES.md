# Licenses

## Ground Control (GCTRL) — own license

GCTRL is **dual-licensed**: open source under the **GNU AGPL v3** ([`/LICENSE`](../LICENSE)),
or under a **commercial license** for proprietary/closed/hosted use without AGPL
copyleft obligations. See [`/LICENSING.md`](../LICENSING.md) for the full explanation
and how to obtain a commercial license. (The `n8n-nodes-gctrl` connector is
separately MIT-licensed.)

---

# Third-Party License Notices

## LIMES — Link Discovery Framework for Metric Spaces

- **License:** GNU Affero General Public License v3.0 (AGPL-3.0)
- **Source:** https://github.com/dice-group/LIMES
- **Usage:** LIMES runs as an independent Docker container. Ground Control
  communicates with it exclusively via HTTP REST. LIMES source code is
  not modified and is not incorporated into Ground Control's codebase.
- **Compliance:** As an unmodified, separately-running service accessed
  only via network, LIMES is not a derivative work of Ground Control.
  Users who require LIMES source code may obtain it at the URL above.
