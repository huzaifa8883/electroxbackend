
-- Run once as DB owner / superuser:
--   psql -U postgres -d electrox_pro -f migrate_website_fields.sql

ALTER TABLE products ADD COLUMN IF NOT EXISTS short_description TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS meta_description TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS tags TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS focus_keyword VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight NUMERIC(10,3) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sync_to_website BOOLEAN NOT NULL DEFAULT TRUE;
