
const crypto = require("crypto");
const axios = require("axios");
const pool = require("../config/db");

// ─────────────────────────────────────────────────────────────
// Signature verification (optional)
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
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

/**
 * Dynamic Category Mapping
 * Website category → Inventory category (exact match for most)
 * Special rules for Cables subs, Chargers, Computer and Networking
 */
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

  // ─── Cables subcategories ───────────────────────────────────
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

  if (sorted.some((i) => i.lower.includes("cable"))) {
    return "Cables > Others";
  }

  // ─── Chargers (standalone main category) ────────────────────
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

  // ─── Computer and Networking ────────────────────────────────
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
    if (specific) {
      return `Computer and Networking > ${specific.original}`;
    }
    return "Computer and Networking";
  }

  // ─── Everything else → exact name from website ──────────────
  return sorted[0]?.original || "Uncategorized";
}

function buildCaption(product) {
  const title = product.name || "New Product";
  const price =
    product.sale_price && Number(product.sale_price) > 0
      ? `Rs. ${product.sale_price}`
      : product.regular_price
      ? `Rs. ${product.regular_price}`
      : product.price
      ? `Rs. ${product.price}`
      : "Price on request";

  const shortDesc = stripHtml(product.short_description || product.description || "")
    .slice(0, 180)
    .trim();

  const link = product.permalink || process.env.WEBSITE_URL || "";

  let caption = `🔥 ${title}\n\n`;
  caption += `💰 ${price}\n\n`;
  if (shortDesc) caption += `📝 ${shortDesc}\n\n`;
  if (link) caption += `🛒 Order now: ${link}\n\n`;
  caption += `#Electrox #Electronics #NewArrival`;

  return caption;
}

// ─────────────────────────────────────────────────────────────
// 1. Sync Product to Inventory DB (upsert by woo_product_id + SKU)
// ─────────────────────────────────────────────────────────────
let wooIdColumnReady = false;
async function ensureWooProductIdColumn() {
  if (wooIdColumnReady) return;
  try {
    await pool.query(
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS woo_product_id INTEGER`
    );
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_products_woo_product_id
       ON products (woo_product_id) WHERE woo_product_id IS NOT NULL`
    );
    wooIdColumnReady = true;
  } catch (err) {
    console.warn("[WooCommerce Webhook] woo_product_id column ensure:", err.message);
  }
}

/** Return meta value if key exists (including empty / 0). missing → undefined */
function getMetaEntry(wooProduct, keys) {
  const list = Array.isArray(wooProduct.meta_data) ? wooProduct.meta_data : [];
  const want = keys.map((k) => String(k).toLowerCase());
  for (const m of list) {
    const key = String(m.key || m.meta_key || "").toLowerCase();
    if (want.includes(key)) {
      return m.value !== undefined ? m.value : m.meta_value;
    }
  }
  return undefined;
}

/**
 * Resolve box_id from box_number string.
 * Creates the box in inventory if it does not exist yet.
 * Returns null if boxNumber empty.
 */
async function resolveBoxId(boxNumber) {
  if (boxNumber === undefined || boxNumber === null) return null;
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
    console.log(`[WooCommerce Webhook] 📦 Box created → ${num} id=${created.rows[0].id}`);
    return created.rows[0].id;
  } catch (err) {
    console.error("[WooCommerce Webhook] Box resolve failed:", err.message);
    return null;
  }
}

