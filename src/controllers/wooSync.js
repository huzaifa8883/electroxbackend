
/**
 * Push inventory product → WooCommerce (Electrox + optional VoltBank).
 */
const axios = require("axios");
const pool = require("../config/db");

const VOLTBANK_CAT_KEYWORDS = [
  "solar",
  "batter",
  "charger",
  "power supply",
  "power-supply",
  "power supplies",
  "cable",
];

function isVoltBankCategory(category) {
  if (!category) return false;
  const n = String(category).toLowerCase();
  return VOLTBANK_CAT_KEYWORDS.some((k) => n.includes(k));
}

function makeWcClient(base, key, secret) {
  base = (base || "").replace(/\/$/, "");
  if (!base || !key || !secret) return null;
  return axios.create({
    baseURL: `${base}/wp-json/wc/v3`,
    auth: { username: key, password: secret },
    timeout: 30000,
  });
}

/** Primary store (Electrox) */
function wcClient() {
  return makeWcClient(
    process.env.WC_STORE_URL,
    process.env.WC_CONSUMER_KEY,
    process.env.WC_CONSUMER_SECRET
  );
}

/** Secondary store (VoltBank) */
function vbClient() {
  return makeWcClient(
    process.env.VB_STORE_URL || process.env.VOLTBANK_STORE_URL,
    process.env.VB_CONSUMER_KEY || process.env.VOLTBANK_CONSUMER_KEY,
    process.env.VB_CONSUMER_SECRET || process.env.VOLTBANK_CONSUMER_SECRET
  );
}

async function findCategoryId(client, categoryName) {
  if (!categoryName) return null;
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
    .split(/[,|]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const out = [];
  for (const name of names) {
    try {
      const { data } = await client.get("/products/tags", {
        params: { search: name, per_page: 50 },
      });
      let tag = (data || []).find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (!tag) {
        const { data: created } = await client.post("/products/tags", { name });
        tag = created;
      }
      if (tag && tag.id) out.push({ id: tag.id });
    } catch (err) {
      console.error("[WooSync] tag resolve failed:", name, err.response?.data || err.message);
    }
  }
  console.log("[WooSync] resolved tags:", names, "→", out);
  return out;
}

async function getBoxNumber(boxId) {
  if (!boxId) return "";
  try {
    const { rows } = await pool.query(`SELECT box_number FROM boxes WHERE id = $1`, [boxId]);
    return rows[0]?.box_number || "";
  } catch {
    return "";
  }
}

async function buildPayload(client, product) {
  const publicBase = (process.env.PUBLIC_API_URL || process.env.WEBSITE_URL || "").replace(
    /\/$/,
    ""
  );
  const boxNumber = await getBoxNumber(product.box_id);

  const rawImages = Array.isArray(product.images)
    ? product.images
    : product.image_url
    ? [product.image_url]
    : [];
  const all = rawImages.map((x) => (typeof x === "string" ? x : x?.src || x?.url)).filter(Boolean);

  function toAbsoluteImageUrl(src) {
    let url = String(src || "").trim();
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith("//")) return "https:" + url;
    if (!url.startsWith("/")) url = "/" + url;
    return publicBase ? publicBase + url : null;
  }

  const images = [];
  for (const src of all.slice(0, 7)) {
    const url = toAbsoluteImageUrl(src);
    if (url) images.push({ src: url });
  }

  const categoryId = await findCategoryId(client, product.category);
  const tags = await resolveTags(client, product.tags);

  const focus = (product.focus_keyword || "").trim();
  const metaDesc = (product.meta_description || "").trim();
  const shortDesc = (product.short_description || product.meta_description || "").trim();

  const meta_data = [
    { key: "_cost_price", value: String(product.cost_price ?? "0") },
    { key: "cost_price", value: String(product.cost_price ?? "0") },
    { key: "_inventory_box", value: boxNumber || "" },
    { key: "inventory_box", value: boxNumber || "" },
    { key: "rank_math_description", value: metaDesc },
    { key: "rank_math_focus_keyword", value: focus },
    { key: "rank_math_focus_keyword_base", value: focus },
    { key: "_yoast_wpseo_metadesc", value: metaDesc },
    { key: "_yoast_wpseo_focuskw", value: focus },
    { key: "_yoast_wpseo_focuskw_text_input", value: focus },
  ];

  const regular = Number(product.regular_price) || Number(product.selling_price) || 0;
  const sale = Number(product.selling_price) || 0;
  const onSale = sale > 0 && regular > 0 && sale < regular;

  const payload = {
    name: product.name,
    sku: product.sku,
    type: "simple",
    regular_price: String(regular),
    sale_price: onSale ? String(sale) : "",
    description: product.description || "",
    short_description: shortDesc,
    manage_stock: true,
    stock_quantity: Number(product.stock) || 0,
    weight: product.weight != null && product.weight !== "" ? String(product.weight) : "",
    status: "publish",
    meta_data,
  };

  if (images.length) payload.images = images;
  if (categoryId) payload.categories = [{ id: categoryId }];
  if (tags.length) payload.tags = tags;

  console.log(
    "[WooSync] payload tags:",
    payload.tags,
    "short_description length:",
    shortDesc.length
  );

  return payload;
}

