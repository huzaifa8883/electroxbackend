require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const productsRoutes = require("./routes/products");
const apiRoutes = require("./routes/index");
const authRoutes = require("./routes/auth");

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// Serve uploaded product images
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.use("/api", authRoutes);       // /api/auth/login, /api/users, /api/roles
app.use("/api/products", productsRoutes);
app.use("/api", apiRoutes);

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Electrox Pro API running on port ${PORT}`));
