-- 0001_admin_auth: admin accounts, sessions and a generic audit log.
-- Applied inside a transaction by scripts/migrate.ts.

CREATE TABLE admin_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'disabled')),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_users_email_format CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%')
);

CREATE UNIQUE INDEX admin_users_email_key ON admin_users (email);

-- Opaque session tokens: only the SHA-256 hash is stored, never the token itself.
CREATE TABLE admin_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL,
  ip_address    text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  CONSTRAINT admin_sessions_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT admin_sessions_expiry CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX admin_sessions_token_hash_key ON admin_sessions (token_hash);
CREATE INDEX admin_sessions_admin_user_id_idx ON admin_sessions (admin_user_id);

-- Append-only record of security-relevant and admin actions.
-- Order and inventory history get their own dedicated tables in later migrations.
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type  text NOT NULL CHECK (actor_type IN ('admin', 'system', 'anonymous')),
  actor_id    uuid,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  ip_address  text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
