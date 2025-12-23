/**
 * Event-Driven Sync Helper
 *
 * This utility provides easy-to-use functions for controllers to trigger
 * BIDIRECTIONAL sync immediately after any CRUD operation.
 *
 * Instead of waiting 60 seconds for periodic sync:
 * - Changes made in the software are pushed to PostgreSQL immediately
 * - Changes made in PostgreSQL are pulled to SQLite immediately
 *
 * Usage in controllers:
 *   import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
 *
 *   // After create/update/delete:
 *   await syncAfterOperation('product', 'create', createdProduct);
 *
 *   // Before fetching data (to get latest from live):
 *   await pullLatestFromLive('product');
 */

import { getSyncService } from '../services/sync.service';
import { getDatabaseService } from '../services/database.service';

export type SyncOperation = 'create' | 'update' | 'delete';

// Table name mappings (Prisma model -> PostgreSQL table)
const TABLE_MAPPINGS: Record<string, string> = {
  'company': 'companies',
  'category': 'categories',
  'supplier': 'suppliers',
  'manufacturer': 'manufacturers',
  'shelf': 'shelves',
  'settings': 'settings',
  'user': 'users',
  'branch': 'branches',
  'employee': 'employees',
  'product': 'products',
  'batch': 'batches',
  'stockMovement': 'stock_movements',
  'customer': 'customers',
  'sale': 'sales',
  'saleItem': 'sale_items',
  'receipt': 'receipts',
  'purchase': 'purchases',
  'purchaseItem': 'purchase_items',
  'refund': 'refunds',
  'refundItem': 'refund_items',
  'attendance': 'attendance',
  'shift': 'shifts',
  'scheduledShift': 'scheduled_shifts',
  'scheduledShiftUser': 'scheduled_shift_users',
  'commission': 'commissions',
  'cardDetails': 'card_details',
  'subscription': 'subscriptions'
};

/**
 * Sync immediately after a CRUD operation
 * This pushes the change to PostgreSQL AND pulls any changes from PostgreSQL
 *
 * @param tableName - Prisma model name (e.g., 'product', 'customer')
 * @param operation - The operation performed ('create', 'update', 'delete')
 * @param record - The record that was created/updated/deleted
 * @returns Promise<boolean> - true if sync succeeded, false otherwise
 */
export async function syncAfterOperation(
  tableName: string,
  operation: SyncOperation,
  record: any
): Promise<boolean> {
  // If already using PostgreSQL directly (USE_POSTGRESQL=true), no sync needed
  const isPostgreSQLMode = process.env.USE_POSTGRESQL === 'true';
  if (isPostgreSQLMode) {
    console.log(`[Sync-Helper] ⏭️  PostgreSQL mode - No sync needed for ${tableName} (data already in PostgreSQL)`);
    return true; // Return true since data is already in PostgreSQL
  }

  const dbService = getDatabaseService();
  const syncService = getSyncService();

  // Check if online - if offline, queue for later
  if (dbService.getConnectionStatus() !== 'online') {
    // Queue the operation for later sync when connection is restored
    syncService.addToQueue(tableName, operation, record);
    console.log(`[Sync-Helper] ⏳ Offline - Queued ${operation} for ${tableName}`);
    return false;
  }

  try {
    // Step 1: Push LOCAL → LIVE (immediate)
    const pushSuccess = await syncService.syncRecordToPostgreSQL(tableName, operation, record);

    if (pushSuccess) {
      console.log(`[Sync-Helper] ✅ Pushed ${operation} to live: ${tableName}`);
    }

    // Step 2: Pull LIVE → LOCAL for this table (get any external changes)
    // This runs in background to not block the response
    pullLatestFromLive(tableName).catch(err => {
      console.error(`[Sync-Helper] ⚠️ Pull from live failed: ${err.message}`);
    });

    return pushSuccess;
  } catch (error: any) {
    console.error(`[Sync-Helper] ❌ Sync failed: ${error.message}`);
    // Queue for retry
    syncService.addToQueue(tableName, operation, record);
    return false;
  }
}

