const router = require("express").Router();
const { handleWooCommerceProductWebhook } = require("../controllers/woocommerceWebhookController");

// No auth middleware – WooCommerce calls this endpoint directly
router.post("/woocommerce-product", handleWooCommerceProductWebhook);

module.exports = router;
