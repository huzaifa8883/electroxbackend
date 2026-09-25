const router = require("express").Router();
const c = require("../controllers/productsController");
const upload = require("../middleware/upload");
const { verifyToken, requirePermission } = require("../middleware/auth");

router.use(verifyToken);

// Allows the upload if the user can either create or edit products
function canUploadImage(req, res, next) {
  if (req.user?.is_system) return next();
  const perm = (req.user?.permissions || []).find((p) => p.module === "products");
  if (perm?.can_create || perm?.can_edit) return next();
  return res.status(403).json({ error: "You don't have permission to upload product images" });
}

router.post("/upload-image", canUploadImage, upload.single("image"), c.uploadImage);

router.get("/", requirePermission("products", "view"), c.getProducts);
router.get("/:id", requirePermission("products", "view"), c.getProductById);
router.post("/", requirePermission("products", "create"), c.createProduct);
router.put("/:id", requirePermission("products", "edit"), c.updateProduct);
router.patch("/:id/box", requirePermission("products", "edit"), c.assignBox);
router.patch("/:id/stock", requirePermission("products", "edit"), c.adjustStock);
router.delete("/:id", requirePermission("products", "delete"), c.deleteProduct);

module.exports = router;
