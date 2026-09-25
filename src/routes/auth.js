const router = require("express").Router();
const auth = require("../controllers/authController");
const users = require("../controllers/usersController");
const roles = require("../controllers/rolesController");
const { verifyToken, requirePermission } = require("../middleware/auth");

// Public
router.post("/auth/login", auth.login);

// Authenticated
router.get("/auth/me", verifyToken, auth.me);

// User management — gated behind the "users" module permission
router.get("/users", verifyToken, requirePermission("users", "view"), users.getUsers);
router.post("/users", verifyToken, requirePermission("users", "create"), users.createUser);
router.put("/users/:id", verifyToken, requirePermission("users", "edit"), users.updateUser);
router.delete("/users/:id", verifyToken, requirePermission("users", "delete"), users.deleteUser);

// Role management — also gated behind "users" module (role config is part of user administration)
router.get("/roles", verifyToken, requirePermission("users", "view"), roles.getRoles);
router.post("/roles", verifyToken, requirePermission("users", "create"), roles.createRole);
router.put("/roles/:id", verifyToken, requirePermission("users", "edit"), roles.updateRole);
router.delete("/roles/:id", verifyToken, requirePermission("users", "delete"), roles.deleteRole);

module.exports = router;
