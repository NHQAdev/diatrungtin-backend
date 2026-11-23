-- D10: customers confirm their email with a 6-digit code (OTP) after registering.

ALTER TABLE customers ADD COLUMN email_verified_at timestamptz;

-- Accounts created before this feature existed are treated as verified.
UPDATE customers SET email_verified_at = created_at WHERE email_verified_at IS NULL;

CREATE TABLE email_verification_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  -- The address the code was sent to: a code only confirms that exact address.
  email       text NOT NULL,
  -- sha256 of "<customer id>:<code>"; the code itself is never stored.
  code_hash   bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_verification_codes_customer_idx ON email_verification_codes (customer_id, created_at DESC);
