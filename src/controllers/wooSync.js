/**
 * Push inventory product → WooCommerce (create or update by SKU).
 * Requires in .env:
 *   WC_STORE_URL=https://electrox.pk
 *   WC_CONSUMER_KEY=ck_...
 *   WC_CONSUMER_SECRET=cs_...
 */
const axios = require("axios");
const pool = require("../config/db");

function wcClient() {
  const base = (process.env.WC_STORE_URL || "").replace(/\/$/, "");
  const key = process.env.WC_CONSUMER_KEY;
  const secret = process.env.WC_CONSUMER_SECRET;
  if (!base || !key || !secret) {
    return null;
  }
  return axios.create({
    baseURL: `${base}/wp-json/wc/v3`,
    auth: { username: key, password: secret },
    timeout: 30000,
  });
}

async function findCategoryId(client, categoryName) {
  if (!categoryName) return null;
  // Support "Parent > Child"
  const parts = String(categoryName)
    .split(">")
    .map((s) => s.trim())
    .filter(Boolean);
  let parentId = 0;
  let lastId = null;

  for (const part of parts) {
    try {
      const { data } = await client.get("/products/categories", {
        params: { search: part, per_page: 50 },
      });
      let match = (data || []).find(
        (c) =>
          c.name.toLowerCase() === part.toLowerCase() &&
          (parentId === 0 || c.parent === parentId)
      );
      if (!match) {
        match = (data || []).find((c) => c.name.toLowerCase() === part.toLowerCase());
      }
      if (!match) {
        const { data: created } = await client.post("/products/categories", {
          name: part,
          parent: parentId || 0,
        });
        match = created;
      }
      if (match) {
        lastId = match.id;
        parentId = match.id;
      }
    } catch (err) {
      console.error("[WooSync] category resolve failed:", part, err.message);
    }
  }
  return lastId;
}

async function resolveTags(client, tagsStr) {
  if (!tagsStr || !String(tagsStr).trim()) return [];
  const names = String(tagsStr)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const out = [];
  for (const name of names) {
    try {
      const { data } = await client.get("/products/tags", {
        params: { search: name, per_page: 20 },
      });
      let tag = (data || []).find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (!tag) {
        const { data: created } = await client.post("/products/tags", { name });
        tag = created;
      }
      if (tag) out.push({ id: tag.id });
    } catch (err) {
      console.error("[WooSync] tag failed:", name, err.message);
    }
  }
  return out;
}

async function getBoxNumber(boxId) {
  if (!boxId) return "";
  try {
    const { rows } = await pool.query(
      `SELECT box_number FROM boxes WHERE id = $1`,
      [boxId]
    );
    return rows[0]?.box_number || "";
  } catch {
    return "";
  }
}

/**
 * @param {object} product - full product row from inventory
 * @returns {object|null} woo product
 */
async function syncProductToWoo(product) {
  const client = wcClient();
  if (!client) {
    console.warn(
      "[WooSync] WC_STORE_URL / WC_CONSUMER_KEY / WC_CONSUMER_SECRET missing — skip website sync"
    );
    return null;
  }
  if (product.sync_to_website === false) {
    console.log("[WooSync] sync_to_website=false — skip", product.sku);
    return null;
  }

  const boxNumber = await getBoxNumber(product.box_id);

  const images = [];
  const imgs = Array.isArray(product.images) ? product.images : [];
  const cover = product.image_url;
  const all = cover ? [cover, ...imgs.filter((u) => u !== cover)] : imgs;

  // Base URL for inventory-hosted uploads (must be publicly reachable by WordPress)
  const publicBase = (
    process.env.PUBLIC_API_URL ||
    process.env.INVENTORY_PUBLIC_URL ||
    "https://electroxbackend.work.gd"
  ).replace(/\/$/, "");

  function toAbsoluteImageUrl(src) {
    if (!src) return null;
    let url = String(src).trim();
    if (!url) return null;
    // Already absolute
    if (/^https?:\/\//i.test(url)) return url;
    // Protocol-relative
    if (url.startsWith("//")) return "https:" + url;
    // Relative path e.g. /uploads/products/xxx.webp
    if (!url.startsWith("/")) url = "/" + url;
    return publicBase + url;
  }

  for (const src of all.filter(Boolean).slice(0, 7)) {
    const url = toAbsoluteImageUrl(src);
    if (url) images.push({ src: url });
  }
  console.log("[WooSync] images for", product.sku, images.map((i) => i.src));

  const categoryId = await findCategoryId(client, product.category);
  const tags = await resolveTags(client, product.tags);

  const meta_data = [
    { key: "_cost_price", value: String(product.cost_price ?? "0") },
    { key: "cost_price", value: String(product.cost_price ?? "0") },
    { key: "_inventory_box", value: boxNumber || "" },
    { key: "inventory_box", value: boxNumber || "" },
    // Rank Math
    { key: "rank_math_description", value: product.meta_description || "" },
    { key: "rank_math_focus_keyword", value: product.focus_keyword || "" },
    // Yoast
    { key: "_yoast_wpseo_metadesc", value: product.meta_description || "" },
    { key: "_yoast_wpseo_focuskw", value: product.focus_keyword || "" },
  ];

  const regular = Number(product.regular_price) || Number(product.selling_price) || 0;
  const sale = Number(product.selling_price) || 0;
  // If sale < regular and sale > 0, send both; else only regular
  const onSale = sale > 0 && regular > 0 && sale < regular;

  const payload = {
    name: product.name,
    sku: product.sku,
    type: "simple",
    regular_price: String(regular),
    sale_price: onSale ? String(sale) : "",
    description: product.description || "",
    short_description: "",
    manage_stock: true,
    stock_quantity: Number(product.stock) || 0,
    weight: product.weight != null ? String(product.weight) : "",
    status: "publish",
    meta_data,
  };

  if (images.length) payload.images = images;
  if (categoryId) payload.categories = [{ id: categoryId }];
  if (tags.length) payload.tags = tags;

  try {
    // Find existing by SKU
    const { data: found } = await client.get("/products", {
      params: { sku: product.sku, per_page: 1 },
    });

    let result;
    if (Array.isArray(found) && found.length > 0) {
      const { data } = await client.put(`/products/${found[0].id}`, payload);
      result = data;
      console.log(`[WooSync] 🔄 Updated website product id=${data.id} sku=${product.sku}`);
    } else {
      const { data } = await client.post("/products", payload);
      result = data;
      console.log(`[WooSync] ✅ Created website product id=${data.id} sku=${product.sku}`);
    }
    return result;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("[WooSync] ❌ Failed for sku=", product.sku, detail);
    throw new Error(
      typeof detail === "object" ? JSON.stringify(detail) : String(detail)
    );
  }
}

module.exports = { syncProductToWoo, wcClient };
