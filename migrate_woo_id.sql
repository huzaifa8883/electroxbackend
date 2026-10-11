
ALTER TABLE products ADD COLUMN IF NOT EXISTS woo_product_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_woo_product_id
  ON products (woo_product_id) WHERE woo_product_id IS NOT NULL;
-- Backfill from WC-123 style SKUs
UPDATE products
SET woo_product_id = CAST(SUBSTRING(sku FROM 4) AS INTEGER)
WHERE woo_product_id IS NULL
  AND sku ~ '^WC-[0-9]+$';
