const bcrypt = require("bcryptjs");
const pool = require("../config/db");

// GET /api/users
exports.getUsers = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.full_name, u.is_active, u.created_at,
             r.id AS role_id, r.name AS role_name
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      ORDER BY u.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
};

// POST /api/users  { username, password, full_name, role_id }
exports.createUser = async (req, res) => {
  const { username, password, full_name, role_id } = req.body;
  if (!username || !password || !role_id) {
    return res.status(400).json({ error: "username, password and role_id are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role_id, is_active)
       VALUES ($1,$2,$3,$4,TRUE)
       RETURNING id, username, full_name, role_id, is_active, created_at`,
      [username, passwordHash, full_name || null, role_id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === "23505") return res.status(409).json({ error: "Username already exists" });
    res.status(500).json({ error: "Failed to create user" });
  }
};

// PUT /api/users/:id  { full_name, role_id, is_active, password? }
exports.updateUser = async (req, res) => {
  const { full_name, role_id, is_active, password } = req.body;
  try {
    const target = await pool.query(`SELECT u.*, r.is_system FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [req.params.id]);
    if (!target.rows.length) return res.status(404).json({ error: "User not found" });
    if (target.rows[0].is_system && is_active === false) {
      return res.status(403).json({ error: "Cannot deactivate the Super Admin account" });
    }

    let passwordHash = target.rows[0].password_hash;
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
      passwordHash = await bcrypt.hash(password, 10);
    }

    const { rows } = await pool.query(
      `UPDATE users SET
        full_name = COALESCE($1, full_name),
        role_id = COALESCE($2, role_id),
        is_active = COALESCE($3, is_active),
        password_hash = $4
       WHERE id = $5
       RETURNING id, username, full_name, role_id, is_active, created_at`,
      [full_name, role_id, is_active, passwordHash, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update user" });
  }
};

// DELETE /api/users/:id
exports.deleteUser = async (req, res) => {
  try {
    const target = await pool.query(`SELECT u.*, r.is_system FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [req.params.id]);
    if (!target.rows.length) return res.status(404).json({ error: "User not found" });
    if (target.rows[0].is_system) return res.status(403).json({ error: "Cannot delete the Super Admin account" });

    await pool.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete user" });
  }
};
