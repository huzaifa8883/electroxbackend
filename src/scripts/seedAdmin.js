require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("../config/db");

const USERNAME = process.env.SUPERADMIN_USERNAME || "suntechpakistan";
const PASSWORD = process.env.SUPERADMIN_PASSWORD || "12345";

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Ensure the Super Admin role exists with full permissions on every module
    const roleRes = await client.query(
      `INSERT INTO roles (name, is_system) VALUES ('Super Admin', TRUE)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    const roleId = roleRes.rows[0].id;

    const modules = [
      "dashboard", "products", "boxes",
      "customers", "sales", "stock_ledger", "reports", "users",
    ];
    for (const module of modules) {
      await client.query(
        `INSERT INTO permissions (role_id, module, can_view, can_create, can_edit, can_delete)
         VALUES ($1,$2,TRUE,TRUE,TRUE,TRUE)
         ON CONFLICT (role_id, module) DO UPDATE
         SET can_view=TRUE, can_create=TRUE, can_edit=TRUE, can_delete=TRUE`,
        [roleId, module]
      );
    }

    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    await client.query(
      `INSERT INTO users (username, password_hash, full_name, role_id, is_active)
       VALUES ($1,$2,'Super Admin',$3,TRUE)
       ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, role_id = EXCLUDED.role_id, is_active = TRUE`,
      [USERNAME, passwordHash, roleId]
    );

    await client.query("COMMIT");
    console.log(`✅ Superadmin ready — username: "${USERNAME}"`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Seeding failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    pool.end();
  }
}

seed();
