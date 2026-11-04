-- 0002_catalog: categories, collections, filter tags, products, variants (SKU) and inventory history.
-- Money is stored as bigint VND (no decimals).

-- Category = product type tree (Vòng tay, Vòng cổ, Nhang cây, Nhang nụ, Phụ kiện…). One category per product.
CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid REFERENCES categories (id) ON DELETE RESTRICT,
  name        text NOT NULL CHECK (btrim(name) <> ''),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text,
  sort_order  integer NOT NULL DEFAULT 0,
  is_visible  boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

-- Collection = curated list (Quà tặng, Dành cho trẻ em…). A product can be in many collections.
CREATE TABLE collections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text,
  image_url   text,
  sort_order  integer NOT NULL DEFAULT 0,
  is_visible  boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Filter tags: "audience" (người lớn, trẻ em…) and "need" (đeo hằng ngày, không gian, quà tặng…).
CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text NOT NULL CHECK (type IN ('audience', 'need')),
  name       text NOT NULL CHECK (btrim(name) <> ''),
  slug       text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, slug)
);

CREATE TABLE products (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id       uuid NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  name              text NOT NULL CHECK (btrim(name) <> ''),
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  short_description text,
  description       text,
  material          text,
  -- [{ "label": "Đường kính hạt", "value": "8 mm" }, …]
  specs             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(specs) = 'array'),
  usage_guide       text,
  -- draft: admin is still editing; active: on sale; hidden: removed from the shop but kept for old orders.
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'hidden')),
  seo_title         text,
  seo_description   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX products_category_id_idx ON products (category_id);
CREATE INDEX products_status_idx ON products (status);

CREATE TABLE product_images (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  url        text NOT NULL,
  alt        text,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE INDEX product_images_product_id_idx ON product_images (product_id, sort_order);

CREATE TABLE product_collections (
  product_id    uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  sort_order    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, collection_id)
);

CREATE TABLE product_tags (
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, tag_id)
);

-- A variant is one sellable SKU with its own price and stock.
-- Bracelets: one variant per bead diameter; "extra beads" are an option priced per bead (D2).
CREATE TABLE product_variants (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id                uuid NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  sku                       text NOT NULL CHECK (sku ~ '^[A-Z0-9][A-Z0-9-]{1,63}$'),
  name                      text NOT NULL CHECK (btrim(name) <> ''),
  -- e.g. {"bead_size_mm": 8} or {"pack": "Hộp 50 nụ"}; must be unique within a product.
  options                   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  retail_price              bigint NOT NULL CHECK (retail_price > 0),
  business_price            bigint CHECK (business_price > 0),
  stock                     integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  max_extra_beads           integer NOT NULL DEFAULT 0 CHECK (max_extra_beads BETWEEN 0 AND 100),
  extra_bead_price          bigint CHECK (extra_bead_price > 0),
  business_extra_bead_price bigint CHECK (business_extra_bead_price > 0),
  status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  sort_order                integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_variants_extra_bead_price_required
    CHECK (max_extra_beads = 0 OR extra_bead_price IS NOT NULL)
);

CREATE UNIQUE INDEX product_variants_sku_key ON product_variants (sku);
CREATE UNIQUE INDEX product_variants_product_options_key ON product_variants (product_id, options);
CREATE INDEX product_variants_product_id_idx ON product_variants (product_id);

-- Every stock change is recorded here, with the stock level right after the change.
CREATE TABLE inventory_movements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id     uuid NOT NULL REFERENCES product_variants (id) ON DELETE RESTRICT,
  change         integer NOT NULL CHECK (change <> 0),
  stock_after    integer NOT NULL CHECK (stock_after >= 0),
  reason         text NOT NULL CHECK (reason IN ('initial', 'admin_adjustment', 'order_placed', 'order_cancelled', 'order_returned')),
  order_id       uuid,
  admin_user_id  uuid REFERENCES admin_users (id),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inventory_movements_variant_idx ON inventory_movements (variant_id, created_at DESC);
