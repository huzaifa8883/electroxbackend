const pool = require("../config/db");

// GET /api/boxes — all boxes with product count + total quantity inside
exports.getBoxes = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        b.id, b.box_number, b.rack_location, b.description, b.created_at,
        COUNT(p.id)::int AS product_count,
        COALESCE(SUM(p.stock), 0)::int AS total_quantity
      FROM boxes b
      LEFT JOIN products p ON p.box_id = b.id
      GROUP BY b.id
      ORDER BY b.box_number ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch boxes" });
  }
};

// GET /api/boxes/:id — box detail + all products inside it
exports.getBoxById = async (req, res) => {
  try {
    const { id } = req.params;
    const boxRes = await pool.query(`SELECT * FROM boxes WHERE id = $1`, [id]);
    if (!boxRes.rows.length) return res.status(404).json({ error: "Box not found" });

    const productsRes = await pool.query(
      `SELECT id, sku, name, category, stock, min_stock, selling_price, image_url
       FROM products WHERE box_id = $1 ORDER BY name ASC`,
      [id]
    );

    res.json({
      ...boxRes.rows[0],
      product_count: productsRes.rows.length,
      total_quantity: productsRes.rows.reduce((sum, p) => sum + p.stock, 0),
      products: productsRes.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch box" });
  }
};

// POST /api/boxes
exports.createBox = async (req, res) => {
  const { box_number, rack_location, description } = req.body;
  if (!box_number) return res.status(400).json({ error: "box_number is required" });
  try {
    const { rows } = await pool.query(
      `INSERT INTO boxes (box_number, rack_location, description) VALUES ($1,$2,$3) RETURNING *`,
      [box_number, rack_location, description]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "23505") return res.status(409).json({ error: "Box number already exists" });
    res.status(500).json({ error: "Failed to create box" });
  }
};

// PUT /api/boxes/:id
exports.updateBox = async (req, res) => {
  const { box_number, rack_location, description } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE boxes SET
        box_number = COALESCE($1, box_number),
        rack_location = COALESCE($2, rack_location),
        description = COALESCE($3, description)
       WHERE id = $4 RETURNING *`,
      [box_number, rack_location, description, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Box not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update box" });
  }
};

// DELETE /api/boxes/:id — unassigns products from the box, then deletes it
exports.deleteBox = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE products SET box_id = NULL WHERE box_id = $1`, [req.params.id]);
    const { rowCount } = await client.query(`DELETE FROM boxes WHERE id = $1`, [req.params.id]);
    if (!rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Box not found" });
    }
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to delete box" });
  } finally {
    client.release();
  }
};
