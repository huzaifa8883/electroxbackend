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

// Public boxes API (website ↔ inventory sync)
const boxesCtrl = require("./controllers/boxesController");
function publicBoxKeyOk(req) {
  const key = req.headers["x-electrox-key"] || req.query.key || "";
  const secret = process.env.BOXES_API_KEY || process.env.WOOCOMMERCE_WEBHOOK_SECRET || "";
  return secret && key === secret;
}
app.get("/api/public/boxes", boxesCtrl.getBoxes);
app.get("/api/public/boxes/:id", boxesCtrl.getBoxById);
app.post("/api/public/boxes", (req, res) => {
  if (!publicBoxKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
  return boxesCtrl.createBox(req, res);
});
app.put("/api/public/boxes/:id", (req, res) => {
  if (!publicBoxKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
  return boxesCtrl.updateBox(req, res);
});
app.delete("/api/public/boxes/:id", (req, res) => {
  if (!publicBoxKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
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
