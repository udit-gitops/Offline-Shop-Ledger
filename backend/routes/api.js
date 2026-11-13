/*
  api.js — the HTTP endpoints of the server. All of them start with /api.

    GET  /api/health    is the server running?
    POST /api/sync      save the browser's pending changes
    GET  /api/snapshot  everything stored on the server
*/
const express = require('express');
const { processOperations } = require('../services/syncService');
const { readSnapshot } = require('../services/snapshot');

const router = express.Router();

// API answers must always be fresh, never a copy kept by the browser.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Request : { "operations": [ { id, type, payload }, ... ] }   (oldest first)
// Response: { "results":    [ { id, status, error? }, ... ] }  (same order)
router.post('/sync', (req, res) => {
  const operations = req.body ? req.body.operations : null;
  if (!Array.isArray(operations)) {
    return res.status(400).json({ error: 'Send a JSON body like { "operations": [ ... ] }.' });
  }
  res.json({ results: processOperations(operations) });
});

// Used by a browser that has no data yet (first visit, or cleared storage)
// to copy the shop's records from the server.
router.get('/snapshot', (req, res) => {
  res.json(readSnapshot());
});

module.exports = router;
