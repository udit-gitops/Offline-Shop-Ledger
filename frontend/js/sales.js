/* sales.js — build a bill, check stock, save the sale. */
(() => {
  const { money, esc, round2 } = App;
  const $ = (id) => document.getElementById(id);

  let products = [];
  let customers = [];
  let cart = [];            // the bill being built: [{ productId, quantity }]
  let paidEdited = false;   // until the user types an amount, "paid" follows the total

  const productOf = (id) => products.find((p) => p.id === id);
  const inCart = (id) => (cart.find((c) => c.productId === id) || {}).quantity || 0;

  // Bill Total = sum of (quantity × unit price)
  const total = () => round2(cart.reduce((sum, c) => sum + c.quantity * productOf(c.productId).price, 0));

  async function load() {
    [products, customers] = await Promise.all([DB.getAll('products'), DB.getAll('customers')]);
    products.sort(App.byName);
    customers.sort(App.byName);

    // The stock may have changed since the bill was started (for example in
    // another tab): drop deleted products and never keep more than is in stock.
    cart = cart.filter((c) => productOf(c.productId) && productOf(c.productId).quantity > 0);
    cart.forEach((c) => { c.quantity = Math.min(c.quantity, productOf(c.productId).quantity); });

    renderCustomers($('customer').value);
    renderPicker();
    renderBill();
    renderToday();
  }

  function renderCustomers(selectedId) {
    $('customer').innerHTML =
      '<option value="">Walk-in customer (pays in full)</option>' +
      customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('customer').value = customers.some((c) => c.id === selectedId) ? selectedId : '';
  }

  function renderPicker() {
    if (!products.length) {
      $('pickBox').innerHTML = `<div class="empty"><strong>No products yet</strong>Add products before recording a sale.
        <div><a class="btn btn-primary" href="products.html">Add products</a></div></div>`;
      return;
    }
    const term = $('search').value.trim().toLowerCase();
    const rows = products.filter((p) => p.name.toLowerCase().includes(term));
    $('pickBox').innerHTML = rows.length
      ? `<div class="pick-list">${rows.map((p) => {
          const left = p.quantity - inCart(p.id); // stock still available for this bill
          return `<button type="button" class="pick" data-id="${p.id}" ${left <= 0 ? 'disabled' : ''}>
            <span class="pick-name">${esc(p.name)}</span>
            <span class="pick-meta"><span>${money(p.price)}</span><span>${left <= 0 ? 'None left' : left + ' left'}</span></span>
          </button>`;
        }).join('')}</div>`
      : `<div class="empty">No product matches "${esc(term)}".</div>`;
  }

  function renderBill() {
    if (!cart.length) {
      $('billBox').innerHTML = `<div class="empty">The bill is empty.</div>`;
    } else {
      $('billBox').innerHTML = `<table class="bill">
        <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th><th></th></tr></thead>
        <tbody>${cart.map((c) => {
          const p = productOf(c.productId);
          return `<tr>
            <td>${esc(p.name)}</td>
            <td class="num"><input class="qty" type="number" min="1" max="${p.quantity}" step="1" value="${c.quantity}" data-qty="${p.id}" aria-label="Quantity of ${esc(p.name)}"></td>
            <td class="num">${money(p.price)}</td>
            <td class="num" data-line="${p.id}">${money(c.quantity * p.price)}</td>
            <td><button type="button" class="btn btn-sm btn-danger" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    }
    renderTotals();
  }

  function renderTotals() {
    $('billTotal').textContent = money(total());
    if (!paidEdited) $('paid').value = cart.length ? total() : '';
    renderDue();
  }

  function renderDue() {
    const paid = Number($('paid').value || 0);
    $('dueAmount').textContent = money(Math.max(0, round2(total() - paid)));
    $('saveBtn').disabled = cart.length === 0;
  }

  async function renderToday() {
    const [sales, saleItems] = await Promise.all([DB.getAll('sales'), DB.getAll('saleItems')]);
    const todays = sales
      .filter((s) => App.dayKey(s.createdAt) === App.today())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!todays.length) {
      $('todayBox').innerHTML = `<div class="empty">No sales recorded today.</div>`;
      return;
    }
    $('todayBox').innerHTML = `<table>
      <thead><tr><th>Time</th><th>Customer</th><th>Items</th><th class="num">Total</th><th>Sync</th></tr></thead>
      <tbody>${todays.map((s) => `
        <tr>
          <td class="muted">${App.fmtTime(s.createdAt)}</td>
          <td>${esc(App.customerName(customers, s.customerId))}</td>
          <td class="small">${esc(App.itemsText(saleItems, s.id))}</td>
          <td class="num">${money(s.totalAmount)}</td>
          <td>${App.syncBadge(s.syncStatus)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  }

  const renderCart = () => { renderPicker(); renderBill(); };

  /* ---------- Bill events ---------- */

  $('pickBox').addEventListener('click', (e) => {
    const button = e.target.closest('.pick');
    if (!button) return;
    const id = button.dataset.id;
    if (inCart(id) >= productOf(id).quantity) return; // never more than the stock
    const line = cart.find((c) => c.productId === id);
    if (line) line.quantity += 1; else cart.push({ productId: id, quantity: 1 });
    renderCart();
  });

  // A quantity typed in the bill is applied on every keystroke, and only the
  // numbers that depend on it are updated. The bill table itself is NOT rebuilt
  // here: rebuilding it while the user is moving to the next button would
  // swallow that click.
  $('billBox').addEventListener('input', (e) => {
    const id = e.target.dataset.qty;
    if (!id) return;
    const stock = productOf(id).quantity;
    let qty = Math.floor(Number(e.target.value));
    if (!(qty >= 1)) return; // empty or 0 while typing: wait for a real number
    if (qty > stock) {
      qty = stock;
      e.target.value = stock;
      App.toast(`Only ${stock} in stock`, 'error');
    }
    cart.find((c) => c.productId === id).quantity = qty;
    $('billBox').querySelector(`[data-line="${id}"]`).textContent = money(qty * productOf(id).price);
    renderPicker();
    renderTotals();
  });

  // Leaving the box: show the quantity that is really on the bill
  // (for example after the box was left empty).
  $('billBox').addEventListener('change', (e) => {
    const id = e.target.dataset.qty;
    if (id) e.target.value = cart.find((c) => c.productId === id).quantity;
  });

  $('billBox').addEventListener('click', (e) => {
    const id = e.target.dataset.remove;
    if (!id) return;
    cart = cart.filter((c) => c.productId !== id);
    renderCart();
  });

  $('paid').addEventListener('input', () => { paidEdited = true; renderDue(); });
  $('fullBtn').addEventListener('click', () => { paidEdited = false; renderBill(); });
  $('creditBtn').addEventListener('click', () => { paidEdited = true; $('paid').value = 0; renderDue(); });
  $('search').addEventListener('input', renderPicker);

  /* ---------- Save sale ---------- */

  App.onSubmit($('saleForm'), $('formError'), async () => {
    try {
      const sale = await DB.recordSale({
        customerId: $('customer').value || null,
        items: cart,
        paidAmount: $('paid').value === '' ? NaN : Number($('paid').value),
      });
      const due = round2(sale.totalAmount - sale.paidAmount);
      App.toast(`Sale of ${money(sale.totalAmount)} saved` + (due > 0 ? ` · ${money(due)} added to dues` : ''));
      cart = [];
      paidEdited = false;
      $('customer').value = '';
    } finally {
      // Saved or refused, show the stock and prices as they are now.
      await load();
    }
  });

  $('newCustomerBtn').addEventListener('click', () => {
    App.askNewCustomer((customer) => {
      customers.push(customer);
      customers.sort(App.byName);
      renderCustomers(customer.id);
    });
  });

  // While a bill is being typed, a finished sync only refreshes the list of
  // today's sales, so it cannot disturb the quantity boxes.
  App.onSynced(() => (products.length ? renderToday() : load()));
  load();
})();
