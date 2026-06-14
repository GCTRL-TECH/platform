-- Let an access token's clearance reference a specific classification level
-- (system OR custom). Previously a token stored only a numeric rank, so a custom
-- level chosen for a token collapsed to the nearest standard band on display
-- (e.g. a custom level at rank 100 showed as "Internal"). Storing the level id
-- preserves exactly which level was picked; the rank (used for enforcement) is
-- still derived from that level.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS max_clearance_level_id UUID REFERENCES classification_levels(id);
