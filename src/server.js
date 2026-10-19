require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const productsRoutes = require("./routes/products");
const apiRoutes = require("./routes/index");
const authRoutes = require("./routes/auth");
const webhooksRoutes = require("./routes/webhooks");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

// Serve uploaded product images
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

// ========== PUBLIC ROUTES (NO AUTH) — FIRST ==========
app.use("/webhooks", webhooksRoutes);
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Public boxes list (for website All Boxes page) — read only
const boxesCtrl = require("./controllers/boxesController");
app.get("/api/public/boxes", boxesCtrl.getBoxes);
app.get("/api/public/boxes/:id", boxesCtrl.getBoxById);

// Public box delete — requires header X-Electrox-Key matching WOOCOMMERCE_WEBHOOK_SECRET or BOXES_API_KEY
app.delete("/api/public/boxes/:id", async (req, res) => {
  const key = req.headers["x-electrox-key"] || req.query.key || "";
  const secret = process.env.BOXES_API_KEY || process.env.WOOCOMMERCE_WEBHOOK_SECRET || "";
  if (!secret || key !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return boxesCtrl.deleteBox(req, res);
});

// ========== AUTH + PROTECTED ROUTES ==========
app.use("/api", authRoutes);
app.use("/api/products", productsRoutes);
app.use("/api", apiRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Electrox Pro API running on port ${PORT}`));
