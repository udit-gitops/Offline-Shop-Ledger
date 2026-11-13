/*
  seed.js — fills an EMPTY database with a small sample kirana shop, so the
  app has something to show: 10 products, 4 customers, a week of sales and
  two dues payments.

  Run it with:   npm run seed     (inside the backend folder)

  The sample data goes through the same code as a real sync (syncService.js),
  so every rule is checked and the stock is worked out by the server itself.
  If the database already has data, nothing is added.
*/
const { randomUUID } = require('node:crypto');
const db = require('./database/db');
const { processOperations } = require('./services/syncService');

/* ---------- small helpers ---------- */

const operation = (type, payload) => ({ id: randomUUID(), type, payload });

// The moment `days` days ago at the given local time, as ISO text.
function daysAgo(days, hour, minute) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

/* ---------- products and customers ---------- */

const OPENING_DAY = daysAgo(8, 9, 0);

const newProduct = (name, price, quantity) => ({
  id: randomUUID(), name, price, quantity, createdAt: OPENING_DAY, updatedAt: OPENING_DAY,
});
const newCustomer = (name, phone) => ({ id: randomUUID(), name, phone, createdAt: OPENING_DAY });

// name, price in rupees, opening stock
const products = {
  sugar: newProduct('Sugar (1 kg)', 45, 50),
  rice: newProduct('Rice (1 kg)', 60, 80),
  atta: newProduct('Wheat flour / Atta (5 kg)', 210, 20),
  dal: newProduct('Toor dal (1 kg)', 140, 25),
  oil: newProduct('Mustard oil (1 L)', 165, 15),
  salt: newProduct('Salt (1 kg)', 22, 40),
  tea: newProduct('Tea (250 g)', 120, 8),
  biscuit: newProduct('Biscuit packet', 10, 100),
  soap: newProduct('Bath soap', 35, 30),
  washing: newProduct('Washing powder (1 kg)', 95, 6),
};

const customers = {
  ramesh: newCustomer('Ramesh Kumar', '9876543210'),
  sunita: newCustomer('Sunita Devi', ''),
  imran: newCustomer('Imran Khan', '9812345678'),
  geeta: newCustomer('Geeta Bai', ''),
};

/* ---------- sales and payments ---------- */

// lines: [[product, quantity], ...]
// paid: rupees paid at billing, or 'full'. customer null = walk-in.
function sale(when, customer, lines, paid) {
  const id = randomUUID();
  const items = lines.map(([product, quantity]) => ({
    id: randomUUID(), productId: product.id, productName: product.name, quantity, unitPrice: product.price,
  }));
  const total = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const paidAmount = paid === 'full' ? total : paid;
  return operation('sale.create', {
    sale: { id, customerId: customer ? customer.id : null, totalAmount: total, paidAmount, createdAt: when },
    items,
    payment: paidAmount > 0 ? { id: randomUUID(), amount: paidAmount, createdAt: when } : null,
  });
}

// A customer paying off old dues.
const duesPayment = (when, customer, amount) =>
  operation('payment.create', { id: randomUUID(), customerId: customer.id, amount, createdAt: when });

const { sugar, rice, atta, dal, oil, salt, tea, biscuit, soap, washing } = products;
const { ramesh, sunita, imran, geeta } = customers;

// Oldest first, exactly as they would have happened in the shop.
const shopHistory = [
  sale(daysAgo(6, 10, 15), null, [[sugar, 2], [tea, 1]], 'full'),
  sale(daysAgo(6, 17, 40), ramesh, [[atta, 1], [dal, 1], [oil, 1]], 200),      // Ramesh owes 315
  sale(daysAgo(5, 9, 30), null, [[biscuit, 5], [soap, 2]], 'full'),
  sale(daysAgo(4, 11, 5), sunita, [[rice, 5], [sugar, 2], [salt, 1]], 0),      // full credit: Sunita owes 412
  sale(daysAgo(4, 18, 20), null, [[washing, 1], [soap, 1]], 'full'),
  sale(daysAgo(3, 12, 0), imran, [[tea, 2], [biscuit, 10], [sugar, 1]], 'full'),
  duesPayment(daysAgo(3, 15, 0), ramesh, 200),                                 // Ramesh owes 115
  sale(daysAgo(2, 10, 45), null, [[rice, 2], [dal, 1]], 'full'),
  sale(daysAgo(2, 16, 10), ramesh, [[sugar, 3], [salt, 2]], 0),                // Ramesh owes 294
  sale(daysAgo(1, 9, 50), null, [[oil, 1], [atta, 1], [washing, 2]], 'full'),
  duesPayment(daysAgo(1, 12, 30), sunita, 212),                                // Sunita owes 200
  sale(daysAgo(1, 19, 5), geeta, [[rice, 3], [tea, 1], [soap, 2]], 170),       // Geeta owes 200
  sale(minutesAgo(40), null, [[biscuit, 4], [salt, 1]], 'full'),
  sale(minutesAgo(10), sunita, [[dal, 2], [oil, 1]], 245),                     // Sunita owes 400
];

const operations = [
  ...Object.values(products).map((product) => operation('product.create', product)),
  ...Object.values(customers).map((customer) => operation('customer.create', customer)),
  ...shopHistory,
];

/* ---------- run ---------- */

const existing = db.prepare(
  `SELECT (SELECT COUNT(*) FROM products) + (SELECT COUNT(*) FROM customers) + (SELECT COUNT(*) FROM sales) AS records`
).get().records;

if (existing > 0) {
  console.log('The database already has data, so no sample data was added.');
  console.log('To start fresh: stop the server, delete backend/data/ledger.db, then run this again.');
  process.exit(0);
}

// One outer transaction: either the whole sample shop is saved, or nothing is.
const addEverything = db.transaction(() => {
  const rejected = processOperations(operations).filter((result) => result.status !== 'ok');
  if (rejected.length > 0) throw new Error('Sample data was rejected: ' + rejected[0].error);
});
addEverything();

console.log(`Sample shop added: ${Object.keys(products).length} products, ${Object.keys(customers).length} customers, ` +
  `${shopHistory.length} sales and payments.`);
console.log('Open http://localhost:5500 and reload the page to see it.');
