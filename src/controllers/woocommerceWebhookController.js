const crypto = require("crypto");
const pool = require("../config/db");
const { postToFacebook, postToInstagram } = require("./socialPost");

function verifyWooSignature(req) {
  const secret = process.env.WOOCOMMERCE_WEBHOOK_SECRET;
  if (!secret) return true;
  const signature = req.headers["x-wc-webhook-signature"];
  if (!signature) return false;
  const payload = JSON.stringify(req.body);
  const hash = crypto
    .createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hash));
  } catch {
    return false;
  }
}

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
    "ac cables": "AC Cables", "ac cable": "AC Cables",
    "dc cables": "DC Cables", "dc cable": "DC Cables",
    "power cables": "Power Cables", "power cable": "Power Cables",
    "mobile cables": "Mobile Cables", "mobile cable": "Mobile Cables",
    "display cables": "Display Cables", "display cable": "Display Cables",
    connectors: "Connectors", connector: "Connectors",
    others: "Others", other: "Others",
  };
  for (const item of sorted) {
    for (const [key, label] of Object.entries(cableSubMap)) {
      if (item.lower === key || item.lower.includes(key)) return `Cables > ${label}`;
    }
  }
  if (sorted.some((i) => i.lower.includes("cable"))) return "Cables > Others";

  const chargerSubMap = {
    "battery chargers": "Battery Chargers", "battery charger": "Battery Chargers",
    "laptop chargers": "Laptop Chargers", "laptop charger": "Laptop Chargers",
    "mobile chargers": "Mobile Chargers", "mobile charger": "Mobile Chargers",
    "wireless chargers": "Wireless Chargers", "wireless charger": "Wireless Chargers",
  };
  for (const item of sorted) {
    for (const [key, label] of Object.entries(chargerSubMap)) {
      if (item.lower === key || item.lower.includes(key)) return `Chargers > ${label}`;
    }
  }
  if (sorted.some((i) => i.lower.includes("charger") || i.lower.includes("charging"))) {
    return "Chargers > Battery Chargers";
  }

  if (
    sorted.some((i) =>
      ["computer", "networking", "network", "router", "switch", "lan", "wifi", "ethernet", "nic"].some(
        (k) => i.lower.includes(k)
      )
    )
  ) {
    const specific = sorted.find((i) =>
      ["router", "switch", "adapter", "card", "hub", "modem"].some((k) => i.lower.includes(k))
    );
    if (specific) return `Computer and Networking > ${specific.original}`;
    return "Computer and Networking";
  }

  return sorted[0]?.original || "Uncategorized";
}

function getMeta(wooProduct, keys) {
  const list = Array.isArray(wooProduct.meta_data) ? wooProduct.meta_data : [];
  for (const key of keys) {
    const hit = list.find((m) => m && m.key === key);
    if (hit && hit.value !== undefined && hit.value !== null && String(hit.value).trim() !== "") {
      return String(hit.value).trim();
    }
  }
  return "";
}

function extractTags(wooProduct) {
  if (!Array.isArray(wooProduct.tags) || !wooProduct.tags.length) return "";
  return wooProduct.tags
    .map((t) => (typeof t === "string" ? t : t.name || t.slug || ""))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(", ");
}

