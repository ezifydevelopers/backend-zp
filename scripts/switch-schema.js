#!/usr/bin/env node
/**
 * Switch Prisma schema provider between SQLite and PostgreSQL
 * Usage:
 *   node scripts/switch-schema.js sqlite   # For Electron
 *   node scripts/switch-schema.js postgres # For Website
 */

const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
const target = process.argv[2];

if (!target || !['sqlite', 'postgres', 'postgresql'].includes(target)) {
  console.log('Usage: node scripts/switch-schema.js [sqlite|postgres]');
  console.log('  sqlite   - For Electron/offline mode');
  console.log('  postgres - For Website/online mode');
  process.exit(1);
}

const isSQLite = target === 'sqlite';

// Read current schema
let schema = fs.readFileSync(schemaPath, 'utf8');

// Replace provider
if (isSQLite) {
  schema = schema.replace(
    /provider\s*=\s*"postgresql"/,
    'provider = "sqlite"'
  );
  console.log('✅ Switched to SQLite provider');
  console.log('💡 Run: npx prisma generate');
  console.log('💡 Use: npm run dev (for Electron mode)');
} else {
  schema = schema.replace(
    /provider\s*=\s*"sqlite"/,
    'provider = "postgresql"'
  );
  console.log('✅ Switched to PostgreSQL provider');
  console.log('💡 Run: npx prisma generate');
  console.log('💡 Use: npm run dev:web (for Website mode)');
}

// Write updated schema
fs.writeFileSync(schemaPath, schema, 'utf8');

console.log('');
console.log('Schema provider updated in:', schemaPath);
