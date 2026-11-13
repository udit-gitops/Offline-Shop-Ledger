/*
  app.js — code shared by every page:
  sidebar, online/offline + sync indicator, small helpers, service worker registration.
*/
const App = (() => {
  const LOW_STOCK = 5; // a product with this many units or fewer counts as "low stock"

  const icon = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

  const NAV = [
    { key: 'dashboard', href: 'index.html', label: 'Dashboard',
      icon: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>' },
    { key: 'products', href: 'products.html', label: 'Products',
      icon: '<path d="M3 8l9-5 9 5v8l-9 5-9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/>' },
    { key: 'sales', href: 'sales.html', label: 'Sales',
      icon: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6"/>' },
    { key: 'customers', href: 'customers.html', label: 'Customers',
      icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>' },
    { key: 'reports', href: 'reports.html', label: 'Reports',
      icon: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>' },
  ];

  /* ---------- Formatting helpers ---------- */

  const money = (n) =>
    '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  // Always escape text typed by the user before putting it into innerHTML.
  const esc = (text) =>
    String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const pad = (n) => String(n).padStart(2, '0');

  // Local calendar day of a date, as "YYYY-MM-DD". Timestamps are stored in
  // UTC (ISO), but "today's sales" must follow the shopkeeper's local day.
  const dayKey = (date) => {
    const d = new Date(date);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const today = () => dayKey(new Date());

  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtDateTime = (iso) => `${new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${fmtTime(iso)}`;

  const syncBadge = (status) =>
    status === 'synced'
      ? '<span class="badge badge-ok">Synced</span>'
      : '<span class="badge badge-warn">Pending</span>';

  /* ---------- Record helpers used by several pages ---------- */

  // Name of a sale's or payment's customer. No customer id means a walk-in sale.
  const customerName = (customers, id) => (customers.find((c) => c.id === id) || {}).name || 'Walk-in';

  // "Sugar × 2, Rice × 1" for one sale.
  const itemsText = (saleItems, saleId) =>
    saleItems.filter((item) => item.saleId === saleId).map((item) => `${item.productName} × ${item.quantity}`).join(', ');

  const byName = (a, b) => a.name.localeCompare(b.name);

  /* ---------- Messages and forms ---------- */

  function toast(message, type = 'ok') {
    const box = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // Handles a form submit for every form in the app:
  // runs `save`, shows its error message inside `errorBox`, and ignores a
  // second click while the first save is still running (no double entries).
  function onSubmit(form, errorBox, save) {
    let saving = false;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving) return;
      saving = true;
      errorBox.hidden = true;
      try {
        await save();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      } finally {
        saving = false;
      }
    });
  }

  // The "new customer" dialog is needed on the Sales and Customers pages,
  // so it is built here once. `onAdded` receives the saved customer.
  function askNewCustomer(onAdded) {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = `
      <form novalidate>
        <div class="dialog-head">New customer</div>
        <div class="dialog-body">
          <div class="form-error" hidden></div>
          <div class="field">
            <label for="cName">Name</label>
            <input id="cName" maxlength="80" autocomplete="off">
          </div>
          <div class="field">
            <label for="cPhone">Phone (optional)</label>
            <input id="cPhone" type="tel" maxlength="15" autocomplete="off">
          </div>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" data-cancel>Cancel</button>
          <button type="submit" class="btn btn-primary">Add customer</button>
        </div>
      </form>`;
    document.body.appendChild(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());

    onSubmit(dialog.querySelector('form'), dialog.querySelector('.form-error'), async () => {
      const customer = await DB.addCustomer({
        name: dialog.querySelector('#cName').value,
        phone: dialog.querySelector('#cPhone').value,
      });
      dialog.close();
      toast('Customer added');
      onAdded(customer);
    });
    dialog.showModal();
  }

  /* ---------- Sidebar + sync indicator ---------- */

  function renderShell() {
    const page = document.body.dataset.page;
    document.getElementById('sidebar').innerHTML = `
      <a class="brand" href="index.html">
        <span class="brand-mark">₹</span>
        <span class="brand-name">Shop Ledger</span>
      </a>
      <nav class="nav" aria-label="Main">
        ${NAV.map((n) => `
          <a href="${n.href}" class="nav-link${n.key === page ? ' active' : ''}"${n.key === page ? ' aria-current="page"' : ''}>
            ${icon(n.icon)}<span>${n.label}</span>
          </a>`).join('')}
      </nav>
      <div class="sync">
        <div class="sync-net"><span class="dot" id="netDot"></span><span id="netText"></span></div>
        <div class="sync-msg" id="syncText"></div>
        <button type="button" class="sync-btn" id="syncBtn">Sync now</button>
      </div>`;
    document.getElementById('syncBtn').addEventListener('click', () => Sync.run());
  }

  async function refreshStatus() {
    const online = navigator.onLine;
    const { pending, failed } = await DB.queueCounts();
    const { running, unreachable } = Sync.state();

    document.getElementById('netDot').className = 'dot ' + (online ? 'dot-on' : 'dot-off');
    document.getElementById('netText').textContent = online ? 'Online' : 'Offline';

    const parts = [];
    if (pending) parts.push(`${pending} pending`);
    if (failed) parts.push(`${failed} rejected`);
    let message = parts.join(' · ') || 'All changes synced';
    if (running && pending) message = 'Syncing…';
    else if (pending && !online) message += ' · will sync when online';
    else if (pending && unreachable) message += ' · server not reachable';

    document.getElementById('syncText').textContent = message;
    document.getElementById('syncBtn').disabled = running || !online || pending + failed === 0;
  }

  /* ---------- Start-up ---------- */

  function start() {
    renderShell();
    refreshStatus();

    window.addEventListener('online', () => { refreshStatus(); Sync.run(); });
    window.addEventListener('offline', refreshStatus);
    window.addEventListener('ledger:queued', () => { refreshStatus(); Sync.run(); }); // a new local change
    window.addEventListener('ledger:sync', refreshStatus);                            // a sync attempt started/finished

    // An error nobody handled must not pass silently: show it.
    window.addEventListener('unhandledrejection', (event) => {
      toast((event.reason && event.reason.message) || 'Something went wrong.', 'error');
    });

    // Ask the browser not to delete this site's data when the disk gets full:
    // sales that are not synced yet exist only in IndexedDB.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

    Sync.run();
    setInterval(() => Sync.run(), 30000); // keep retrying while the tab is open

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch((err) => console.warn('Service worker not registered:', err));
    }
  }

  // Lets a page re-draw itself when records change from "pending" to "synced"
  // (or when data was restored from the server).
  const onSynced = (redraw) =>
    window.addEventListener('ledger:sync', (event) => { if (event.detail.changed) redraw(); });

  start();

  return {
    LOW_STOCK, round2: DB.round2,
    money, esc, dayKey, today, fmtTime, fmtDate, fmtDateTime, syncBadge,
    customerName, itemsText, byName,
    toast, onSubmit, askNewCustomer, onSynced,
  };
})();
