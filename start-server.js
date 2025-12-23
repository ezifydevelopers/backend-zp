#!/usr/bin/env node
/**
 * Startup script that sets DATABASE_URL before starting the server
 *
 * DUAL MODE:
 * - Default: SQLite (for Electron/offline)
 * - USE_POSTGRESQL=true: PostgreSQL (for website)
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
require('dotenv').config();

// Check mode
const usePostgreSQL = process.env.USE_POSTGRESQL === 'true';

// PostgreSQL URL
const postgresUrl = process.env.REMOTE_DATABASE_URL ||
                   'postgresql://poszap_user:Ezify143@31.97.72.136:5432/poszap_db?schema=public';

// SQLite URL
const sqlitePath = path.join(os.homedir(), '.zapeera', 'data', 'zapeera.db');
const sqliteDir = path.dirname(sqlitePath);
const sqliteUrl = `file:${sqlitePath}`;

// Ensure SQLite directory exists
if (!fs.existsSync(sqliteDir)) {
  try {
    fs.mkdirSync(sqliteDir, { recursive: true });
  } catch (err) {}
}

// Set DATABASE_URL based on mode
let databaseUrl;
if (usePostgreSQL) {
  console.log('[Startup] 🌐 WEBSITE MODE - Using PostgreSQL');
  databaseUrl = postgresUrl;
} else {
  console.log('[Startup] 💻 ELECTRON MODE - Using SQLite');
  databaseUrl = sqliteUrl;
}

process.env.DATABASE_URL = databaseUrl;
process.env.REMOTE_DATABASE_URL = postgresUrl;

console.log('[Startup] ✅ DATABASE_URL set');

// Get the script to run (dev or start)
const script = process.argv[2] || 'start';
const isDev = script === 'dev';

// Determine the command to run
let command;
let args;

if (isDev) {
  command = 'npx';
  args = ['ts-node-dev', '--respawn', '--transpile-only', 'src/server.ts'];
} else {
  command = 'node';
  args = ['dist/server.js'];
}

// Spawn the process
const child = spawn(command, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    REMOTE_DATABASE_URL: postgresUrl
  },
  shell: true
});

child.on('error', (error) => {
  console.error('[Startup] ❌ Failed to start server:', error);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
