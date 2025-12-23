#!/usr/bin/env node
/**
 * Ensure schema is set to SQLite before starting Electron mode
 * This prevents Prisma validation errors
 * Also ensures database is initialized
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');

// Ensure SQLite database directory exists
const sqlitePath = path.join(os.homedir(), '.zapeera', 'data', 'zapeera.db');
const sqliteDir = path.dirname(sqlitePath);

try {
  // Ensure SQLite directory exists
  if (!fs.existsSync(sqliteDir)) {
    fs.mkdirSync(sqliteDir, { recursive: true });
    console.log('[Schema Check] 📁 Created SQLite directory:', sqliteDir);
  }

  // Read current schema
  const schema = fs.readFileSync(schemaPath, 'utf8');

  // Check current provider
  const currentProvider = schema.match(/provider\s*=\s*"(\w+)"/);
  const provider = currentProvider ? currentProvider[1] : null;

  let needsRegenerate = false;

  if (provider === 'sqlite') {
    // Already correct, just regenerate if needed
    console.log('[Schema Check] ✅ Schema is already set to SQLite');
    needsRegenerate = true;
  } else {
    // Need to switch
    console.log(`[Schema Check] ⚠️  Schema is set to ${provider}, switching to SQLite...`);

    // Replace provider
    let updatedSchema = schema.replace(
      /provider\s*=\s*"postgresql"/,
      'provider = "sqlite"'
    );

    // Note: Prisma handles BigInt for SQLite automatically (stores as INTEGER)
    // No need to convert types - Prisma handles the mapping

    fs.writeFileSync(schemaPath, updatedSchema, 'utf8');
    console.log('[Schema Check] ✅ Switched to SQLite');
    needsRegenerate = true;
  }

  if (needsRegenerate) {
    // Regenerate Prisma client
    console.log('[Schema Check] 🔄 Regenerating Prisma client...');
    try {
      execSync('npx prisma generate', {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: `file:${sqlitePath}` }
      });
      console.log('[Schema Check] ✅ Prisma client regenerated');
    } catch (err) {
      console.error('[Schema Check] ⚠️  Error regenerating client:', err.message);
      // Continue anyway - might already be generated
    }

    // Push schema to database (creates tables if they don't exist)
    console.log('[Schema Check] 🔄 Initializing SQLite database...');
    const dbExists = fs.existsSync(sqlitePath);

    try {
      execSync('npx prisma db push --accept-data-loss', {
        stdio: 'pipe',
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: `file:${sqlitePath}` }
      });
      console.log('[Schema Check] ✅ SQLite database initialized');
    } catch (err) {
      const errorMsg = err.message || err.toString();

      // Handle constraint/index errors by recreating database
      if (errorMsg.includes('index associated with UNIQUE or PRIMARY KEY constraint cannot be dropped') ||
          errorMsg.includes('UNIQUE constraint failed') ||
          errorMsg.includes('cannot drop')) {
        console.log('[Schema Check] ⚠️  Schema conflict - recreating database...');

        if (dbExists) {
          // Backup and delete old database
          const backupPath = sqlitePath + '.backup.' + Date.now();
          try {
            fs.copyFileSync(sqlitePath, backupPath);
            fs.unlinkSync(sqlitePath);
            // Also remove WAL and SHM files
            const walPath = sqlitePath + '-wal';
            const shmPath = sqlitePath + '-shm';
            if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
            if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
            console.log('[Schema Check] 📦 Old database backed up and removed');
          } catch (backupErr) {
            console.error('[Schema Check] ⚠️  Could not backup database:', backupErr.message);
          }
        }

        // Try again with fresh database
        try {
          execSync('npx prisma db push --accept-data-loss', {
            stdio: 'inherit',
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, DATABASE_URL: `file:${sqlitePath}` }
          });
          console.log('[Schema Check] ✅ Fresh SQLite database initialized');
        } catch (retryErr) {
          console.error('[Schema Check] ⚠️  Error initializing fresh database:', retryErr.message);
          // Continue anyway - might work on first use
        }
      } else {
        console.error('[Schema Check] ⚠️  Error initializing database:', errorMsg);
        // Continue anyway - database might already exist with correct schema
      }
    }
  }
} catch (error) {
  console.error('[Schema Check] ❌ Error:', error.message);
  process.exit(1);
}
