const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "electrox-pro-dev-secret-change-me";

// Verifies the JWT and attaches { id, username, role_id, role_name, is_system, permissions } to req.user
function verifyToken(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token provided" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// requirePermission("products", "edit") — Super Admin (is_system) always passes.
function requirePermission(module, action = "view") {
  const field = `can_${action}`;
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (req.user.is_system) return next(); // superadmin / system role bypasses all checks

    const perm = (req.user.permissions || []).find((p) => p.module === module);
    if (!perm || !perm[field]) {
      return res.status(403).json({ error: `You don't have permission to ${action} ${module}` });
    }
    next();
  };
}

module.exports = { verifyToken, requirePermission, JWT_SECRET };
