/*
  validate.js — small checks used before anything is written to SQLite.
  The server never trusts the browser: every operation is checked again here.
*/

// Thrown when the data sent by the browser is not acceptable.
// The sync code reports it back as a "rejected" operation instead of crashing.
class ValidationError extends Error {}

function check(condition, message) {
  if (!condition) throw new ValidationError(message);
}

// Money is kept to 2 decimal places (paise).
const round2 = (value) => Math.round(value * 100) / 100;

// Names and similar text: not empty, and not absurdly long.
const isText = (value) => typeof value === 'string' && value.trim() !== '' && value.length <= 200;

// Ids are UUIDs made by the browser. Allowing only letters, digits and "-"
// means an id can never carry HTML or SQL characters.
const isId = (value) => typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// A rupee amount: zero or more, with at most 2 decimal places.
const isMoney = (value) => isNumber(value) && value >= 0 && round2(value) === value;

const isDate = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));

module.exports = { ValidationError, check, round2, isText, isId, isMoney, isDate };