async function syncToDatabase(wooProduct) {
  try {
    await ensureWooProductIdColumn();

    const wooId = wooProduct.id ? Number(wooProduct.id) : null;
    const sku =
      (wooProduct.sku && String(wooProduct.sku).trim()) ||
      (wooId ? `WC-${wooId}` : null);

    if (!sku) {
      console.warn("[WooCommerce Webhook] No SKU / id – skip sync");
      return null;
    }

    const name = (wooProduct.name || "Untitled Product").trim();
    const category = mapWooCategories(wooProduct.categories || []);

    // Stock: only apply when Woo sends a real quantity (manage stock on)
    const manageStock =
      wooProduct.manage_stock === true ||
      wooProduct.manage_stock === "true" ||
      wooProduct.manage_stock === 1 ||
      wooProduct.manage_stock === "yes";
    const hasStockQty =
      wooProduct.stock_quantity !== null &&
      wooProduct.stock_quantity !== undefined &&
      wooProduct.stock_quantity !== "";
    const stock = hasStockQty ? Number(wooProduct.stock_quantity) || 0 : null;

    const sellingPrice =
      Number(wooProduct.sale_price) ||
      Number(wooProduct.regular_price) ||
      Number(wooProduct.price) ||
      0;

    const description = stripHtml(
      wooProduct.description || wooProduct.short_description || ""
    );

    // Cost price — update when meta key is present (including 0)
    const costRaw = getMetaEntry(wooProduct, ["_cost_price", "cost_price"]);
    const hasCostMeta = costRaw !== undefined;
    const costPrice = hasCostMeta
      ? Number(costRaw) || 0
      : null;

    // Box — update when meta key is present
    const boxRaw = getMetaEntry(wooProduct, [
      "_inventory_box",
      "inventory_box",
      "_box",
      "box",
    ]);
    const hasBoxMeta = boxRaw !== undefined;
    let boxId = null;
    if (hasBoxMeta) {
      boxId = await resolveBoxId(boxRaw); // null if cleared
    }

    // Images
    let images = [];
    if (Array.isArray(wooProduct.images) && wooProduct.images.length > 0) {
      images = wooProduct.images
        .map((img) => img.src || img.url)
        .filter(Boolean);
    }
    const imageUrl = images[0] || null;

    // Find existing row: prefer woo_product_id, then SKU, then WC-{id} fallback
    let existingId = null;
    if (wooId) {
      const byWoo = await pool.query(
        `SELECT id, sku FROM products WHERE woo_product_id = $1 LIMIT 1`,
        [wooId]
      );
      if (byWoo.rows.length) existingId = byWoo.rows[0].id;
    }
    if (!existingId) {
      const bySku = await pool.query(
        `SELECT id FROM products WHERE sku = $1 LIMIT 1`,
        [sku]
      );
      if (bySku.rows.length) existingId = bySku.rows[0].id;
    }
    if (!existingId && wooId) {
      const byFallback = await pool.query(
        `SELECT id FROM products WHERE sku = $1 LIMIT 1`,
        [`WC-${wooId}`]
      );
      if (byFallback.rows.length) existingId = byFallback.rows[0].id;
    }

    let rows;
    if (existingId) {
      // ─── UPDATE existing product (website edit) ───
      const sets = [
        `name = $1`,
        `category = $2`,
        `selling_price = $3`,
        `description = $4`,
        `sku = $5`,
      ];
      const vals = [name, category, sellingPrice, description, sku];

      if (wooId) {
        vals.push(wooId);
        sets.push(`woo_product_id = $${vals.length}`);
      }
      if (stock !== null) {
        vals.push(stock);
        sets.push(`stock = $${vals.length}`);
      }
      if (hasCostMeta) {
        vals.push(costPrice);
        sets.push(`cost_price = $${vals.length}`);
      }
      if (hasBoxMeta) {
        vals.push(boxId);
        sets.push(`box_id = $${vals.length}`);
      }
      if (imageUrl) {
        vals.push(imageUrl);
        sets.push(`image_url = COALESCE($${vals.length}, image_url)`);
      }
      if (images.length > 0) {
        vals.push(images);
        sets.push(`images = $${vals.length}`);
      }

      vals.push(existingId);
      const { rows: updated } = await pool.query(
        `UPDATE products SET ${sets.join(", ")} WHERE id = $${vals.length}
         RETURNING id, sku, name, category, stock, selling_price, cost_price, box_id`,
        vals
      );
      rows = updated;
      console.log(
        `[WooCommerce Webhook] 🔄 UPDATED id=${rows[0].id} sku=${rows[0].sku} stock=${rows[0].stock} price=${rows[0].selling_price} cost=${rows[0].cost_price} box_id=${rows[0].box_id}`
      );
    } else {
      // ─── INSERT new product ───
      const { rows: inserted } = await pool.query(
        `INSERT INTO products (
           sku, name, category, stock, selling_price, cost_price, box_id,
           image_url, images, description, min_stock, woo_product_id
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,5,$11)
         ON CONFLICT (sku) DO UPDATE SET
           name          = EXCLUDED.name,
           category      = EXCLUDED.category,
           stock         = COALESCE(EXCLUDED.stock, products.stock),
           selling_price = EXCLUDED.selling_price,
           cost_price    = COALESCE(EXCLUDED.cost_price, products.cost_price),
           box_id        = COALESCE(EXCLUDED.box_id, products.box_id),
           image_url     = COALESCE(EXCLUDED.image_url, products.image_url),
           images        = CASE
                             WHEN EXCLUDED.images IS NOT NULL AND array_length(EXCLUDED.images, 1) > 0
                             THEN EXCLUDED.images
                             ELSE products.images
                           END,
           description   = EXCLUDED.description,
           woo_product_id = COALESCE(EXCLUDED.woo_product_id, products.woo_product_id)
         RETURNING id, sku, name, category, stock, selling_price, cost_price, box_id`,
        [
          sku,
          name,
          category,
          stock !== null ? stock : 0,
          sellingPrice,
          hasCostMeta ? costPrice : 0,
          hasBoxMeta ? boxId : null,
          imageUrl,
          images,
          description,
          wooId,
        ]
      );
      rows = inserted;
      console.log(
        `[WooCommerce Webhook] ✅ CREATED id=${rows[0].id} sku=${rows[0].sku} stock=${rows[0].stock} price=${rows[0].selling_price} cost=${rows[0].cost_price} box_id=${rows[0].box_id}`
      );
    }

    return rows[0];
  } catch (err) {
    console.error("[WooCommerce Webhook] ❌ Database sync failed:", err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// 2. Post to Facebook Page
// ─────────────────────────────────────────────────────────────
async function postToFacebook(wooProduct) {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;

  if (!pageId || !token) {
    console.warn("[WooCommerce Webhook] Facebook credentials missing – skipping FB post");
    return null;
  }

  const caption = buildCaption(wooProduct);
  let imageUrl = null;
  if (Array.isArray(wooProduct.images) && wooProduct.images.length > 0) {
    imageUrl = wooProduct.images[0].src || wooProduct.images[0].url;
  }

  try {
    const url = `https://graph.facebook.com/v19.0/${pageId}/photos`;
    const payload = {
      caption,
      access_token: token,
    };
    if (imageUrl) payload.url = imageUrl;

    const { data } = await axios.post(url, payload, { timeout: 20000 });
    console.log(`[WooCommerce Webhook] ✅ Facebook post created → id=${data.id || data.post_id}`);
    return data;
  } catch (err) {
    console.error(
      "[WooCommerce Webhook] ❌ Facebook post failed:",
      err.response?.data || err.message
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 3. Post to Instagram Business Feed (2-step)
// ─────────────────────────────────────────────────────────────
async function postToInstagram(wooProduct) {
  const igAccountId = process.env.IG_ACCOUNT_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;

  if (!igAccountId || !token) {
    console.warn("[WooCommerce Webhook] Instagram credentials missing – skipping IG post");
    return null;
  }

  let imageUrl = null;
  if (Array.isArray(wooProduct.images) && wooProduct.images.length > 0) {
    imageUrl = wooProduct.images[0].src || wooProduct.images[0].url;
  }

  if (!imageUrl) {
    console.warn("[WooCommerce Webhook] No image – Instagram requires an image, skipping");
    return null;
  }

  const caption = buildCaption(wooProduct);

  try {
    const createUrl = `https://graph.facebook.com/v19.0/${igAccountId}/media`;
    const { data: container } = await axios.post(
      createUrl,
      {
        image_url: imageUrl,
        caption,
        access_token: token,
      },
      { timeout: 20000 }
    );

    if (!container.id) {
      throw new Error("No container ID returned from Instagram media endpoint");
    }

    const publishUrl = `https://graph.facebook.com/v19.0/${igAccountId}/media_publish`;
    const { data: published } = await axios.post(
      publishUrl,
      {
        creation_id: container.id,
        access_token: token,
      },
      { timeout: 20000 }
    );

    console.log(`[WooCommerce Webhook] ✅ Instagram post published → id=${published.id}`);
    return published;
  } catch (err) {
    console.error(
      "[WooCommerce Webhook] ❌ Instagram post failed:",
      err.response?.data || err.message
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Background processor
// ─────────────────────────────────────────────────────────────
async function processWebhookPayload(wooProduct, topic) {
  // Always sync inventory on create + update
  const jobs = [syncToDatabase(wooProduct)];

  // Social posts only for brand-new products (avoid spam on every edit)
  const isCreate =
    !topic ||
    topic === "product.created" ||
    topic === "product.restored";
  if (isCreate) {
    jobs.push(postToFacebook(wooProduct));
    jobs.push(postToInstagram(wooProduct));
  }

  const results = await Promise.allSettled(jobs);
  results.forEach((r, i) => {
    const labels = isCreate
      ? ["DB Sync", "Facebook", "Instagram"]
      : ["DB Sync"];
    if (r.status === "rejected") {
      console.error(`[WooCommerce Webhook] ${labels[i]} rejected:`, r.reason?.message || r.reason);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Main Express handler
// ─────────────────────────────────────────────────────────────
exports.handleWooCommerceProductWebhook = async (req, res) => {
  // Immediate 200 so WooCommerce never times out
  res.status(200).send({ success: true, message: "Webhook received" });

  try {
    if (!verifyWooSignature(req)) {
      console.warn("[WooCommerce Webhook] Invalid signature – continuing anyway");
    }
  } catch (sigErr) {
    console.warn("[WooCommerce Webhook] Signature check error:", sigErr.message);
  }

  const body = req.body;
  const topic = String(
    req.headers["x-wc-webhook-topic"] ||
      req.headers["x-wc-webhook-event"] ||
      ""
  ).toLowerCase();

  console.log(
    `[WooCommerce Webhook] topic=${topic || "unknown"} id=${body?.id} sku=${body?.sku} name=${body?.name}`
  );

  // Ignore deletes
  if (topic === "product.deleted") {
    console.log("[WooCommerce Webhook] product.deleted – inventory unchanged");
    return;
  }

  if (!body || (!body.id && !body.sku && !body.name)) {
    console.log("[WooCommerce Webhook] Empty or test payload – ignored");
    return;
  }

  processWebhookPayload(body, topic).catch((err) => {
    console.error("[WooCommerce Webhook] Unhandled background error:", err);
  });
};
