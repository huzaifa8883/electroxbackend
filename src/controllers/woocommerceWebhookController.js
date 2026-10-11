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
// DB sync — update by woo_product_id OR sku (no duplicates)
// ─────────────────────────────────────────────────────────────
async function syncToDatabase(wooProduct) {
  const wooId = wooProduct.id ? Number(wooProduct.id) : null;
  const rawSku = wooProduct.sku && String(wooProduct.sku).trim();
  const sku = rawSku || (wooId ? `WC-${wooId}` : `WC-${Date.now()}`);

  const name = (wooProduct.name || "Untitled Product").trim();
  const category = mapWooCategories(wooProduct.categories || []);
  const stock = Number(wooProduct.stock_quantity) || 0;

  const sellingPrice =
    Number(wooProduct.sale_price) ||
    Number(wooProduct.regular_price) ||
    Number(wooProduct.price) ||
    0;

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
    images = wooProduct.images.map((img) => img.src || img.url).filter(Boolean);
  }
  const imageUrl = images[0] || null;

  // ─── 1) Existing row by woo_product_id ───
  if (wooId) {
    try {
      const found = await pool.query(
        `SELECT id FROM products WHERE woo_product_id = $1 LIMIT 1`,
        [wooId]
      );
      if (found.rows.length) {
        const { rows } = await pool.query(
          `UPDATE products SET
             sku = $1,
             name = $2,
             category = $3,
             stock = $4,
             selling_price = $5,
             cost_price = CASE WHEN $6 > 0 THEN $6 ELSE cost_price END,
             image_url = COALESCE($7, image_url),
             images = CASE WHEN $8::text[] IS NOT NULL AND array_length($8::text[], 1) > 0 THEN $8 ELSE images END,
             description = $9
           WHERE id = $10
           RETURNING id, sku, name, category, stock, selling_price, cost_price, box_id`,
          [
            sku,
            name,
            category,
            stock,
            sellingPrice,
            costPrice,
            imageUrl,
            images,
            description,
            found.rows[0].id,
          ]
        );
        console.log(
          `[WooCommerce Webhook] ✅ UPDATED by woo_id → id=${rows[0].id} sku=${rows[0].sku}`
        );
        return rows[0];
      }
    } catch (e) {
      if (!String(e.message).includes("woo_product_id")) throw e;
    }
  }

  // ─── 2) Existing row by SKU ───
  const bySku = await pool.query(
    `SELECT id FROM products WHERE sku = $1 LIMIT 1`,
    [sku]
  );
  if (bySku.rows.length) {
    let rows;
    try {
      const result = await pool.query(
        `UPDATE products SET
           name = $1,
           category = $2,
           stock = $3,
           selling_price = $4,
           cost_price = CASE WHEN $5 > 0 THEN $5 ELSE cost_price END,
           image_url = COALESCE($6, image_url),
           images = CASE WHEN $7::text[] IS NOT NULL AND array_length($7::text[], 1) > 0 THEN $7 ELSE images END,
           description = $8,
           woo_product_id = COALESCE($9, woo_product_id)
         WHERE id = $10
         RETURNING id, sku, name, category, stock, selling_price, cost_price, box_id`,
        [
          name,
          category,
          stock,
          sellingPrice,
          costPrice,
          imageUrl,
          images,
          description,
          wooId,
          bySku.rows[0].id,
        ]
      );
      rows = result.rows;
    } catch (err) {
      if (String(err.message).includes("woo_product_id")) {
        const result = await pool.query(
          `UPDATE products SET
             name = $1,
             category = $2,
             stock = $3,
             selling_price = $4,
             cost_price = CASE WHEN $5 > 0 THEN $5 ELSE cost_price END,
             image_url = COALESCE($6, image_url),
             images = CASE WHEN $7::text[] IS NOT NULL AND array_length($7::text[], 1) > 0 THEN $7 ELSE images END,
             description = $8
           WHERE id = $9
           RETURNING id, sku, name, category, stock, selling_price, cost_price, box_id`,
          [
            name,
            category,
            stock,
            sellingPrice,
            costPrice,
            imageUrl,
            images,
            description,
            bySku.rows[0].id,
          ]
        );
        rows = result.rows;
      } else {
        throw err;
      }
    }
    console.log(
      `[WooCommerce Webhook] ✅ UPDATED by sku → id=${rows[0].id} sku=${rows[0].sku}`
    );
    return rows[0];
  }

  // ─── 3) Insert new ───
  try {
    const { rows } = await pool.query(
      `INSERT INTO products (
         sku, name, category, stock, selling_price, cost_price,
         image_url, images, description, min_stock, woo_product_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,5,$10)
       RETURNING id, sku, name, category, stock, selling_price, cost_price, box_id`,
      [
        sku,
        name,
        category,
        stock,
        sellingPrice,
        costPrice,
        imageUrl,
        images,
        description,
        wooId,
      ]
    );
    console.log(
      `[WooCommerce Webhook] ✅ CREATED → id=${rows[0].id} sku=${rows[0].sku}`
    );
    return rows[0];
  } catch (err) {
    if (String(err.message).includes("woo_product_id")) {
      const { rows } = await pool.query(
        `INSERT INTO products (
           sku, name, category, stock, selling_price, cost_price,
           image_url, images, description, min_stock
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,5)
         RETURNING id, sku, name, category, stock, selling_price, cost_price, box_id`,
        [
          sku,
          name,
          category,
          stock,
          sellingPrice,
          costPrice,
          imageUrl,
          images,
          description,
        ]
      );
      console.log(
        `[WooCommerce Webhook] ✅ CREATED (no woo_id) → id=${rows[0].id} sku=${rows[0].sku}`
      );
      return rows[0];
    }
    // unique sku race → update
    if (err.code === "23505") {
      const { rows } = await pool.query(
        `UPDATE products SET
           name = $1,
           category = $2,
           stock = $3,
           selling_price = $4,
           image_url = COALESCE($5, image_url),
           description = $6
         WHERE sku = $7
         RETURNING id, sku, name, category, stock, selling_price, cost_price, box_id`,
        [name, category, stock, sellingPrice, imageUrl, description, sku]
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
      console.warn(
        "[WooCommerce Webhook] Invalid signature – continuing anyway"
      );
    }
  } catch (e) {
    console.warn("[WooCommerce Webhook] Signature check error:", e.message);
  }

  // DELETE / TRASH
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
          console.warn(
            "[WooCommerce Webhook] woo_product_id delete skip:",
            colErr.message
          );
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

      console.log(
        `[WooCommerce Webhook] 🗑️ deleted count=${deletedRows.length}`
      );
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
    // Always sync inventory (create + update)
    const row = await syncToDatabase(body);

    // Social ONLY on create — not on update (stops double FB posts)
    const isCreate =
      topic === "product.created" || topic === "product.restored";

    if (isCreate) {
      Promise.allSettled([postToFacebook(body), postToInstagram(body)]).catch(
        () => {}
      );
    } else {
      console.log(
        `[WooCommerce Webhook] topic=${topic} → social skipped (update only)`
      );
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

exports.webhookPing = async (req, res) => {
  res.status(200).json({
    ok: true,
    service: "electrox-inventory",
    time: new Date().toISOString(),
  });
};
