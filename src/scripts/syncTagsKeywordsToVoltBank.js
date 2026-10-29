/**
 * Re-sync tags + focus keywords from Electrox → VoltBank for existing products (match by SKU).
 * Also creates missing products' meta when found on both stores.
 *
 * Usage:
 *   node src/scripts/syncTagsKeywordsToVoltBank.js
 *   node src/scripts/syncTagsKeywordsToVoltBank.js --dry-run
 *   node src/scripts/syncTagsKeywordsToVoltBank.js --only=cables
 */
require("dotenv").config();
const axios = require("axios");

const PARENT_SLUGS = ["solar", "batteries", "chargers", "power-supply", "cables"];

const META_KEYS = [
  "rank_math_focus_keyword",
  "rank_math_focus_keyword_base",
  "rank_math_description",
  "rank_math_title",
  "_yoast_wpseo_focuskw",
  "_yoast_wpseo_focuskw_text_input",
  "_yoast_wpseo_metadesc",
  "_yoast_wpseo_title",
];

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
  const { data } = await api.get("/products/categories", { params: { slug, per_page: 20 } });
  return Array.isArray(data) && data[0] ? data[0] : null;
}

async function fetchAllInCategory(api, categoryId) {
  const all = [];
  let page = 1;
  while (true) {
    const { data, headers } = await api.get("/products", {
      params: { category: categoryId, per_page: 50, page, status: "publish" },
    });
    if (!Array.isArray(data) || !data.length) break;
    all.push(...data);
    const totalPages = parseInt(headers["x-wp-totalpages"] || "1", 10);
    if (page >= totalPages) break;
    page++;
  }
  return all;
}

function extractMeta(product) {
  const meta = Array.isArray(product.meta_data) ? product.meta_data : [];
  const out = [];
  for (const key of META_KEYS) {
    const row = meta.find((m) => m && m.key === key);
    if (row && row.value != null && String(row.value).trim() !== "") {
      out.push({ key, value: row.value });
    }
  }
  return out;
}

async function resolveTagsOnVb(vb, electroxTags, cache) {
  if (!Array.isArray(electroxTags) || !electroxTags.length) return [];
  const ids = [];
  for (const t of electroxTags) {
    const name = (t.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (cache.has(key)) {
      ids.push({ id: cache.get(key) });
      continue;
    }
    try {
      const { data } = await vb.get("/products/tags", { params: { search: name, per_page: 50 } });
      let tag = (data || []).find((x) => x.name.toLowerCase() === key);
      if (!tag) {
        const { data: created } = await vb.post("/products/tags", { name });
        tag = created;
      }
      if (tag && tag.id) {
        cache.set(key, tag.id);
        ids.push({ id: tag.id });
      }
    } catch (e) {
      console.warn("  tag fail:", name, e.response?.data || e.message);
    }
  }
  return ids;
}

async function findVbBySku(vb, sku) {
  if (!sku) return null;
  const { data } = await vb.get("/products", { params: { sku, per_page: 5 } });
  return (data || []).find((p) => String(p.sku || "").trim() === String(sku).trim()) || null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.split("=")[1].split(",").map((s) => s.trim()) : null;

  const ex = electrox();
  const vb = voltbank();
  if (!ex || !vb) {
    console.error("Need WC_* and VB_* credentials in .env");
    process.exit(1);
  }

  const slugs = only || PARENT_SLUGS;
  const tagCache = new Map();
  let ok = 0;
  let skip = 0;
  let fail = 0;

  for (const slug of slugs) {
    let cat = await findCategoryBySlug(ex, slug);
    if (!cat && slug === "power-supply") cat = await findCategoryBySlug(ex, "power-supplies");
    if (!cat) {
      console.warn("Electrox category missing:", slug);
      continue;
    }

    const products = await fetchAllInCategory(ex, cat.id);
    console.log(`\n[${slug}] Electrox products: ${products.length}`);

    for (const p of products) {
      const sku = (p.sku || "").trim();
      if (!sku) {
        skip++;
        continue;
      }

      const meta = extractMeta(p);
      const tagNames = (p.tags || []).map((t) => t.name).filter(Boolean);

      if (dryRun) {
        console.log(`  ${sku} tags=${tagNames.length} meta=${meta.length} focus=${meta.find((m) => m.key.includes("focus"))?.value || "-"}`);
        ok++;
        continue;
      }

      try {
        const vbProduct = await findVbBySku(vb, sku);
        if (!vbProduct) {
          console.warn(`  SKIP no VB product for sku=${sku}`);
          skip++;
          continue;
        }

        const tags = await resolveTagsOnVb(vb, p.tags || [], tagCache);
        const payload = {};
        if (tags.length) payload.tags = tags;
        if (meta.length) payload.meta_data = meta;

        if (!tags.length && !meta.length) {
          skip++;
          continue;
        }

        await vb.put(`/products/${vbProduct.id}`, payload);
        ok++;
        console.log(`  OK ${sku} tags=${tags.length} meta=${meta.length}`);
      } catch (e) {
        fail++;
        console.error(`  FAIL ${sku}:`, e.response?.data || e.message);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  console.log(`\nDone OK=${ok} SKIP=${skip} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
