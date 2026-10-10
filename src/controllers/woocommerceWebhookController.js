
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
// 1. Sync Product to Inventory DB (SKU / WC-{id} only — no ALTER)
// ─────────────────────────────────────────────────────────────

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
 * Creates the box if missing.
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

/**
 * Find inventory product id for a Woo product.
 * Tries: exact SKU → WC-{wooId} → any sku ending / matching patterns.
 */
async function findExistingProductId(sku, wooId) {
  if (sku) {
    const bySku = await pool.query(
      `SELECT id FROM products WHERE sku = $1 LIMIT 1`,
      [sku]
    );
    if (bySku.rows.length) return bySku.rows[0].id;
  }
  if (wooId) {
    const fallbackSku = `WC-${wooId}`;
    const byWc = await pool.query(
      `SELECT id FROM products WHERE sku = $1 LIMIT 1`,
      [fallbackSku]
    );
    if (byWc.rows.length) return byWc.rows[0].id;
  }
  return null;
}

async function syncToDatabase(wooProduct) {
  try {
    const wooId = wooProduct.id ? Number(wooProduct.id) : null;
    // Prefer real SKU; if empty use WC-{id} so create/update stay consistent
    const rawSku = wooProduct.sku && String(wooProduct.sku).trim();
    const sku = rawSku || (wooId ? `WC-${wooId}` : null);

    if (!sku) {
      console.warn("[WooCommerce Webhook] No SKU / id – skip sync");
      return null;
    }

    const name = (wooProduct.name || "Untitled Product").trim();
    const category = mapWooCategories(wooProduct.categories || []);

    const manageStock =
      wooProduct.manage_stock === true ||
      wooProduct.manage_stock === "true" ||
      wooProduct.manage_stock === 1 ||
      wooProduct.manage_stock === "yes";
    const hasStockQty =
      wooProduct.stock_quantity !== null &&
      wooProduct.stock_quantity !== undefined &&
      wooProduct.stock_quantity !== "";
    // Update stock when manage_stock is on OR quantity is explicitly sent
    const stock =
      hasStockQty ? Number(wooProduct.stock_quantity) || 0 : null;

    const regularPrice =
      Number(wooProduct.regular_price) ||
      Number(wooProduct.price) ||
      0;
    const salePriceRaw = wooProduct.sale_price;
    const salePrice =
      salePriceRaw !== undefined &&
      salePriceRaw !== null &&
      String(salePriceRaw).trim() !== ""
        ? Number(salePriceRaw) || 0
        : 0;
    // selling_price = active price (sale if set, else regular) — used by POS
    const sellingPrice = salePrice > 0 ? salePrice : regularPrice;

    const description = stripHtml(
      wooProduct.description || wooProduct.short_description || ""
    );

    // SEO + tags from Woo / Rank Math / Yoast
    const tagsArr = Array.isArray(wooProduct.tags)
      ? wooProduct.tags.map((t) => t.name || t).filter(Boolean)
      : [];
    const tagsStr = tagsArr.join(", ");

    const metaDescRaw =
      getMetaEntry(wooProduct, [
        "rank_math_description",
        "_yoast_wpseo_metadesc",
        "meta_description",
      ]) || "";
    const focusRaw =
      getMetaEntry(wooProduct, [
        "rank_math_focus_keyword",
        "_yoast_wpseo_focuskw",
        "focus_keyword",
      ]) || "";
    const metaDescription = String(metaDescRaw || "").trim();
    const focusKeyword = String(focusRaw || "").trim();

    const weightRaw = wooProduct.weight;
    const weightVal =
      weightRaw !== undefined && weightRaw !== null && String(weightRaw).trim() !== ""
        ? Number(weightRaw) || 0
        : null;

    const costRaw = getMetaEntry(wooProduct, ["_cost_price", "cost_price"]);
    const hasCostMeta = costRaw !== undefined;
    const costPrice = hasCostMeta ? Number(costRaw) || 0 : null;

    const boxRaw = getMetaEntry(wooProduct, [
      "_inventory_box",
      "inventory_box",
      "_box",
      "box",
    ]);
    const hasBoxMeta = boxRaw !== undefined;
    let boxId = null;
    if (hasBoxMeta) {
      boxId = await resolveBoxId(boxRaw);
    }

    let images = [];
    if (Array.isArray(wooProduct.images) && wooProduct.images.length > 0) {
      images = wooProduct.images
        .map((img) => img.src || img.url)
        .filter(Boolean);
    }
    const imageUrl = images[0] || null;

    // Find existing: real SKU first, then WC-{id}
    let existingId = await findExistingProductId(rawSku || null, wooId);
    // If website now has a real SKU but inventory still has WC-{id}, link them
    if (!existingId && rawSku && wooId) {
      existingId = await findExistingProductId(null, wooId);
    }

    let rows;
    if (existingId) {
      const sets = [
        `name = $1`,
        `category = $2`,
        `selling_price = $3`,
        `description = $4`,
        `sku = $5`,
        `regular_price = $6`,
      ];
      const vals = [name, category, sellingPrice, description, sku, regularPrice];

      if (tagsStr) {
        vals.push(tagsStr);
        sets.push(`tags = $${vals.length}`);
      }
      if (metaDescription) {
        vals.push(metaDescription);
        sets.push(`meta_description = $${vals.length}`);
      }
      if (focusKeyword) {
        vals.push(focusKeyword);
        sets.push(`focus_keyword = $${vals.length}`);
      }
      if (weightVal !== null) {
        vals.push(weightVal);
        sets.push(`weight = $${vals.length}`);
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
      const { rows: inserted } = await pool.query(
        `INSERT INTO products (
           sku, name, category, stock, selling_price, regular_price, cost_price, box_id,
           image_url, images, description, min_stock,
           tags, meta_description, focus_keyword, weight
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,5,$12,$13,$14,$15)
         ON CONFLICT (sku) DO UPDATE SET
           name             = EXCLUDED.name,
           category         = EXCLUDED.category,
           stock            = COALESCE(EXCLUDED.stock, products.stock),
           selling_price    = EXCLUDED.selling_price,
           regular_price    = EXCLUDED.regular_price,
           cost_price       = COALESCE(EXCLUDED.cost_price, products.cost_price),
           box_id           = COALESCE(EXCLUDED.box_id, products.box_id),
           image_url        = COALESCE(EXCLUDED.image_url, products.image_url),
           images           = CASE
                                WHEN EXCLUDED.images IS NOT NULL AND array_length(EXCLUDED.images, 1) > 0
                                THEN EXCLUDED.images
                                ELSE products.images
                              END,
           description      = EXCLUDED.description,
           tags             = COALESCE(EXCLUDED.tags, products.tags),
           meta_description = COALESCE(EXCLUDED.meta_description, products.meta_description),
           focus_keyword    = COALESCE(EXCLUDED.focus_keyword, products.focus_keyword),
           weight           = COALESCE(EXCLUDED.weight, products.weight)
         RETURNING id, sku, name, category, stock, selling_price, cost_price, box_id`,
        [
          sku,
          name,
          category,
          stock !== null ? stock : 0,
          sellingPrice,
          regularPrice,
          hasCostMeta ? costPrice : 0,
          hasBoxMeta ? boxId : null,
          imageUrl,
          images,
          description,
          tagsStr || null,
          metaDescription || null,
          focusKeyword || null,
          weightVal !== null ? weightVal : 0,
        ]
      );
      rows = inserted;
      console.log(
        `[WooCommerce Webhook] ✅ CREATED/UPSERT id=${rows[0].id} sku=${rows[0].sku} stock=${rows[0].stock} price=${rows[0].selling_price} cost=${rows[0].cost_price} box_id=${rows[0].box_id}`
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
  const body = req.body || {};
  const topic = String(
    req.headers["x-wc-webhook-topic"] ||
      req.headers["x-wc-webhook-event"] ||
      body.topic ||
      ""
  ).toLowerCase();

  console.log(
    `[WooCommerce Webhook] INCOMING topic=${topic || "unknown"} id=${body?.id} sku=${body?.sku} name=${body?.name} keys=${Object.keys(body).join(",")}`
  );

  // Respond AFTER we start work, but still quick — actually process sync AWAIT so we know it worked
  // (Woo allows ~5s; our DB update is fast)
  try {
    if (!verifyWooSignature(req)) {
      console.warn("[WooCommerce Webhook] Invalid signature – continuing anyway");
    }
  } catch (sigErr) {
    console.warn("[WooCommerce Webhook] Signature check error:", sigErr.message);
  }

  if (topic === "product.deleted" || topic === "product.trashed") {
    try {
      const wooId = body?.id ? Number(body.id) : null;
      const rawSku = body?.sku && String(body.sku).trim();
      const sku = rawSku || (wooId ? `WC-${wooId}` : null);
      let deleted = 0;
      if (sku) {
        const r = await pool.query(`DELETE FROM products WHERE sku = $1 RETURNING id, sku`, [sku]);
        deleted = r.rowCount || 0;
      }
      if (!deleted && wooId) {
        const r2 = await pool.query(`DELETE FROM products WHERE sku = $1 RETURNING id, sku`, [`WC-${wooId}`]);
        deleted = r2.rowCount || 0;
      }
      console.log(`[WooCommerce Webhook] 🗑️ DELETED from inventory sku=${sku} count=${deleted}`);
      return res.status(200).json({ success: true, message: "deleted", deleted });
    } catch (err) {
      console.error("[WooCommerce Webhook] delete failed:", err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (!body || (!body.id && !body.sku && !body.name)) {
    console.log("[WooCommerce Webhook] Empty or test payload – ignored");
    return res.status(200).json({ success: true, message: "empty ignored" });
  }

  try {
    // Await DB sync so create+update both definitely run before response
    const row = await syncToDatabase(body);
    // Social only on create (non-blocking)
    const isCreate =
      !topic ||
      topic === "product.created" ||
      topic === "product.restored";
    if (isCreate) {
      Promise.allSettled([postToFacebook(body), postToInstagram(body)]).catch(() => {});
    }
    return res.status(200).json({
      success: true,
      message: "synced",
      product: row
        ? {
            id: row.id,
            sku: row.sku,
            stock: row.stock,
            selling_price: row.selling_price,
            cost_price: row.cost_price,
            box_id: row.box_id,
          }
        : null,
    });
  } catch (err) {
    console.error("[WooCommerce Webhook] Sync error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// Health ping for WordPress to verify URL
exports.webhookPing = async (req, res) => {
  res.status(200).json({ ok: true, service: "electrox-inventory", time: new Date().toISOString() });
};
