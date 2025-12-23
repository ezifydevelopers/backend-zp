#!/usr/bin/env node
/**
 * Comprehensive SQLite Setup Fix
 * This script ensures SQLite mode is properly configured and working
 * Run this if SQLite mode is not working
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
const sqlitePath = path.join(os.homedir(), '.zapeera', 'data', 'zapeera.db');
const sqliteDir = path.dirname(sqlitePath);

console.log('🔧 SQLite Setup Fix');
console.log('==================\n');

try {
  // Step 1: Ensure SQLite directory exists
  console.log('Step 1: Ensuring SQLite directory exists...');
  if (!fs.existsSync(sqliteDir)) {
    fs.mkdirSync(sqliteDir, { recursive: true });
    console.log('✅ Created SQLite directory:', sqliteDir);
  } else {
    console.log('✅ SQLite directory exists');
  }

  // Step 2: Read and check schema
  console.log('\nStep 2: Checking Prisma schema...');
  let schema = fs.readFileSync(schemaPath, 'utf8');

  const currentProvider = schema.match(/provider\s*=\s*"(\w+)"/);
  const provider = currentProvider ? currentProvider[1] : null;

  if (provider !== 'sqlite') {
    console.log(`⚠️  Schema is set to ${provider}, switching to SQLite...`);

    // Replace provider
    schema = schema.replace(
      /provider\s*=\s*"postgresql"/,
      'provider = "sqlite"'
    );

    // Fix BigInt to Int for SQLite compatibility
    schema = schema.replace(
      /maxStock\s+BigInt\?/g,
      'maxStock             Int?'
    );

    fs.writeFileSync(schemaPath, schema, 'utf8');
    console.log('✅ Schema switched to SQLite');
  } else {
    console.log('✅ Schema is already set to SQLite');
  }

  // Step 3: Set DATABASE_URL
  console.log('\nStep 3: Setting DATABASE_URL...');
  process.env.DATABASE_URL = `file:${sqlitePath}`;
  console.log('✅ DATABASE_URL set to:', process.env.DATABASE_URL);

  // Step 4: Regenerate Prisma client
  console.log('\nStep 4: Regenerating Prisma client...');
  try {
    execSync('npx prisma generate', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: `file:${sqlitePath}` }
    });
    console.log('✅ Prisma client regenerated');
  } catch (err) {
    console.error('❌ Error regenerating Prisma client:', err.message);
    throw err;
  }

  // Step 5: Push schema to database
  console.log('\nStep 5: Initializing database schema...');

  // Check if database exists and handle constraint errors
  const dbExists = fs.existsSync(sqlitePath);
  let needsFreshStart = false;

  if (dbExists) {
    console.log('⚠️  Database file already exists');
    console.log('   Attempting to update schema...');
  }

  try {
    execSync('npx prisma db push --accept-data-loss', {
      stdio: 'pipe',
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: `file:${sqlitePath}` }
    });
    console.log('✅ Database schema initialized');
  } catch (err) {
    const errorMsg = err.message || err.toString();

    // Check if it's the constraint/index error
    if (errorMsg.includes('index associated with UNIQUE or PRIMARY KEY constraint cannot be dropped') ||
        errorMsg.includes('UNIQUE constraint failed') ||
        errorMsg.includes('cannot drop')) {
      console.log('⚠️  Schema conflict detected - recreating database...');
      needsFreshStart = true;
    } else {
      console.error('❌ Error initializing database:', errorMsg);
      throw err;
    }
  }

  // If we need to recreate, backup and delete old database
  if (needsFreshStart) {
    if (dbExists) {
      const backupPath = sqlitePath + '.backup.' + Date.now();
      console.log(`📦 Backing up existing database to: ${backupPath}`);
      try {
        fs.copyFileSync(sqlitePath, backupPath);
        console.log('✅ Backup created');
      } catch (backupErr) {
        console.log('⚠️  Could not create backup:', backupErr.message);
      }

      // Also backup the -wal and -shm files if they exist
      const walPath = sqlitePath + '-wal';
      const shmPath = sqlitePath + '-shm';
      if (fs.existsSync(walPath)) {
        try {
          fs.copyFileSync(walPath, backupPath + '-wal');
        } catch (e) {}
      }
      if (fs.existsSync(shmPath)) {
        try {
          fs.copyFileSync(shmPath, backupPath + '-shm');
        } catch (e) {}
      }

      // Delete old database files
      console.log('🗑️  Removing old database files...');
      try {
        fs.unlinkSync(sqlitePath);
        if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
        if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
        console.log('✅ Old database removed');
      } catch (deleteErr) {
        console.error('❌ Could not delete old database:', deleteErr.message);
        throw deleteErr;
      }
    }

    // Now try again with fresh database
    console.log('🔄 Creating fresh database...');
    try {
      execSync('npx prisma db push --accept-data-loss', {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: `file:${sqlitePath}` }
      });
      console.log('✅ Fresh database schema initialized');
    } catch (retryErr) {
      console.error('❌ Error creating fresh database:', retryErr.message);
      throw retryErr;
    }
  }

  // Step 6: Seed database with default data
  console.log('\nStep 6: Seeding database with default data...');
  try {
    execSync('npx ts-node scripts/seed-sqlite.ts', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: `file:${sqlitePath}` }
    });
    console.log('✅ Database seeded');
  } catch (err) {
    console.log('⚠️  Could not seed database (may already have data):', err.message);
    // Continue anyway - seeding is optional
  }

  // Step 7: Verify database
  console.log('\nStep 7: Verifying database...');
  if (fs.existsSync(sqlitePath)) {
    const stats = fs.statSync(sqlitePath);
    console.log('✅ Database file exists');
    console.log(`   Size: ${(stats.size / 1024).toFixed(2)} KB`);
    console.log(`   Path: ${sqlitePath}`);
  } else {
    console.log('⚠️  Database file not found (will be created on first use)');
  }

  console.log('\n✅ SQLite setup complete!');
  console.log('\nNext steps:');
  console.log('  1. Start the server: npm run dev:electron');
  console.log('  2. Or build and start: npm run build && npm start');
  console.log('\nDefault login credentials:');
  console.log('   Username: superadmin');
  console.log('   Password: admin123');
  console.log('\nNote: Make sure USE_POSTGRESQL is NOT set to "true" for SQLite mode');

} catch (error) {
  console.error('\n❌ Error fixing SQLite setup:', error.message);
  console.error('\nTroubleshooting:');
  console.error('  1. Make sure you have Node.js and npm installed');
  console.error('  2. Run: npm install');
  console.error('  3. Check that Prisma is installed: npx prisma --version');
  console.error('  4. Try manually: npx prisma generate && npx prisma db push');
  process.exit(1);
}
