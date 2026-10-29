/**
 * Push inventory VoltBank-category products → WooCommerce (Electrox + VoltBank via wooSync).
 *
 * Usage (from electroxbackend folder):
 *   node src/scripts/pushVoltBankCategoriesToWoo.js --dry-run
 *   node src/scripts/pushVoltBankCategoriesToWoo.js
 */
require("dotenv").config();
const pool = require("../config/db");
const { syncProductToWoo, isVoltBankCategory, vbClient } = require("../controllers/wooSync");

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log("[VoltBank Push] VB_STORE_URL:", process.env.VB_STORE_URL || process.env.VOLTBANK_STORE_URL || "(missing!)");
  console.log("[VoltBank Push] WC_STORE_URL:", process.env.WC_STORE_URL || "(missing!)");

  if (!vbClient()) {
    console.error("Set VB_STORE_URL, VB_CONSUMER_KEY, VB_CONSUMER_SECRET in .env");
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT * FROM products WHERE category IS NOT NULL AND TRIM(category) <> '' ORDER BY id ASC`
  );
  const targets = rows.filter((p) => isVoltBankCategory(p.category));
  console.log(`[VoltBank Push] Matching products: ${targets.length} / ${rows.length}`);

  if (dryRun) {
    const byCat = {};
    for (const p of targets) {
      byCat[p.category] = (byCat[p.category] || 0) + 1;
    }
    console.log("[VoltBank Push] By category:", byCat);
    console.log(
      "[VoltBank Push] Sample:",
      targets.slice(0, 15).map((p) => `${p.sku} | ${p.category} | ${p.name}`)
    );
    process.exit(0);
  }

  let ok = 0;
  let fail = 0;
  for (const product of targets) {
    try {
      await syncProductToWoo({ ...product, _allowCreate: true, sync_to_website: true });
      ok++;
      console.log(`  OK ${product.sku} (${product.category})`);
    } catch (e) {
      fail++;
      console.error(`  FAIL ${product.sku}:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`[VoltBank Push] Done OK=${ok} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
