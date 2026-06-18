# Ground Control (GCTRL)

The knowledge-infrastructure layer for enterprise AI — extract structured
knowledge from your documents, fuse it into one governed knowledge graph, and
ground your LLMs/agents on it with full access control.

**Modules:** KEX (knowledge extraction) · FUSE (graph fusion) ·
Knowledge-Graph management · Talk-to-Graph (GDPR-compliant RAG) · Pi agent.

## Install

```bash
curl -fsSL https://gctrl.tech/install | bash
```

Uninstall (keep data) / full reset:

```bash
curl -fsSL https://gctrl.tech/uninstall | bash               # keep your data
curl -fsSL https://gctrl.tech/uninstall | bash -s -- --purge  # wipe everything
```

## ⚠️ Before production — change the default secrets

The bundled compose files ship with **well-known placeholder secrets**
(`POSTGRES_PASSWORD`, `NEO4J_PASSWORD`, `JWT_SECRET`, …) so GCTRL runs out of the
box on localhost. **Set your own real values** (via a local `.env`, never
committed) before exposing GCTRL to a network. A predictable `JWT_SECRET` lets
anyone forge admin tokens; default DB passwords are public knowledge.

## License

GCTRL is **dual-licensed**:

- **Open source — GNU AGPL v3** ([`LICENSE`](./LICENSE)): free to use, modify, and
  self-host, as long as your own stack stays open under the AGPL.
- **Commercial license**: for proprietary / closed-source or hosted use **without**
  AGPL copyleft obligations.

See **[`LICENSING.md`](./LICENSING.md)** for what's allowed under each option and
how to obtain a commercial license. Third-party notices: [`docs/LICENSES.md`](./docs/LICENSES.md).
