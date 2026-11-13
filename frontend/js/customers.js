/* customers.js — customer list, each customer's ledger, and recording payments. */
(() => {
  const { money, esc, round2 } = App;
  const $ = (id) => document.getElementById(id);

  let customers = [];
  let balances = {};
  let sales = [];
  let payments = [];
  let saleItems = [];
  let selectedId = new URLSearchParams(location.search).get('id');

  const balanceOf = (id) => balances[id] || { purchases: 0, paid: 0, balance: 0 };

  async function load() {
    [customers, balances, sales, payments, saleItems] = await Promise.all([
      DB.getAll('customers'), DB.customerBalances(), DB.getAll('sales'), DB.getAll('payments'), DB.getAll('saleItems'),
    ]);
    customers.sort(App.byName);
    if (!customers.some((c) => c.id === selectedId)) selectedId = customers.length ? customers[0].id : null;
    renderList();
    renderLedger();
  }

  function renderList() {
    const totalDue = customers.reduce((sum, c) => sum + Math.max(0, balanceOf(c.id).balance), 0);
    $('summary').textContent = `${customers.length} ${customers.length === 1 ? 'customer' : 'customers'} · ${money(totalDue)} pending in total`;

    const term = $('search').value.trim().toLowerCase();
    const rows = customers.filter((c) => c.name.toLowerCase().includes(term) || c.phone.includes(term));

    if (!customers.length) {
      $('listBox').innerHTML = `<div class="empty"><strong>No customers yet</strong>Add customers who buy on credit.</div>`;
      return;
    }
    $('listBox').innerHTML = rows.length
      ? rows.map((c) => {
          const due = balanceOf(c.id).balance;
          return `<button type="button" class="cust${c.id === selectedId ? ' active' : ''}" data-id="${c.id}">
            <span>
              <span class="cust-name">${esc(c.name)}</span>
              ${c.phone ? `<br><span class="muted small">${esc(c.phone)}</span>` : ''}
            </span>
            ${due > 0 ? `<span class="badge badge-warn">${money(due)} due</span>` : '<span class="badge badge-ok">Settled</span>'}
          </button>`;
        }).join('')
      : `<div class="empty">No customer matches "${esc(term)}".</div>`;
  }

  // The customer's history, oldest first, with the balance after each entry.
  // Purchases increase the balance, payments reduce it.
  function ledgerEntries(customerId) {
    const entries = [
      ...sales.filter((s) => s.customerId === customerId).map((s) => ({
        at: s.createdAt, order: 0, change: s.totalAmount, status: s.syncStatus,
        label: 'Purchase', detail: App.itemsText(saleItems, s.id),
      })),
      ...payments.filter((p) => p.customerId === customerId).map((p) => ({
        at: p.createdAt, order: 1, change: -p.amount, status: p.syncStatus,
        label: 'Payment', detail: p.saleId ? 'Paid at billing' : 'Payment received',
      })),
    ].sort((x, y) => x.at.localeCompare(y.at) || x.order - y.order);

    let running = 0;
    entries.forEach((entry) => {
      running = round2(running + entry.change);
      entry.balance = running;
    });
    return entries;
  }

  function renderLedger() {
    const customer = customers.find((c) => c.id === selectedId);
    if (!customer) {
      $('ledgerBox').innerHTML = `<div class="empty">Select a customer to see their ledger.</div>`;
      return;
    }
    const b = balanceOf(customer.id);
    const entries = ledgerEntries(customer.id).reverse(); // newest first on screen

    $('ledgerBox').innerHTML = `
      <div class="card-head">
        <h2>${esc(customer.name)}</h2>
        <span class="muted small">${customer.phone ? esc(customer.phone) + ' · ' : ''}Customer since ${App.fmtDate(customer.createdAt)} ${App.syncBadge(customer.syncStatus)}</span>
      </div>
      <div class="ledger-sum">
        <div><span class="muted small">Total purchases</span><b>${money(b.purchases)}</b></div>
        <div><span class="muted small">Payments received</span><b>${money(b.paid)}</b></div>
        <div><span class="muted small">Pending amount</span><b class="${b.balance > 0 ? 'is-due' : ''}">${money(b.balance)}</b></div>
      </div>
      ${b.balance > 0 ? `
        <form class="card-body" id="payForm" novalidate>
          <div class="form-error" id="payError" hidden></div>
          <label for="payAmount">Record a payment (₹)</label>
          <div class="inline-form">
            <input id="payAmount" type="number" min="0" max="${b.balance}" step="0.01" inputmode="decimal" placeholder="Up to ${b.balance}">
            <button type="button" class="btn" id="payFull">Full</button>
            <button type="submit" class="btn btn-primary">Save payment</button>
          </div>
        </form>` : ''}
      <div class="table-wrap">
        ${entries.length ? `<table>
          <thead><tr><th>Date</th><th>Entry</th><th class="num">Amount</th><th class="num">Balance</th><th>Sync</th></tr></thead>
          <tbody>${entries.map((e) => `
            <tr>
              <td class="muted">${App.fmtDateTime(e.at)}</td>
              <td><b>${e.label}</b><br><span class="muted small">${esc(e.detail)}</span></td>
              <td class="num">${e.change > 0 ? '+' : '−'}${money(Math.abs(e.change))}</td>
              <td class="num">${money(e.balance)}</td>
              <td>${App.syncBadge(e.status)}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : `<div class="empty">No purchases or payments yet.</div>`}
      </div>`;

    // The payment form exists only while the customer owes something.
    if (b.balance <= 0) return;
    $('payFull').addEventListener('click', () => { $('payAmount').value = b.balance; });
    App.onSubmit($('payForm'), $('payError'), async () => {
      const amount = $('payAmount').value === '' ? NaN : Number($('payAmount').value);
      await DB.recordPayment({ customerId: customer.id, amount });
      App.toast(`Payment of ${money(amount)} recorded`);
      await load();
    });
  }

  $('listBox').addEventListener('click', (e) => {
    const button = e.target.closest('.cust');
    if (!button) return;
    selectedId = button.dataset.id;
    history.replaceState(null, '', '?id=' + selectedId);
    renderList();
    renderLedger();
  });

  $('search').addEventListener('input', renderList);

  $('addBtn').addEventListener('click', () => {
    App.askNewCustomer((customer) => {
      selectedId = customer.id;
      load();
    });
  });

  // Do not re-draw while the user is typing a payment amount.
  App.onSynced(() => { if (!($('payAmount') && $('payAmount').value)) load(); });
  load();
})();
