const crypto = require("crypto");
const pool = require("../config/db");
const { postToFacebook, postToInstagram } = require("./socialPost");

// ─────────────────────────────────────────────────────────────
// Signature verification (soft — don't block on mismatch)
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

// ─────────────────────────────────────────────────────────────
// DB sync (THIS WAS MISSING — root cause of the bug)
// ─────────────────────────────────────────────────────────────
async function syncToDatabase(wooProduct) {
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

  // cost from meta if present
  let costPrice = 0;
  if (Array.isArray(wooProduct.meta_data)) {
    const costMeta = wooProduct.meta_data.find(
      (m) =>
        m &&
        (m.key === "_cost_price" ||
          m.key === "cost_price" ||
          m.key === "_wc_cog_cost")
    );
    if (costMeta) costPrice = Number(costMeta.value) || 0;
  }

  const description = stripHtml(
    wooProduct.description || wooProduct.short_description || ""
  );

  let images = [];
  if (Array.isArray(wooProduct.images) && wooProduct.images.length > 0) {
    images = wooProduct.images
      .map((img) => img.src || img.url)
      .filter(Boolean);
  }
  const imageUrl = images[0] || null;

  const wooId = wooProduct.id ? Number(wooProduct.id) : null;

  // Try with woo_product_id column; fallback if column missing
  try {
    const { rows } = await pool.query(
      `INSERT INTO products (
         sku, name, category, stock, selling_price, cost_price,
         image_url, images, description, min_stock, woo_product_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,5,$10)
       ON CONFLICT (sku) DO UPDATE SET
         name          = EXCLUDED.name,
         category      = EXCLUDED.category,
         stock         = EXCLUDED.stock,
         selling_price = EXCLUDED.selling_price,
         cost_price    = CASE WHEN EXCLUDED.cost_price > 0 THEN EXCLUDED.cost_price ELSE products.cost_price END,
         image_url     = COALESCE(EXCLUDED.image_url, products.image_url),
         images        = CASE
                           WHEN EXCLUDED.images IS NOT NULL AND array_length(EXCLUDED.images, 1) > 0
                           THEN EXCLUDED.images
                           ELSE products.images
                         END,
         description   = EXCLUDED.description,
         woo_product_id = COALESCE(EXCLUDED.woo_product_id, products.woo_product_id)
       RETURNING id, sku, name, category, stock, selling_price, cost_price, box_id`,
      [sku, name, category, stock, sellingPrice, costPrice, imageUrl, images, description, wooId]
    );

    console.log(
      `[WooCommerce Webhook] ✅ Product synced → id=${rows[0].id} sku=${rows[0].sku} category="${rows[0].category}" images=${images.length}`
    );
    return rows[0];
  } catch (err) {
    // Column woo_product_id may not exist
    if (err.message && err.message.includes("woo_product_id")) {
      const { rows } = await pool.query(
        `INSERT INTO products (
           sku, name, category, stock, selling_price, cost_price,
           image_url, images, description, min_stock
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,5)
         ON CONFLICT (sku) DO UPDATE SET
           name          = EXCLUDED.name,
           category      = EXCLUDED.category,
           stock         = EXCLUDED.stock,
           selling_price = EXCLUDED.selling_price,
           cost_price    = CASE WHEN EXCLUDED.cost_price > 0 THEN EXCLUDED.cost_price ELSE products.cost_price END,
           image_url     = COALESCE(EXCLUDED.image_url, products.image_url),
           images        = CASE
                             WHEN EXCLUDED.images IS NOT NULL AND array_length(EXCLUDED.images, 1) > 0
                             THEN EXCLUDED.images
                             ELSE products.images
                           END,
           description   = EXCLUDED.description
         RETURNING id, sku, name, category, stock, selling_price, cost_price, box_id`,
        [sku, name, category, stock, sellingPrice, costPrice, imageUrl, images, description]
      );
      console.log(
        `[WooCommerce Webhook] ✅ Product synced (no woo_id col) → id=${rows[0].id} sku=${rows[0].sku}`
      );
      return rows[0];
    }
    console.error("[WooCommerce Webhook] ❌ Database sync failed:", err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Main handler
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

  // DELETE
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
        } catch (colErr) {
          console.warn("[WooCommerce Webhook] woo_product_id delete skip:", colErr.message);
        }
      }
      if (!deletedRows.length && rawSku) {
        const r = await pool.query(
          `DELETE FROM products WHERE sku = $1 RETURNING id, sku`,
          [rawSku]
        );
        deletedRows = r.rows;
      }
      if (!deletedRows.length && wooId) {
        const r2 = await pool.query(
          `DELETE FROM products WHERE sku = $1 OR sku = $2 RETURNING id, sku`,
          [`WC-${wooId}`, String(wooId)]
        );
        deletedRows = r2.rows;
      }

      console.log(`[WooCommerce Webhook] 🗑️ deleted count=${deletedRows.length}`);
      return res.status(200).json({
        success: true,
        message: "deleted",
        deleted: deletedRows.length,
      });
    } catch (err) {
      console.error("[WooCommerce Webhook] delete failed:", err.message);
      return res.status(200).json({ success: false, error: err.message });
    }
  }

  if (!body || (!body.id && !body.sku && !body.name)) {
    console.log("[WooCommerce Webhook] Empty payload – ignored");
    return res.status(200).json({ success: true, message: "empty ignored" });
  }

  try {
    // 1) Always sync inventory (create + update)
    const row = await syncToDatabase(body);

    // 2) Social on create AND update (so website products get FB/IG posts)
    Promise.allSettled([postToFacebook(body), postToInstagram(body)]).catch(
      () => {}
    );

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

exports.webhookPing = async (req, res) => {
  res.status(200).json({
    ok: true,
    service: "electrox-inventory",
    time: new Date().toISOString(),
  });
};
