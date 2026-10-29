
/**
 * 1) Delete ALL products on VoltBank
 * 2) Copy Solar, Batteries, Chargers, Power Supply, Cables from Electrox → VoltBank
 *
 * Usage:
 *   node src/scripts/resetVoltBankFromElectrox.js --dry-run
 *   node src/scripts/resetVoltBankFromElectrox.js --confirm-delete
 *
 * MUST pass --confirm-delete to actually wipe VoltBank products.
 */
require("dotenv").config();
const axios = require("axios");

const PARENT_SLUGS = ["solar", "batteries", "chargers", "power-supply", "cables"];
const ALLOWED_IMG = /\.(jpe?g|png|gif|webp)(\?.*)?$/i;

function client(base, key, secret) {
  base = (base || "").replace(/\/$/, "");
  if (!base || !key || !secret) return null;
  return axios.create({
    baseURL: `${base}/wp-json/wc/v3`,
    auth: { username: key, password: secret },
    timeout: 90000,
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
  const { data } = await api.get("/products/categories", { params: { slug, per_page: 20 } });
  return Array.isArray(data) && data[0] ? data[0] : null;
}

async function ensureCategory(api, name, slug, parentId = 0) {
  let cat = await findCategoryBySlug(api, slug);
  if (cat) return cat;
  const { data: search } = await api.get("/products/categories", {
    params: { search: name, per_page: 50 },
  });
  cat = (search || []).find(
    (c) => c.name.toLowerCase() === name.toLowerCase() && (parentId === 0 || c.parent === parentId)
  );
  if (cat) return cat;
  const { data: created } = await api.post("/products/categories", {
    name,
    slug,
    parent: parentId || 0,
  });
  console.log(`  [cat+] ${name} (${slug}) id=${created.id}`);
  return created;
}

async function fetchAllProducts(api, params = {}) {
  const all = [];
  let page = 1;
  while (true) {
    const { data, headers } = await api.get("/products", {
      params: { per_page: 50, page, status: "any", ...params },
    });
    if (!Array.isArray(data) || !data.length) break;
    all.push(...data);
    const totalPages = parseInt(headers["x-wp-totalpages"] || "1", 10);
    if (page >= totalPages) break;
    page++;
  }
  return all;
}

async function deleteAllVoltBankProducts(vb, dryRun) {
  const products = await fetchAllProducts(vb, { status: "any" });
  console.log(`[Delete] VoltBank products found: ${products.length}`);
  if (dryRun) {
    console.log("[Delete] dry-run — no deletes");
    return products.length;
  }
  let n = 0;
  for (const p of products) {
    try {
      // force=true permanently delete
      await vb.delete(`/products/${p.id}`, { params: { force: true } });
      n++;
      if (n % 20 === 0) console.log(`  deleted ${n}/${products.length}`);
    } catch (e) {
      console.warn(`  delete fail id=${p.id}:`, e.response?.data || e.message);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`[Delete] Removed ${n} products from VoltBank`);
  return n;
}

function pickImages(product) {
  const out = [];
  for (const img of product.images || []) {
    const src = img.src || img;
    if (!src || typeof src !== "string") continue;
    if (!/^https?:\/\//i.test(src)) continue;
    if (!ALLOWED_IMG.test(src.split("?")[0])) continue;
    out.push({ src });
    if (out.length >= 5) break;
  }
  return out;
}

async function resolveVbCategories(vb, electroxCats, fallbackParent) {
  const ids = [];
  const list = Array.isArray(electroxCats) && electroxCats.length
    ? electroxCats
    : [fallbackParent];

  for (const c of list) {
    try {
      let name = c.name || "Uncategorized";
      let slug = (c.slug || name).toLowerCase().replace(/\s+/g, "-");
      if (/^power supplies$/i.test(name)) {
        name = "Power Supply";
        slug = "power-supply";
      }

      let parentId = 0;
      if (c.parent && c.parent !== 0) {
        const parentMeta = list.find((x) => x.id === c.parent);
        if (parentMeta) {
          let pName = parentMeta.name;
          let pSlug = (parentMeta.slug || pName).toLowerCase().replace(/\s+/g, "-");
          if (/power supplies/i.test(pName)) {
            pName = "Power Supply";
            pSlug = "power-supply";
          }
          const parent = await ensureCategory(vb, pName, pSlug, 0);
          parentId = parent.id;
        }
      }

      const cat = await ensureCategory(vb, name, slug, parentId);
      if (!ids.find((x) => x.id === cat.id)) ids.push({ id: cat.id });
    } catch (e) {
      console.warn("  cat map fail", c.name, e.response?.data || e.message);
    }
  }
  return ids;
}

async function upsertProduct(vb, product, categoryIds) {
  const payload = {
    name: product.name,
    sku: product.sku || "",
    type: product.type === "variable" ? "simple" : product.type || "simple",
    regular_price: product.regular_price != null ? String(product.regular_price) : "",
    sale_price: product.sale_price != null ? String(product.sale_price) : "",
    description: product.description || "",
    short_description: product.short_description || "",
    status: "publish",
    manage_stock: !!product.manage_stock,
    stock_status: product.stock_status || "instock",
    categories: categoryIds,
  };
  if (product.stock_quantity != null) payload.stock_quantity = product.stock_quantity;
  if (product.weight) payload.weight = String(product.weight);

  const images = pickImages(product);
  if (images.length) payload.images = images;

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
    const code = err.response?.data?.code || "";
    const msg = String(err.response?.data?.message || err.message || "").toLowerCase();
    if (
      code === "woocommerce_product_image_upload_error" ||
      msg.includes("invalid image") ||
      msg.includes("not allowed to upload")
    ) {
      const noImg = { ...payload };
      delete noImg.images;
      console.warn(`  image fail ${product.sku} — no images`);
      return await attempt(noImg);
    }
    throw err;
  }
}

async function copyCategory(ex, vb, slug, dryRun) {
  let cat = await findCategoryBySlug(ex, slug);
  if (!cat && slug === "power-supply") {
    cat = await findCategoryBySlug(ex, "power-supplies");
  }
  if (!cat) {
    console.warn(`[Copy] Electrox missing category: ${slug}`);
    return { seen: 0, ok: 0, fail: 0 };
  }

  const products = await fetchAllProducts(ex, {
    category: cat.id,
    status: "publish",
  });
  console.log(`\n[Copy] ${slug} ← Electrox id=${cat.id} count=${products.length}`);

  if (dryRun) return { seen: products.length, ok: 0, fail: 0 };

  // Ensure parent on VB
  const parentName = cat.name.replace(/Power Supplies/i, "Power Supply");
  const parentSlug = slug === "power-supplies" ? "power-supply" : slug;
  await ensureCategory(vb, parentName, parentSlug, 0);

  let ok = 0;
  let fail = 0;
  for (const p of products) {
    try {
      const catIds = await resolveVbCategories(vb, p.categories, {
        id: cat.id,
        name: parentName,
        slug: parentSlug,
        parent: 0,
      });
      const parentVb = await ensureCategory(vb, parentName, parentSlug, 0);
      if (!catIds.find((x) => x.id === parentVb.id)) catIds.push({ id: parentVb.id });

      const saved = await upsertProduct(vb, p, catIds);
      ok++;
      console.log(`  OK ${p.sku || p.id} → ${saved.id}`);
    } catch (e) {
      fail++;
      console.error(`  FAIL ${p.sku || p.id}:`, e.response?.data || e.message);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { seen: products.length, ok, fail };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const confirm = process.argv.includes("--confirm-delete");

  const ex = electrox();
  const vb = voltbank();
  if (!ex) {
    console.error("Missing WC_STORE_URL / WC_CONSUMER_KEY / WC_CONSUMER_SECRET");
    process.exit(1);
  }
  if (!vb) {
    console.error("Missing VB_STORE_URL / VB_CONSUMER_KEY / VB_CONSUMER_SECRET");
    process.exit(1);
  }

  console.log("Electrox:", process.env.WC_STORE_URL);
  console.log("VoltBank:", process.env.VB_STORE_URL || process.env.VOLTBANK_STORE_URL);

  if (!dryRun && !confirm) {
    console.error("\nRefusing to delete without --confirm-delete");
    console.error("Usage:");
    console.error("  node src/scripts/resetVoltBankFromElectrox.js --dry-run");
    console.error("  node src/scripts/resetVoltBankFromElectrox.js --confirm-delete");
    process.exit(1);
  }

  // Step 1: wipe VoltBank products
  await deleteAllVoltBankProducts(vb, dryRun);

  // Step 2: copy each parent category from Electrox
  let seen = 0;
  let ok = 0;
  let fail = 0;
  for (const slug of PARENT_SLUGS) {
    const r = await copyCategory(ex, vb, slug, dryRun);
    seen += r.seen;
    ok += r.ok;
    fail += r.fail;
  }

  console.log("\n========== SUMMARY ==========");
  console.log("Electrox products in energy cats:", seen);
  if (!dryRun) console.log(`Copied OK=${ok} FAIL=${fail}`);
  else console.log("Dry-run complete — nothing changed");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
