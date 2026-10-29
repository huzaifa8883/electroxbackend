
/**
 * Copy energy products from Electrox WooCommerce → VoltBank WooCommerce
 * by CATEGORY (not inventory category field).
 *
 * This fixes mismatch: Electrox Cables = 103 but inventory.category
 * only tagged ~42 as cable*.
 *
 * Usage (on server, electroxbackend folder):
 *   node src/scripts/pushElectroxCatsToVoltBank.js
 *   node src/scripts/pushElectroxCatsToVoltBank.js --dry-run
 *   node src/scripts/pushElectroxCatsToVoltBank.js --only=cables
 *
 * Env required:
 *   WC_STORE_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET  (Electrox)
 *   VB_STORE_URL, VB_CONSUMER_KEY, VB_CONSUMER_SECRET  (VoltBank)
 */
require("dotenv").config();
const axios = require("axios");

const PARENT_SLUGS = ["solar", "batteries", "chargers", "power-supply", "cables"];

function client(base, key, secret) {
  base = (base || "").replace(/\/$/, "");
  if (!base || !key || !secret) return null;
  return axios.create({
    baseURL: `${base}/wp-json/wc/v3`,
    auth: { username: key, password: secret },
    timeout: 60000,
  });
}

function electrox() {
  return client(process.env.WC_STORE_URL, process.env.WC_CONSUMER_KEY, process.env.WC_CONSUMER_SECRET);
}
function voltbank() {
  return client(
    process.env.VB_STORE_URL || process.env.VOLTBANK_STORE_URL,
    process.env.VB_CONSUMER_KEY || process.env.VOLTBANK_CONSUMER_KEY,
    process.env.VB_CONSUMER_SECRET || process.env.VOLTBANK_CONSUMER_SECRET
  );
}

async function findCategoryBySlug(api, slug) {
  const { data } = await api.get("/products/categories", {
    params: { slug, per_page: 20 },
  });
  return Array.isArray(data) && data[0] ? data[0] : null;
}

async function ensureCategory(api, name, slug, parentId = 0) {
  let cat = await findCategoryBySlug(api, slug);
  if (cat) return cat;
  // try search by name
  const { data: search } = await api.get("/products/categories", {
    params: { search: name, per_page: 50 },
  });
  cat = (search || []).find((c) => c.name.toLowerCase() === name.toLowerCase() && (parentId === 0 || c.parent === parentId));
  if (cat) return cat;
  const { data: created } = await api.post("/products/categories", {
    name,
    slug,
    parent: parentId || 0,
  });
  return created;
}

async function fetchAllProductsInCategory(api, categoryId) {
  const all = [];
  let page = 1;
  while (true) {
    const { data, headers } = await api.get("/products", {
      params: {
        category: categoryId,
        per_page: 50,
        page,
        status: "publish",
      },
    });
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    const totalPages = parseInt(headers["x-wp-totalpages"] || "1", 10);
    if (page >= totalPages) break;
    page++;
  }
  return all;
}

async function resolveVbCategories(vb, electroxCats) {
  // Map electrox category objects → voltbank category ids (create parent/child as needed)
  const ids = [];
  if (!Array.isArray(electroxCats)) return ids;

  // Sort so parents (parent=0) first is hard without full tree; resolve each by name path
  for (const c of electroxCats) {
    try {
      let parentId = 0;
      // If has parent, try to get parent name from electrox — we only have id; use name only as child under matching parent slug
      const name = c.name || "";
      const slug = (c.slug || name).toLowerCase().replace(/\s+/g, "-");

      // Prefer known parents
      const parentGuess = PARENT_SLUGS.find((p) => slug === p || slug.startsWith(p));
      if (c.parent && c.parent !== 0) {
        // child category: ensure under same parent name if we can match parent from list
        const parentCat = electroxCats.find((x) => x.id === c.parent);
        if (parentCat) {
          const pSlug = (parentCat.slug || parentCat.name || "").toLowerCase().replace(/\s+/g, "-");
          const pNorm = pSlug.replace(/power-supplies/, "power-supply");
          const parent = await ensureCategory(vb, parentCat.name.replace(/Power Supplies/i, "Power Supply"), pNorm === "power-supplies" ? "power-supply" : pNorm, 0);
          parentId = parent.id;
          const child = await ensureCategory(vb, name, slug, parentId);
          ids.push({ id: child.id });
          continue;
        }
      }

      let useName = name;
      let useSlug = slug;
      if (/^power supplies$/i.test(name)) {
        useName = "Power Supply";
        useSlug = "power-supply";
      }
      const created = await ensureCategory(vb, useName, useSlug, parentId);
      ids.push({ id: created.id });
    } catch (e) {
      console.warn("[cat map]", c.name, e.response?.data || e.message);
    }
  }
  return ids;
}

