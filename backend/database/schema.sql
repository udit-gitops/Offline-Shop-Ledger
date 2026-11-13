-- SQLite tables for the Shop Ledger server.
-- Every id is a UUID created in the browser, so a record keeps the same id
-- in IndexedDB (browser) and in SQLite (server).
-- Dates are stored as ISO text in UTC, for example 2026-11-13T06:45:00.000Z.

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  price       REAL NOT NULL CHECK (price > 0),
  quantity    INTEGER NOT NULL CHECK (quantity >= 0),   -- stock can never go below zero
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

-- customer_id is empty (NULL) for a walk-in sale.
CREATE TABLE IF NOT EXISTS sales (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT REFERENCES customers (id),
  total_amount    REAL NOT NULL CHECK (total_amount > 0),
  paid_amount     REAL NOT NULL CHECK (paid_amount >= 0 AND paid_amount <= total_amount),
  payment_status  TEXT NOT NULL CHECK (payment_status IN ('paid', 'partial', 'credit')),
  created_at      TEXT NOT NULL
);

-- product_name and unit_price are copied at the time of sale, so old bills
-- stay correct even if the product is later renamed, repriced or deleted.
CREATE TABLE IF NOT EXISTS sale_items (
  id            TEXT PRIMARY KEY,
  sale_id       TEXT NOT NULL REFERENCES sales (id),
  product_id    TEXT REFERENCES products (id) ON DELETE SET NULL,
  product_name  TEXT NOT NULL,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  unit_price    REAL NOT NULL CHECK (unit_price > 0)
);

-- A payment is its own event. sale_id is filled when the money was taken
-- at billing time, and empty when a customer pays off old dues later.
CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT REFERENCES customers (id),
  sale_id      TEXT REFERENCES sales (id),
  amount       REAL NOT NULL CHECK (amount > 0),
  created_at   TEXT NOT NULL
);

-- One row per sync operation already applied. If the browser sends the same
-- operation again (for example because the reply got lost), it is found here
-- and skipped. This is what prevents duplicate sales.
CREATE TABLE IF NOT EXISTS sync_log (
  operation_id  TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  processed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales (customer_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments (customer_id);