/**
 * Sync one product to one Woo client.
 */
async function syncToClient(client, product, label, opts = {}) {
  const { saveWooId = false, allowCreate = true, existingId = null } = opts;
  const payload = await buildPayload(client, product);

  let result = null;
  let id = existingId ? Number(existingId) : null;

  if (id) {
    try {
      const { data } = await client.put(`/products/${id}`, payload);
      result = data;
      console.log(`[WooSync:${label}] 🔄 Updated by id=${id} sku=${product.sku}`);
    } catch (e) {
      if (e.response?.status === 404) {
        id = null;
      } else {
        throw e;
      }
    }
  }

  if (!result && product.sku) {
    const { data: found } = await client.get("/products", {
      params: { sku: product.sku, per_page: 5 },
    });
    const match = Array.isArray(found)
      ? found.find((p) => String(p.sku || "").trim() === String(product.sku).trim())
      : null;
    if (match) {
      const { data } = await client.put(`/products/${match.id}`, payload);
      result = data;
      console.log(`[WooSync:${label}] 🔄 Updated by SKU id=${match.id} sku=${product.sku}`);
    }
  }

  if (!result) {
    if (!allowCreate) {
      console.warn(`[WooSync:${label}] No product for sku=${product.sku} — skip create`);
      return null;
    }
    const { data } = await client.post("/products", payload);
    result = data;
    console.log(`[WooSync:${label}] ✅ Created id=${data.id} sku=${product.sku}`);
  }

  if (saveWooId && result?.id && product.id) {
    try {
      await pool.query(`UPDATE products SET woo_product_id = $1 WHERE id = $2`, [
        result.id,
        product.id,
      ]);
    } catch (e) {
      console.warn(`[WooSync:${label}] could not save woo_product_id:`, e.message);
    }
  }

  return result;
}

/**
 * Main: Electrox always; VoltBank when category is energy-related.
 */
async function syncProductToWoo(product) {
  const allowCreate = product._allowCreate !== false;
  let primaryResult = null;

  // 1) Electrox (primary) — same as before
  const primary = wcClient();
  if (primary) {
    try {
      primaryResult = await syncToClient(primary, product, "Electrox", {
        saveWooId: true,
        allowCreate,
        existingId: product.woo_product_id || null,
      });
    } catch (err) {
      const detail = err.response?.data || err.message;
      console.error("[WooSync:Electrox] ❌ Failed for sku=", product.sku, detail);
      // continue to VoltBank even if Electrox fails
    }
  } else {
    console.warn("[WooSync] Electrox WC credentials missing – skip primary");
  }

  // 2) VoltBank (secondary) — only Solar / Batteries / Chargers / Power Supply / Cables
  const vb = vbClient();
  if (vb && isVoltBankCategory(product.category)) {
    try {
      await syncToClient(vb, product, "VoltBank", {
        saveWooId: false,
        allowCreate: true,
        existingId: null,
      });
    } catch (err) {
      const detail = err.response?.data || err.message;
      console.error("[WooSync:VoltBank] ❌ Failed for sku=", product.sku, detail);
    }
  } else if (vb && product.category) {
    console.log(
      `[WooSync:VoltBank] skip sku=${product.sku} category="${product.category}" (not energy)`
    );
  }

  if (!primary && !vb) {
    console.warn("[WooSync] WC credentials missing – skip");
    return null;
  }

  // If Electrox failed hard and we had no result, surface error like old code when only primary exists
  if (primary && !primaryResult && !vb) {
    throw new Error("Electrox sync failed");
  }

  return primaryResult;
}

module.exports = { syncProductToWoo, wcClient, vbClient, isVoltBankCategory };
