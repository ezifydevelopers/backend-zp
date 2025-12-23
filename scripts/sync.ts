/**
 * Manual Sync Script
 * Run: npm run sync
 */

import { getEnhancedSyncService } from '../src/services/enhanced-sync.service';
import { getConnectivityService } from '../src/services/connectivity.service';

async function main() {
  console.log('🔄 Starting manual sync...');

  const connectivityService = getConnectivityService();
  const syncService = getEnhancedSyncService();

  // Check connectivity
  const status = await connectivityService.checkConnectivity();
  console.log(`📡 Connectivity status: ${status}`);

  let result;
  if (status === 'online') {
    console.log('📤 Syncing SQLite → PostgreSQL...');
    result = await syncService.syncToPostgreSQL();
  } else {
    console.log('📥 Syncing PostgreSQL → SQLite...');
    result = await syncService.syncToSQLite();
  }

  console.log('\n📊 Sync Results:');
  console.log(`   Success: ${result.success}`);
  console.log(`   Synced: ${result.synced}`);
  console.log(`   Failed: ${result.failed}`);
  console.log(`   Conflicts: ${result.conflicts}`);

  if (result.errors.length > 0) {
    console.log('\n❌ Errors:');
    result.errors.forEach(error => console.log(`   - ${error}`));
  }

  process.exit(result.success ? 0 : 1);
}

main().catch(error => {
  console.error('❌ Sync failed:', error);
  process.exit(1);
});
