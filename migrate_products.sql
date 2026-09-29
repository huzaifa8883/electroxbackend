-- Run this once against an existing electrox_pro database:
--   psql -d electrox_pro -f migrate_products.sql

ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS characteristics TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT '{}';

-- Backfill images array from existing image_url where missing
UPDATE products
SET images = ARRAY[image_url]
WHERE image_url IS NOT NULL
  AND image_url <> ''
  AND (images IS NULL OR images = '{}');
