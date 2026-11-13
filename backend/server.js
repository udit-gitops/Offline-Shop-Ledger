/*
  server.js — starts the Shop Ledger server.

  One server does two jobs:
    1. sends the frontend files (HTML, CSS, JS) to the browser
    2. answers the /api requests and stores data in SQLite

  Start it with:   npm start        (inside the backend folder)
  Then open:       http://localhost:5500
*/
const path = require('path');
const express = require('express');
const apiRoutes = require('./routes/api');

const PORT = process.env.PORT || 5500;

// The app has no login, so the server accepts connections from this computer
// only. Other devices on the same Wi-Fi cannot reach it.
const HOST = '127.0.0.1';

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

const app = express();

// Turns a JSON request body into req.body.
app.use(express.json({ limit: '1mb' }));

app.use('/api', apiRoutes);
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown API route.' });
});

app.use(express.static(FRONTEND_DIR));

// Last stop for any error thrown above. Always answers in JSON.
// err.status is set by Express for bad requests (for example broken JSON = 400).
app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error. Please try again.' });
});

// Start listening only when this file is run directly (not when the tests load it).
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`Shop Ledger is running at http://localhost:${PORT}`);
    console.log('Press Ctrl + C to stop.');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. The server may already be running in another terminal.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

module.exports = app;
