-- 0003_customers: customer accounts (personal / business), sessions, password reset tokens.

CREATE TABLE customers (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                      text NOT NULL,
  password_hash              text NOT NULL,
  full_name                  text NOT NULL CHECK (btrim(full_name) <> ''),
  phone                      text NOT NULL CHECK (phone ~ '^0[0-9]{9}$'),
  account_type               text NOT NULL CHECK (account_type IN ('personal', 'business')),
  status                     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- Business accounts only (D8, D9). Business prices apply only when business_status = 'approved'.
  business_status            text CHECK (business_status IN ('pending', 'approved', 'rejected')),
  company_name               text,
  tax_code                   text CHECK (tax_code ~ '^[0-9]{10}(-[0-9]{3})?$'),
  invoice_address            text,
  business_reviewed_at       timestamptz,
  business_reviewed_by       uuid REFERENCES admin_users (id),
  business_rejection_reason  text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_email_format CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  CONSTRAINT customers_business_fields CHECK (
    (account_type = 'personal' AND business_status IS NULL)
    OR (account_type = 'business' AND business_status IS NOT NULL
        AND company_name IS NOT NULL AND tax_code IS NOT NULL AND invoice_address IS NOT NULL)
  )
);

CREATE UNIQUE INDEX customers_email_key ON customers (email);
CREATE INDEX customers_business_status_idx ON customers (business_status) WHERE business_status IS NOT NULL;

CREATE TABLE customer_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  ip_address   text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);

CREATE UNIQUE INDEX customer_sessions_token_hash_key ON customer_sessions (token_hash);
CREATE INDEX customer_sessions_customer_id_idx ON customer_sessions (customer_id);

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
