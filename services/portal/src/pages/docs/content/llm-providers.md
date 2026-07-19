# LLM Providers

GCTRL runs on **local inference by default** and can optionally connect to cloud providers when you want them. You choose the trade-off between performance, cost, and data sovereignty.

## Local by default: Ollama

Out of the box, GCTRL uses **local Ollama**:

- **On-prem.** Inference runs on your hardware.
- **Zero token cost.** No per-request billing.
- **Data-sovereign.** No prompt or content ever leaves the machine.

This is the recommended path for regulated and GDPR-sensitive deployments.

## Optional cloud providers

For teams that want frontier models or higher throughput, GCTRL also supports:

| Provider | Notes |
|----------|-------|
| **OpenAI** | Connect with an API key |
| **Anthropic** | Connect with an API key |
| **OpenRouter** | Single key, many upstream models |

## Configuring a provider

Connect providers in **Settings → connect provider**:

- **Cloud keys are encrypted at rest** and are **never returned** by the API - once saved, a key cannot be read back out.
- **Cloud base URLs are pinned and SSRF-guarded** - GCTRL only talks to the provider's known endpoint, preventing request forgery to internal hosts.

## Embeddings

Embeddings default to **`nomic-embed-text`**, run **locally**. This keeps the vector index - and the content it represents - on your machine regardless of which generation provider you select.

## Choosing for data sovereignty

> For **full data sovereignty**, use **Ollama only**. Any cloud provider you connect will, by definition, send prompts to that provider. Leave cloud providers disconnected to guarantee nothing leaves your infrastructure.

## See also

- [Infrastructure](infrastructure.md) - switch to native GPU-accelerated Ollama for a major speedup
- [Performance](performance.md) - pick the right model for your hardware
