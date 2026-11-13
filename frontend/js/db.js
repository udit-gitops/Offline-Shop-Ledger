/*
  db.js — the browser-side database (IndexedDB).

  Every page talks to IndexedDB only through the DB object defined here.
  Rule followed by every write function below:
    1. change the business record (product / sale / payment ...)
    2. add one entry to the "syncQueue" store describing that change
  Both steps happen inside ONE IndexedDB transaction, so either both are
  saved or neither is. That is what makes the offline queue trustworthy.
*/
const DB = (() => {
  const DB_NAME = 'shop-ledger-db';
  const DB_VERSION = 2;
  const DATA_STORES = ['products', 'customers', 'sales', 'saleItems', 'payments'];
  const ALL_STORES = [...DATA_STORES, 'syncQueue'];

  /* ---------- Opening the database ---------- */

  function createDataStores(db) {
    db.createObjectStore('products', { keyPath: 'id' });
    db.createObjectStore('customers', { keyPath: 'id' });
    db.createObjectStore('sales', { keyPath: 'id' }).createIndex('customerId', 'customerId');
    db.createObjectStore('saleItems', { keyPath: 'id' }).createIndex('saleId', 'saleId');
    db.createObjectStore('payments', { keyPath: 'id' }).createIndex('customerId', 'customerId');
  }

  // Each queue entry gets a number (seq) that only goes up: 1, 2, 3 ...
  // Changes are sent to the server in that order, which is the order they
  // happened in the shop, even if the computer's clock is changed.
  function createQueueStore(db) {
    return db.createObjectStore('syncQueue', { keyPath: 'seq', autoIncrement: true });
  }

  // Version 1 of this database had a queue without numbers. Move its waiting
  // entries into the numbered queue so nothing a user already entered is lost.
  function upgradeQueueFromV1(db, upgradeTx) {
    upgradeTx.objectStore('syncQueue').getAll().onsuccess = (event) => {
      const waiting = event.target.result
        .filter((op) => op.status !== 'synced')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      db.deleteObjectStore('syncQueue');
      const queue = createQueueStore(db);
      waiting.forEach(({ id, type, entityId, payload, createdAt }) => {
        queue.add({ id, type, entityId, payload, createdAt, status: 'pending', lastError: null });
      });
    };
  }

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      // Runs only when the browser has no database yet, or an older version.
      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (event.oldVersion === 0) {
          createDataStores(db);
          createQueueStore(db);
        } else if (event.oldVersion === 1) {
          upgradeQueueFromV1(db, request.transaction);
        }
      };
      request.onsuccess = () => {
        // If a newer version of the app opens in another tab, let it upgrade.
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Please close the other tabs of Shop Ledger and reload this page.'));
    });
    return dbPromise;
  }

  // Turns an IndexedDB request into a Promise so we can use await.
  const req = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

  // Runs `work` inside a single transaction. If `work` throws, everything
  // done inside the transaction is rolled back.
  async function tx(stores, mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction aborted'));

      const run = async () => work((name) => t.objectStore(name));
      run()
        .then((value) => { result = value; })
        .catch((err) => {
          try { t.abort(); } catch (e) { /* already finished */ }
          reject(err);
        });
    });
  }

  const uid = () => crypto.randomUUID();
  const round2 = (n) => Math.round(Number(n) * 100) / 100; // money: 2 decimal places

  // Adds one waiting change to the sync queue.
  // "id" is the idempotency key: the server remembers every id it has
  // processed and ignores a repeat, so a retry can never create a duplicate.
  function enqueue(s, type, entityId, payload) {
    s('syncQueue').add({
      id: uid(),
      type,
      entityId,
      payload,
      status: 'pending',
      lastError: null,
      createdAt: new Date().toISOString(),
    });
  }

  // Tells the rest of the app that a new change is waiting to be synced.
  const announce = () => window.dispatchEvent(new Event('ledger:queued'));

  /* ---------- Reading ---------- */

  const getAll = (store) => tx([store], 'readonly', (s) => req(s(store).getAll()));

  /* ---------- Products ---------- */

  async function saveProduct(input) {
    const name = String(input.name || '').trim();
    const price = round2(input.price);
    const quantity = Number(input.quantity);

    if (!name) throw new Error('Product name is required.');
    if (!Number.isFinite(price) || price <= 0) throw new Error('Price must be greater than 0.');
    if (!Number.isInteger(quantity) || quantity < 0) throw new Error('Quantity must be a whole number, 0 or more.');

    const now = new Date().toISOString();
    const product = await tx(['products', 'syncQueue'], 'readwrite', async (s) => {
      const all = await req(s('products').getAll());
      if (all.some((p) => p.id !== input.id && p.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`A product named "${name}" already exists.`);
      }
      const existing = input.id ? all.find((p) => p.id === input.id) : null;
      if (input.id && !existing) throw new Error('This product no longer exists.');

      const record = {
        id: existing ? existing.id : uid(),
        name,
        price,
        quantity,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        syncStatus: 'pending',
      };
      s('products').put(record);
      const { syncStatus, ...payload } = record;
      enqueue(s, existing ? 'product.update' : 'product.create', record.id, payload);
      return record;
    });
    announce();
    return product;
  }

  async function deleteProduct(id) {
    await tx(['products', 'syncQueue'], 'readwrite', (s) => {
      s('products').delete(id);
      enqueue(s, 'product.delete', id, { id });
    });
    announce();
  }

  /* ---------- Customers ---------- */

  async function addCustomer(input) {
    const name = String(input.name || '').trim();
    const phone = String(input.phone || '').trim();
    if (!name) throw new Error('Customer name is required.');
    if (phone && !/^[0-9+\- ]{6,15}$/.test(phone)) throw new Error('Phone number does not look valid.');

    const customer = {
      id: uid(),
      name,
      phone,
      createdAt: new Date().toISOString(),
      syncStatus: 'pending',
    };
    await tx(['customers', 'syncQueue'], 'readwrite', (s) => {
      s('customers').put(customer);
      const { syncStatus, ...payload } = customer;
      enqueue(s, 'customer.create', customer.id, payload);
    });
    announce();
    return customer;
  }

  /* ---------- Sales ---------- */

  // items: [{ productId, quantity }]
  // paidAmount: money received right now (0 = full credit).
  async function recordSale({ customerId = null, items, paidAmount }) {
    if (!items || !items.length) throw new Error('Add at least one product to the bill.');
    const now = new Date().toISOString();
    const saleId = uid();

    const sale = await tx(ALL_STORES, 'readwrite', async (s) => {
      if (customerId && !(await req(s('customers').get(customerId)))) {
        throw new Error('The selected customer no longer exists.');
      }

      // Stock is re-read INSIDE the transaction, so the check and the
      // deduction cannot be separated by another write.
      const saleItems = [];
      let total = 0;
      for (const item of items) {
        const qty = Number(item.quantity);
        if (!Number.isInteger(qty) || qty <= 0) throw new Error('Quantity must be a whole number greater than 0.');
        const product = await req(s('products').get(item.productId));
        if (!product) throw new Error('A product on this bill no longer exists.');
        if (qty > product.quantity) throw new Error(`Only ${product.quantity} of "${product.name}" in stock.`);

        product.quantity -= qty;
        product.updatedAt = now;
        s('products').put(product);

        saleItems.push({
          id: uid(),
          saleId,
          productId: product.id,
          productName: product.name, // copied, so old bills survive a rename or delete
          quantity: qty,
          unitPrice: product.price,
        });
        total = round2(total + qty * product.price);
      }

      const paid = round2(paidAmount);
      if (!Number.isFinite(paid) || paid < 0) throw new Error('Enter the amount paid.');
      if (paid > total) throw new Error('Amount paid cannot be more than the bill total.');
      if (!customerId && paid !== total) {
        throw new Error('A walk-in sale must be paid in full. Select a customer to sell on credit.');
      }

      const record = {
        id: saleId,
        customerId,
        totalAmount: total,
        paidAmount: paid,
        paymentStatus: paid === total ? 'paid' : paid === 0 ? 'credit' : 'partial',
        createdAt: now,
        syncStatus: 'pending',
      };
      s('sales').put(record);
      saleItems.forEach((it) => s('saleItems').put(it));

      // Money received at billing time is stored as its own payment record:
      // a sale and a payment are separate business events.
      let payment = null;
      if (paid > 0) {
        payment = { id: uid(), customerId, saleId, amount: paid, createdAt: now, syncStatus: 'pending' };
        s('payments').put(payment);
      }

      // One queue entry for the whole sale, so the server can apply
      // sale + items + stock deduction + payment in a single SQL transaction.
      const strip = ({ syncStatus, ...rest }) => rest;
      enqueue(s, 'sale.create', saleId, {
        sale: strip(record),
        items: saleItems,
        payment: payment ? strip(payment) : null,
      });
      return record;
    });
    announce();
    return sale;
  }

  /* ---------- Payments & balances ---------- */

  // Pending balance of a customer = all their purchases − all their payments.
  async function customerBalances() {
    const [sales, payments] = await Promise.all([getAll('sales'), getAll('payments')]);
    const map = {};
    const entry = (id) => (map[id] = map[id] || { purchases: 0, paid: 0, balance: 0 });
    sales.forEach((x) => { if (x.customerId) entry(x.customerId).purchases += x.totalAmount; });
    payments.forEach((x) => { if (x.customerId) entry(x.customerId).paid += x.amount; });
    Object.values(map).forEach((e) => {
      e.purchases = round2(e.purchases);
      e.paid = round2(e.paid);
      e.balance = round2(e.purchases - e.paid);
    });
    return map;
  }

  async function recordPayment({ customerId, amount }) {
    const value = round2(amount);
    if (!customerId) throw new Error('Select a customer.');
    if (!Number.isFinite(value) || value <= 0) throw new Error('Payment amount must be greater than 0.');

    const payment = {
      id: uid(),
      customerId,
      saleId: null,
      amount: value,
      createdAt: new Date().toISOString(),
      syncStatus: 'pending',
    };
    await tx(['customers', 'sales', 'payments', 'syncQueue'], 'readwrite', async (s) => {
      if (!(await req(s('customers').get(customerId)))) throw new Error('This customer no longer exists.');
      const sales = await req(s('sales').index('customerId').getAll(customerId));
      const pays = await req(s('payments').index('customerId').getAll(customerId));
      const balance = round2(
        sales.reduce((sum, x) => sum + x.totalAmount, 0) - pays.reduce((sum, x) => sum + x.amount, 0)
      );
      if (value > balance) throw new Error(`Payment is more than the pending amount (₹${balance}).`);

      s('payments').put(payment);
      const { syncStatus, ...payload } = payment;
      enqueue(s, 'payment.create', payment.id, payload);
    });
    announce();
    return payment;
  }

  /* ---------- Sync queue (used by sync.js) ---------- */

  // Changes still waiting for the server, oldest first (getAll returns them in seq order).
  const queuedOps = () => getAll('syncQueue');

  async function queueCounts() {
    const ops = await queuedOps();
    const failed = ops.filter((op) => op.status === 'failed').length;
    return { pending: ops.length - failed, failed };
  }

  // Called only after the server has confirmed these operations.
  // The queue entry is removed and the record it belongs to is marked "synced".
  async function markSynced(ops) {
    if (!ops.length) return;
    await tx(ALL_STORES, 'readwrite', async (s) => {
      ops.forEach((op) => s('syncQueue').delete(op.seq));

      // A record shows "synced" only when no other change to it is still waiting.
      const stillQueued = await req(s('syncQueue').getAll());
      const waitingIds = new Set(stillQueued.map((op) => op.entityId));
      const storeOf = { product: 'products', customer: 'customers', sale: 'sales', payment: 'payments' };

      const setSynced = async (store, id) => {
        const record = await req(s(store).get(id));
        if (record) s(store).put({ ...record, syncStatus: 'synced' });
      };
      for (const op of ops) {
        if (waitingIds.has(op.entityId) || op.type === 'product.delete') continue;
        await setSynced(storeOf[op.type.split('.')[0]], op.entityId);
        if (op.type === 'sale.create' && op.payload.payment) await setSynced('payments', op.payload.payment.id);
      }
    });
  }

  // The server refused this change. It stays in the queue with the reason,
  // so the problem is visible instead of silently disappearing.
  async function markRejected(op, reason) {
    await tx(['syncQueue'], 'readwrite', async (s) => {
      const current = await req(s('syncQueue').get(op.seq));
      if (current) s('syncQueue').put({ ...current, status: 'failed', lastError: reason });
    });
  }

  /* ---------- Restore from server (used by sync.js) ---------- */

  async function hasNoData(s) {
    for (const name of ALL_STORES) {
      if ((await req(s(name).count())) > 0) return false;
    }
    return true;
  }

  // True when this browser holds nothing at all: first visit, or its storage was cleared.
  const isEmpty = () => tx(ALL_STORES, 'readonly', hasNoData);

  // Copies the server's records into an empty local database.
  // Returns true if something was restored.
  function restore(snapshot) {
    return tx(ALL_STORES, 'readwrite', async (s) => {
      // Checked again inside the transaction: the user may have added
      // something while the snapshot was being downloaded.
      if (!(await hasNoData(s))) return false;

      let restored = false;
      for (const name of DATA_STORES) {
        for (const record of snapshot[name] || []) {
          // Sale items have no sync badge of their own; they belong to their sale.
          s(name).put(name === 'saleItems' ? record : { ...record, syncStatus: 'synced' });
          restored = true;
        }
      }
      return restored;
    });
  }

  return {
    round2,
    getAll,
    saveProduct, deleteProduct,
    addCustomer,
    recordSale,
    recordPayment, customerBalances,
    queuedOps, queueCounts, markSynced, markRejected,
    isEmpty, restore,
  };
})();
