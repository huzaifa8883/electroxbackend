const pool = require("../config/db");

// POST /api/pos/checkout
// body: { customer_id, items: [{product_id, quantity, unit_price}], discount, tax, payment_method }
exports.checkout = async (req, res) => {
  const { customer_id, items, discount = 0, tax = 0, payment_method = "cash" } = req.body;

  if (!items || !items.length) {
    return res.status(400).json({ error: "At least one item is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let subtotal = 0;
    let totalCost = 0;
    const lineItems = [];

    for (const item of items) {
      const { rows } = await client.query(
        `SELECT * FROM products WHERE id = $1 FOR UPDATE`,
        [item.product_id]
      );
      if (!rows.length) throw { status: 404, message: `Product ${item.product_id} not found` };
      const product = rows[0];

      if (product.stock < item.quantity) {
        throw { status: 400, message: `Insufficient stock for ${product.name} (have ${product.stock}, need ${item.quantity})` };
      }

      const unitPrice = item.unit_price ?? product.selling_price;
      const lineTotal = unitPrice * item.quantity;
      subtotal += lineTotal;
      totalCost += product.cost_price * item.quantity;

      lineItems.push({
        product_id: product.id,
        quantity: item.quantity,
        unit_price: unitPrice,
        unit_cost: product.cost_price,
        line_total: lineTotal,
      });
    }

    const total = subtotal - discount + tax;
    const profit = subtotal - totalCost - discount;
    const invoiceNo = `INV-${Date.now()}`;

    const saleRes = await client.query(
      `INSERT INTO sales (invoice_no, customer_id, total, discount, tax, profit, payment_method, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'completed') RETURNING *`,
      [invoiceNo, customer_id || null, total, discount, tax, profit, payment_method]
    );
    const sale = saleRes.rows[0];

    for (const li of lineItems) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, unit_cost, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sale.id, li.product_id, li.quantity, li.unit_price, li.unit_cost, li.line_total]
      );

      const updateRes = await client.query(
        `UPDATE products SET stock = stock - $1 WHERE id = $2 RETURNING stock`,
        [li.quantity, li.product_id]
      );

      await client.query(
        `INSERT INTO stock_ledger (product_id, type, quantity_changed, balance_after, reference)
         VALUES ($1, 'sale', $2, $3, $4)`,
        [li.product_id, -li.quantity, updateRes.rows[0].stock, invoiceNo]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ ...sale, items: lineItems });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Checkout failed" });
  } finally {
    client.release();
  }
};

// GET /api/pos/sales — recent sales list
exports.getSales = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, c.name AS customer_name
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      ORDER BY s.date DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch sales" });
  }
};

// GET /api/pos/sales/:id — invoice detail with line items
exports.getSaleById = async (req, res) => {
  try {
    const saleRes = await pool.query(`SELECT * FROM sales WHERE id = $1`, [req.params.id]);
    if (!saleRes.rows.length) return res.status(404).json({ error: "Sale not found" });

    const itemsRes = await pool.query(
      `SELECT si.*, p.name, p.sku FROM sale_items si
       JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = $1`,
      [req.params.id]
    );

    res.json({ ...saleRes.rows[0], items: itemsRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch sale" });
  }
};
