const router = require("express").Router();
const { handleWooCommerceProductWebhook } = require("../controllers/woocommerceWebhookController");

// No auth — WooCommerce calls this directly
router.post("/woocommerce-product", handleWooCommerceProductWebhook);

module.exports = router;
