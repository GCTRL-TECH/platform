-- RUNTIME VISION (v0.9.7) — does the active generation runtime understand images?
--
-- KEX transcribes uploaded images and scanned PDFs with the ONE model that is
-- already loaded (Qwen3.6 on oMLX is a vision-language model; Ollama reports
-- `vision` in /api/show) instead of loading a second model, and falls back to
-- Tesseract OCR otherwise. The platform has to know which case applies:
--
--   vision           'auto' (default) | 'on' | 'off' — operator switch
--   vision_detected  result of the one-time probe (NULL = never probed / unknown)
--   vision_probed_at when that probe ran
--
-- Effective = on -> true, off -> false, auto -> vision_detected IS TRUE.
-- The probe sends a 1x1 PNG with max_tokens 5 (services/llm.rs probe_vision);
-- the detected value is cleared whenever model or base_url change.
ALTER TABLE runtime_config
    ADD COLUMN IF NOT EXISTS vision TEXT NOT NULL DEFAULT 'auto',
    ADD COLUMN IF NOT EXISTS vision_detected BOOLEAN,
    ADD COLUMN IF NOT EXISTS vision_probed_at TIMESTAMPTZ;

ALTER TABLE runtime_config
    DROP CONSTRAINT IF EXISTS runtime_config_vision_check;
ALTER TABLE runtime_config
    ADD CONSTRAINT runtime_config_vision_check CHECK (vision IN ('auto', 'on', 'off'));
