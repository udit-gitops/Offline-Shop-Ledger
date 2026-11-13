/*
  sync.js — sends the waiting changes from IndexedDB to the server.

  Contract with the backend (backend/routes/api.js):

    POST /api/sync
    Request : { "operations": [ { id, type, payload }, ... ] }      oldest first
    Response: { "results":    [ { id, status, error? }, ... ] }
              status is "ok", "duplicate" (already applied earlier) or "error" (rejected)

  Rules:
  - A change is removed from the local queue ONLY after the server confirmed it.
  - If the request fails for any reason, everything stays in the queue and is
    sent again later. The server ignores operation ids it has already applied,
    so sending twice never creates a duplicate.
*/
const Sync = (() => {
  const BATCH_SIZE = 50;     // operations per request, keeps each request small
  const TIMEOUT_MS = 10000;

  let running = false;
  let runAgain = false;      // a new change arrived while a sync was in progress
  let unreachable = false;   // the last attempt could not get an answer from the server
  let restoreChecked = false;

  const notify = (changed) =>
    window.dispatchEvent(new CustomEvent('ledger:sync', { detail: { changed } }));

  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Server answered with status ${response.status}`);
    return response.json();
  }

  // A browser with no data at all (first visit, or its storage was cleared)
  // copies the shop's records from the server. Returns true if it restored anything.
  async function restoreIfEmpty() {
    if (restoreChecked) return false;
    let restored = false;
    if (await DB.isEmpty()) {
      restored = await DB.restore(await request('/api/snapshot'));
    }
    restoreChecked = true;
    return restored;
  }

  // Sends one batch. Returns true if any record changed its sync state.
  async function sendBatch(ops) {
    const data = await request('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations: ops.map(({ id, type, payload }) => ({ id, type, payload })) }),
    });
    if (!Array.isArray(data.results)) throw new Error('Unexpected answer from the server');

    const resultOf = new Map(data.results.map((result) => [result.id, result]));
    const statusOf = (op) => (resultOf.get(op.id) || {}).status;

    const accepted = ops.filter((op) => statusOf(op) === 'ok' || statusOf(op) === 'duplicate');
    const rejected = ops.filter((op) => statusOf(op) === 'error');
    // An operation the server did not mention simply stays in the queue.

    await DB.markSynced(accepted);
    for (const op of rejected) await DB.markRejected(op, resultOf.get(op.id).error || 'Rejected by the server');

    return accepted.length > 0 || rejected.some((op) => op.status !== 'failed');
  }

  async function run() {
    if (running) { runAgain = true; return; }
    running = true;
    let changed = false;
    try {
      // navigator.onLine === true does NOT prove the server is reachable;
      // the real test is whether the requests below succeed.
      if (!navigator.onLine) return;

      changed = await restoreIfEmpty();

      const ops = await DB.queuedOps();
      if (ops.length) notify(false); // lets the sidebar show "Syncing…"
      for (let start = 0; start < ops.length; start += BATCH_SIZE) {
        // Batches go one after another; if one fails we stop, to keep the order.
        if (await sendBatch(ops.slice(start, start + BATCH_SIZE))) changed = true;
      }
      unreachable = false;
    } catch (err) {
      // Network failure, timeout or server error: keep everything for the next try.
      console.warn('Sync attempt failed:', err.message);
      unreachable = true;
    } finally {
      running = false;
      notify(changed);
      if (runAgain) { runAgain = false; run(); }
    }
  }

  return {
    run,
    state: () => ({ running, unreachable }),
  };
})();
