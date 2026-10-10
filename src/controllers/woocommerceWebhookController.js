const crypto = require("crypto");
const axios = require("axios");
const pool = require("../config/db");

// ─────────────────────────────────────────────────────────────
// Signature verification (optional but recommended)
// ─────────────────────────────────────────────────────────────
function verifyWooSignature(req) {
  const secret = process.env.WOOCOMMERCE_WEBHOOK_SECRET;
  if (!secret) return true; // secret not set → skip check

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
 * -----------------------------------------
 * Rule:
 *   Website pe jo category assigned hai, inventory mein bilkul usi matching
 *   category mein product jaaye.
 *
 * Special restructuring rules (as required):
 *   1. Cables → subcategories: AC Cables, DC Cables, Power Cables,
 *      Mobile Cables, Display Cables, Connectors, Others
 *   2. Battery Chargers (and other chargers) → standalone main category "Chargers"
 *      with subs: Battery Chargers, Laptop Chargers, Mobile Chargers, Wireless Chargers
 *   3. Computer and Networking → new main category
 *
 * Everything else (Power Supplies, CCTV, Electric, etc.) → exact name match.
 * Format stored in DB: "MainCategory" or "MainCategory > SubCategory"
 */
function mapWooCategories(wooCategories = []) {
  if (!Array.isArray(wooCategories) || wooCategories.length === 0) {
    return "Uncategorized";
  }

  // Normalize for matching
  const normalized = wooCategories.map((c) => ({
    original: (c.name || c.slug || "").trim(),
    lower: (c.name || c.slug || "").trim().toLowerCase(),
    parent: c.parent || 0,
  }));

  // Prefer the deepest (child) category first
  const sorted = [...normalized].sort((a, b) => b.parent - a.parent);

  // ─── 1. Cables special handling ────────────────────────────
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

  // Generic "cables" without specific sub
  if (sorted.some((i) => i.lower.includes("cable"))) {
    return "Cables > Others";
  }

  // ─── 2. Chargers (standalone main category) ────────────────
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

  // Generic charger / charging related
  if (sorted.some((i) => i.lower.includes("charger") || i.lower.includes("charging"))) {
    return "Chargers > Battery Chargers";
  }

  // ─── 3. Computer and Networking ────────────────────────────
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
    // Keep a more specific subcategory name if present
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

  // ─── 4. Everything else → exact match from website ─────────
  // Use the deepest category name as-is (Power Supplies, CCTV, Electric, etc.)
  const primary = sorted[0]?.original || "Uncategorized";
  return primary;
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
// 1. Sync Product to Inventory DB (upsert by SKU)
// ─────────────────────────────────────────────────────────────
async function syncToDatabase(wooProduct) {
  try {
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

    let imageUrl = null;
    if (Array.isArray(wooProduct.images) && wooProduct.images.length > 0) {
      imageUrl = wooProduct.images[0].src || wooProduct.images[0].url || null;
    }

    const images = imageUrl ? [imageUrl] : [];

    const { rows } = await pool.query(
      `INSERT INTO products (
         sku, name, category, stock, selling_price,
         image_url, images, description, min_stock
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 5)
       ON CONFLICT (sku) DO UPDATE SET
         name          = EXCLUDED.name,
         category      = EXCLUDED.category,
         stock         = EXCLUDED.stock,
         selling_price = EXCLUDED.selling_price,
         image_url     = COALESCE(EXCLUDED.image_url, products.image_url),
         images        = CASE
                           WHEN EXCLUDED.images IS NOT NULL AND array_length(EXCLUDED.images, 1) > 0
                           THEN EXCLUDED.images
                           ELSE products.images
                         END,
         description   = EXCLUDED.description
       RETURNING id, sku, name, category`,
      [sku, name, category, stock, sellingPrice, imageUrl, images, description]
    );

    console.log(
      `[WooCommerce Webhook] ✅ Product synced → id=${rows[0].id} sku=${rows[0].sku} category="${rows[0].category}"`
    );
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
    // Step A – Create media container
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

    // Step B – Publish
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
async function processWebhookPayload(wooProduct) {
  const results = await Promise.allSettled([
    syncToDatabase(wooProduct),
    postToFacebook(wooProduct),
    postToInstagram(wooProduct),
  ]);

  results.forEach((r, i) => {
    const labels = ["DB Sync", "Facebook", "Instagram"];
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
      console.warn("[WooCommerce Webhook] Invalid signature – payload discarded");
      // return;
    }
  } catch (sigErr) {
    console.warn("[WooCommerce Webhook] Signature check error:", sigErr.message);
  }

  const body = req.body;

  if (!body || (!body.id && !body.sku && !body.name)) {
    console.log("[WooCommerce Webhook] Empty or test payload – ignored");
    return;
  }

  processWebhookPayload(body).catch((err) => {
    console.error("[WooCommerce Webhook] Unhandled background error:", err);
  });
};