// ─────────────────────────────────────────────────────────────
// Website → Inventory upsert (ALL fields)
// ─────────────────────────────────────────────────────────────
async function syncToDatabase(wooProduct) {
  const wooId = wooProduct.id ? Number(wooProduct.id) : null;
  const rawSku = wooProduct.sku && String(wooProduct.sku).trim();
  const sku = rawSku || (wooId ? `WC-${wooId}` : `WC-${Date.now()}`);

  const name = (wooProduct.name || "Untitled Product").trim();
  const category = mapWooCategories(wooProduct.categories || []);
  const stock = Number(wooProduct.stock_quantity) || 0;

  const regularPrice =
    Number(wooProduct.regular_price) ||
    Number(wooProduct.price) ||
    0;
  const salePrice = Number(wooProduct.sale_price) || 0;
  const sellingPrice = salePrice > 0 ? salePrice : regularPrice;

  let costPrice = Number(getMeta(wooProduct, ["_cost_price", "cost_price", "_wc_cog_cost"])) || 0;

  const description = stripHtml(wooProduct.description || "");
  const shortDescription = stripHtml(wooProduct.short_description || "");

  const tags = extractTags(wooProduct);
  const focusKeyword = getMeta(wooProduct, [
    "rank_math_focus_keyword",
    "rank_math_focus_keyword_base",
    "_yoast_wpseo_focuskw",
    "_yoast_wpseo_focuskw_text_input",
    "focus_keyword",
  ]);
  const metaDescription =
    getMeta(wooProduct, [
      "rank_math_description",
      "_yoast_wpseo_metadesc",
      "meta_description",
    ]) || shortDescription.slice(0, 160);

  const weight = Number(wooProduct.weight) || 0;

  let images = [];
  if (Array.isArray(wooProduct.images) && wooProduct.images.length > 0) {
    images = wooProduct.images.map((img) => img.src || img.url).filter(Boolean);
  }
  const imageUrl = images[0] || null;

  const fields = {
    sku,
    name,
    category,
    stock,
    selling_price: sellingPrice,
    regular_price: regularPrice,
    cost_price: costPrice,
    image_url: imageUrl,
    images,
    description,
    short_description: shortDescription,
    meta_description: metaDescription,
    tags,
    focus_keyword: focusKeyword,
    weight,
    woo_product_id: wooId,
  };

  // 1) by woo_product_id
  if (wooId) {
    try {
      const found = await pool.query(
        `SELECT id FROM products WHERE woo_product_id = $1 LIMIT 1`,
        [wooId]
      );
      if (found.rows.length) {
        const { rows } = await pool.query(
          `UPDATE products SET
             sku = $1, name = $2, category = $3, stock = $4,
             selling_price = $5, regular_price = $6,
             cost_price = CASE WHEN $7 > 0 THEN $7 ELSE cost_price END,
             image_url = COALESCE($8, image_url),
             images = CASE WHEN $9::text[] IS NOT NULL AND array_length($9::text[], 1) > 0 THEN $9 ELSE images END,
             description = $10,
             short_description = $11,
             meta_description = $12,
             tags = $13,
             focus_keyword = $14,
             weight = $15
           WHERE id = $16
           RETURNING *`,
          [
            fields.sku, fields.name, fields.category, fields.stock,
            fields.selling_price, fields.regular_price, fields.cost_price,
            fields.image_url, fields.images, fields.description,
            fields.short_description, fields.meta_description,
            fields.tags, fields.focus_keyword, fields.weight,
            found.rows[0].id,
          ]
        );
        console.log(`[WooCommerce Webhook] ✅ UPDATED by woo_id → id=${rows[0].id} sku=${rows[0].sku}`);
        return rows[0];
      }
    } catch (e) {
      if (!String(e.message).includes("woo_product_id") && !String(e.message).includes("short_description") && !String(e.message).includes("column")) {
        // continue to fallbacks for missing columns
      }
      if (!String(e.message).includes("woo_product_id")) {
        console.warn("[WooCommerce Webhook] update by woo_id warn:", e.message);
      }
    }
  }

  // 2) by SKU
  const bySku = await pool.query(`SELECT id FROM products WHERE sku = $1 LIMIT 1`, [sku]);
  if (bySku.rows.length) {
    try {
      const { rows } = await pool.query(
        `UPDATE products SET
           name = $1, category = $2, stock = $3,
           selling_price = $4, regular_price = $5,
           cost_price = CASE WHEN $6 > 0 THEN $6 ELSE cost_price END,
           image_url = COALESCE($7, image_url),
           images = CASE WHEN $8::text[] IS NOT NULL AND array_length($8::text[], 1) > 0 THEN $8 ELSE images END,
           description = $9,
           short_description = $10,
           meta_description = $11,
           tags = $12,
           focus_keyword = $13,
           weight = $14,
           woo_product_id = COALESCE($15, woo_product_id)
         WHERE id = $16
         RETURNING *`,
        [
          fields.name, fields.category, fields.stock,
          fields.selling_price, fields.regular_price, fields.cost_price,
          fields.image_url, fields.images, fields.description,
          fields.short_description, fields.meta_description,
          fields.tags, fields.focus_keyword, fields.weight,
          fields.woo_product_id, bySku.rows[0].id,
        ]
      );
      console.log(`[WooCommerce Webhook] ✅ UPDATED by sku → id=${rows[0].id} sku=${rows[0].sku}`);
      return rows[0];
    } catch (e) {
      // Minimal update if extra columns missing
      const { rows } = await pool.query(
        `UPDATE products SET
           name = $1, category = $2, stock = $3, selling_price = $4,
           image_url = COALESCE($5, image_url), description = $6
         WHERE id = $7 RETURNING *`,
        [fields.name, fields.category, fields.stock, fields.selling_price, fields.image_url, fields.description, bySku.rows[0].id]
      );
      console.warn("[WooCommerce Webhook] partial update (some columns missing):", e.message);
      return rows[0];
    }
  }

  // 3) INSERT
  try {
    const { rows } = await pool.query(
      `INSERT INTO products (
         sku, name, category, stock, selling_price, regular_price, cost_price,
         image_url, images, description, short_description, meta_description,
         tags, focus_keyword, weight, min_stock, woo_product_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,5,$16)
       RETURNING *`,
      [
        fields.sku, fields.name, fields.category, fields.stock,
        fields.selling_price, fields.regular_price, fields.cost_price,
        fields.image_url, fields.images, fields.description,
        fields.short_description, fields.meta_description,
        fields.tags, fields.focus_keyword, fields.weight,
        fields.woo_product_id,
      ]
    );
    console.log(`[WooCommerce Webhook] ✅ CREATED → id=${rows[0].id} sku=${rows[0].sku}`);
    return rows[0];
  } catch (err) {
    // Fallback without optional columns
    const { rows } = await pool.query(
      `INSERT INTO products (
         sku, name, category, stock, selling_price, cost_price,
         image_url, images, description, min_stock
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,5)
       RETURNING *`,
      [
        fields.sku, fields.name, fields.category, fields.stock,
        fields.selling_price, fields.cost_price,
        fields.image_url, fields.images, fields.description,
      ]
    );
    console.warn("[WooCommerce Webhook] created with basic columns only:", err.message);
    return rows[0];
  }
}

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────
exports.handleWooCommerceProductWebhook = async (req, res) => {
  const body = req.body || {};
  const topic = String(
    req.headers["x-wc-webhook-topic"] ||
      req.headers["x-wc-webhook-event"] ||
      body.topic ||
      ""
  ).toLowerCase();

  console.log(
    `[WooCommerce Webhook] INCOMING topic=${topic || "unknown"} id=${body?.id} sku=${body?.sku} name=${body?.name}`
  );

  try {
    if (!verifyWooSignature(req)) {
      console.warn("[WooCommerce Webhook] Invalid signature – continuing anyway");
    }
  } catch (e) {
    console.warn("[WooCommerce Webhook] Signature check error:", e.message);
  }

  if (topic.includes("deleted") || topic.includes("trashed")) {
    try {
      const wooId = body.id;
      const rawSku = body.sku && String(body.sku).trim();
      let deletedRows = [];
      if (wooId) {
        try {
          const r = await pool.query(
            `DELETE FROM products WHERE woo_product_id = $1 RETURNING id, sku`,
            [wooId]
          );
          deletedRows = r.rows;
        } catch (_) {}
      }
      if (!deletedRows.length && rawSku) {
        const r = await pool.query(`DELETE FROM products WHERE sku = $1 RETURNING id, sku`, [rawSku]);
        deletedRows = r.rows;
      }
      if (!deletedRows.length && wooId) {
        const r2 = await pool.query(
          `DELETE FROM products WHERE sku = $1 OR sku = $2 RETURNING id, sku`,
          [`WC-${wooId}`, String(wooId)]
        );
        deletedRows = r2.rows;
      }
      return res.status(200).json({ success: true, message: "deleted", deleted: deletedRows.length });
    } catch (err) {
      return res.status(200).json({ success: false, error: err.message });
    }
  }

  if (!body || (!body.id && !body.sku && !body.name)) {
    return res.status(200).json({ success: true, message: "empty ignored" });
  }

  try {
    const row = await syncToDatabase(body);

    // FB/IG only on create
    const isCreate = topic === "product.created" || topic === "product.restored";
    if (isCreate) {
      const forSocial = {
        ...body,
        id: row?.id, // inventory id so facebook_post_id can be saved
        name: body.name || row?.name,
        permalink: body.permalink,
        images: body.images,
        selling_price: row?.selling_price,
        regular_price: row?.regular_price,
        sale_price: body.sale_price,
        price: body.price,
        description: body.short_description || body.description,
      };
      Promise.allSettled([
        postToFacebook(forSocial),
        postToInstagram(forSocial),
      ]).catch(() => {});
      console.log("[WooCommerce Webhook] social posts queued for create");
    } else {
      console.log(`[WooCommerce Webhook] topic=${topic} → social skipped`);
    }

    return res.status(200).json({
      success: true,
      message: "synced",
      product: row
        ? {
            id: row.id,
            sku: row.sku,
            tags: row.tags,
            focus_keyword: row.focus_keyword,
            short_description: row.short_description,
            weight: row.weight,
            regular_price: row.regular_price,
            selling_price: row.selling_price,
          }
        : null,
    });
  } catch (err) {
    console.error("[WooCommerce Webhook] Sync error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

exports.webhookPing = async (req, res) => {
  res.status(200).json({ ok: true, service: "electrox-inventory", time: new Date().toISOString() });
};
