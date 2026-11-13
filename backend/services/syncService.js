/*
  syncService.js — applies the operations sent by the browser, each one exactly once.

  Why "exactly once" matters: the browser may send the same sale twice (for
  example the first reply was lost on a bad network). The operation id is
  saved in the sync_log table in the SAME transaction as the sale itself, so
  the second copy is recognised and skipped.
*/
const db = require('../database/db');
const operations = require('./operations');
const { ValidationError, check, isId } = require('./validate');

// db.transaction(...) makes everything inside all-or-nothing:
// if any step throws, SQLite undoes the steps before it.
const applyOnce = db.transaction((operation) => {
  const alreadyDone = db.prepare('SELECT 1 FROM sync_log WHERE operation_id = ?').get(operation.id);
  if (alreadyDone) return 'duplicate';

  operations[operation.type](operation.payload);

  db.prepare('INSERT INTO sync_log (operation_id, type, processed_at) VALUES (?, ?, ?)')
    .run(operation.id, operation.type, new Date().toISOString());
  return 'ok';
});

// A record the database itself refused (for example a CHECK rule in schema.sql).
const isConstraintError = (err) => String(err.code).startsWith('SQLITE_CONSTRAINT');

// Returns { id, status: "ok" | "duplicate" } or { id, status: "error", error }.
function processOperation(operation) {
  try {
    check(operation && isId(operation.id), 'Operation id is not valid.');
    check(Object.hasOwn(operations, operation.type), `Unknown operation type "${operation.type}".`);
    check(operation.payload && typeof operation.payload === 'object', 'Operation payload is missing.');
    return { id: operation.id, status: applyOnce(operation) };
  } catch (err) {
    // Bad data: tell the browser which operation was rejected and why.
    if (err instanceof ValidationError || isConstraintError(err)) {
      return { id: operation ? operation.id : null, status: 'error', error: err.message };
    }
    // Anything else is a real server problem. Let it fail the whole request,
    // so the browser keeps its changes as "pending" and tries again later.
    throw err;
  }
}

// Operations are applied one by one in the order they were made in the shop.
function processOperations(list) {
  return list.map(processOperation);
}

module.exports = { processOperations };
