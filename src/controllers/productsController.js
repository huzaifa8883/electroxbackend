const pool = require("../config/db");

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

// POST /api/products
exports.createProduct = async (req, res) => {
  const {
    sku, name, category, stock = 0, min_stock = 5,
    cost_price = 0, selling_price = 0, supplier_id, box_id,
    image_url, location,
  } = req.body;

  if (!sku || !name) {
    return res.status(400).json({ error: "sku and name are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO products
        (sku, name, category, stock, min_stock, cost_price, selling_price, supplier_id, box_id, image_url, location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [sku, name, category, stock, min_stock, cost_price, selling_price, supplier_id || null, box_id || null, image_url, location]
    );

    const product = rows[0];

    if (stock > 0) {
      await client.query(
        `INSERT INTO stock_ledger (product_id, type, quantity_changed, balance_after, reference)
         VALUES ($1, 'adjustment', $2, $2, 'Initial stock')`,
        [product.id, stock]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(product);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    if (err.code === "23505") return res.status(409).json({ error: "SKU already exists" });
    res.status(500).json({ error: "Failed to create product" });
  } finally {
    client.release();
  }
};

// PUT /api/products/:id
exports.updateProduct = async (req, res) => {
  const { id } = req.params;
  const fields = ["sku","name","category","min_stock","cost_price","selling_price","supplier_id","box_id","image_url","location"];
  const updates = [];
  const values = [];

  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      values.push(req.body[f]);
      updates.push(`${f} = $${values.length}`);
    }
  });

  if (!updates.length) return res.status(400).json({ error: "No fields to update" });

  values.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE products SET ${updates.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update product" });
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

  if (!quantity_changed || isNaN(quantity_changed)) {
    return res.status(400).json({ error: "quantity_changed (number) is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: prodRows } = await client.query(
      `UPDATE products SET stock = stock + $1 WHERE id = $2 RETURNING *`,
      [quantity_changed, id]
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
      [id, type, quantity_changed, product.stock, reference]
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
  try {
    const { rowCount } = await pool.query(`DELETE FROM products WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "Product not found" });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete product" });
  }
};
