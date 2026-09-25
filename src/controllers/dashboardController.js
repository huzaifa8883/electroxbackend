const pool = require("../config/db");

// GET /api/dashboard/stats
exports.getStats = async (req, res) => {
  try {
    const [productsCount, lowStock, todaySales, totalRevenue] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM products`),
      pool.query(`SELECT COUNT(*)::int AS count FROM products WHERE stock <= min_stock`),
      pool.query(`SELECT COALESCE(SUM(total),0)::numeric AS total, COUNT(*)::int AS count
                  FROM sales WHERE date::date = CURRENT_DATE AND status = 'completed'`),
      pool.query(`SELECT COALESCE(SUM(total),0)::numeric AS total, COALESCE(SUM(profit),0)::numeric AS profit
                  FROM sales WHERE status = 'completed'`),
    ]);

    res.json({
      total_products: productsCount.rows[0].count,
      low_stock_count: lowStock.rows[0].count,
      today_sales_total: todaySales.rows[0].total,
      today_sales_count: todaySales.rows[0].count,
      total_revenue: totalRevenue.rows[0].total,
      total_profit: totalRevenue.rows[0].profit,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
};

// GET /api/dashboard/top-sellers?limit=5
exports.getTopSellers = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.sku, SUM(si.quantity)::int AS units_sold,
              SUM(si.line_total)::numeric AS revenue
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       GROUP BY p.id
       ORDER BY units_sold DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch top sellers" });
  }
};

// GET /api/dashboard/low-stock
exports.getLowStock = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, b.box_number FROM products p
       LEFT JOIN boxes b ON b.id = p.box_id
       WHERE p.stock <= p.min_stock
       ORDER BY p.stock ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch low stock items" });
  }
};

// GET /api/dashboard/revenue-graph?days=14
exports.getRevenueGraph = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 14;
    const { rows } = await pool.query(
      `SELECT date_trunc('day', date)::date AS day,
              COALESCE(SUM(total),0)::numeric AS revenue,
              COALESCE(SUM(profit),0)::numeric AS profit
       FROM sales
       WHERE date >= CURRENT_DATE - $1::int
         AND status = 'completed'
       GROUP BY day
       ORDER BY day ASC`,
      [days]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch revenue graph" });
  }
};
