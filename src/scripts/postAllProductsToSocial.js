/**
 * Post ALL published WooCommerce products to Facebook + Instagram.
 *
 * Usage:
 *   node src/scripts/postAllProductsToSocial.js
 *   node src/scripts/postAllProductsToSocial.js --limit=10
 *   node src/scripts/postAllProductsToSocial.js --skip=0 --limit=50
 *
 * .env required:
 *   WC_STORE_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET
 *   FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN
 *   IG_ACCOUNT_ID (optional – skip IG if missing)
 *   WEBSITE_URL
 */
require("dotenv").config();
const axios = require("axios");
const { postProductToSocial } = require("../controllers/socialPost");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs() {
  const args = { skip: 0, limit: 0 };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--skip=")) args.skip = Number(a.split("=")[1]) || 0;
    if (a.startsWith("--limit=")) args.limit = Number(a.split("=")[1]) || 0;
  }
  return args;
}

async function fetchAllWooProducts() {
  const base = (process.env.WC_STORE_URL || "").replace(/\/$/, "");
  const key = process.env.WC_CONSUMER_KEY;
  const secret = process.env.WC_CONSUMER_SECRET;

  if (!base || !key || !secret) {
    throw new Error("Set WC_STORE_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET in .env");
  }

  const all = [];
  let page = 1;
  const perPage = 50;

  while (true) {
    console.log(`[Fetch] page ${page}...`);
    const { data } = await axios.get(`${base}/wp-json/wc/v3/products`, {
      params: { page, per_page: perPage, status: "publish" },
      auth: { username: key, password: secret },
      timeout: 30000,
    });
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < perPage) break;
    page += 1;
  }

  return all;
}

async function main() {
  const { skip, limit } = parseArgs();

  console.log("=== Bulk social post: WooCommerce → Facebook + Instagram ===\n");

  if (!process.env.FB_PAGE_ID || !process.env.FB_PAGE_ACCESS_TOKEN) {
    throw new Error("FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN required in .env");
  }

  const products = await fetchAllWooProducts();
  console.log(`Total published products: ${products.length}`);

  let list = products.slice(skip);
  if (limit > 0) list = list.slice(0, limit);

  console.log(`Will post: ${list.length} products (skip=${skip}, limit=${limit || "all"})\n`);

  let fbOk = 0;
  let igOk = 0;
  let fail = 0;

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const label = `[${i + 1}/${list.length}] ${p.sku || p.id} – ${p.name}`;

    try {
      console.log(`\n→ ${label}`);
      const result = await postProductToSocial(p);

      if (result.facebook) {
        fbOk++;
        console.log("  FB ✅");
      } else {
        console.log("  FB ❌ / skipped");
      }

      if (result.instagram) {
        igOk++;
        console.log("  IG ✅");
      } else {
        console.log("  IG ❌ / skipped");
      }
    } catch (err) {
      fail++;
      console.error(`  ERROR:`, err.message);
    }

    // Rate limit – Meta API ke liye delay zaroori
    // FB ~ few seconds, IG container ke liye socialPost already 3s wait karta hai
    if (i < list.length - 1) {
      console.log("  waiting 8s...");
      await sleep(8000);
    }
  }

  console.log("\n========== DONE ==========");
  console.log(`Facebook OK : ${fbOk}`);
  console.log(`Instagram OK: ${igOk}`);
  console.log(`Failed      : ${fail}`);
  console.log(`Total tried : ${list.length}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
