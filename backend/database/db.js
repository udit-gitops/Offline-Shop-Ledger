/*
  db.js — opens the SQLite database file and creates the tables if they are missing.
  Every other backend file gets the database by requiring this file.
*/
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// The tests set LEDGER_DB=":memory:" to get an empty throw-away database.
const DB_FILE = process.env.LEDGER_DB || path.join(__dirname, '..', 'data', 'ledger.db');

if (DB_FILE !== ':memory:') {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
}

const db = new Database(DB_FILE);

// SQLite ignores foreign keys unless this is switched on for the connection.
db.pragma('foreign_keys = ON');

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

module.exports = db;
