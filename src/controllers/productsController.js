const pool = require("../config/db");

// Optional: inventory → website sync (do not crash app if file missing)
let syncProductToWoo = async () => null;
try {
  syncProductToWoo = require("./wooSync").syncProductToWoo;
} catch (e) {
  console.warn("[productsController] wooSync.js not loaded — website push disabled:", e.message);
}
let postProductToSocial = async () => null;
try {
  postProductToSocial = require("./socialPost").postProductToSocial;
} catch (e) {
  console.warn("[productsController] socialPost.js not loaded:", e.message);
}

// POST /api/products/upload-image — multipart/form-data field "image"
exports.uploadImage = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image file uploaded" });
  res.status(201).json({ url: `/uploads/products/${req.file.filename}` });
};

// GET /api/products?search=&category=&box_id=&low_stock=true
exports.getProducts = async (req, res) => {
  try {
    const { search, category, box_id, low_stock } = req.query;
    const clauses = [];
    const values = [];

    if (search) {
      values.push(`%${search}%`);
      clauses.push(`(p.name ILIKE $${values.length} OR p.sku ILIKE $${values.length} OR p.category ILIKE $${values.length} OR b.box_number ILIKE $${values.length})`);
    }
    if (category) {
      values.push(category);
      clauses.push(`p.category = $${values.length}`);
    }
    if (box_id) {
      values.push(box_id);
      clauses.push(`p.box_id = $${values.length}`);
    }
    if (low_stock === "true") {
      clauses.push(`p.stock <= p.min_stock`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `SELECT p.*, s.name AS supplier_name, b.box_number
       FROM products p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN boxes b ON b.id = p.box_id
       ${where}
       ORDER BY p.created_at DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
};

exports.getProductById = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, s.name AS supplier_name, b.box_number
       FROM products p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN boxes b ON b.id = p.box_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch product" });
  }
};

// Normalize images array from body (string JSON or array)
function normalizeImages(images, image_url) {
  let imgs = [];
  if (Array.isArray(images)) {
    imgs = images.filter(Boolean);
  } else if (typeof images === "string" && images.trim()) {
    try {
      const parsed = JSON.parse(images);
      if (Array.isArray(parsed)) imgs = parsed.filter(Boolean);
    } catch {
      imgs = images.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  // Ensure primary image_url is first in gallery if present
  if (image_url && !imgs.includes(image_url)) {
    imgs = [image_url, ...imgs];
  }
  // Cap at 7
  return imgs.slice(0, 7);
}

// POST /api/products
exports.createProduct = async (req, res) => {
  const {
    sku, name, category, stock = 0, min_stock = 5,
    cost_price = 0, selling_price = 0, regular_price = 0, supplier_id, box_id,
    image_url, description, images,
    meta_description, tags, focus_keyword, weight,
    sync_to_website = true,
  } = req.body;

  if (!sku || !name) {
    return res.status(400).json({ error: "sku and name are required" });
  }

  const imgs = normalizeImages(images, image_url);
  const cover = imgs[0] || image_url || null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const reg = Number(regular_price) || Number(selling_price) || 0;
    const sale = Number(selling_price) || 0;
    const { rows } = await client.query(
      `INSERT INTO products
        (sku, name, category, stock, min_stock, cost_price, selling_price, regular_price,
         supplier_id, box_id, image_url, images, description,
         meta_description, tags, focus_keyword, weight, sync_to_website)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        sku, name, category || null,
        Number(stock) || 0, Number(min_stock) || 5,
        Number(cost_price) || 0, sale, reg,
        supplier_id || null, box_id || null,
        cover, imgs, description || null,
        meta_description || null, tags || null,
        focus_keyword || null, Number(weight) || 0,
        sync_to_website === false || sync_to_website === "false" ? false : true,
      ]
    );
    const product = rows[0];

    if (Number(stock) > 0) {
      await client.query(
        `INSERT INTO stock_ledger (product_id, type, quantity_changed, balance_after, reference)
         VALUES ($1, 'adjustment', $2, $2, 'Initial stock')`,
        [product.id, Number(stock)]
      );
    }

    await client.query("COMMIT");

    // Respond immediately — website sync in background (fast UI, no double-click lag)
    res.status(201).json({ ...product, website_sync: "queued" });
    setImmediate(async () => {
      try {
        const w = await syncProductToWoo({ ...product, _allowCreate: true });
        console.log("[createProduct] website sync OK", product.sku, w?.id);
        // Use website permalink if available for caption link
        const forSocial = {
          ...product,
          permalink: w?.permalink || product.permalink,
          images: w?.images || product.images,
          image_url: product.image_url,
          regular_price: product.regular_price,
          sale_price: product.selling_price,
          price: product.selling_price,
        };
        await postProductToSocial(forSocial);
      } catch (e) {
        console.error("[createProduct] website/social:", e.message);
      }
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    if (err.code === "23505") return res.status(409).json({ error: "SKU already exists" });
    if (err.message && err.message.includes("column")) {
      console.error("[createProduct] column missing, retrying without website fields:", err.message);
      try {
        const imgs2 = normalizeImages(req.body.images, req.body.image_url);
        const cover2 = imgs2[0] || req.body.image_url || null;
        const { rows: rows2 } = await pool.query(
          `INSERT INTO products
            (sku, name, category, stock, min_stock, cost_price, selling_price,
             supplier_id, box_id, image_url, images, description, characteristics, location)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING *`,
          [
            req.body.sku, req.body.name, req.body.category || null,
            Number(req.body.stock) || 0, Number(req.body.min_stock) || 5,
            Number(req.body.cost_price) || 0, Number(req.body.selling_price) || 0,
            req.body.supplier_id || null, req.body.box_id || null,
            cover2, imgs2, req.body.description || null, req.body.characteristics || null, req.body.location || null,
          ]
        );
        const product2 = rows2[0];
        let website = null, website_error = "Run migrate_website_fields.sql to enable SEO fields + full website sync meta";
        try { website = await syncProductToWoo({ ...product2, ...req.body }); } catch (e) { website_error = e.message; }
        return res.status(201).json({ ...product2, website, website_error });
      } catch (err2) {
        console.error(err2);
        return res.status(500).json({
          error: "Database missing website fields. Run as postgres: psql -U postgres -d electrox_pro -f migrate_website_fields.sql",
          detail: err.message,
        });
      }
    }
    res.status(500).json({ error: "Failed to create product" });
  } finally {
    client.release();
  }
};

// PUT /api/products/:id
exports.updateProduct = async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};

  const fields = [
    "sku", "name", "category", "min_stock", "cost_price", "selling_price", "regular_price",
    "supplier_id", "box_id", "description",
    "meta_description", "tags", "focus_keyword", "weight",
    "sync_to_website",
  ];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: currentRows } = await client.query(
      `SELECT * FROM products WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!currentRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Product not found" });
    }
    const current = currentRows[0];

    const updates = [];
    const values = [];

    fields.forEach((f) => {
      if (body[f] !== undefined) {
        let val = body[f];
        if (["min_stock", "cost_price", "selling_price", "regular_price", "weight"].includes(f)) val = Number(val) || 0;
        if (["supplier_id", "box_id"].includes(f) && (val === "" || val === null)) val = null;
        if (f === "sync_to_website") val = val === false || val === "false" ? false : true;
        values.push(val);
        updates.push(`${f} = $${values.length}`);
      }
    });

    if (body.images !== undefined || body.image_url !== undefined) {
      const cover = body.image_url !== undefined ? body.image_url : current.image_url;
      const imgs = normalizeImages(
        body.images !== undefined ? body.images : current.images,
        cover
      );
      const finalCover = imgs[0] || cover || null;
      values.push(finalCover);
      updates.push(`image_url = $${values.length}`);
      values.push(imgs);
      updates.push(`images = $${values.length}`);
    }

    if (body.stock !== undefined) {
      const newStock = Number(body.stock);
      if (!Number.isNaN(newStock) && newStock !== Number(current.stock)) {
        const delta = newStock - Number(current.stock);
        values.push(newStock);
        updates.push(`stock = $${values.length}`);
        await client.query(
          `INSERT INTO stock_ledger (product_id, type, quantity_changed, balance_after, reference)
           VALUES ($1, 'adjustment', $2, $3, $4)`,
          [id, delta, newStock, body.stock_note || "Manual stock edit"]
        );
      }
    }

    if (!updates.length) {
      await client.query("ROLLBACK");
      return res.json(current);
    }

    values.push(id);
    const { rows } = await client.query(
      `UPDATE products SET ${updates.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values
    );

    await client.query("COMMIT");
    const product = rows[0];

    res.json({ ...product, website_sync: "queued" });
    setImmediate(() => {
      // Updates never create new website products (prevents duplicates on stock change)
      syncProductToWoo({ ...product, _allowCreate: false }).then((w) => {
        console.log("[updateProduct] website sync OK", product.sku, w?.id);
      }).catch((e) => {
        console.error("[updateProduct] website sync:", e.message);
      });
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    if (err.code === "23505") return res.status(409).json({ error: "SKU already exists" });
    res.status(500).json({ error: "Failed to update product" });
  } finally {
    client.release();
  }
};

// PATCH /api/products/:id/box  { box_id }
exports.assignBox = async (req, res) => {
  const { id } = req.params;
  const { box_id } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE products SET box_id = $1 WHERE id = $2 RETURNING *`,
      [box_id || null, id]
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to assign box" });
  }
};

// PATCH /api/products/:id/stock  { quantity_changed, type, reference }
exports.adjustStock = async (req, res) => {
  const { id } = req.params;
  const { quantity_changed, type = "adjustment", reference = "" } = req.body;

  if (quantity_changed === undefined || quantity_changed === null || isNaN(Number(quantity_changed))) {
    return res.status(400).json({ error: "quantity_changed (number) is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: prodRows } = await client.query(
      `UPDATE products SET stock = stock + $1 WHERE id = $2 RETURNING *`,
      [Number(quantity_changed), id]
    );
    if (!prodRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Product not found" });
    }
    const product = prodRows[0];
    if (product.stock < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient stock" });
    }

    await client.query(
      `INSERT INTO stock_ledger (product_id, type, quantity_changed, balance_after, reference)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, type, Number(quantity_changed), product.stock, reference]
    );

    await client.query("COMMIT");
    res.json(product);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to adjust stock" });
  } finally {
    client.release();
  }
};

