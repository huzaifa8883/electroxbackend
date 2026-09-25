const pool = require("../config/db");

/* ---------------- Suppliers ---------------- */
exports.getSuppliers = async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM suppliers ORDER BY name`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch suppliers" });
  }
};
exports.createSupplier = async (req, res) => {
  try {
    const { name, phone, city } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const { rows } = await pool.query(
      `INSERT INTO suppliers (name, phone, city) VALUES ($1,$2,$3) RETURNING *`,
      [name, phone, city]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create supplier" });
  }
};
exports.updateSupplier = async (req, res) => {
  try {
    const { name, phone, city } = req.body;
    const { rows } = await pool.query(
      `UPDATE suppliers SET name=COALESCE($1,name), phone=COALESCE($2,phone), city=COALESCE($3,city)
       WHERE id=$4 RETURNING *`,
      [name, phone, city, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Supplier not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update supplier" });
  }
};
exports.deleteSupplier = async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM suppliers WHERE id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "Supplier not found" });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete supplier" });
  }
};

/* ---------------- Customers ---------------- */
exports.getCustomers = async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM customers ORDER BY name`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch customers" });
  }
};
exports.createCustomer = async (req, res) => {
  try {
    const { name, phone, city } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const { rows } = await pool.query(
      `INSERT INTO customers (name, phone, city) VALUES ($1,$2,$3) RETURNING *`,
      [name, phone, city]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create customer" });
  }
};
exports.updateCustomer = async (req, res) => {
  try {
    const { name, phone, city } = req.body;
    const { rows } = await pool.query(
      `UPDATE customers SET name=COALESCE($1,name), phone=COALESCE($2,phone), city=COALESCE($3,city)
       WHERE id=$4 RETURNING *`,
      [name, phone, city, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Customer not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update customer" });
  }
};
exports.deleteCustomer = async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM customers WHERE id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "Customer not found" });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete customer" });
  }
};

/* ---------------- Purchase Orders ---------------- */
exports.getPurchaseOrders = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT po.*, s.name AS supplier_name, p.name AS product_name, p.sku
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id
      LEFT JOIN products p ON p.id = po.product_id
      ORDER BY po.date DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch purchase orders" });
  }
};

exports.createPurchaseOrder = async (req, res) => {
  try {
    const { supplier_id, product_id, quantity, cost } = req.body;
    if (!product_id || !quantity || !cost) {
      return res.status(400).json({ error: "product_id, quantity and cost are required" });
    }
    const poNumber = `PO-${Date.now()}`;
    const { rows } = await pool.query(
      `INSERT INTO purchase_orders (po_number, supplier_id, product_id, quantity, cost, status)
       VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *`,
      [poNumber, supplier_id || null, product_id, quantity, cost]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create purchase order" });
  }
};

// PATCH /api/purchase-orders/:id/receive — marks PO received & adds stock
exports.receivePurchaseOrder = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const poRes = await client.query(`SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!poRes.rows.length) throw { status: 404, message: "Purchase order not found" };
    const po = poRes.rows[0];
    if (po.status === "received") throw { status: 400, message: "Already received" };

    const prodRes = await client.query(
      `UPDATE products SET stock = stock + $1 WHERE id = $2 RETURNING stock`,
      [po.quantity, po.product_id]
    );

    await client.query(
      `INSERT INTO stock_ledger (product_id, type, quantity_changed, balance_after, reference)
       VALUES ($1,'purchase',$2,$3,$4)`,
      [po.product_id, po.quantity, prodRes.rows[0].stock, po.po_number]
    );

    const updated = await client.query(
      `UPDATE purchase_orders SET status='received' WHERE id=$1 RETURNING *`,
      [req.params.id]
    );

    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Failed to receive PO" });
  } finally {
    client.release();
  }
};

/* ---------------- Stock Ledger ---------------- */
exports.getStockLedger = async (req, res) => {
  try {
    const { product_id } = req.query;
    const values = [];
    let where = "";
    if (product_id) {
      values.push(product_id);
      where = `WHERE sl.product_id = $1`;
    }
    const { rows } = await pool.query(
      `SELECT sl.*, p.name AS product_name, p.sku
       FROM stock_ledger sl
       JOIN products p ON p.id = sl.product_id
       ${where}
       ORDER BY sl.created_at DESC
       LIMIT 200`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch stock ledger" });
  }
};
