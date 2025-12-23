/**
 * Reset PostgreSQL database completely
 * WARNING: This will DELETE ALL DATA in PostgreSQL!
 * Run: npm run db:reset-postgresql
 */

import * as dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

async function resetPostgreSQL() {
  // Try to find PostgreSQL URL (same logic as database service)
  let postgresUrl = process.env.REMOTE_DATABASE_URL ||
                   process.env.POSTGRESQL_URL ||
                   process.env.POSTGRES_URL;

  // If not found, try common URLs
  if (!postgresUrl || !postgresUrl.startsWith('postgresql://')) {
    const os = require('os');
    const currentUser = os.userInfo().username;

    const commonUrls = [
      `postgresql://${currentUser}@localhost:5432/medibill_pulse`,
      `postgresql://${currentUser}@localhost:5432/postgres`,
      'postgresql://postgres:postgres@localhost:5432/medibill_pulse',
      'postgresql://postgres:postgres@localhost:5432/postgres',
    ];

    console.log('🔍 Trying to find PostgreSQL URL...');

    for (const url of commonUrls) {
      try {
        const testClient = new Client({ connectionString: url });
        await testClient.connect();
        await testClient.query('SELECT 1');
        await testClient.end();
        postgresUrl = url;
        console.log(`✅ Found PostgreSQL: ${url.replace(/:[^:@]+@/, ':****@')}`);
        break;
      } catch (error) {
        // Continue to next URL
      }
    }
  }

  if (!postgresUrl || !postgresUrl.startsWith('postgresql://')) {
    console.error('❌ PostgreSQL URL not configured');
    console.error('💡 Set REMOTE_DATABASE_URL in .env file');
    console.error('💡 Or ensure PostgreSQL is running on localhost:5432');
    process.exit(1);
  }

  const client = new Client({
    connectionString: postgresUrl
  });

  try {
    await client.connect();
    console.log('✅ Connected to PostgreSQL');
    console.log('⚠️  WARNING: This will DELETE ALL DATA in PostgreSQL!');
    console.log('⚠️  Press Ctrl+C within 5 seconds to cancel...');

    // Wait 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('\n🗑️  Dropping public schema...');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');

    console.log('✅ Creating new public schema...');
    await client.query('CREATE SCHEMA public');

    console.log('✅ Granting permissions...');
    await client.query('GRANT ALL ON SCHEMA public TO postgres');
    await client.query('GRANT ALL ON SCHEMA public TO public');

    await client.end();
    console.log('\n✅ PostgreSQL database reset complete!');
    console.log('💡 Now run: npm run dev (sync will rebuild all tables)');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    await client.end();
    process.exit(1);
  }
}

resetPostgreSQL();
