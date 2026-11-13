# Offline-First Shop Ledger Web-App

B.Tech CSE VII Semester minor project — Udit Navariya and Vinod Kumar Meena.

A small web app for one shop and one user. The shopkeeper can manage products, record sales,
keep customer dues and see basic reports. It keeps working without internet: entries are saved
in the browser first and sent to the server when the connection returns.

## Features

- **Products:** add, edit and delete products with name, price and quantity; low-stock warning.
- **Sales:** pick products, enter quantities, bill total is calculated, stock is reduced automatically.
- **Customer ledger:** sell on credit, record payments, see each customer's pending amount and history.
- **Reports:** daily sales, pending dues, and a chart of the last 7 days.
- **Offline:** the app opens and records entries without internet.
- **Sync status:** every entry shows **Pending** or **Synced**; pending entries are sent when the server is reachable.

## Tech stack

| Part | Technology |
|---|---|
| Pages and styling | HTML, CSS, JavaScript (no framework) |
| Data in the browser | IndexedDB |
| Opening the app offline | Service Worker + Cache API |
| Server | Node.js + Express |
| Data on the server | SQLite (`better-sqlite3` package) |
| Chart | Chart.js |

## How to run

You need [Node.js](https://nodejs.org) 22 or newer (`node -v` shows your version) and Git.

```powershell
git clone https://github.com/udit-gitops/Offline-Shop-Ledger.git
cd Offline-Shop-Ledger\backend
npm install      # only the first time, downloads Express and better-sqlite3
npm start
```

Then open **http://localhost:5500** in Chrome or Edge. Stop the server with `Ctrl + C`.

While changing backend code, use `npm run dev` instead of `npm start`: the server then restarts by
itself whenever a backend file is saved.

- Always open the app through `http://localhost:5500`. Do not double-click the HTML files:
  the service worker (offline support) only works on `localhost` or `https`.
- The server only accepts connections from the same computer (it listens on `127.0.0.1`), because
  the app has no login.
- The SQLite database file is created automatically at `backend/data/ledger.db`.
- For demo data, run `npm run seed` in the `backend` folder: it fills an empty database with a sample
  kirana shop (10 products, 4 customers, a week of sales). A browser that has no data yet shows it
  after a reload.
- To start again with an empty shop: stop the server, delete `backend/data/ledger.db`, and in the
  browser clear the site data (DevTools → Application → Storage → "Clear site data"). Do both,
  otherwise the browser and the server no longer agree.

## Folder structure

```
frontend/                  what runs in the browser
  index.html               Dashboard
  products.html            Products / inventory
  sales.html               Sales / billing
  customers.html           Customer ledger
  reports.html             Reports (daily sales, pending dues, 7-day chart)
  css/style.css            all styling
  js/db.js                 IndexedDB: every read and write of local data + the sync queue
  js/sync.js               sends waiting changes to the server
  js/app.js                shared code: sidebar, sync status, helpers
  js/<page>.js             one file per page
  service-worker.js        caches the app files so the app opens offline
  assets/chart.umd.min.js  Chart.js library (local copy, so the chart works offline)
backend/                   what runs on the server
  server.js                starts Express; serves the frontend and the API
  routes/api.js            the three API endpoints
  services/syncService.js  applies each change exactly once
  services/operations.js   what each kind of change does (validation + SQL)
  services/snapshot.js     reads everything stored on the server
  services/validate.js     small validation helpers
  database/schema.sql      the SQLite tables
  database/db.js           opens the database
  tests/sync.test.js       backend tests (`npm test`)
```

## How it works

There are two databases with different jobs:

| | IndexedDB | SQLite |
|---|---|---|
| Where | inside the browser | on the server (`backend/data/ledger.db`) |
| Job | the app reads and writes here, always, online or offline | keeps a safe copy of everything that was synced |

And two different offline mechanisms:

- **Service Worker + Cache API** keep the app's *files* (HTML, CSS, JS) so the app can open offline.
- **IndexedDB** keeps the shop's *data* (products, sales, ...).

### What happens when a sale is saved

1. `db.js` opens one IndexedDB transaction and, inside it: checks the stock, reduces the stock,
   saves the sale, its items and the payment, and adds one entry to the `syncQueue` store.
   If any step fails, the whole transaction is undone.
2. The sale appears on screen at once with a **Pending** badge. No internet was needed.
3. `sync.js` sends the queue to `POST /api/sync` (immediately if online, otherwise when the
   connection returns, and every 30 seconds while the page is open).
4. The server checks the sale again and saves it in one SQLite transaction.
5. Only after the server answers does the browser remove the queue entry and show **Synced**.

### How duplicates are prevented

Every queue entry has a unique id made in the browser. The server stores each id it has applied
in the `sync_log` table, in the same transaction as the change itself. If the same entry arrives
again (for example the first reply was lost on a bad network) the server answers `duplicate` and
changes nothing.

### How stock stays correct

- The browser sends *what happened* ("sold 5 Sugar"), not the resulting stock number.
  The server subtracts 5 from its own stock, so two offline sales of 5 and 3 take 50 down to 42.
- Queue entries are numbered 1, 2, 3 ... and are sent and applied in that order.
- SQLite refuses negative stock (`CHECK (quantity >= 0)`).

### If the server refuses a change

The entry stays in the queue marked as rejected, the dashboard shows it with the server's reason,
and later changes still sync. It is tried again on every sync.

### If the browser's storage is cleared

When the app starts with a completely empty IndexedDB, it copies the records from the server
(`GET /api/snapshot`).

## API

All data is JSON. There is no login: the prototype is for one user on one computer.

| Method | URL | Purpose |
|---|---|---|
| GET | `/api/health` | `{ "ok": true }` when the server is running |
| POST | `/api/sync` | apply the browser's waiting changes |
| GET | `/api/snapshot` | every record on the server: `{ products, customers, sales, saleItems, payments }` |

`POST /api/sync`

```
Request : { "operations": [ { "id": "<uuid>", "type": "sale.create", "payload": { ... } } ] }
Response: { "results":    [ { "id": "<uuid>", "status": "ok" } ] }
```

`status` is `ok`, `duplicate` (already applied earlier) or `error` (rejected; an `error` text says why).

| type | payload |
|---|---|
| `product.create`, `product.update` | `{ id, name, price, quantity, createdAt, updatedAt }` |
| `product.delete` | `{ id }` |
| `customer.create` | `{ id, name, phone, createdAt }` |
| `sale.create` | `{ sale: { id, customerId, totalAmount, paidAmount, createdAt }, items: [ { id, productId, productName, quantity, unitPrice } ], payment: { id, amount, createdAt } or null }` |
| `payment.create` | `{ id, customerId, amount, createdAt }` |

Rules the server checks again for every sale: the total must equal the sum of its items, the
amount paid must be between 0 and the total, a walk-in sale (no customer) must be paid in full,
and there must be enough stock. Ids may contain only letters, digits and `-`, and money values may
have at most 2 decimals.

## Testing

Backend tests (23 tests, they use a temporary in-memory database):

```powershell
cd backend
npm test
```

Manual offline test (the sequence from the synopsis):

1. Open the app online and record a sale. The sidebar shows "All changes synced".
2. Stop the server (`Ctrl + C`), or in DevTools → Network choose "Offline".
3. Record more sales and a payment. They show a **Pending** badge.
4. Refresh the page. The app still opens and the entries are still there.
5. Start the server again (`npm start`) or switch the network back on.
6. Within 30 seconds (or press "Sync now") everything turns **Synced**.
7. Open http://localhost:5500/api/snapshot and check each sale is there exactly once.

## Limitations

- One shop, one user, one browser. Using two browsers or two devices on the same server at the
  same time is not supported: each would keep its own local copy.
- No login or user accounts.
- Quantities are whole numbers (no 0.5 kg).
- Customers cannot be edited or deleted, and a saved sale cannot be changed.
- A change the server rejects stays listed on the dashboard; there is no button to discard it.
- Not included by design: online payments, GST filing, multiple branches, advanced accounting.
- The server can be reached only from the computer it runs on.
- On a very slow connection the app waits for the network before using its cached files.