/**
 * Pull latest records from PostgreSQL to SQLite for a specific table
 * Call this before fetching data to ensure you have the latest from the live database
 *
 * @param tableName - Prisma model name (e.g., 'product', 'customer')
 * @returns Promise<{ synced: number; failed: number }>
 */
export async function pullLatestFromLive(
  tableName: string
): Promise<{ synced: number; failed: number }> {
  // If already using PostgreSQL directly (USE_POSTGRESQL=true), no pull needed
  const isPostgreSQLMode = process.env.USE_POSTGRESQL === 'true';
  if (isPostgreSQLMode) {
    console.log(`[Sync-Helper] ⏭️  PostgreSQL mode - No pull needed for ${tableName} (data already in PostgreSQL)`);
    return { synced: 0, failed: 0 };
  }

  // CRITICAL FIX: Never pull users from PostgreSQL in SQLite mode
  // Users created locally should NEVER be overwritten by empty/old PostgreSQL data
  if (tableName === 'user') {
    console.log(`[Sync-Helper] ⚠️ Skipping user pull - users should only sync TO PostgreSQL, not FROM PostgreSQL in SQLite mode`);
    return { synced: 0, failed: 0 };
  }

  const dbService = getDatabaseService();
  const syncService = getSyncService();

  // Check if online
  if (dbService.getConnectionStatus() !== 'online') {
    console.log(`[Sync-Helper] ⚠️ Offline - Cannot pull from live`);
    return { synced: 0, failed: 0 };
  }

  try {
    // Use the sync service to pull this specific table from PostgreSQL
    const result = await syncService.pullTableFromPostgreSQL(tableName);

    if (result.synced > 0) {
      console.log(`[Sync-Helper] ⬇️ Pulled ${result.synced} records from live: ${tableName}`);
    }

    return result;
  } catch (error: any) {
    console.error(`[Sync-Helper] ❌ Pull from live failed: ${error.message}`);
    return { synced: 0, failed: 1 };
  }
}

/**
 * Trigger a full bidirectional sync for all tables
 * Use this sparingly (e.g., on app startup or user request)
 *
 * @returns Promise<{ localToLive: { synced: number }, liveToLocal: { synced: number } }>
 */
export async function triggerFullBidirectionalSync(): Promise<{
  localToLive: { synced: number; failed: number };
  liveToLocal: { synced: number; failed: number };
  errors: string[];
}> {
  const syncService = getSyncService();
  return syncService.bidirectionalSync();
}

/**
 * Sync multiple tables at once (useful for related data)
 * For example, after creating a sale, sync sale, saleItems, and receipt together
 *
 * @param operations - Array of { tableName, operation, record }
 */
export async function syncMultipleOperations(
  operations: Array<{ tableName: string; operation: SyncOperation; record: any }>
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;

  for (const op of operations) {
    const result = await syncAfterOperation(op.tableName, op.operation, op.record);
    if (result) {
      success++;
    } else {
      failed++;
    }
  }

  return { success, failed };
}

/**
 * Check if sync is needed (useful before major operations)
 * Returns true if there are pending items in the queue
 */
export function hasPendingSync(): boolean {
  const syncService = getSyncService();
  const status = syncService.getStatus();
  return status.pendingItems > 0;
}

/**
 * Get PostgreSQL table name from Prisma model name
 */
export function getPostgresTableName(prismaModelName: string): string {
  return TABLE_MAPPINGS[prismaModelName] || prismaModelName;
}

/**
 * Debounced sync - prevents too many syncs in rapid succession
 * Useful when multiple rapid changes happen (like bulk imports)
 */
let syncDebounceTimer: NodeJS.Timeout | null = null;
let pendingOperations: Array<{ tableName: string; operation: SyncOperation; record: any }> = [];

export function debouncedSync(
  tableName: string,
  operation: SyncOperation,
  record: any,
  delayMs: number = 1000
): void {
  pendingOperations.push({ tableName, operation, record });

  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
  }

  syncDebounceTimer = setTimeout(async () => {
    const ops = [...pendingOperations];
    pendingOperations = [];
    syncDebounceTimer = null;

    if (ops.length > 0) {
      console.log(`[Sync-Helper] 🔄 Debounced sync: ${ops.length} operations`);
      await syncMultipleOperations(ops);
    }
  }, delayMs);
}
