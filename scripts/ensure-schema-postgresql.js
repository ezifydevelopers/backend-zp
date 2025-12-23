#!/usr/bin/env node
/**
 * Ensure schema is set to PostgreSQL before starting Web mode
 * This prevents Prisma validation errors
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');

try {
  // Read current schema
  const schema = fs.readFileSync(schemaPath, 'utf8');

  // Check current provider
  const currentProvider = schema.match(/provider\s*=\s*"(\w+)"/);
  const provider = currentProvider ? currentProvider[1] : null;

  if (provider === 'postgresql') {
    // Already correct, just regenerate if needed
    console.log('[Schema Check] ✅ Schema is already set to PostgreSQL');
    try {
      execSync('npx prisma generate', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    } catch (err) {
      // Ignore if already generated
    }
  } else {
    // Need to switch
    console.log(`[Schema Check] ⚠️  Schema is set to ${provider}, switching to PostgreSQL...`);
    const updatedSchema = schema.replace(
      /provider\s*=\s*"sqlite"/,
      'provider = "postgresql"'
    );
    fs.writeFileSync(schemaPath, updatedSchema, 'utf8');
    console.log('[Schema Check] ✅ Switched to PostgreSQL');

    // Regenerate Prisma client
    console.log('[Schema Check] 🔄 Regenerating Prisma client...');
    execSync('npx prisma generate', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    console.log('[Schema Check] ✅ Prisma client regenerated');
  }
} catch (error) {
  console.error('[Schema Check] ❌ Error:', error.message);
  process.exit(1);
}
