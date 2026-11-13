/*
  snapshot.js — reads everything stored on the server.

  Column names are renamed (created_at -> createdAt) so the records look
  exactly like the ones the browser keeps in IndexedDB.
*/
const db = require('../database/db');

const QUERIES = {
  products: `SELECT id, name, price, quantity, created_at AS createdAt, updated_at AS updatedAt
             FROM products ORDER BY name`,
  customers: `SELECT id, name, phone, created_at AS createdAt
              FROM customers ORDER BY name`,
  sales: `SELECT id, customer_id AS customerId, total_amount AS totalAmount, paid_amount AS paidAmount,
                 payment_status AS paymentStatus, created_at AS createdAt
          FROM sales ORDER BY created_at`,
  saleItems: `SELECT id, sale_id AS saleId, product_id AS productId, product_name AS productName,
                     quantity, unit_price AS unitPrice
              FROM sale_items`,
  payments: `SELECT id, customer_id AS customerId, sale_id AS saleId, amount, created_at AS createdAt
             FROM payments ORDER BY created_at`,
};

// Returns { products: [...], customers: [...], sales: [...], saleItems: [...], payments: [...] }.
function readSnapshot() {
  const snapshot = {};
  for (const [name, sql] of Object.entries(QUERIES)) {
    snapshot[name] = db.prepare(sql).all();
  }
  return snapshot;
}

module.exports = { readSnapshot };
