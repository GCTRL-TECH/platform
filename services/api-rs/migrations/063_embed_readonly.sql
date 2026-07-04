-- Wave 2: external graph embedding (token links + public links).
ALTER TABLE api_keys ADD COLUMN read_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE compilations ADD COLUMN embed_public BOOLEAN NOT NULL DEFAULT false;
