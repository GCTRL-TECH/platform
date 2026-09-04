-- MLX runtime + per-runtime concurrency gate (spec 2026-09-04, D2 + D6).
--
-- runtime_id      : which catalog entry (ollama|llamacpp|vllm|external|mlx) was
--                   applied; the provider column alone cannot tell "mlx" from
--                   "external" (both are openai_compatible) and the UI label needs to.
-- max_concurrency : maximum simultaneous generation requests THIS GCTRL instance
--                   opens against an openai_compatible runtime. Default 4 — a
--                   21 GB model on a 48 GB Mac Studio starts returning 507/409
--                   under memory pressure when a worker fans out more than that.
ALTER TABLE runtime_config
    ADD COLUMN IF NOT EXISTS runtime_id TEXT,
    ADD COLUMN IF NOT EXISTS max_concurrency INT NOT NULL DEFAULT 4;
