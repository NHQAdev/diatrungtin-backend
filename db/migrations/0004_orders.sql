-- 0004_orders: orders with item snapshots, status history, idempotency keys and an email outbox.

CREATE TABLE orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text NOT NULL UNIQUE,
  customer_id           uuid REFERENCES customers (id) ON DELETE SET NULL,
  -- Contact and shipping info, copied at order time (guest checkout requires phone + email, D5).
  customer_name         text NOT NULL,
  phone                 text NOT NULL CHECK (phone ~ '^0[0-9]{9}$'),
  email                 text NOT NULL,
  shipping_province     text NOT NULL,
  shipping_ward         text NOT NULL,
  shipping_address_line text NOT NULL,
  note                  text,
  -- Which price list was applied (D8). Decided by the server from the logged-in account.
  price_tier            text NOT NULL CHECK (price_tier IN ('retail', 'business')),
  -- VAT invoice snapshot (business customers).
  invoice_requested     boolean NOT NULL DEFAULT false,
  invoice_company_name  text,
  invoice_tax_code      text,
  invoice_address       text,
  -- Money (VND).
  subtotal              bigint NOT NULL CHECK (subtotal >= 0),
  shipping_fee          bigint NOT NULL CHECK (shipping_fee >= 0),
  discount_total        bigint NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  total                 bigint NOT NULL CHECK (total >= 0),
  -- Three separate statuses (D4).
  order_status          text NOT NULL DEFAULT 'pending' CHECK (order_status IN ('pending', 'confirmed', 'completed', 'cancelled')),
  payment_status        text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid', 'refunded')),
  fulfillment_status    text NOT NULL DEFAULT 'unfulfilled' CHECK (fulfillment_status IN ('unfulfilled', 'packing', 'shipped', 'delivered', 'returned')),
  payment_method        text NOT NULL DEFAULT 'cod' CHECK (payment_method IN ('cod')),
  carrier               text,
  tracking_number       text,
  cancel_reason         text,
  -- Set exactly once when stock is put back (cancel / return). Guards against double restock.
  stock_restored_at     timestamptz,
  -- Secret for the guest "cancel my order" link in the confirmation email. Only the hash is stored.
  access_token_hash     bytea NOT NULL CHECK (octet_length(access_token_hash) = 32),
  confirmed_at          timestamptz,
  shipped_at            timestamptz,
  delivered_at          timestamptz,
  paid_at               timestamptz,
  completed_at          timestamptz,
  cancelled_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_total_matches CHECK (total = subtotal + shipping_fee - discount_total),
  CONSTRAINT orders_invoice_fields CHECK (
    NOT invoice_requested OR (invoice_company_name IS NOT NULL AND invoice_tax_code IS NOT NULL AND invoice_address IS NOT NULL)
  )
);

CREATE INDEX orders_customer_id_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_created_at_idx ON orders (created_at DESC);
CREATE INDEX orders_phone_idx ON orders (phone);
CREATE INDEX orders_status_idx ON orders (order_status, fulfillment_status, payment_status);

CREATE TABLE order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  -- Kept for stock restore and reports. Snapshot columns below are what the customer bought.
  variant_id            uuid NOT NULL REFERENCES product_variants (id) ON DELETE RESTRICT,
  product_id            uuid NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  product_name          text NOT NULL,
  variant_name          text NOT NULL,
  sku                   text NOT NULL,
  options               jsonb NOT NULL DEFAULT '{}'::jsonb,
  image_url             text,
  unit_price            bigint NOT NULL CHECK (unit_price > 0),
  extra_beads           integer NOT NULL DEFAULT 0 CHECK (extra_beads >= 0),
  extra_bead_unit_price bigint NOT NULL DEFAULT 0 CHECK (extra_bead_unit_price >= 0),
  quantity              integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  line_total            bigint NOT NULL,
  CONSTRAINT order_items_line_total_matches
    CHECK (line_total = (unit_price + extra_beads * extra_bead_unit_price) * quantity)
);

CREATE INDEX order_items_order_id_idx ON order_items (order_id);
CREATE INDEX order_items_variant_id_idx ON order_items (variant_id);

CREATE TABLE order_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  actor_type  text NOT NULL CHECK (actor_type IN ('admin', 'customer', 'guest', 'system')),
  actor_id    uuid,
  action      text NOT NULL,
  -- Snapshot of the three statuses after the action.
  order_status       text NOT NULL,
  payment_status     text NOT NULL,
  fulfillment_status text NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_events_order_id_idx ON order_events (order_id, id);

-- Idempotency for "place order". The primary key makes two concurrent requests with the same
-- key wait for each other inside the database, so only one order can be created.
CREATE TABLE idempotency_keys (
  scope        text NOT NULL,
  key          text NOT NULL CHECK (length(key) BETWEEN 16 AND 100),
  request_hash text NOT NULL,
  order_id     uuid REFERENCES orders (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Emails are written here in the same transaction as the change that triggers them,
-- then sent by a background loop. A mail server outage can never lose or duplicate an order.
CREATE TABLE email_outbox (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  to_email    text NOT NULL,
  subject     text NOT NULL,
  body_text   text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  send_after  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

CREATE INDEX email_outbox_pending_idx ON email_outbox (send_after) WHERE status = 'pending';
