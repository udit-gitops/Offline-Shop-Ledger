/* dashboard.js — every number on this page is calculated from IndexedDB records. */
(() => {
  const { money, esc } = App;
  const $ = (id) => document.getElementById(id);

  const OPERATION_NAMES = {
    'product.create': 'New product',
    'product.update': 'Product edit',
    'product.delete': 'Product delete',
    'customer.create': 'New customer',
    'sale.create': 'Sale',
    'payment.create': 'Payment',
  };

  async function render() {
    const [products, customers, sales, payments, balances, queue] = await Promise.all([
      DB.getAll('products'), DB.getAll('customers'), DB.getAll('sales'), DB.getAll('payments'),
      DB.customerBalances(), DB.queuedOps(),
    ]);

    $('todayLabel').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

    // Today's sales
    const todaySales = sales.filter((s) => App.dayKey(s.createdAt) === App.today());
    $('statSales').textContent = money(todaySales.reduce((sum, s) => sum + s.totalAmount, 0));
    $('statSalesNote').textContent = `${todaySales.length} ${todaySales.length === 1 ? 'sale' : 'sales'} today`;

    // Products
    $('statProducts').textContent = products.length;
    $('statProductsNote').textContent = `${products.reduce((sum, p) => sum + p.quantity, 0)} units in stock`;

    // Pending dues
    const owing = Object.values(balances).filter((b) => b.balance > 0);
    const dues = owing.reduce((sum, b) => sum + b.balance, 0);
    $('statDues').textContent = money(dues);
    $('statDuesNote').textContent = `${owing.length} ${owing.length === 1 ? 'customer' : 'customers'} with dues`;
    $('statDuesCard').classList.toggle('is-warn', dues > 0);

    // Low stock
    const low = products.filter((p) => p.quantity <= App.LOW_STOCK).sort((a, b) => a.quantity - b.quantity);
    $('statLow').textContent = low.length;
    $('statLowNote').textContent = `${App.LOW_STOCK} units or fewer`;
    $('statLowCard').classList.toggle('is-warn', low.length > 0);

    $('lowBox').innerHTML = low.length
      ? `<table>
          <thead><tr><th>Product</th><th class="num">Left</th></tr></thead>
          <tbody>${low.map((p) => `
            <tr>
              <td>${esc(p.name)}</td>
              <td class="num">${p.quantity === 0 ? '<span class="badge badge-danger">Out of stock</span>' : p.quantity}</td>
            </tr>`).join('')}
          </tbody>
        </table>`
      : `<div class="empty">${products.length ? 'All products are well stocked.' : 'No products yet.'}</div>`;

    renderRejected(queue.filter((op) => op.status === 'failed'));
    renderRecent(products, customers, sales, payments);
  }

  // Changes the server refused, with the server's reason. Normally empty.
  function renderRejected(rejected) {
    $('rejectedCard').hidden = rejected.length === 0;
    $('rejectedBox').innerHTML = `<table>
      <thead><tr><th>Change</th><th>Made on</th><th>Reason given by the server</th></tr></thead>
      <tbody>${rejected.map((op) => `
        <tr>
          <td>${OPERATION_NAMES[op.type]}</td>
          <td class="muted">${App.fmtDateTime(op.createdAt)}</td>
          <td>${esc(op.lastError)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  }

  // Recent transactions = sales + payments received later (not the ones taken at billing).
  function renderRecent(products, customers, sales, payments) {
    const recent = [
      ...sales.map((s) => ({ ...s, type: 'Sale', amount: s.totalAmount })),
      ...payments.filter((p) => !p.saleId).map((p) => ({ ...p, type: 'Payment' })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);

    if (recent.length) {
      $('recentBox').innerHTML = `<table>
        <thead><tr><th>When</th><th>Type</th><th>Customer</th><th class="num">Amount</th><th>Sync</th></tr></thead>
        <tbody>${recent.map((r) => `
          <tr>
            <td class="muted">${App.fmtDateTime(r.createdAt)}</td>
            <td><span class="badge ${r.type === 'Sale' ? 'badge-plain' : 'badge-ok'}">${r.type}</span></td>
            <td>${esc(App.customerName(customers, r.customerId))}</td>
            <td class="num">${money(r.amount)}</td>
            <td>${App.syncBadge(r.syncStatus)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    } else if (!products.length) {
      $('recentBox').innerHTML = `<div class="empty">
        <strong>Your ledger is empty</strong>
        Add your products first, or load a small sample shop to try the app.
        <div><a class="btn btn-primary" href="products.html">Add products</a>
        <button type="button" class="btn" id="sampleBtn">Load sample data</button></div>
      </div>`;
      $('sampleBtn').addEventListener('click', loadSample);
    } else {
      $('recentBox').innerHTML = `<div class="empty"><strong>No transactions yet</strong>Record your first sale to see it here.</div>`;
    }
  }

  // Sample shop data for demos and testing. It goes through the normal
  // DB functions, so it is queued for sync like any other entry.
  async function loadSample(event) {
    event.target.disabled = true; // a second click must not add everything twice
    const products = [
      ['Sugar (1 kg)', 45, 50], ['Rice (1 kg)', 60, 40], ['Wheat flour (5 kg)', 210, 12],
      ['Toor dal (1 kg)', 140, 18], ['Tea (250 g)', 120, 4], ['Salt (1 kg)', 22, 30],
      ['Mustard oil (1 L)', 165, 9], ['Bath soap', 35, 3], ['Biscuits', 10, 80],
    ];
    const customers = [['Ramesh Kumar', '9876543210'], ['Sunita Devi', ''], ['Imran Khan', '9812345678']];
    try {
      for (const [name, price, quantity] of products) await DB.saveProduct({ name, price, quantity });
      for (const [name, phone] of customers) await DB.addCustomer({ name, phone });
      App.toast('Sample data added');
    } catch (err) {
      App.toast(err.message, 'error');
    }
    render();
  }

  App.onSynced(render);
  render();
})();
