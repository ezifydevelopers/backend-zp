/**
 * CRITICAL: This file MUST be CommonJS (not ES6) to ensure it runs synchronously
 * before any ES6 imports execute.
 *
 * DUAL MODE SUPPORT:
 * - USE_POSTGRESQL=true  -> Website mode (PostgreSQL direct)
 * - Default              -> Electron mode (SQLite offline + sync)
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

// Check if we should use PostgreSQL directly (for website)
const usePostgreSQL = process.env.USE_POSTGRESQL === 'true';

// PostgreSQL URL
const postgresUrl = process.env.REMOTE_DATABASE_URL ||
                   process.env.POSTGRESQL_URL ||
                   'postgresql://poszap_user:Ezify143@31.97.72.136:5432/poszap_db?schema=public';

// SQLite URL
const sqlitePath = path.join(os.homedir(), '.zapeera', 'data', 'zapeera.db');
const sqliteDir = path.dirname(sqlitePath);
const sqliteUrl = `file:${sqlitePath}`;

// Ensure SQLite directory exists
if (!fs.existsSync(sqliteDir)) {
  try {
    fs.mkdirSync(sqliteDir, { recursive: true });
  } catch (err) {
    // Ignore
  }
}

// Store PostgreSQL URL for sync
process.env.REMOTE_DATABASE_URL = postgresUrl;

if (usePostgreSQL) {
  // Website mode
  console.log('[DB URL Init] 🌐 WEBSITE MODE - PostgreSQL');
  process.env.DATABASE_URL = postgresUrl;
} else {
  // Electron mode - SQLite for offline
  console.log('[DB URL Init] 💻 ELECTRON MODE - SQLite');
  process.env.DATABASE_URL = sqliteUrl;
}

module.exports = {
  DATABASE_URL: process.env.DATABASE_URL,
  IS_POSTGRESQL_MODE: usePostgreSQL
};
