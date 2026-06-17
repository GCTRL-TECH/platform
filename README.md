# Ground Control (GCTRL)

The knowledge-infrastructure layer for enterprise AI — extract structured
knowledge from your documents, fuse it into one governed knowledge graph, and
ground your LLMs/agents on it with full access control.

**Modules:** KEX (knowledge extraction) · FUSE (graph fusion, powered by LIMES) ·
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

## License

GCTRL is **dual-licensed** (the same model as the bundled
[LIMES](https://github.com/dice-group/LIMES)):

- **Open source — GNU AGPL v3** ([`LICENSE`](./LICENSE)): free to use, modify, and
  self-host, as long as your own stack stays open under the AGPL.
- **Commercial license**: for proprietary / closed-source or hosted use **without**
  AGPL copyleft obligations.

See **[`LICENSING.md`](./LICENSING.md)** for what's allowed under each option and
how to obtain a commercial license. Third-party notices: [`docs/LICENSES.md`](./docs/LICENSES.md).
