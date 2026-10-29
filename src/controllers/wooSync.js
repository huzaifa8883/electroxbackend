
/**
 * Push inventory product → WooCommerce (Electrox + optional VoltBank).
 * On image upload errors: retry product create/update WITHOUT images.
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

const ALLOWED_IMAGE_EXT = /\.(jpe?g|png|gif|webp)(\?.*)?$/i;

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
    timeout: 45000,
  });
}

function wcClient() {
  return makeWcClient(
    process.env.WC_STORE_URL,
    process.env.WC_CONSUMER_KEY,
    process.env.WC_CONSUMER_SECRET
  );
}

function vbClient() {
  return makeWcClient(
    process.env.VB_STORE_URL || process.env.VOLTBANK_STORE_URL,
    process.env.VB_CONSUMER_KEY || process.env.VOLTBANK_CONSUMER_KEY,
    process.env.VB_CONSUMER_SECRET || process.env.VOLTBANK_CONSUMER_SECRET
  );
}

function normalizeCategoryName(categoryName) {
  if (!categoryName) return categoryName;
  let s = String(categoryName).trim();
  s = s.replace(/^Power Supplies$/i, "Power Supply");
  s = s.replace(/^Power Supplies\s*>/i, "Power Supply >");
  return s;
}

async function findCategoryId(client, categoryName) {
  if (!categoryName) return null;
  categoryName = normalizeCategoryName(categoryName);
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

function isAllowedImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return false;
  // strip query for ext check, but allow CDN urls with query
  const path = u.split("?")[0];
  if (ALLOWED_IMAGE_EXT.test(path)) return true;
  // some stores serve /uploads/... without clear ext in rare cases — still try common image hosts
  if (/\/uploads\/.*\.(jpe?g|png|gif|webp)/i.test(u)) return true;
  return false;
}

async function buildPayload(client, product, { includeImages = true } = {}) {
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
  if (includeImages) {
    for (const src of all.slice(0, 7)) {
      const url = toAbsoluteImageUrl(src);
      if (url && isAllowedImageUrl(url)) {
        images.push({ src: url });
      } else if (url) {
        console.warn(`[WooSync] skip invalid image type: ${url}`);
      }
    }
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

  return payload;
}

function isImageUploadError(err) {
  const data = err.response?.data;
  const code = data?.code || data?.data?.code || "";
  const msg = String(data?.message || err.message || "").toLowerCase();
  return (
    code === "woocommerce_product_image_upload_error" ||
    msg.includes("invalid image") ||
    msg.includes("not allowed to upload") ||
    msg.includes("file type")
  );
}

async function putOrCreate(client, product, payload, label, existingId) {
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
    const { data } = await client.post("/products", payload);
    result = data;
    console.log(`[WooSync:${label}] ✅ Created id=${data.id} sku=${product.sku}`);
  }

  return result;
}

/**
 * Sync one product to one Woo client.
 * If images fail → retry once without images so product still lands.
 */
async function syncToClient(client, product, label, opts = {}) {
  const { saveWooId = false, allowCreate = true, existingId = null } = opts;

  let payload = await buildPayload(client, product, { includeImages: true });
  if (!allowCreate && !existingId && !product.sku) {
    return null;
  }

  try {
    // If create not allowed and no existing, only update path
    if (!allowCreate) {
      // putOrCreate will still create — gate here
      let probeId = existingId ? Number(existingId) : null;
      if (!probeId && product.sku) {
        const { data: found } = await client.get("/products", {
          params: { sku: product.sku, per_page: 5 },
        });
        const match = Array.isArray(found)
          ? found.find((p) => String(p.sku || "").trim() === String(product.sku).trim())
          : null;
        if (match) probeId = match.id;
      }
      if (!probeId) {
        console.warn(`[WooSync:${label}] No product for sku=${product.sku} — skip create`);
        return null;
      }
    }

    let result;
    try {
      result = await putOrCreate(client, product, payload, label, existingId);
    } catch (err) {
      if (isImageUploadError(err) && payload.images && payload.images.length) {
        console.warn(
          `[WooSync:${label}] image failed for ${product.sku} — retry WITHOUT images`
        );
        payload = await buildPayload(client, product, { includeImages: false });
        result = await putOrCreate(client, product, payload, label, existingId);
        console.log(`[WooSync:${label}] ✅ Saved without images sku=${product.sku}`);
      } else {
        throw err;
      }
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
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error(`[WooSync:${label}] ❌ Failed for sku=`, product.sku, detail);
    throw new Error(typeof detail === "object" ? JSON.stringify(detail) : String(detail));
  }
}

async function syncProductToWoo(product) {
  const allowCreate = product._allowCreate !== false;
  let primaryResult = null;

  const primary = wcClient();
  if (primary) {
    try {
      primaryResult = await syncToClient(primary, product, "Electrox", {
        saveWooId: true,
        allowCreate,
        existingId: product.woo_product_id || null,
      });
    } catch (err) {
      console.error("[WooSync:Electrox] ❌", product.sku, err.message);
    }
  } else {
    console.warn("[WooSync] Electrox WC credentials missing – skip primary");
  }

  const vb = vbClient();
  if (vb && isVoltBankCategory(product.category)) {
    try {
      await syncToClient(vb, product, "VoltBank", {
        saveWooId: false,
        allowCreate: true,
        existingId: null,
      });
    } catch (err) {
      console.error("[WooSync:VoltBank] ❌", product.sku, err.message);
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

  return primaryResult;
}

module.exports = { syncProductToWoo, wcClient, vbClient, isVoltBankCategory };
