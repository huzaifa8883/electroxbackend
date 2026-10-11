const crypto = require("crypto");
const axios = require("axios");
const pool = require("../config/db");
const { postToFacebook, postToInstagram, buildCaption } = require("./socialPost");

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
      console.log(`[WooCommerce Webhook] DELETE request id=${wooId} sku=${rawSku} keys=${Object.keys(body||{}).join(",")}`);

      let deletedRows = [];

      // 1) by woo_product_id (most reliable when SKU missing)
      if (wooId) {
        try {
          const r0 = await pool.query(
            `DELETE FROM products WHERE woo_product_id = $1 RETURNING id, sku, woo_product_id`,
            [wooId]
          );
          deletedRows = r0.rows;
        } catch (colErr) {
          // column may not exist yet
          console.warn("[WooCommerce Webhook] woo_product_id delete skip:", colErr.message);
        }
      }

      // 2) exact SKU
      if (!deletedRows.length && rawSku) {
        const r = await pool.query(
          `DELETE FROM products WHERE sku = $1 RETURNING id, sku`,
          [rawSku]
        );
        deletedRows = r.rows;
      }

      // 3) WC-{id} fallback
      if (!deletedRows.length && wooId) {
        const r2 = await pool.query(
          `DELETE FROM products WHERE sku = $1 OR sku = $2 RETURNING id, sku`,
          [`WC-${wooId}`, String(wooId)]
        );
        deletedRows = r2.rows;
      }

      console.log(
        `[WooCommerce Webhook] 🗑️ DELETED from inventory count=${deletedRows.length}`,
        deletedRows
      );
      return res.status(200).json({
        success: true,
        message: "deleted",
        deleted: deletedRows.length,
        rows: deletedRows,
      });
    } catch (err) {
      console.error("[WooCommerce Webhook] delete failed:", err.message);
      return res.status(200).json({ success: false, error: err.message });
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
