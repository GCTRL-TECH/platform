CREATE TABLE licenses (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  license_key       VARCHAR(255) NOT NULL UNIQUE,
  tier              VARCHAR(50)  NOT NULL DEFAULT 'free',
  credits_allocated INTEGER      NOT NULL DEFAULT 1000,
  credits_used      INTEGER      NOT NULL DEFAULT 0,
  status            VARCHAR(50)  NOT NULL DEFAULT 'active',
  activated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_licenses_user_id ON licenses(user_id);
