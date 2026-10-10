/**
 * Pull ALL published WooCommerce products into inventory.
 * Usage: node src/scripts/syncAllWooProducts.js
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
  if (!Array.isArray(wooCategories) || wooCategories.length === 0) {
    return "Uncategorized";
  }

  const normalized = wooCategories.map((c) => ({
    original: (c.name || c.slug || "").trim(),
    lower: (c.name || c.slug || "").trim().toLowerCase(),
    parent: c.parent || 0,
  }));
  const sorted = [...normalized].sort((a, b) => b.parent - a.parent);

  const cableSubMap = {
    "ac cables": "AC Cables",
    "ac cable": "AC Cables",
    "dc cables": "DC Cables",
    "dc cable": "DC Cables",
    "power cables": "Power Cables",
    "power cable": "Power Cables",
    "mobile cables": "Mobile Cables",
    "mobile cable": "Mobile Cables",
    "display cables": "Display Cables",
    "display cable": "Display Cables",
    connectors: "Connectors",
    connector: "Connectors",
    others: "Others",
    other: "Others",
  };
  for (const item of sorted) {
    for (const [key, label] of Object.entries(cableSubMap)) {
      if (item.lower === key || item.lower.includes(key)) {
        return `Cables > ${label}`;
      }
    }
  }
  if (sorted.some((i) => i.lower.includes("cable"))) return "Cables > Others";

  const chargerSubMap = {
    "battery chargers": "Battery Chargers",
    "battery charger": "Battery Chargers",
    "laptop chargers": "Laptop Chargers",
    "laptop charger": "Laptop Chargers",
    "mobile chargers": "Mobile Chargers",
    "mobile charger": "Mobile Chargers",
    "wireless chargers": "Wireless Chargers",
    "wireless charger": "Wireless Chargers",
  };
  for (const item of sorted) {
    for (const [key, label] of Object.entries(chargerSubMap)) {
      if (item.lower === key || item.lower.includes(key)) {
        return `Chargers > ${label}`;
      }
    }
  }
  if (sorted.some((i) => i.lower.includes("charger") || i.lower.includes("charging"))) {
    return "Chargers > Battery Chargers";
  }

  if (
    sorted.some(
      (i) =>
        i.lower.includes("computer") ||
        i.lower.includes("networking") ||
        i.lower.includes("network") ||
        i.lower.includes("router") ||
        i.lower.includes("switch") ||
        i.lower.includes("lan") ||
        i.lower.includes("wifi") ||
        i.lower.includes("ethernet") ||
        i.lower.includes("nic")
    )
  ) {
    const specific = sorted.find((i) => {
      const n = i.lower;
      return (
        n.includes("router") ||
        n.includes("switch") ||
        n.includes("adapter") ||
        n.includes("card") ||
        n.includes("hub") ||
        n.includes("modem")
      );
    });
    if (specific) return `Computer and Networking > ${specific.original}`;
    return "Computer and Networking";
  }

  return sorted[0]?.original || "Uncategorized";
}

function getMetaValue(wooProduct, keys) {
  const list = Array.isArray(wooProduct.meta_data) ? wooProduct.meta_data : [];
  const want = keys.map((k) => String(k).toLowerCase());
  for (const m of list) {
    const key = String(m.key || m.meta_key || "").toLowerCase();
    if (want.includes(key)) {
      const v = m.value !== undefined ? m.value : m.meta_value;
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
  }
  return null;
}

async function resolveBoxId(boxNumber) {
  if (!boxNumber) return null;
  const num = String(boxNumber).trim();
  if (!num) return null;
  const existing = await pool.query(
    `SELECT id FROM boxes WHERE box_number = $1 LIMIT 1`,
    [num]
  );
  if (existing.rows.length) return existing.rows[0].id;
  try {
    const created = await pool.query(
      `INSERT INTO boxes (box_number, description)
       VALUES ($1, $2)
       ON CONFLICT (box_number) DO UPDATE SET box_number = EXCLUDED.box_number
       RETURNING id`,
      [num, "Created from website product"]
    );
    return created.rows[0].id;
  } catch {
    return null;
  }
}

async function upsertProduct(wooProduct) {
  const sku =
    (wooProduct.sku && String(wooProduct.sku).trim()) ||
    `WC-${wooProduct.id}`;

  const name = (wooProduct.name || "Untitled Product").trim();
  const category = mapWooCategories(wooProduct.categories || []);
  const stock = Number(wooProduct.stock_quantity) || 0;
  const sellingPrice =
    Number(wooProduct.sale_price) ||
    Number(wooProduct.regular_price) ||
    Number(wooProduct.price) ||
    0;
  const description = stripHtml(
    wooProduct.description || wooProduct.short_description || ""
  );

  const costRaw = getMetaValue(wooProduct, ["_cost_price", "cost_price"]);
  const costPrice =
    costRaw !== null && costRaw !== undefined && String(costRaw).trim() !== ""
      ? Number(costRaw) || 0
      : null;

  const boxNumber = getMetaValue(wooProduct, [
    "_inventory_box",
    "inventory_box",
    "_box",
    "box",
  ]);
  const boxId = await resolveBoxId(boxNumber);

  let images = [];
  if (Array.isArray(wooProduct.images) && wooProduct.images.length > 0) {
    images = wooProduct.images.map((img) => img.src || img.url).filter(Boolean);
  }
  const imageUrl = images[0] || null;

  const { rows } = await pool.query(
    `INSERT INTO products (
       sku, name, category, stock, selling_price, cost_price, box_id,
       image_url, images, description, min_stock
     )
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0), $7, $8, $9, $10, 5)
     ON CONFLICT (sku) DO UPDATE SET
       name          = EXCLUDED.name,
       category      = EXCLUDED.category,
       stock         = EXCLUDED.stock,
       selling_price = EXCLUDED.selling_price,
       cost_price    = COALESCE($6, products.cost_price),
       box_id        = COALESCE($7, products.box_id),
       image_url     = COALESCE(EXCLUDED.image_url, products.image_url),
       images        = CASE
                         WHEN EXCLUDED.images IS NOT NULL AND array_length(EXCLUDED.images, 1) > 0
                         THEN EXCLUDED.images
                         ELSE products.images
                       END,
       description   = EXCLUDED.description
     RETURNING id, sku, name, category, cost_price, box_id`,
    [sku, name, category, stock, sellingPrice, costPrice, boxId, imageUrl, images, description]
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
      params: { page, per_page: perPage, status: "publish" },
      auth: { username: key, password: secret },
      timeout: 30000,
    });

    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < perPage) break;
    page += 1;
  }

  return all;
}

async function main() {
  console.log("=== WooCommerce → Inventory bulk sync ===");
  const products = await fetchAllProducts();
  console.log(`Total products fetched: ${products.length}`);

  let ok = 0;
  let fail = 0;

  for (const p of products) {
    try {
      const row = await upsertProduct(p);
      console.log(`✅ ${row.sku} → ${row.name} [${row.category}]`);
      ok++;
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
