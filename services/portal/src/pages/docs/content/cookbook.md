# Cookbook: Hardware-Aware Model Tuning

The Cookbook is GCTRL's built-in model tuning assistant. It profiles the machine GCTRL is running on and recommends the right model for each pipeline stage — instead of you guessing at model names and finding out the hard way that a stage is too slow, or that the hardware can't carry it at all.

> **Status:** this page is a skeleton for the Cookbook feature shipping in this release. It will expand with screenshots and a full walkthrough as the page sees real usage.

## What it does

- **Detects your hardware** — CPU, RAM, and GPU/VRAM where applicable — and classifies the machine's tier.
- **Recommends a model per pipeline stage**, matched to that tier:
  - KEX embedding
  - KEX relation extraction
  - FUSE distill
  - Pi agent (the built-in GCTRL agent)
  - Talk-to-Graph
- **Shows an impact estimate** for each recommendation — the expected quality/speed tradeoff of switching, so the choice isn't blind.
- **Guardrails the choice** — if a recommended model repeatedly fails at runtime (crashes, timeouts), the Cookbook automatically reverts that stage to its safe default rather than leaving the pipeline stuck on a model the hardware can't run.

## Where to find it

**Settings → Cookbook**, alongside **Settings → AI Models** (the manual picker). The Cookbook is the guided, hardware-aware path to the same underlying settings — use either, they stay in sync.

## See also

[LLM Providers](llm-providers.md) · [Infrastructure & Ollama](infrastructure.md) · [Performance Guide](performance.md)
