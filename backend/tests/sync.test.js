/*
  Backend tests. Run with:   npm test    (inside the backend folder)

  They start the real Express app on a spare port with an empty in-memory
  database, send real HTTP requests, and check what ends up in SQLite.
*/
process.env.LEDGER_DB = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const app = require('../server');

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => server.close());

/* ---------- helpers ---------- */

const NOW = '2026-11-13T06:00:00.000Z';

// Wraps a payload in an operation with a fresh operation id.
const op = (type, payload) => ({ id: randomUUID(), type, payload });

async function sync(operations) {
  const response = await fetch(`${baseUrl}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operations }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).results;
}

const snapshot = async () => (await fetch(`${baseUrl}/api/snapshot`)).json();

const newProduct = (name, price, quantity) => ({ id: randomUUID(), name, price, quantity, createdAt: NOW, updatedAt: NOW });
const newCustomer = (name) => ({ id: randomUUID(), name, phone: '', createdAt: NOW });

// Builds a sale payload the same way the browser does (frontend/js/db.js).
function newSale(lines, { customerId = null, paid } = {}) {
  const saleId = randomUUID();
  const items = lines.map(([product, quantity]) => ({
    id: randomUUID(), saleId, productId: product.id, productName: product.name, quantity, unitPrice: product.price,
  }));
  const total = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const paidAmount = paid === undefined ? total : paid;
  return {
    sale: { id: saleId, customerId, totalAmount: total, paidAmount, createdAt: NOW },
    items,
    payment: paidAmount > 0 ? { id: randomUUID(), customerId, saleId, amount: paidAmount, createdAt: NOW } : null,
  };
}

const stockOf = async (product) => (await snapshot()).products.find((p) => p.id === product.id).quantity;

async function addProduct(name, price, quantity) {
  const product = newProduct(name, price, quantity);
  const [result] = await sync([op('product.create', product)]);
  assert.equal(result.status, 'ok');
  return product;
}

async function addCustomer(name) {
  const customer = newCustomer(name);
  const [result] = await sync([op('customer.create', customer)]);
  assert.equal(result.status, 'ok');
  return customer;
}

/* ---------- tests ---------- */

test('health check answers', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.deepEqual(await response.json(), { ok: true });
});

test('a product is stored and comes back in the snapshot', async () => {
  const product = await addProduct('Sugar T1', 45, 50);
  const stored = (await snapshot()).products.find((p) => p.id === product.id);
  assert.deepEqual(stored, product);
});

test('the same operation sent twice is applied only once', async () => {
  const operation = op('product.create', newProduct('Rice T2', 60, 40));
  assert.equal((await sync([operation]))[0].status, 'ok');
  assert.equal((await sync([operation]))[0].status, 'duplicate');
  const copies = (await snapshot()).products.filter((p) => p.name === 'Rice T2');
  assert.equal(copies.length, 1);
});

test('two sales of 5 and 3 units take stock from 50 to 42', async () => {
  const product = await addProduct('Sugar T3', 45, 50);
  const results = await sync([op('sale.create', newSale([[product, 5]])), op('sale.create', newSale([[product, 3]]))]);
  assert.deepEqual(results.map((r) => r.status), ['ok', 'ok']);
  assert.equal(await stockOf(product), 42);
});

test('re-sending a whole batch does not sell the stock twice', async () => {
  const product = await addProduct('Sugar T4', 45, 50);
  const batch = [op('sale.create', newSale([[product, 5]])), op('sale.create', newSale([[product, 3]]))];
  await sync(batch);
  const again = await sync(batch); // as if the first reply never reached the browser
  assert.deepEqual(again.map((r) => r.status), ['duplicate', 'duplicate']);
  assert.equal(await stockOf(product), 42);
  const sales = (await snapshot()).saleItems.filter((item) => item.productId === product.id);
  assert.equal(sales.length, 2);
});

test('a sale stores its items and its payment, and works out the status itself', async () => {
  const sugar = await addProduct('Sugar T5', 45, 10);
  const rice = await addProduct('Rice T5', 60, 10);
  const customer = await addCustomer('Ramesh T5');
  const payload = newSale([[sugar, 2], [rice, 1]], { customerId: customer.id, paid: 50 });
  assert.equal((await sync([op('sale.create', payload)]))[0].status, 'ok');

  const data = await snapshot();
  const sale = data.sales.find((s) => s.id === payload.sale.id);
  assert.equal(sale.totalAmount, 150);
  assert.equal(sale.paidAmount, 50);
  assert.equal(sale.paymentStatus, 'partial');
  assert.equal(data.saleItems.filter((item) => item.saleId === sale.id).length, 2);
  const payment = data.payments.find((p) => p.saleId === sale.id);
  assert.equal(payment.amount, 50);
  assert.equal(payment.customerId, customer.id);
});

test('selling more than the stock is rejected and nothing of that sale is saved', async () => {
  const sugar = await addProduct('Sugar T6', 45, 10);
  const rice = await addProduct('Rice T6', 60, 2);
  // Sugar is fine, rice is not: the sugar part must be undone too.
  const payload = newSale([[sugar, 4], [rice, 3]]);
  const [result] = await sync([op('sale.create', payload)]);
  assert.equal(result.status, 'error');
  assert.match(result.error, /Rice T6/);

  const data = await snapshot();
  assert.equal(await stockOf(sugar), 10);
  assert.equal(await stockOf(rice), 2);
  assert.equal(data.sales.some((s) => s.id === payload.sale.id), false);
  assert.equal(data.payments.some((p) => p.saleId === payload.sale.id), false);
});

test('a rejected sale can be sent again later and is then accepted', async () => {
  const product = await addProduct('Oil T7', 100, 1);
  const operation = op('sale.create', newSale([[product, 2]]));
  assert.equal((await sync([operation]))[0].status, 'error');
  await sync([op('product.update', { ...product, quantity: 5 })]);
  assert.equal((await sync([operation]))[0].status, 'ok');
  assert.equal(await stockOf(product), 3);
});

test('a bill total that does not match its items is rejected', async () => {
  const product = await addProduct('Tea T8', 120, 10);
  const payload = newSale([[product, 1]]);
  payload.sale.totalAmount = 1;
  payload.sale.paidAmount = 1;
  payload.payment.amount = 1;
  assert.equal((await sync([op('sale.create', payload)]))[0].status, 'error');
  assert.equal(await stockOf(product), 10);
});

test('a walk-in sale cannot be on credit', async () => {
  const product = await addProduct('Salt T9', 22, 10);
  const [result] = await sync([op('sale.create', newSale([[product, 1]], { paid: 0 }))]);
  assert.equal(result.status, 'error');
  assert.match(result.error, /walk-in/i);
});

test('a sale for an unknown customer is rejected', async () => {
  const product = await addProduct('Soap T10', 35, 10);
  const [result] = await sync([op('sale.create', newSale([[product, 1]], { customerId: randomUUID(), paid: 0 }))]);
  assert.equal(result.status, 'error');
});

test('the same sale under a new operation id is still not stored twice', async () => {
  const product = await addProduct('Dal T11', 140, 10);
  const payload = newSale([[product, 1]]);
  assert.equal((await sync([op('sale.create', payload)]))[0].status, 'ok');
  assert.equal((await sync([op('sale.create', payload)]))[0].status, 'error');
  assert.equal(await stockOf(product), 9);
});

test('payments reduce dues, and paying more than is owed is rejected', async () => {
  const product = await addProduct('Flour T12', 210, 10);
  const customer = await addCustomer('Sunita T12');
  await sync([op('sale.create', newSale([[product, 1]], { customerId: customer.id, paid: 10 }))]); // owes 200

  const pay = (amount) => op('payment.create', { id: randomUUID(), customerId: customer.id, saleId: null, amount, createdAt: NOW });
  assert.equal((await sync([pay(500)]))[0].status, 'error');
  assert.equal((await sync([pay(150)]))[0].status, 'ok');
  assert.equal((await sync([pay(50)]))[0].status, 'ok');
  assert.equal((await sync([pay(1)]))[0].status, 'error'); // nothing left to pay

  const paid = (await snapshot()).payments.filter((p) => p.customerId === customer.id).reduce((sum, p) => sum + p.amount, 0);
  assert.equal(paid, 210);
});

test('a product can be edited, and editing an unknown product is rejected', async () => {
  const product = await addProduct('Biscuit T13', 10, 80);
  const edited = { ...product, name: 'Biscuits T13', price: 12, quantity: 75, updatedAt: '2026-11-13T07:00:00.000Z' };
  assert.equal((await sync([op('product.update', edited)]))[0].status, 'ok');
  assert.deepEqual((await snapshot()).products.find((p) => p.id === product.id), edited);
  assert.equal((await sync([op('product.update', newProduct('Ghost T13', 1, 1))]))[0].status, 'error');
});

test('deleting a product keeps its old sales', async () => {
  const product = await addProduct('Candle T14', 15, 10);
  const payload = newSale([[product, 2]]);
  await sync([op('sale.create', payload), op('product.delete', { id: product.id })]);

  const data = await snapshot();
  assert.equal(data.products.some((p) => p.id === product.id), false);
  const item = data.saleItems.find((i) => i.saleId === payload.sale.id);
  assert.equal(item.productName, 'Candle T14');
  assert.equal(item.productId, null);
});

test('invalid products are rejected', async () => {
  const bad = [
    { ...newProduct('', 10, 1) },
    { ...newProduct('Negative stock', 10, -1) },
    { ...newProduct('Half unit', 10, 1.5) },
    { ...newProduct('Free item', 0, 1) },
    { ...newProduct('Text price', '10', 1) },
  ];
  const results = await sync(bad.map((product) => op('product.create', product)));
  assert.deepEqual(results.map((r) => r.status), ['error', 'error', 'error', 'error', 'error']);
});

test('ids with unsafe characters, long names and 3-decimal prices are rejected', async () => {
  const bad = [
    { ...newProduct('Bad id', 10, 1), id: '"><script>alert(1)</script>' },
    { ...newProduct('Bad id 2', 10, 1), id: "x' OR '1'='1" },
    newProduct('N'.repeat(201), 10, 1),
    newProduct('Three decimals', 10.555, 1),
  ];
  const results = await sync([
    ...bad.map((product) => op('product.create', product)),
    { id: '<b>op</b>', type: 'product.create', payload: newProduct('Bad op id', 10, 1) },
    op('customer.create', { ...newCustomer('Long phone'), phone: '9'.repeat(21) }),
  ]);
  assert.equal(results.every((r) => r.status === 'error'), true);
  assert.equal((await snapshot()).products.some((p) => /Bad id|Three decimals|Bad op id/.test(p.name)), false);
});

test('API answers are never cached by the browser', async () => {
  const response = await fetch(`${baseUrl}/api/snapshot`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('one bad operation does not block the others in the batch', async () => {
  const good1 = newProduct('Good A T16', 10, 1);
  const good2 = newProduct('Good B T16', 10, 1);
  const results = await sync([
    op('product.create', good1),
    op('product.create', newProduct('', 10, 1)),
    op('product.create', good2),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['ok', 'error', 'ok']);
});

test('malformed operations are rejected without crashing the server', async () => {
  const results = await sync([
    { id: randomUUID(), type: 'unknown.type', payload: {} },
    { id: randomUUID(), type: 'constructor', payload: {} },
    { id: randomUUID(), type: 'product.create' },
    { type: 'product.create', payload: {} },
    null,
    op('sale.create', { sale: { id: randomUUID(), customerId: { bad: true }, createdAt: NOW }, items: [{}] }),
  ]);
  assert.equal(results.every((r) => r.status === 'error'), true);
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
});

test('a bad request body gets a 400 answer in JSON', async () => {
  const send = (body) => fetch(`${baseUrl}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  for (const body of ['{ not json', '{}', '{"operations":"x"}']) {
    const response = await send(body);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('an unknown API route gets a 404 answer in JSON', async () => {
  const response = await fetch(`${baseUrl}/api/nothing-here`);
  assert.equal(response.status, 404);
  assert.equal(typeof (await response.json()).error, 'string');
});

test('the frontend pages are served', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Shop Ledger/);
});
