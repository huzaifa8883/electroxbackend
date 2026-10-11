/**
 * Pull ALL WooCommerce products into inventory (full fields).
 *
 * Usage:
 *   node src/scripts/syncAllWooProducts.js           # upsert all
 *   node src/scripts/syncAllWooProducts.js --fresh   # delete inventory products (no sales), then import
 */
require("dotenv").config();
const axios = require("axios");
const pool = require("../config/db");

function stripHtml(html = "") {
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function mapWooCategories(wooCategories = []) {
  if (!Array.isArray(wooCategories) || wooCategories.length === 0) return "Uncategorized";
  const normalized = wooCategories.map((c) => ({
    original: (c.name || c.slug || "").trim(),
    lower: (c.name || c.slug || "").trim().toLowerCase(),
    parent: c.parent || 0,
  }));
  const sorted = [...normalized].sort((a, b) => b.parent - a.parent);
  return sorted[0]?.original || "Uncategorized";
}

function getMeta(wooProduct, keys) {
  const list = Array.isArray(wooProduct.meta_data) ? wooProduct.meta_data : [];
  const want = keys.map((k) => String(k).toLowerCase());
  for (const m of list) {
    const key = String(m.key || "").toLowerCase();
    if (want.includes(key)) {
      const v = m.value;
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
  }
  return null;
}

async function resolveBoxId(boxNumber) {
  if (!boxNumber) return null;
  const num = String(boxNumber).trim();
  if (!num) return null;
  const existing = await pool.query(`SELECT id FROM boxes WHERE box_number = $1 LIMIT 1`, [num]);
  if (existing.rows.length) return existing.rows[0].id;
  try {
    const created = await pool.query(
      `INSERT INTO boxes (box_number, description) VALUES ($1,$2)
       ON CONFLICT (box_number) DO UPDATE SET box_number = EXCLUDED.box_number RETURNING id`,
      [num, "From website"]
    );
    return created.rows[0].id;
  } catch {
    return null;
  }
}

async function upsertProduct(wooProduct) {
  const wooId = wooProduct.id ? Number(wooProduct.id) : null;
  const rawSku = wooProduct.sku && String(wooProduct.sku).trim();
  const sku = rawSku || (wooId ? `WC-${wooId}` : null);
  if (!sku) return null;

  const name = (wooProduct.name || "Untitled").trim();
  const category = mapWooCategories(wooProduct.categories || []);
  const stock = Number(wooProduct.stock_quantity) || 0;
  const regularPrice = Number(wooProduct.regular_price) || Number(wooProduct.price) || 0;
  const saleRaw = wooProduct.sale_price;
  const salePrice =
    saleRaw !== undefined && saleRaw !== null && String(saleRaw).trim() !== ""
      ? Number(saleRaw) || 0
      : 0;
  const sellingPrice = salePrice > 0 ? salePrice : regularPrice;

  const description = stripHtml(wooProduct.description || "");
  // Meta description = RankMath/Yoast OR short_description from WordPress
  const shortDesc = stripHtml(wooProduct.short_description || "");
  const metaFromSeo =
    getMeta(wooProduct, ["rank_math_description", "_yoast_wpseo_metadesc", "meta_description"]) || "";
  const metaDescription = String(metaFromSeo || shortDesc || "").trim();

  const focusKeyword = String(
    getMeta(wooProduct, ["rank_math_focus_keyword", "_yoast_wpseo_focuskw", "focus_keyword"]) || ""
  ).trim();

  const tagsArr = Array.isArray(wooProduct.tags)
    ? wooProduct.tags.map((t) => t.name || t).filter(Boolean)
    : [];
  const tags = tagsArr.join(", ");

  const weight = Number(wooProduct.weight) || 0;
  const costRaw = getMeta(wooProduct, ["_cost_price", "cost_price"]);
  const costPrice = costRaw !== null ? Number(costRaw) || 0 : 0;
  const boxNumber = getMeta(wooProduct, ["_inventory_box", "inventory_box"]);
  const boxId = await resolveBoxId(boxNumber);

  let images = [];
  if (Array.isArray(wooProduct.images)) {
    images = wooProduct.images.map((img) => img.src || img.url).filter(Boolean);
  }
  const imageUrl = images[0] || null;

  const { rows } = await pool.query(
    `INSERT INTO products (
       sku, name, category, stock, selling_price, regular_price, cost_price, box_id,
       image_url, images, description, min_stock,
       tags, meta_description, focus_keyword, weight
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,5,$12,$13,$14,$15)
     ON CONFLICT (sku) DO UPDATE SET
       name = EXCLUDED.name,
       category = EXCLUDED.category,
       stock = EXCLUDED.stock,
       selling_price = EXCLUDED.selling_price,
       regular_price = EXCLUDED.regular_price,
       cost_price = CASE WHEN EXCLUDED.cost_price > 0 THEN EXCLUDED.cost_price ELSE products.cost_price END,
       box_id = COALESCE(EXCLUDED.box_id, products.box_id),
       image_url = COALESCE(EXCLUDED.image_url, products.image_url),
       images = CASE WHEN array_length(EXCLUDED.images, 1) > 0 THEN EXCLUDED.images ELSE products.images END,
       description = EXCLUDED.description,
       tags = EXCLUDED.tags,
       meta_description = EXCLUDED.meta_description,
       focus_keyword = EXCLUDED.focus_keyword,
       weight = EXCLUDED.weight
     RETURNING id, sku, name`,
    [
      sku, name, category, stock, sellingPrice, regularPrice, costPrice, boxId,
      imageUrl, images, description,
      tags || null, metaDescription || null, focusKeyword || null, weight,
    ]
  );
  return rows[0];
}

async function fetchAllProducts() {
  const base = (process.env.WC_STORE_URL || "").replace(/\/$/, "");
  const key = process.env.WC_CONSUMER_KEY;
  const secret = process.env.WC_CONSUMER_SECRET;
  if (!base || !key || !secret) {
    throw new Error("Set WC_STORE_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET in .env");
  }

  const all = [];
  let page = 1;
  const perPage = 50;
  while (true) {
    console.log(`Fetching page ${page}...`);
    const { data } = await axios.get(`${base}/wp-json/wc/v3/products`, {
      params: { page, per_page: perPage, status: "any" },
      auth: { username: key, password: secret },
      timeout: 60000,
    });
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < perPage) break;
    page += 1;
  }
  return all;
}

async function clearInventoryProducts() {
  // Remove products that are not in any sale_items
  const { rowCount } = await pool.query(`
    DELETE FROM products p
    WHERE NOT EXISTS (SELECT 1 FROM sale_items si WHERE si.product_id = p.id)
  `);
  console.log(`Cleared ${rowCount} products without sales history`);
  // Also clear stock_ledger orphans is cascade
  return rowCount;
}

async function main() {
  const fresh = process.argv.includes("--fresh");
  console.log("=== WooCommerce → Inventory full sync ===");
  if (fresh) {
    console.log("--fresh: clearing inventory products (keeping those with sales)...");
    await clearInventoryProducts();
  }

  const products = await fetchAllProducts();
  console.log(`Total products fetched: ${products.length}`);

  let ok = 0;
  let fail = 0;
  for (const p of products) {
    try {
      const row = await upsertProduct(p);
      if (row) {
        console.log(`✅ ${row.sku} → ${row.name}`);
        ok++;
      }
    } catch (err) {
      console.error(`❌ id=${p.id} sku=${p.sku}:`, err.message);
      fail++;
    }
  }
  console.log(`\nDone. Success: ${ok}, Failed: ${fail}`);
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
