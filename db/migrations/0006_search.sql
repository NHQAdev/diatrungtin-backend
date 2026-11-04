-- 0006_search: accent-insensitive search ("vong tay" finds "Vòng tay").
-- Uses only built-in functions (no extension needed): normalize to NFC, map every Vietnamese
-- letter to its plain form with translate(), then lower-case.

CREATE FUNCTION vn_unaccent(input text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
RETURN lower(translate(normalize(input, NFC),
  'àÀáÁảẢãÃạẠăĂằẰắẮẳẲẵẴặẶâÂầẦấẤẩẨẫẪậẬèÈéÉẻẺẽẼẹẸêÊềỀếẾểỂễỄệỆìÌíÍỉỈĩĨịỊòÒóÓỏỎõÕọỌôÔồỒốỐổỔỗỖộỘơƠờỜớỚởỞỡỠợỢùÙúÚủỦũŨụỤưƯừỪứỨửỬữỮựỰỳỲýÝỷỶỹỸỵỴđĐ',
  'aAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAeEeEeEeEeEeEeEeEeEeEeEiIiIiIiIiIoOoOoOoOoOoOoOoOoOoOoOoOoOoOoOoOoOuUuUuUuUuUuUuUuUuUuUuUyYyYyYyYyYdD'));

-- Kept up to date by PostgreSQL itself whenever name or short description changes.
ALTER TABLE products
  ADD COLUMN search_text text GENERATED ALWAYS AS (
    vn_unaccent(name || ' ' || coalesce(short_description, ''))
  ) STORED;
