-- 0005_store: store information, shipping fee settings and content pages (policies…).

-- Single-row table. Unknown business info stays NULL and is shown as "[Cập nhật]" by the frontend.
CREATE TABLE store_settings (
  id                      integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  store_name              text NOT NULL DEFAULT 'Trầm Hương Địa Trung Tín',
  hotline                 text,
  email                   text,
  address                 text,
  business_info           text,
  facebook_url            text,
  zalo_url                text,
  -- NULL = not configured yet: checkout is refused until the admin sets a fee (can be 0).
  shipping_fee            bigint CHECK (shipping_fee >= 0),
  free_shipping_threshold bigint CHECK (free_shipping_threshold > 0),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

INSERT INTO store_settings (id) VALUES (1);

CREATE TABLE pages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title        text NOT NULL CHECK (btrim(title) <> ''),
  content      text NOT NULL DEFAULT '',
  is_published boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
