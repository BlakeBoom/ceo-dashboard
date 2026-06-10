-- 0004 · Shared Zoho access-token cache.
-- Single-row table that all serverless function instances read/write to,
-- so we refresh the OAuth access token roughly once per hour instead of
-- once per cold start (Zoho rate-limits the token endpoint aggressively).

CREATE TABLE IF NOT EXISTS zoho_tokens (
  id            INT PRIMARY KEY DEFAULT 1,
  access_token  TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (id = 1)
);
