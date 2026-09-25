const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const { JWT_SECRET } = require("../middleware/auth");

async function getPermissionsForRole(roleId) {
  const { rows } = await pool.query(
    `SELECT module, can_view, can_create, can_edit, can_delete
     FROM permissions WHERE role_id = $1`,
    [roleId]
  );
  return rows;
}

// POST /api/auth/login  { username, password }
exports.login = async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT u.*, r.name AS role_name, r.is_system
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.username = $1`,
      [username]
    );

    const user = rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid username or password" });

    const permissions = await getPermissionsForRole(user.role_id);

    const payload = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role_id: user.role_id,
      role_name: user.role_name,
      is_system: user.is_system,
      permissions,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
    res.json({ token, user: payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
};

// GET /api/auth/me — refresh current user's permissions (call after role edits)
exports.me = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role_id, r.name AS role_name, r.is_system
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    const permissions = await getPermissionsForRole(rows[0].role_id);
    res.json({ ...rows[0], permissions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch current user" });
  }
};