function pickImages(product) {
  const ALLOWED = /\.(jpe?g|png|gif|webp)(\?.*)?$/i;
  const out = [];
  for (const img of product.images || []) {
    const src = img.src || img;
    if (!src || typeof src !== "string") continue;
    if (!/^https?:\/\//i.test(src)) continue;
    if (!ALLOWED.test(src.split("?")[0])) continue;
    out.push({ src });
    if (out.length >= 7) break;
  }
  return out;
}

function buildPayload(product, categoryIds) {
  const payload = {
    name: product.name,
    sku: product.sku || "",
    type: product.type || "simple",
    regular_price: product.regular_price != null ? String(product.regular_price) : "",
    sale_price: product.sale_price != null ? String(product.sale_price) : "",
    description: product.description || "",
    short_description: product.short_description || "",
    status: "publish",
    manage_stock: product.manage_stock === true,
    stock_quantity: product.stock_quantity != null ? product.stock_quantity : undefined,
    stock_status: product.stock_status || "instock",
    weight: product.weight || "",
    categories: categoryIds,
  };
  const images = pickImages(product);
  if (images.length) payload.images = images;
  if (Array.isArray(product.tags) && product.tags.length) {
    // tags by name — skip ids (different store); omit tags for simplicity or pass names
  }
  return payload;
}

async function upsertOnVoltBank(vb, product, categoryIds) {
  const payload = buildPayload(product, categoryIds);

  async function attempt(p) {
    if (product.sku) {
      const { data: found } = await vb.get("/products", {
        params: { sku: product.sku, per_page: 5 },
      });
      const match = (found || []).find(
        (x) => String(x.sku || "").trim() === String(product.sku).trim()
      );
      if (match) {
        const { data } = await vb.put(`/products/${match.id}`, p);
        return data;
      }
    }
    const { data } = await vb.post("/products", p);
    return data;
  }

  try {
    return await attempt(payload);
  } catch (err) {
    const msg = String(err.response?.data?.message || err.message || "").toLowerCase();
    const code = err.response?.data?.code || "";
    if (
      code === "woocommerce_product_image_upload_error" ||
      msg.includes("invalid image") ||
      msg.includes("not allowed to upload")
    ) {
      const noImg = { ...payload };
      delete noImg.images;
      console.warn(`  image fail ${product.sku} — retry without images`);
      return await attempt(noImg);
    }
    throw err;
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.split("=")[1].split(",").map((s) => s.trim()) : null;

  const ex = electrox();
  const vb = voltbank();
  if (!ex) {
    console.error("Missing Electrox WC_* env");
    process.exit(1);
  }
  if (!vb) {
    console.error("Missing VoltBank VB_* env");
    process.exit(1);
  }

  const slugs = only || PARENT_SLUGS;
  console.log("[Copy] Electrox → VoltBank categories:", slugs.join(", "));

  let total = 0;
  let ok = 0;
  let fail = 0;

  for (const slug of slugs) {
    // Electrox may use power-supplies vs power-supply
    let cat = await findCategoryBySlug(ex, slug);
    if (!cat && slug === "power-supply") {
      cat = await findCategoryBySlug(ex, "power-supplies");
    }
    if (!cat) {
      console.warn(`[Copy] Electrox category not found: ${slug}`);
      continue;
    }

    const products = await fetchAllProductsInCategory(ex, cat.id);
    console.log(`[Copy] ${slug} (id=${cat.id}): ${products.length} products on Electrox`);
    total += products.length;

    if (dryRun) continue;

    for (const p of products) {
      try {
        // Build VB categories from product's electrox categories
        const catIds = await resolveVbCategories(vb, p.categories || [{ id: cat.id, name: cat.name, slug: cat.slug, parent: 0 }]);
        // Always ensure parent energy category is included
        const parentVb = await ensureCategory(
          vb,
          cat.name.replace(/Power Supplies/i, "Power Supply"),
          slug === "power-supplies" ? "power-supply" : slug,
          0
        );
        if (!catIds.find((x) => x.id === parentVb.id)) {
          catIds.push({ id: parentVb.id });
        }

        const saved = await upsertOnVoltBank(vb, p, catIds);
        ok++;
        console.log(`  OK ${p.sku || p.id} → VB ${saved.id} (${slug})`);
      } catch (e) {
        fail++;
        console.error(`  FAIL ${p.sku || p.id}:`, e.response?.data || e.message);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log(`[Copy] Electrox products seen: ${total}`);
  if (!dryRun) console.log(`[Copy] Done OK=${ok} FAIL=${fail}`);
  else console.log("[Copy] Dry-run only — no writes");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
