const router = require("express").Router();

const boxes = require("../controllers/boxesController");
const pos = require("../controllers/posController");
const dashboard = require("../controllers/dashboardController");
const misc = require("../controllers/miscControllers");
const { verifyToken, requirePermission } = require("../middleware/auth");

router.use(verifyToken);

// Boxes
router.get("/boxes", requirePermission("boxes", "view"), boxes.getBoxes);
router.get("/boxes/:id", requirePermission("boxes", "view"), boxes.getBoxById);
router.post("/boxes", requirePermission("boxes", "create"), boxes.createBox);
router.put("/boxes/:id", requirePermission("boxes", "edit"), boxes.updateBox);
router.delete("/boxes/:id", requirePermission("boxes", "delete"), boxes.deleteBox);

// Sales & Invoices (invoice creation lives under the "sales" module now)
router.post("/pos/checkout", requirePermission("sales", "create"), pos.checkout);
router.get("/pos/sales", requirePermission("sales", "view"), pos.getSales);
router.get("/pos/sales/:id", requirePermission("sales", "view"), pos.getSaleById);

// Dashboard
router.get("/dashboard/stats", requirePermission("dashboard", "view"), dashboard.getStats);
router.get("/dashboard/top-sellers", requirePermission("dashboard", "view"), dashboard.getTopSellers);
router.get("/dashboard/low-stock", requirePermission("dashboard", "view"), dashboard.getLowStock);
router.get("/dashboard/revenue-graph", requirePermission("dashboard", "view"), dashboard.getRevenueGraph);

// Suppliers
router.get("/suppliers", requirePermission("suppliers", "view"), misc.getSuppliers);
router.post("/suppliers", requirePermission("suppliers", "create"), misc.createSupplier);
router.put("/suppliers/:id", requirePermission("suppliers", "edit"), misc.updateSupplier);
router.delete("/suppliers/:id", requirePermission("suppliers", "delete"), misc.deleteSupplier);

// Customers
router.get("/customers", requirePermission("customers", "view"), misc.getCustomers);
router.post("/customers", requirePermission("customers", "create"), misc.createCustomer);
router.put("/customers/:id", requirePermission("customers", "edit"), misc.updateCustomer);
router.delete("/customers/:id", requirePermission("customers", "delete"), misc.deleteCustomer);

// Purchase Orders
router.get("/purchase-orders", requirePermission("purchase_orders", "view"), misc.getPurchaseOrders);
router.post("/purchase-orders", requirePermission("purchase_orders", "create"), misc.createPurchaseOrder);
router.patch("/purchase-orders/:id/receive", requirePermission("purchase_orders", "edit"), misc.receivePurchaseOrder);

// Stock Ledger
router.get("/stock-ledger", requirePermission("stock_ledger", "view"), misc.getStockLedger);

module.exports = router;
