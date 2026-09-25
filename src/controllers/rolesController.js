const pool = require("../config/db");

const MODULES = [
  "dashboard", "products", "boxes",
  "customers", "sales", "stock_ledger", "reports", "users",
];

// GET /api/roles — list roles with their permission sets
exports.getRoles = async (req, res) => {
  try {
    const { rows: roles } = await pool.query(`SELECT * FROM roles ORDER BY id ASC`);
    const { rows: perms } = await pool.query(`SELECT * FROM permissions`);
    const result = roles.map((r) => ({
      ...r,
      permissions: perms.filter((p) => p.role_id === r.id),
    }));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch roles" });
  }
};

// POST /api/roles  { name, permissions: [{module, can_view, can_create, can_edit, can_delete}] }
exports.createRole = async (req, res) => {
  const { name, permissions = [] } = req.body;
  if (!name) return res.status(400).json({ error: "Role name is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const roleRes = await client.query(
      `INSERT INTO roles (name, is_system) VALUES ($1, FALSE) RETURNING *`,
      [name]
    );
    const role = roleRes.rows[0];

    for (const module of MODULES) {
      const p = permissions.find((x) => x.module === module) || {};
      await client.query(
        `INSERT INTO permissions (role_id, module, can_view, can_create, can_edit, can_delete)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [role.id, module, !!p.can_view, !!p.can_create, !!p.can_edit, !!p.can_delete]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(role);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    if (err.code === "23505") return res.status(409).json({ error: "Role name already exists" });
    res.status(500).json({ error: "Failed to create role" });
  } finally {
    client.release();
  }
};

// PUT /api/roles/:id  { name, permissions: [...] }
exports.updateRole = async (req, res) => {
  const { id } = req.params;
  const { name, permissions = [] } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const roleRes = await client.query(`SELECT * FROM roles WHERE id = $1`, [id]);
    if (!roleRes.rows.length) throw { status: 404, message: "Role not found" };
    if (roleRes.rows[0].is_system) throw { status: 403, message: "Cannot modify the Super Admin role" };

    if (name) {
      await client.query(`UPDATE roles SET name = $1 WHERE id = $2`, [name, id]);
    }

    for (const p of permissions) {
      if (!MODULES.includes(p.module)) continue;
      await client.query(
        `INSERT INTO permissions (role_id, module, can_view, can_create, can_edit, can_delete)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (role_id, module) DO UPDATE
         SET can_view=$3, can_create=$4, can_edit=$5, can_delete=$6`,
        [id, p.module, !!p.can_view, !!p.can_create, !!p.can_edit, !!p.can_delete]
      );
    }

    await client.query("COMMIT");
    const { rows } = await pool.query(`SELECT * FROM roles WHERE id = $1`, [id]);
    res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Failed to update role" });
  } finally {
    client.release();
  }
};

// DELETE /api/roles/:id
exports.deleteRole = async (req, res) => {
  try {
    const roleRes = await pool.query(`SELECT * FROM roles WHERE id = $1`, [req.params.id]);
    if (!roleRes.rows.length) return res.status(404).json({ error: "Role not found" });
    if (roleRes.rows[0].is_system) return res.status(403).json({ error: "Cannot delete the Super Admin role" });

    const inUse = await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE role_id = $1`, [req.params.id]);
    if (inUse.rows[0].count > 0) {
      return res.status(400).json({ error: "Cannot delete a role that has users assigned to it" });
    }

    await pool.query(`DELETE FROM roles WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete role" });
  }
};

exports.MODULES = MODULES;