exports.deleteProduct = async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: prodRows } = await client.query(
      `SELECT * FROM products WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!prodRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Product not found" });
    }
    const product = prodRows[0];

    const { rows: saleCheck } = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM sale_items WHERE product_id = $1`,
      [id]
    );
    if (saleCheck[0].cnt > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error:
          "Cannot delete this product because it has sales history. Remove related sales first, or keep the product for records.",
      });
    }

    const { rowCount } = await client.query(
      `DELETE FROM products WHERE id = $1`,
      [id]
    );
    if (!rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Product not found" });
    }

    await client.query("COMMIT");

    // Delete from WooCommerce (best-effort, does not fail inventory delete)
    let website_error = null;
    try {
      const { wcClient } = require("./wooSync");
      const clientWoo = wcClient();
      if (clientWoo) {
        let wooId = product.woo_product_id ? Number(product.woo_product_id) : null;

        // 1) by woo_product_id
        if (wooId) {
          try {
            await clientWoo.delete(`/products/${wooId}`, {
              params: { force: true },
            });
            console.log("[deleteProduct] website deleted by woo_id=", wooId);
            wooId = null; // done
          } catch (e) {
            if (e.response?.status !== 404) {
              console.warn(
                "[deleteProduct] delete by woo_id failed:",
                e.response?.data || e.message
              );
            }
          }
        }

        // 2) by SKU if still needed
        if (product.sku) {
          try {
            const { data: found } = await clientWoo.get("/products", {
              params: { sku: product.sku, per_page: 5 },
            });
            const matches = Array.isArray(found) ? found : [];
            for (const p of matches) {
              if (String(p.sku || "").trim() === String(product.sku).trim()) {
                await clientWoo.delete(`/products/${p.id}`, {
                  params: { force: true },
                });
                console.log(
                  "[deleteProduct] website deleted by sku id=",
                  p.id
                );
              }
            }
          } catch (e) {
            website_error = e.response?.data
              ? JSON.stringify(e.response.data)
              : e.message;
            console.error("[deleteProduct] website delete by sku:", website_error);
          }
        }
      } else {
        website_error = "WC credentials missing";
        console.warn("[deleteProduct] WC client null — website not deleted");
      }
    } catch (e) {
      website_error = e.message;
      console.error("[deleteProduct] website delete:", e.message);
    }

    res.json({ success: true, website_error });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    if (err.code === "23503") {
      return res.status(409).json({
        error:
          "Cannot delete this product because it is linked to sales or other records.",
      });
    }
    res.status(500).json({ error: "Failed to delete product" });
  } finally {
    client.release();
  }
};
