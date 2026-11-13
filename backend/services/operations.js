/*
  operations.js — what each kind of sync operation does to the database.

  The browser sends operations such as "product.create" or "sale.create".
  Each function below checks one operation and writes it to SQLite.
  They are always called inside a transaction (see syncService.js), so if a
  check fails half-way, nothing from that operation is saved.
*/
const db = require('../database/db');
const { check, round2, isText, isId, isMoney, isDate } = require('./validate');

// `table` is always one of our own table names written in this file, never user input.
function exists(table, id) {
  return db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
}

/* ---------- Products ---------- */

function checkProduct(product) {
  check(isId(product.id), 'Product id is not valid.');
  check(isText(product.name), 'Product name is required (up to 200 characters).');
  check(isMoney(product.price) && product.price > 0, 'Price must be greater than 0, with at most 2 decimals.');
  check(Number.isInteger(product.quantity) && product.quantity >= 0, 'Quantity must be a whole number, 0 or more.');
  check(isDate(product.createdAt) && isDate(product.updatedAt), 'Product dates are not valid.');
}

function createProduct(product) {
  checkProduct(product);
  check(!exists('products', product.id), 'This product is already on the server.');
  db.prepare(
    `INSERT INTO products (id, name, price, quantity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(product.id, product.name.trim(), product.price, product.quantity, product.createdAt, product.updatedAt);
}

function updateProduct(product) {
  checkProduct(product);
  check(exists('products', product.id), 'This product is not on the server.');
  db.prepare('UPDATE products SET name = ?, price = ?, quantity = ?, updated_at = ? WHERE id = ?')
    .run(product.name.trim(), product.price, product.quantity, product.updatedAt, product.id);
}

// Old bills keep the product's name; only their link to the product is cleared
// (ON DELETE SET NULL in schema.sql).
function deleteProduct({ id }) {
  check(isId(id), 'Product id is not valid.');
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
}

/* ---------- Customers ---------- */

function createCustomer(customer) {
  check(isId(customer.id), 'Customer id is not valid.');
  check(isText(customer.name), 'Customer name is required (up to 200 characters).');
  check(typeof customer.phone === 'string' && customer.phone.length <= 20, 'Phone number is not valid.');
  check(isDate(customer.createdAt), 'Customer date is not valid.');
  check(!exists('customers', customer.id), 'This customer is already on the server.');
  db.prepare('INSERT INTO customers (id, name, phone, created_at) VALUES (?, ?, ?, ?)')
    .run(customer.id, customer.name.trim(), customer.phone.trim(), customer.createdAt);
}

// What the customer still owes = all their purchases − all their payments.
function customerBalance(customerId) {
  const row = db.prepare(
    `SELECT
       (SELECT COALESCE(SUM(total_amount), 0) FROM sales    WHERE customer_id = @id) AS purchases,
       (SELECT COALESCE(SUM(amount), 0)       FROM payments WHERE customer_id = @id) AS paid`
  ).get({ id: customerId });
  return round2(row.purchases - row.paid);
}

/* ---------- Payments ---------- */

function insertPayment(payment, customerId, saleId) {
  check(isId(payment.id), 'Payment id is not valid.');
  check(isMoney(payment.amount) && payment.amount > 0, 'Payment amount must be greater than 0, with at most 2 decimals.');
  check(isDate(payment.createdAt), 'Payment date is not valid.');
  check(!exists('payments', payment.id), 'This payment is already on the server.');
  db.prepare('INSERT INTO payments (id, customer_id, sale_id, amount, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(payment.id, customerId, saleId, payment.amount, payment.createdAt);
}

// A customer paying off old dues (not linked to one particular sale).
function createPayment(payment) {
  check(isId(payment.customerId) && exists('customers', payment.customerId), 'The customer of this payment is not on the server.');
  check(isMoney(payment.amount) && payment.amount <= customerBalance(payment.customerId), 'Payment is more than the customer owes.');
  insertPayment(payment, payment.customerId, null);
}

/* ---------- Sales ---------- */

function checkSaleItem(item) {
  check(isId(item.id), 'A sale item has no valid id.');
  check(isId(item.productId), 'A sale item has no valid product.');
  check(isText(item.productName), 'A sale item has no product name.');
  check(Number.isInteger(item.quantity) && item.quantity > 0, 'Item quantity must be a whole number greater than 0.');
  check(isMoney(item.unitPrice) && item.unitPrice > 0, 'Item price must be greater than 0.');
}

// Takes the sold quantity out of stock. The stock is REDUCED by the sold
// amount, it is never overwritten with a number sent by the browser, and the
// "quantity >= ?" condition refuses a sale that would make stock negative.
function reduceStock(item, soldAt) {
  const result = db
    .prepare('UPDATE products SET quantity = quantity - ?, updated_at = ? WHERE id = ? AND quantity >= ?')
    .run(item.quantity, soldAt, item.productId, item.quantity);
  check(result.changes === 1, `"${item.productName}" is missing on the server or does not have enough stock.`);
}

// One sale = the sale row + its items + stock reduction + (optional) payment.
function createSale({ sale, items, payment }) {
  check(sale && typeof sale === 'object', 'Sale details are missing.');
  check(Array.isArray(items) && items.length > 0, 'A sale needs at least one item.');
  check(isId(sale.id), 'Sale id is not valid.');
  check(isDate(sale.createdAt), 'Sale date is not valid.');
  check(!exists('sales', sale.id), 'This sale is already on the server.');

  const customerId = sale.customerId || null; // null = walk-in customer
  check(customerId === null || isId(customerId), 'Customer id is not valid.');
  check(customerId === null || exists('customers', customerId), 'The customer of this sale is not on the server.');

  // The bill total is worked out again here instead of trusting the browser.
  items.forEach(checkSaleItem);
  const total = round2(items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
  check(sale.totalAmount === total, 'Bill total does not match its items.');

  const paid = sale.paidAmount;
  check(isMoney(paid) && paid <= total, 'Amount paid must be between 0 and the bill total.');
  check(customerId !== null || paid === total, 'A walk-in sale must be paid in full.');

  // Money taken at billing must come with a payment record of the same amount.
  const paymentMatches = paid > 0 ? Boolean(payment) && payment.amount === paid : !payment;
  check(paymentMatches, 'The payment record does not match the amount paid.');

  const status = paid === total ? 'paid' : paid === 0 ? 'credit' : 'partial';
  db.prepare(
    `INSERT INTO sales (id, customer_id, total_amount, paid_amount, payment_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sale.id, customerId, total, paid, status, sale.createdAt);

  const insertItem = db.prepare(
    `INSERT INTO sale_items (id, sale_id, product_id, product_name, quantity, unit_price)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const item of items) {
    reduceStock(item, sale.createdAt);
    insertItem.run(item.id, sale.id, item.productId, item.productName, item.quantity, item.unitPrice);
  }

  if (payment) insertPayment(payment, customerId, sale.id);
}

// Operation type -> the function that applies it.
module.exports = {
  'product.create': createProduct,
  'product.update': updateProduct,
  'product.delete': deleteProduct,
  'customer.create': createCustomer,
  'sale.create': createSale,
  'payment.create': createPayment,
};
