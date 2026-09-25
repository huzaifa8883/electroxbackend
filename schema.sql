-- ============================================================
-- ELECTROX PRO — Inventory Management System
-- PostgreSQL Schema
-- ============================================================

CREATE TABLE IF NOT EXISTS boxes (
    id              SERIAL PRIMARY KEY,
    box_number      VARCHAR(50) UNIQUE NOT NULL,      -- e.g. Box-101, Shelf-3
    rack_location   VARCHAR(100),                      -- e.g. Aisle 2, Rack B
    description     TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suppliers (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(150) NOT NULL,
    phone           VARCHAR(30),
    city            VARCHAR(100),
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(150) NOT NULL,
    phone           VARCHAR(30),
    city            VARCHAR(100),
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
    id              SERIAL PRIMARY KEY,
    sku             VARCHAR(80) UNIQUE NOT NULL,
    name            VARCHAR(200) NOT NULL,
    category        VARCHAR(100),
    stock           INTEGER NOT NULL DEFAULT 0,
    min_stock       INTEGER NOT NULL DEFAULT 5,
    cost_price      NUMERIC(12,2) NOT NULL DEFAULT 0,
    selling_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
    supplier_id     INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    box_id          INTEGER REFERENCES boxes(id) ON DELETE SET NULL,
    image_url       TEXT,
    location        VARCHAR(150),                      -- free-text fallback location
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_box_id ON products(box_id);
CREATE INDEX IF NOT EXISTS idx_products_supplier_id ON products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);

CREATE TABLE IF NOT EXISTS sales (
    id              SERIAL PRIMARY KEY,
    invoice_no      VARCHAR(50) UNIQUE NOT NULL,
    customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    total           NUMERIC(12,2) NOT NULL DEFAULT 0,
    discount        NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax             NUMERIC(12,2) NOT NULL DEFAULT 0,
    profit          NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_method  VARCHAR(30) NOT NULL DEFAULT 'cash', -- cash | card | credit
    status          VARCHAR(30) NOT NULL DEFAULT 'completed', -- completed | refunded | void
    date            TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sale_items (
    id              SERIAL PRIMARY KEY,
    sale_id         INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id      INTEGER NOT NULL REFERENCES products(id),
    quantity        INTEGER NOT NULL,
    unit_price      NUMERIC(12,2) NOT NULL,
    unit_cost       NUMERIC(12,2) NOT NULL DEFAULT 0,
    line_total      NUMERIC(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_orders (
    id              SERIAL PRIMARY KEY,
    po_number       VARCHAR(50) UNIQUE NOT NULL,
    supplier_id     INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
    quantity        INTEGER NOT NULL,
    cost            NUMERIC(12,2) NOT NULL,
    status          VARCHAR(30) NOT NULL DEFAULT 'pending', -- pending | received | cancelled
    date            TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_ledger (
    id                SERIAL PRIMARY KEY,
    product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    type              VARCHAR(30) NOT NULL,   -- sale | purchase | adjustment | return | box_transfer
    quantity_changed  INTEGER NOT NULL,        -- negative for outgoing
    balance_after     INTEGER NOT NULL,
    reference         VARCHAR(100),            -- invoice_no / po_number / note
    created_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_ledger_product ON stock_ledger(product_id);

-- ============================================================
-- ROLES, PERMISSIONS & USERS (access control)
-- ============================================================

CREATE TABLE IF NOT EXISTS roles (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) UNIQUE NOT NULL,
    is_system       BOOLEAN NOT NULL DEFAULT FALSE, -- true only for the built-in Super Admin role
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One row per (role, module) describing exactly what that role can do in that section.
CREATE TABLE IF NOT EXISTS permissions (
    id              SERIAL PRIMARY KEY,
    role_id         INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    module          VARCHAR(50) NOT NULL,   -- dashboard | products | boxes | purchase_orders |
                                              -- suppliers | customers | pos | sales | stock_ledger |
                                              -- reports | users
    can_view        BOOLEAN NOT NULL DEFAULT FALSE,
    can_create      BOOLEAN NOT NULL DEFAULT FALSE,
    can_edit        BOOLEAN NOT NULL DEFAULT FALSE,
    can_delete      BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (role_id, module)
);

CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    username        VARCHAR(100) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    full_name       VARCHAR(150),
    role_id         INTEGER REFERENCES roles(id) ON DELETE SET NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Seed: Super Admin role with full access to every module
INSERT INTO roles (name, is_system) VALUES ('Super Admin', TRUE)
ON CONFLICT (name) DO NOTHING;

INSERT INTO permissions (role_id, module, can_view, can_create, can_edit, can_delete)
SELECT r.id, m.module, TRUE, TRUE, TRUE, TRUE
FROM roles r
CROSS JOIN (VALUES
  ('dashboard'), ('products'), ('boxes'), ('purchase_orders'), ('suppliers'),
  ('customers'), ('pos'), ('sales'), ('stock_ledger'), ('reports'), ('users')
) AS m(module)
WHERE r.name = 'Super Admin'
ON CONFLICT (role_id, module) DO NOTHING;

-- NOTE: the superadmin user (username: suntechpakistan) is NOT seeded here because
-- its password must be bcrypt-hashed. Run `npm run seed:admin` in /backend after
-- migrating this schema — see backend/src/scripts/seedAdmin.js.

-- Sample seed data
INSERT INTO boxes (box_number, rack_location, description) VALUES
  ('Box-101', 'Aisle 1 - Rack A', 'Small electronic components'),
  ('Box-A2', 'Aisle 2 - Rack B', 'Cables and connectors'),
  ('Shelf-3', 'Aisle 3', 'Bulk items')
ON CONFLICT DO NOTHING;

INSERT INTO suppliers (name, phone, city) VALUES
  ('TechSource Distributors', '0300-1234567', 'Karachi'),
  ('Global Electronics Co', '0321-9876543', 'Lahore')
ON CONFLICT DO NOTHING;

-- Starter customers so the Customers screen isn't empty on first run
INSERT INTO customers (name, phone, city) VALUES
  ('Ahmed Raza', '0300-1112233', 'Faisalabad'),
  ('Bilal Traders', '0321-4445566', 'Lahore'),
  ('Sana Electronics', '0333-7778899', 'Karachi'),
  ('Usman Khan', '0345-2223344', 'Faisalabad'),
  ('Hina Enterprises', '0301-9998877', 'Multan')
ON CONFLICT DO NOTHING;
