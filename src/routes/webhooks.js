const router = require("express").Router();
const { handleWooCommerceProductWebhook } = require("../controllers/woocommerceWebhookController");
const boxesCtrl = require("../controllers/boxesController");

// No auth — WooCommerce calls this directly
router.post("/woocommerce-product", handleWooCommerceProductWebhook);

// Boxes sync for website (key required for write; list is public)
function boxKeyOk(req) {
  const key = req.headers["x-electrox-key"] || req.query.key || "";
  const secret = process.env.BOXES_API_KEY || process.env.WOOCOMMERCE_WEBHOOK_SECRET || "";
  return secret && key === secret;
}

router.get("/boxes", boxesCtrl.getBoxes);
router.get("/boxes/:id", boxesCtrl.getBoxById);

router.post("/boxes", (req, res) => {
  if (!boxKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
  return boxesCtrl.createBox(req, res);
});

router.put("/boxes/:id", (req, res) => {
  if (!boxKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
  return boxesCtrl.updateBox(req, res);
});

// Also accept POST with _method=PUT for hosts that block PUT
router.post("/boxes/:id", (req, res) => {
  if (!boxKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
  const method = (req.body && req.body._method) || req.query._method || "";
  if (String(method).toUpperCase() === "DELETE") {
    return boxesCtrl.deleteBox(req, res);
  }
  return boxesCtrl.updateBox(req, res);
});

router.delete("/boxes/:id", (req, res) => {
  if (!boxKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
  return boxesCtrl.deleteBox(req, res);
});

module.exports = router;
