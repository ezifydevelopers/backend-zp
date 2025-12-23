/**
 * Sync Service - Handles bidirectional synchronization between SQLite and PostgreSQL
 * Syncs data when going online/offline and maintains data consistency
 */

import { PrismaClient } from '@prisma/client';
import { getDatabaseService, DatabaseType, ConnectionStatus } from './database.service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface SyncQueueItem {
  id: string;
  table: string;
  operation: 'create' | 'update' | 'delete';
  data: any;
  timestamp: Date;
  synced: boolean;
  error?: string;
}

interface SyncStatus {
  inProgress: boolean;
  lastSync: Date | null;
  pendingItems: number;
  syncedItems: number;
  failedItems: number;
  currentOperation: string | null;
}

class SyncService {
  private syncQueue: SyncQueueItem[] = [];
  private syncStatus: SyncStatus = {
    inProgress: false,
    lastSync: null,
    pendingItems: 0,
    syncedItems: 0,
    failedItems: 0,
    currentOperation: null
  };
  private queueFilePath: string;
  private postgresTablesExist: boolean = false; // Track if tables exist
  private tablesCheckDone: boolean = false; // Only log missing tables once
  private lastTableCheckTime: Date | null = null; // Rate limit table checks

  constructor() {
    const queueDir = path.join(os.homedir(), '.zapeera', 'sync');
    if (!fs.existsSync(queueDir)) {
      fs.mkdirSync(queueDir, { recursive: true });
    }
    this.queueFilePath = path.join(queueDir, 'sync-queue.json');
    this.loadQueue();
  }

  /**
   * Check if SQLite database exists and is valid
   * Returns true if database needs to be rebuilt
   */
  async checkDatabaseHealth(): Promise<{
    exists: boolean;
    valid: boolean;
    needsRebuild: boolean;
    tableCount: number;
    userCount: number;
  }> {
    const sqlitePath = path.join(os.homedir(), '.zapeera', 'data', 'zapeera.db');

    const result = {
      exists: false,
      valid: false,
      needsRebuild: false,
      tableCount: 0,
      userCount: 0
    };

    // Check if file exists
    if (!fs.existsSync(sqlitePath)) {
      console.log('[Sync] ⚠️ SQLite database file not found - needs full rebuild');
      result.needsRebuild = true;
      return result;
    }

    result.exists = true;

    // Check if database is valid and has data
    try {
      const dbService = getDatabaseService();
      const sqliteClient = dbService.getSQLiteClient();

      if (!sqliteClient) {
        console.log('[Sync] ⚠️ SQLite client not available - needs rebuild');
        result.needsRebuild = true;
        return result;
      }

      // Check table count
      const tables = await sqliteClient.$queryRawUnsafe<any[]>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'`
      );
      result.tableCount = tables.length;

      // Check user count (minimum data validation)
      const userCount = await sqliteClient.user.count();
      result.userCount = userCount;

      // Database is valid if it has tables and at least some users
      if (result.tableCount > 0 && result.userCount > 0) {
        result.valid = true;
        console.log(`[Sync] ✅ SQLite database valid: ${result.tableCount} tables, ${result.userCount} users`);
      } else {
        console.log(`[Sync] ⚠️ SQLite database empty or incomplete: ${result.tableCount} tables, ${result.userCount} users`);
        result.needsRebuild = true;
      }

    } catch (error: any) {
      console.error('[Sync] ❌ SQLite database check failed:', error.message);
      result.needsRebuild = true;
    }

    return result;
  }

  /**
   * Full database rebuild from PostgreSQL
   * Called when SQLite database is missing or corrupted (e.g., after reinstall)
   */
  async rebuildDatabaseFromServer(): Promise<{
    success: boolean;
    tablesRebuilt: number;
    recordsSynced: number;
    errors: string[];
  }> {
    const result = {
      success: false,
      tablesRebuilt: 0,
      recordsSynced: 0,
      errors: [] as string[]
    };

    console.log('[Sync] 🔄 Starting FULL DATABASE REBUILD from PostgreSQL...');
    console.log('[Sync] ⚠️ This may take a few minutes for large databases...');

    // Check if PostgreSQL is available
    const isPostgreSQLMode = process.env.USE_POSTGRESQL === 'true';
    if (isPostgreSQLMode) {
      console.log('[Sync] ℹ️ Using PostgreSQL directly - no rebuild needed');
      result.success = true;
      return result;
    }

    try {
      const dbService = getDatabaseService();

      // Check PostgreSQL connectivity
      const pgClient = await dbService.getRawPostgreSQLClient();
      if (!pgClient) {
        result.errors.push('PostgreSQL not available - cannot rebuild database');
        console.error('[Sync] ❌ PostgreSQL not available for rebuild');
        return result;
      }

      // Ensure SQLite directory exists
      const sqliteDir = path.join(os.homedir(), '.zapeera', 'data');
      if (!fs.existsSync(sqliteDir)) {
        fs.mkdirSync(sqliteDir, { recursive: true });
        console.log('[Sync] 📁 Created SQLite directory:', sqliteDir);
      }

      // Run Prisma db push to create schema FIRST (before any sync)
      console.log('[Sync] 📋 Creating database schema with Prisma...');
      try {
        const { execSync } = require('child_process');
        const sqlitePath = path.join(sqliteDir, 'zapeera.db');

        // Set DATABASE_URL for prisma command
        const env = {
          ...process.env,
          DATABASE_URL: `file:${sqlitePath}`
        };

        // Run prisma db push to create all tables
        execSync('npx prisma db push --skip-generate --accept-data-loss', {
          cwd: path.join(__dirname, '..', '..'),
          env,
          stdio: 'pipe',
          timeout: 60000 // 60 second timeout
        });

        console.log('[Sync] ✅ Database schema created successfully');
      } catch (schemaError: any) {
        console.error('[Sync] ❌ Failed to create schema:', schemaError.message);
        // Continue anyway - tables might already exist
      }

      // Reinitialize database service to pick up new schema
      console.log('[Sync] 🔄 Reinitializing database connection...');
      await dbService.initialize();

      // Initialize SQLite client (will create database if missing)
      const sqliteClient = dbService.getSQLiteClient();
      if (!sqliteClient) {
        result.errors.push('Failed to initialize SQLite client');
        console.error('[Sync] ❌ Failed to initialize SQLite client');
        await pgClient.end();
        return result;
      }

      console.log('[Sync] ✅ Database schema ready');

      // First sync users (critical for authentication)
      console.log('[Sync] 👤 Step 1/2: Syncing users from PostgreSQL...');
      const userResult = await this.syncUsersFromPostgreSQL();
      result.recordsSynced += userResult.synced;
      result.errors.push(...userResult.errors);
      console.log(`[Sync] ✅ Users synced: ${userResult.synced}`);

      // Then sync all other tables
      console.log('[Sync] 📊 Step 2/2: Syncing all tables from PostgreSQL...');
      const tableResult = await this.syncAllTablesFromPostgreSQL();
      result.recordsSynced += tableResult.synced;
      result.tablesRebuilt = 27; // All tables
      result.errors.push(...tableResult.errors);
      console.log(`[Sync] ✅ Tables synced: ${tableResult.synced} records`);

      result.success = true;
      console.log('[Sync] 🎉 DATABASE REBUILD COMPLETE!');
      console.log(`[Sync] 📊 Total records synced: ${result.recordsSynced}`);
      console.log(`[Sync] ⚠️ Errors: ${result.errors.length}`);

    } catch (error: any) {
      console.error('[Sync] ❌ Database rebuild failed:', error.message);
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Initialize database on startup
   * Checks health and rebuilds if needed
   */
  async initializeDatabase(): Promise<boolean> {
    console.log('[Sync] 🔍 Checking database health on startup...');

    // Check database health
    const health = await this.checkDatabaseHealth();

    if (health.needsRebuild) {
      console.log('[Sync] ⚠️ Database needs rebuild - starting full sync from server...');

      const rebuildResult = await this.rebuildDatabaseFromServer();

      if (!rebuildResult.success) {
        console.error('[Sync] ❌ Database rebuild failed - app may not work correctly offline');
        console.error('[Sync] ⚠️ Please ensure internet connection and restart the app');
        return false;
      }

      console.log('[Sync] ✅ Database rebuilt successfully!');
      return true;
    }

    console.log('[Sync] ✅ Database health check passed');
    return true;
  }

  /**
   * Load sync queue from disk
   */
  private loadQueue(): void {
    try {
      if (fs.existsSync(this.queueFilePath)) {
        const data = fs.readFileSync(this.queueFilePath, 'utf8');
        this.syncQueue = JSON.parse(data).map((item: any) => ({
          ...item,
          timestamp: new Date(item.timestamp)
        }));
        this.updateStatus();
      }
    } catch (error) {
      console.error('[Sync] Failed to load queue:', error);
      this.syncQueue = [];
    }
  }

  /**
   * Save sync queue to disk
   */
  private saveQueue(): void {
    try {
      fs.writeFileSync(
        this.queueFilePath,
        JSON.stringify(this.syncQueue, null, 2),
        'utf8'
      );
    } catch (error) {
      console.error('[Sync] Failed to save queue:', error);
    }
  }

  /**
   * Add item to sync queue
   */
  addToQueue(table: string, operation: 'create' | 'update' | 'delete', data: any): void {
    const item: SyncQueueItem = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      table,
      operation,
      data,
      timestamp: new Date(),
      synced: false
    };

    this.syncQueue.push(item);
    this.saveQueue();
    this.updateStatus();

    console.log(`[Sync] Added to queue: ${operation} on ${table}`);
  }

  /**
   * Sync SQLite changes to PostgreSQL (when going online)
   * This is the main sync operation: SQLite (offline) → PostgreSQL (online)
   */
  async syncToPostgreSQL(): Promise<void> {
    if (this.syncStatus.inProgress) {
      console.log('[Sync] Sync already in progress');
      return;
    }

    const dbService = getDatabaseService();

    // Check if PostgreSQL URL is available
    const postgresUrl = dbService.getPostgreSQLUrl();
    if (!postgresUrl) {
      console.log('[Sync] PostgreSQL not available, cannot sync');
      return;
    }

    this.syncStatus.inProgress = true;
    this.syncStatus.currentOperation = 'Syncing to PostgreSQL';

    try {
      const sqliteClient = dbService.getSQLiteClient();

      if (!sqliteClient) {
        console.log('[Sync] SQLite client not available');
        return;
      }

      // Use direct pg client for PostgreSQL operations
      const { Client } = require('pg');
      const postgresClient = new Client({
        connectionString: postgresUrl
      });

      await postgresClient.connect();

      try {
        const pendingItems = this.syncQueue.filter(item => !item.synced);
        console.log(`[Sync] Syncing ${pendingItems.length} items to PostgreSQL`);

        for (const item of pendingItems) {
          try {
            await this.syncItemToPostgreSQL(item, sqliteClient, postgresClient);
            item.synced = true;
            item.error = undefined;
            this.syncStatus.syncedItems++;
          } catch (error: any) {
            item.error = error.message;
            this.syncStatus.failedItems++;
            console.error(`[Sync] Failed to sync item ${item.id}:`, error.message);
          }
          this.saveQueue();
        }

        // Sync all data tables for consistency
        // This ensures PostgreSQL has all data from SQLite
        console.log('[Sync] 🔄 Syncing all tables from SQLite to PostgreSQL...');
        await this.syncAllTables(sqliteClient, postgresClient);

        this.syncStatus.lastSync = new Date();
        this.syncStatus.currentOperation = null;
        console.log('[Sync] ✅ Sync to PostgreSQL completed - Both databases are now in sync');
      } finally {
        await postgresClient.end();
      }
    } catch (error: any) {
      console.error('[Sync] ❌ Sync to PostgreSQL failed:', error.message);
      this.syncStatus.currentOperation = `Error: ${error.message}`;
    } finally {
      this.syncStatus.inProgress = false;
      this.updateStatus();
    }
  }

  /**
   * Download users from PostgreSQL to SQLite
   * This ensures SQLite has the latest user data (including isActive status)
   */
  async syncUsersFromPostgreSQL(): Promise<{ synced: number; errors: string[] }> {
    const result = { synced: 0, errors: [] as string[] };

    // Check if using PostgreSQL directly (website mode)
    const isPostgreSQLMode = process.env.USE_POSTGRESQL === 'true';
    if (isPostgreSQLMode) {
      console.log('[Sync] ℹ️  Using PostgreSQL directly - no sync needed');
      return result;
    }

    try {
      const dbService = getDatabaseService();
      const pgClient = await dbService.getRawPostgreSQLClient();

      if (!pgClient) {
        console.log('[Sync] ⚠️ PostgreSQL not available for user sync');
        return result;
      }

      console.log('[Sync] ⬇️ Downloading users from PostgreSQL to SQLite...');

      // Get all users from PostgreSQL
      // First, check which columns exist to handle schema differences
      const columnCheck = await pgClient.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users'
      `);
      const existingColumns = columnCheck.rows.map((r: any) => r.column_name);

      // Build query with only existing columns
      const baseColumns = ['id', 'email', 'password', 'name', 'role', 'isActive', 'createdAt', 'updatedAt'];
      const optionalColumns = ['username', 'branchId', 'companyId', 'createdBy', 'sessionToken', 'lastLoginAt', 'profileImage'];

      const selectColumns = [...baseColumns];
      for (const col of optionalColumns) {
        if (existingColumns.includes(col)) {
          selectColumns.push(col);
        }
      }

      const selectClause = selectColumns.map(c => `"${c}"`).join(', ');
      const pgUsers = await pgClient.query(`SELECT ${selectClause} FROM users`);

      if (pgUsers.rows.length === 0) {
        console.log('[Sync] No users found in PostgreSQL');
        await pgClient.end();
        return result;
      }

      console.log(`[Sync] Found ${pgUsers.rows.length} users in PostgreSQL`);

      // Get SQLite client
      const sqliteClient = dbService.getSQLiteClient();

      if (!sqliteClient) {
        console.log('[Sync] SQLite client not available');
        await pgClient.end();
        return result;
      }

      // Upsert each user into SQLite
      for (const pgUser of pgUsers.rows) {
        try {
          // Convert PostgreSQL boolean to SQLite integer
          const isActive = pgUser.isActive === true || pgUser.isActive === 't' || pgUser.isActive === 1;

          // Check if user exists by ID first
          let existingUser = await sqliteClient.user.findUnique({
            where: { id: pgUser.id }
          });

          // Also check by email (in case ID is different but same email)
          if (!existingUser && pgUser.email) {
            existingUser = await sqliteClient.user.findUnique({
              where: { email: pgUser.email }
            });
          }

          // Build update data with only available fields
          // Set branchId and companyId to null if they would cause FK violations
          const updateData: any = {
            email: pgUser.email,
            password: pgUser.password,
            name: pgUser.name,
            role: pgUser.role,
            isActive: isActive,
            updatedAt: new Date()
          };

          // Add optional fields if they exist
          if (pgUser.username) updateData.username = pgUser.username;
          else updateData.username = pgUser.email; // Fallback to email

          // For branchId and companyId, check if they exist in SQLite first
          // If not, set to null to avoid FK violations
          if (pgUser.branchId) {
            try {
              const branchExists = await sqliteClient.branch.findUnique({ where: { id: pgUser.branchId } });
              updateData.branchId = branchExists ? pgUser.branchId : null;
            } catch {
              updateData.branchId = null;
            }
          } else {
            updateData.branchId = null;
          }

          if (pgUser.companyId) {
            try {
              const companyExists = await sqliteClient.company.findUnique({ where: { id: pgUser.companyId } });
              updateData.companyId = companyExists ? pgUser.companyId : null;
            } catch {
              updateData.companyId = null;
            }
          } else {
            updateData.companyId = null;
          }

          if (pgUser.sessionToken !== undefined) updateData.sessionToken = pgUser.sessionToken;
          if (pgUser.lastLoginAt !== undefined) updateData.lastLoginAt = pgUser.lastLoginAt;
          if (pgUser.profileImage !== undefined) updateData.profileImage = pgUser.profileImage;

          if (existingUser) {
            // Update existing user by their actual ID
            await sqliteClient.user.update({
              where: { id: existingUser.id },
              data: updateData
            });
            console.log(`[Sync] ✅ Updated user: ${pgUser.email} (isActive: ${isActive})`);
          } else {
            // Create new user - need to ensure username is unique
            let username = pgUser.username || pgUser.email;

            // Check if username already exists
            const usernameExists = await sqliteClient.user.findFirst({
              where: { username: username }
            });

            if (usernameExists) {
              // Append random suffix to make username unique
              username = `${username}_${Date.now().toString(36)}`;
            }

            const createData = {
              ...updateData,
              id: pgUser.id,
              username: username,
              createdBy: pgUser.createdBy || pgUser.id,
              createdAt: pgUser.createdAt || new Date()
            };

            await sqliteClient.user.create({
              data: createData
            });
            console.log(`[Sync] ✅ Created user: ${pgUser.email} (isActive: ${isActive})`);
          }
          result.synced++;
        } catch (userError: any) {
          // Silent fail for non-critical errors, just log
          if (!userError.message?.includes('Unique constraint')) {
            console.error(`[Sync] ❌ Failed to sync user ${pgUser.email}:`, userError.message);
          }
          result.errors.push(`${pgUser.email}: ${userError.message}`);
        }
      }

      await pgClient.end();
      console.log(`[Sync] ✅ User sync complete: ${result.synced} synced, ${result.errors.length} errors`);
      return result;
    } catch (error: any) {
      console.error('[Sync] ❌ User sync from PostgreSQL failed:', error.message);
      result.errors.push(error.message);
      return result;
    }
  }

  /**
   * Comprehensive sync of ALL 27 tables from PostgreSQL to SQLite
   * This ensures SQLite has complete data from PostgreSQL
   */
  async syncAllTablesFromPostgreSQL(): Promise<{ synced: number; failed: number; errors: string[] }> {
    const result = { synced: 0, failed: 0, errors: [] as string[] };

    // Check if using PostgreSQL directly (website mode)
    const isPostgreSQLMode = process.env.USE_POSTGRESQL === 'true';
    if (isPostgreSQLMode) {
      console.log('[Sync] ℹ️  Using PostgreSQL directly - no full sync needed');
      return result;
    }

    if (this.syncStatus.inProgress) {
      console.log('[Sync] ⚠️  Sync already in progress');
      return result;
    }

    this.syncStatus.inProgress = true;
    this.syncStatus.currentOperation = 'Full sync from PostgreSQL';

    try {
      const dbService = getDatabaseService();
      const pgClient = await dbService.getRawPostgreSQLClient();
      const sqliteClient = dbService.getSQLiteClient();

      if (!pgClient) {
        console.log('[Sync] ⚠️  PostgreSQL not available for full sync');
        return result;
      }

      if (!sqliteClient) {
        console.log('[Sync] ⚠️  SQLite client not available');
        return result;
      }

      console.log('[Sync] 🔄 Starting FULL sync of ALL 27 tables from PostgreSQL to SQLite...');

      // Tables in order of dependencies (parents before children)
      // CRITICAL FIX: Exclude 'users' table - users should only sync TO PostgreSQL, not FROM
      // This prevents local SQLite users from being overwritten by PostgreSQL data
      const tablesToSync = [
        // Core tables (no dependencies)
        { pg: 'companies', sqlite: 'company' },
        { pg: 'categories', sqlite: 'category' },
        { pg: 'suppliers', sqlite: 'supplier' },
        { pg: 'manufacturers', sqlite: 'manufacturer' },
        { pg: 'shelves', sqlite: 'shelf' },
        { pg: 'settings', sqlite: 'settings' },
        // Users EXCLUDED - users only sync TO PostgreSQL, not FROM
        // { pg: 'users', sqlite: 'user' }, // DISABLED to prevent overwriting local users
        { pg: 'branches', sqlite: 'branch' },
        { pg: 'employees', sqlite: 'employee' },
        // Products (depend on category, supplier, manufacturer, shelf)
        { pg: 'products', sqlite: 'product' },
        // Batches (depend on product, supplier, manufacturer)
        { pg: 'batches', sqlite: 'batch' },
        { pg: 'stock_movements', sqlite: 'stockMovement' },
        // Customers
        { pg: 'customers', sqlite: 'customer' },
        // Sales
        { pg: 'sales', sqlite: 'sale' },
        { pg: 'sale_items', sqlite: 'saleItem' },
        { pg: 'receipts', sqlite: 'receipt' },
        // Purchases
        { pg: 'purchases', sqlite: 'purchase' },
        { pg: 'purchase_items', sqlite: 'purchaseItem' },
        // Refunds
        { pg: 'refunds', sqlite: 'refund' },
        { pg: 'refund_items', sqlite: 'refundItem' },
        // Employee management
        { pg: 'attendance', sqlite: 'attendance' },
        { pg: 'shifts', sqlite: 'shift' },
        { pg: 'scheduled_shifts', sqlite: 'scheduledShift' },
        { pg: 'scheduled_shift_users', sqlite: 'scheduledShiftUser' },
        { pg: 'commissions', sqlite: 'commission' },
        // Other
        { pg: 'card_details', sqlite: 'card_details' },
        { pg: 'subscriptions', sqlite: 'subscriptions' }
      ];

      // Extra columns to exclude (these were added to PostgreSQL but don't exist in SQLite)
      const excludeColumns = ['updated_at', 'created_at', 'is_synced', 'synced_at', 'last_modified'];

      for (const table of tablesToSync) {
        try {
          this.syncStatus.currentOperation = `Syncing ${table.pg}...`;

          // First get SQLite table columns to know what columns exist
          let sqliteColumns: string[] = [];
          try {
            const tableInfo = await sqliteClient.$queryRawUnsafe<any[]>(`PRAGMA table_info("${table.pg}")`);
            sqliteColumns = tableInfo.map((col: any) => col.name);
          } catch (e) {
            console.log(`[Sync] ⚠️  Cannot get schema for ${table.pg}, skipping`);
            continue;
          }

          if (sqliteColumns.length === 0) {
            console.log(`[Sync] ⚠️  Table ${table.pg} not found in SQLite, skipping`);
            continue;
          }

          // Get records from PostgreSQL
          const pgResult = await pgClient.query(`SELECT * FROM ${table.pg}`);
          const records = pgResult.rows;

          if (records.length === 0) {
            console.log(`[Sync] 📋 ${table.pg}: 0 records (empty)`);
            continue;
          }

          // Upsert each record to SQLite using Prisma for better compatibility
          let tableSuccess = 0;
          let tableFailed = 0;
          let firstError = '';

          // Get Prisma model for this table
          const prismaModel = (sqliteClient as any)[table.sqlite];

          for (const record of records) {
            try {
              // Clean record for Prisma - convert to camelCase and handle types
              const cleanData: any = {};

              for (const [key, value] of Object.entries(record)) {
                // Skip excluded columns
                if (excludeColumns.includes(key)) continue;

                // Convert snake_case to camelCase
                const camelKey = this.snakeToCamel(key);

                // Handle value conversion
                if (value === null || value === undefined) {
                  cleanData[camelKey] = null;
                } else if (value === 't' || value === true) {
                  cleanData[camelKey] = true;
                } else if (value === 'f' || value === false) {
                  cleanData[camelKey] = false;
                } else if (value instanceof Date) {
                  cleanData[camelKey] = value;
                } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
                  // ISO date string
                  cleanData[camelKey] = new Date(value);
                } else {
                  cleanData[camelKey] = value;
                }
              }

              // Make sure id is set
              const recordId = cleanData.id;
              if (!recordId) {
                tableFailed++;
                continue;
              }

              // Remove id from update data
              const { id, ...updateData } = cleanData;

              // Use explicit check + update/create for proper handling
              if (prismaModel) {
                // Check if record exists first
                const existingRecord = await prismaModel.findUnique({
                  where: { id: recordId }
                });

                if (existingRecord) {
                  // UPDATE existing record with ALL fields from PostgreSQL
                  await prismaModel.update({
                    where: { id: recordId },
                    data: updateData
                  });
                } else {
                  // CREATE new record
                  await prismaModel.create({
                    data: cleanData
                  });
                }
                tableSuccess++;
              } else {
                // Fallback to raw SQL if model not found
                const columns = Object.keys(cleanData);
                const values = Object.values(cleanData).map(v => {
                  if (v === null || v === undefined) return null;
                  if (typeof v === 'boolean') return v ? 1 : 0;
                  if (v instanceof Date) return v.toISOString();
                  return v;
                });
                const placeholders = columns.map(() => '?').join(', ');
                const columnList = columns.map(c => `"${c}"`).join(', ');
                const sql = `INSERT OR REPLACE INTO "${table.pg}" (${columnList}) VALUES (${placeholders})`;
                await sqliteClient.$executeRawUnsafe(sql, ...values);
                tableSuccess++;
              }

            } catch (recordError: any) {
              // Capture first error for debugging
              if (!firstError) firstError = recordError.message;
              tableFailed++;
            }
          }

          // Log first error if any failed
          if (firstError && tableFailed > 0) {
            console.log(`[Sync] ⚠️  ${table.pg} error: ${firstError.substring(0, 80)}...`);
          }

          console.log(`[Sync] ✅ ${table.pg}: ${tableSuccess} synced, ${tableFailed} failed (${records.length} total)`);
          result.synced += tableSuccess;
          result.failed += tableFailed;

        } catch (tableError: any) {
          // Log table-level errors
          console.error(`[Sync] ❌ ${table.pg}: ${tableError.message}`);
          result.errors.push(`${table.pg}: ${tableError.message}`);
        }
      }

      await pgClient.end();
      console.log(`[Sync] 🎉 Full sync complete: ${result.synced} synced, ${result.failed} failed`);

    } catch (error: any) {
      console.error('[Sync] ❌ Full sync failed:', error.message);
      result.errors.push(error.message);
    } finally {
      this.syncStatus.inProgress = false;
      this.syncStatus.currentOperation = null;
      this.updateStatus();
    }

    return result;
  }

  /**
   * Convert snake_case to camelCase
   */
  private snakeToCamel(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  /**
   * Clean a record for SQLite/Prisma compatibility
   * Converts snake_case keys to camelCase
   */
  private cleanRecordForSQLite(record: any): any {
    const cleaned: any = {};

    for (const [key, value] of Object.entries(record)) {
      // Convert snake_case to camelCase for Prisma
      const camelKey = this.snakeToCamel(key);

      if (value === null || value === undefined) {
        cleaned[camelKey] = null;
      } else if (typeof value === 'boolean' || value === 't' || value === 'f') {
        // Convert PostgreSQL boolean strings to actual booleans
        cleaned[camelKey] = value === true || value === 't';
      } else if (value instanceof Date) {
        cleaned[camelKey] = value;
      } else if (typeof value === 'object' && !(value instanceof Date)) {
        // Skip complex objects that can't be stored directly
        cleaned[camelKey] = JSON.stringify(value);
      } else {
        cleaned[camelKey] = value;
      }
    }

    return cleaned;
  }

  /**
   * Sync PostgreSQL changes to SQLite (when going offline)
   * This ensures SQLite has the latest data from PostgreSQL
   */
  async syncToSQLite(): Promise<void> {
    if (this.syncStatus.inProgress) {
      console.log('[Sync] Sync already in progress');
      return;
    }

    const dbService = getDatabaseService();

    // Try to get PostgreSQL client (might be available even if not "online")
    let postgresClient: PrismaClient | null = null;
    try {
      postgresClient = await dbService.getPostgreSQLClient();
    } catch (err) {
      console.log('[Sync] PostgreSQL client not available');
    }

    if (!postgresClient) {
      // If PostgreSQL is not available, we can't sync from it
      // But we can still ensure SQLite is ready
      console.log('[Sync] PostgreSQL not available, cannot sync to SQLite');
      console.log('[Sync] SQLite will continue with existing data');
      return;
    }

    this.syncStatus.inProgress = true;
    this.syncStatus.currentOperation = 'Syncing PostgreSQL → SQLite';

    try {
      const sqliteClient = await dbService.getSQLiteClient();

      console.log('[Sync] 🔄 Syncing PostgreSQL data to SQLite to keep data up-to-date...');

      // Sync all tables from PostgreSQL to SQLite
      // This ensures SQLite has the latest data when going offline
      await this.syncAllTables(postgresClient, sqliteClient);

      this.syncStatus.lastSync = new Date();
      this.syncStatus.currentOperation = null;
      console.log('[Sync] ✅ Sync to SQLite completed - SQLite now has up-to-date data');
    } catch (error: any) {
      console.error('[Sync] ❌ Sync to SQLite failed:', error.message);
      this.syncStatus.currentOperation = `Error: ${error.message}`;
      // Don't throw - allow system to continue with SQLite even if sync fails
    } finally {
      this.syncStatus.inProgress = false;
      this.updateStatus();
    }
  }

  /**
   * Sync a single item to PostgreSQL (using raw SQL)
   */
  private async syncItemToPostgreSQL(
    item: SyncQueueItem,
    sqliteClient: PrismaClient,
    postgresClient: any
  ): Promise<void> {
    const { table, operation, data } = item;
    // Convert Prisma model name to PostgreSQL table name
    const postgresTableName = this.getPostgreSQLTableName(table);
    const tableName = this.sanitizeTableName(postgresTableName);

    switch (operation) {
      case 'create':
        await this.insertToPostgreSQL(postgresClient, tableName, data);
        break;
      case 'update':
        await this.updateInPostgreSQL(postgresClient, tableName, data);
        break;
      case 'delete':
        await this.deleteFromPostgreSQL(postgresClient, tableName, data.id);
        break;
    }
  }

  /**
   * Insert into PostgreSQL using raw SQL
   */
  private async insertToPostgreSQL(client: any, table: string, data: any): Promise<void> {
    // Check if table exists
    const tableExists = await this.tableExistsInPostgreSQL(client, table);
    if (!tableExists) {
      throw new Error(`Table ${table} does not exist in PostgreSQL. Please run migrations first.`);
    }

    const columns = Object.keys(data).filter(key => data[key] !== undefined);
    const values = columns.map(col => data[col]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const columnNames = columns.map(col => `"${col}"`).join(', ');

    const query = `INSERT INTO "${table}" (${columnNames}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${columns.map((col, i) => `"${col}" = $${i + 1}`).join(', ')}`;

    await client.query(query, values);
  }

  /**
   * Update in PostgreSQL using raw SQL
   */
  private async updateInPostgreSQL(client: any, table: string, data: any): Promise<void> {
    if (!data.id) {
      throw new Error('Update requires id');
    }

    const columns = Object.keys(data).filter(key => key !== 'id' && data[key] !== undefined);
    const values = columns.map(col => data[col]);
    const setClause = columns.map((col, i) => `"${col}" = $${i + 1}`).join(', ');

    // Check if updated_at column exists
    const hasUpdatedAt = await this.columnExistsInPostgreSQL(client, table, 'updated_at');
    const setClauseWithTimestamp = hasUpdatedAt
      ? `${setClause}, "updated_at" = NOW()`
      : setClause;

    const query = `UPDATE "${table}" SET ${setClauseWithTimestamp} WHERE "id" = $${columns.length + 1}`;

    await client.query(query, [...values, data.id]);
  }

  /**
   * Delete from PostgreSQL using raw SQL
   */
  private async deleteFromPostgreSQL(client: any, table: string, id: string): Promise<void> {
    const query = `DELETE FROM "${table}" WHERE "id" = $1`;
    await client.query(query, [id]);
  }

  /**
   * Sanitize table name
   */
  private sanitizeTableName(table: string): string {
    return table.replace(/[^a-zA-Z0-9_]/g, '');
  }

  /**
   * Check if client is PrismaClient or raw pg Client
   */
  private isPrismaClient(client: any): boolean {
    return client instanceof PrismaClient ||
           (client && typeof client.$connect === 'function' && typeof client.$disconnect === 'function');
  }

  /**
   * Get all records from a table (works with both PrismaClient and pg Client)
   */
  private async getTableRecords(client: any, tableName: string): Promise<any[]> {
    if (this.isPrismaClient(client)) {
      // PrismaClient (SQLite)
      const prismaModel = (client as any)[tableName];
      if (!prismaModel) {
        console.warn(`[Sync] Table ${tableName} not found in Prisma schema, skipping`);
        return [];
      }
      return await prismaModel.findMany();
    } else {
      // Raw pg Client (PostgreSQL)
      try {
        const result = await client.query(`SELECT * FROM "${tableName}"`);
        return result.rows;
      } catch (error: any) {
        // If table doesn't exist, return empty array (don't log repeatedly)
        if (error.message && error.message.includes('does not exist')) {
          return [];
        }
        throw error;
      }
    }
  }

  /**
   * Check if table exists in PostgreSQL
   */
  private async tableExistsInPostgreSQL(client: any, tableName: string): Promise<boolean> {
    try {
      const result = await client.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = $1
        )`,
        [tableName]
      );
      return result.rows[0]?.exists || false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if column exists in PostgreSQL table
   */
  private async columnExistsInPostgreSQL(client: any, tableName: string, columnName: string): Promise<boolean> {
    try {
      const result = await client.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.columns
          WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
        )`,
        [tableName, columnName]
      );
      return result.rows[0]?.exists || false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get unique constraints for a table
   */
  private async getUniqueConstraints(client: any, tableName: string): Promise<string[]> {
    try {
      const result = await client.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
        AND table_name = $1
        AND constraint_type = 'UNIQUE'
      `, [tableName]);
      return result.rows.map((row: any) => row.constraint_name);
    } catch (error) {
      return [];
    }
  }

  /**
   * Get unique columns for a constraint
   */
  private async getUniqueColumnsForConstraint(client: any, tableName: string, constraintName: string): Promise<string[]> {
    try {
      const result = await client.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_schema = 'public'
        AND tc.table_name = $1
        AND tc.constraint_name = $2
      `, [tableName, constraintName]);
      return result.rows.map((row: any) => row.column_name);
    } catch (error) {
      return [];
    }
  }

  /**
   * Convert camelCase to snake_case
   * Examples: companyId -> company_id, branchId -> branch_id
   */
  private camelToSnake(str: string): string {
    return str.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  }

  /**
   * Get actual column names from PostgreSQL table
   */
  private async getActualColumnNames(client: any, tableName: string): Promise<string[]> {
    try {
      const result = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);
      return result.rows.map((row: any) => row.column_name);
    } catch (error) {
      return [];
    }
  }

  /**
   * Find actual column name in PostgreSQL (handles both camelCase and snake_case)
   */
  private findActualColumnName(prismaFieldName: string, actualColumns: string[]): string {
    // First, try exact match (camelCase)
    if (actualColumns.includes(prismaFieldName)) {
      return prismaFieldName;
    }

    // Then, try snake_case
    const snakeCase = this.camelToSnake(prismaFieldName);
    if (actualColumns.includes(snakeCase)) {
      return snakeCase;
    }

    // If not found, return snake_case (most common in PostgreSQL)
    return snakeCase;
  }

  /**
   * Check if foreign key reference exists
   */
  private async foreignKeyExists(client: any, tableName: string, columnName: string, referencedId: string): Promise<boolean> {
    try {
      // Convert camelCase to snake_case for PostgreSQL column names
      const snakeColumnName = this.camelToSnake(columnName);

      // Get foreign key constraint info - try both camelCase and snake_case
      const fkResult = await client.query(`
        SELECT
          tc.constraint_name,
          kcu.column_name,
          ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = $1
        AND (kcu.column_name = $2 OR kcu.column_name = $3)
      `, [tableName, columnName, snakeColumnName]);

      if (fkResult.rows.length === 0) {
        return true; // No foreign key, so it's valid
      }

      const fk = fkResult.rows[0];
      // Check if referenced record exists
      const checkResult = await client.query(
        `SELECT EXISTS (SELECT 1 FROM "${fk.foreign_table_name}" WHERE "${fk.foreign_column_name}" = $1)`,
        [referencedId]
      );

      return checkResult.rows[0]?.exists || false;
    } catch (error: any) {
      console.warn(`[Sync] ⚠️  Error checking foreign key ${tableName}.${columnName}:`, error.message);
      return false; // On error, assume it doesn't exist to be safe
    }
  }

  /**
   * Upsert record to target (works with both PrismaClient and pg Client)
   */
  private async upsertRecord(
    targetClient: any,
    tableName: string,
    record: any
  ): Promise<void> {
    const cleanRecord = this.cleanRecord(record);
    const { id, ...dataWithoutId } = cleanRecord;
    const dataToSync = this.removeRelations(dataWithoutId);

    if (this.isPrismaClient(targetClient)) {
      // PrismaClient (SQLite)
      const prismaModel = (targetClient as any)[tableName];
      if (!prismaModel) {
        throw new Error(`Table ${tableName} not found in Prisma schema`);
      }
      await prismaModel.upsert({
        where: { id: cleanRecord.id },
        update: dataToSync,
        create: { id: cleanRecord.id, ...dataToSync }
      });
    } else {
      // Raw pg Client (PostgreSQL) - check if table exists first
      const tableExists = await this.tableExistsInPostgreSQL(targetClient, tableName);
      if (!tableExists) {
        throw new Error(`Table ${tableName} does not exist in PostgreSQL. Please run migrations first.`);
      }

      // Use raw SQL
      // Get actual column names from PostgreSQL (handles both camelCase and snake_case)
      const columns = Object.keys(dataToSync).filter(key => dataToSync[key] !== undefined);
      const values = columns.map(col => dataToSync[col]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

      // Get actual column names from PostgreSQL table
      const actualColumnNames = await this.getActualColumnNames(targetClient, tableName);

      // Map Prisma field names to actual PostgreSQL column names
      const columnNames = columns.map(col => {
        const actualCol = this.findActualColumnName(col, actualColumnNames);
        return `"${actualCol}"`;
      }).join(', ');

      const updateClause = columns.map((col, i) => {
        const actualCol = this.findActualColumnName(col, actualColumnNames);
        return `"${actualCol}" = $${i + 1}`;
      }).join(', ');

      // Check if updated_at column exists before using it
      const hasUpdatedAt = await this.columnExistsInPostgreSQL(targetClient, tableName, 'updated_at');
      const updateClauseWithTimestamp = hasUpdatedAt
        ? `${updateClause}, "updated_at" = NOW()`
        : updateClause;

      // Use PostgreSQL UPSERT (ON CONFLICT)
      // Handle conflicts on both id and unique constraints
      const uniqueConstraints = await this.getUniqueConstraints(targetClient, tableName);
      let conflictTarget = '"id"';

      // If there are unique constraints, we need to handle them
      // For now, use id as primary conflict target
      const query = `
        INSERT INTO "${tableName}" ("id", ${columnNames})
        VALUES ($${columns.length + 1}, ${placeholders})
        ON CONFLICT ("id")
        DO UPDATE SET ${updateClauseWithTimestamp}
      `;

      try {
        await targetClient.query(query, [...values, cleanRecord.id]);
      } catch (error: any) {
        // Log the actual error for debugging
        if (!error.message.includes('current transaction is aborted')) {
          console.warn(`[Sync] ⚠️  Upsert error for ${tableName} record ${cleanRecord.id}: ${error.message}`);
        }

        // If duplicate key error, check if record exists and update it
        if (error.message && error.message.includes('duplicate key value violates unique constraint')) {
          // Check if record exists by id first
          const existsResult = await targetClient.query(
            `SELECT id FROM "${tableName}" WHERE "id" = $1`,
            [cleanRecord.id]
          );

          if (existsResult.rows.length > 0) {
            // Record exists, just update it
            const updateQuery = `
              UPDATE "${tableName}"
              SET ${updateClauseWithTimestamp}
              WHERE "id" = $${columns.length + 1}
            `;
            await targetClient.query(updateQuery, [...values, cleanRecord.id]);
          } else {
            // Extract constraint name from error and try to update by unique constraint
            const constraintMatch = error.message.match(/constraint "([^"]+)"/);
            if (constraintMatch) {
              const constraintName = constraintMatch[1];
              const uniqueCols = await this.getUniqueColumnsForConstraint(targetClient, tableName, constraintName);
              if (uniqueCols.length > 0) {
                // Build WHERE clause for unique columns
                const whereClause = uniqueCols.map((col: string, i: number) => `"${col}" = $${columns.length + 1 + i}`).join(' AND ');
                const uniqueValues = uniqueCols.map((col: string) => cleanRecord[col]);

                // Try UPDATE by unique constraint
                const updateQuery = `
                  UPDATE "${tableName}"
                  SET ${updateClauseWithTimestamp}
                  WHERE ${whereClause}
                `;
                await targetClient.query(updateQuery, [...values, ...uniqueValues]);
              } else {
                throw error; // Re-throw if we can't handle it
              }
            } else {
              throw error; // Re-throw if we can't extract constraint
            }
          }
        } else {
          throw error; // Re-throw other errors
        }
      }
    }
  }

  /**
   * Map Prisma model names to actual PostgreSQL table names
   * Based on @@map() in schema.prisma
   */
  private getPostgreSQLTableName(modelName: string): string {
    const tableMap: Record<string, string> = {
      // Model name -> PostgreSQL table name
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
      'card_details': 'card_details',
      'subscriptions': 'subscriptions'
    };

    return tableMap[modelName] || modelName;
  }

  /**
   * Get Prisma model name from PostgreSQL table name (reverse mapping)
   */
  private getPrismaModelName(tableName: string): string {
    const modelMap: Record<string, string> = {
      'companies': 'company',
      'categories': 'category',
      'suppliers': 'supplier',
      'manufacturers': 'manufacturer',
      'shelves': 'shelf',
      'settings': 'settings',
      'users': 'user',
      'branches': 'branch',
      'employees': 'employee',
      'products': 'product',
      'batches': 'batch',
      'stock_movements': 'stockMovement',
      'customers': 'customer',
      'sales': 'sale',
      'sale_items': 'saleItem',
      'receipts': 'receipt',
      'purchases': 'purchase',
      'purchase_items': 'purchaseItem',
      'refunds': 'refund',
      'refund_items': 'refundItem',
      'attendance': 'attendance',
      'shifts': 'shift',
      'scheduled_shifts': 'scheduledShift',
      'scheduled_shift_users': 'scheduledShiftUser',
      'commissions': 'commission',
      'card_details': 'card_details',
      'subscriptions': 'subscriptions'
    };

    return modelMap[tableName] || tableName;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Sync all tables between databases
   * Ensures both databases have the same up-to-date data
   */
  private async syncAllTables(
    sourceClient: PrismaClient,
    targetClient: any
  ): Promise<number> {
    // List of all tables to sync (using Prisma model names)
    // Order matters: sync parent tables before child tables (foreign keys)
    // CRITICAL FIX: 'user' table is EXCLUDED - users should only sync TO PostgreSQL, not FROM
    // This prevents local SQLite users from being overwritten by PostgreSQL data
    const modelNames = [
      // Core tables (no dependencies)
      'company',
      'category',
      'supplier',
      'manufacturer',
      'shelf',
      'settings',
      // User EXCLUDED - users only sync TO PostgreSQL, not FROM
      // 'user', // DISABLED to prevent overwriting local users
      'branch',
      'employee',
      // Products (depend on category, supplier, manufacturer, shelf)
      'product',
      // Batches (depend on product)
      'batch',
      'stockMovement',
      // Customers (depend on branch)
      'customer',
      // Sales (depend on customer, user, branch, product)
      'sale',
      'saleItem',
      'receipt',
      // Purchases (depend on supplier, branch, product)
      'purchase',
      'purchaseItem',
      // Refunds (depend on sale)
      'refund',
      'refundItem',
      // Employee management
      'attendance',
      'shift',
      'scheduledShift',
      'scheduledShiftUser',
      'commission',
      // Other
      'card_details',
      'subscriptions'
    ];

    let totalSynced = 0;
    let totalFailed = 0;
    const failedRecords: Array<{ modelName: string; postgresTableName: string; record: any; error: string }> = [];

    // Rate limit: Only do full table check every 5 minutes
    const now = new Date();
    const fiveMinutes = 5 * 60 * 1000;
    if (this.lastTableCheckTime && (now.getTime() - this.lastTableCheckTime.getTime()) < fiveMinutes && !this.postgresTablesExist) {
      // Skip sync if we recently checked and tables don't exist
      return totalSynced;
    }
    this.lastTableCheckTime = now;

    console.log(`[Sync] Starting full database sync (${modelNames.length} tables)...`);

    // For PostgreSQL: Disable FK checks during sync to allow inserting children before parents
    let transactionActive = false;
    let missingTablesCount = 0;

    if (!this.isPrismaClient(targetClient)) {
      try {
        // Rollback any existing failed transaction first (safe to call even if not in transaction)
        try {
          await targetClient.query('ROLLBACK');
        } catch (rollbackError) {
          // Ignore rollback errors if not in transaction - this is expected
        }
        // Start fresh transaction
        await targetClient.query('BEGIN');
        await targetClient.query('SET session_replication_role = replica');
        transactionActive = true;
        console.log('[Sync] 🔓 Disabled foreign key checks for sync (session_replication_role = replica)');
      } catch (error: any) {
        console.warn('[Sync] ⚠️  Could not disable FK checks:', error.message);
        // Try to rollback if transaction was started
        try {
          await targetClient.query('ROLLBACK');
        } catch (rollbackError) {
          // Ignore
        }
        transactionActive = false;
      }
    }

    // First pass: Sync all tables in strict order
    for (const modelName of modelNames) {
      try {
        // Get PostgreSQL table name (plural/snake_case)
        const postgresTableName = this.getPostgreSQLTableName(modelName);
        this.syncStatus.currentOperation = `Syncing ${modelName} (${postgresTableName})...`;

        // Check if table exists in target (PostgreSQL) before syncing
        if (!this.isPrismaClient(targetClient)) {
          const tableExists = await this.tableExistsInPostgreSQL(targetClient, postgresTableName);
          if (!tableExists) {
            missingTablesCount++;
            // Only log individual missing tables on first check
            if (!this.tablesCheckDone) {
              console.warn(`[Sync] ⚠️  Table ${postgresTableName} does not exist in PostgreSQL, skipping.`);
            }
            continue;
          }
        }

        // Get all records from source (SQLite - PrismaClient) using model name
        const records = await this.getTableRecords(sourceClient, modelName);

        if (records.length === 0) {
          console.log(`[Sync] Table ${modelName} is empty, skipping`);
          continue;
        }

        let syncedCount = 0;
        let failedCount = 0;

        // Upsert to target (PostgreSQL - raw pg Client or SQLite - PrismaClient)
        for (const record of records) {
          try {
            // Use PostgreSQL table name for raw SQL, model name for Prisma
            const targetTableName = this.isPrismaClient(targetClient) ? modelName : postgresTableName;

            // Check foreign key constraints before syncing (for PostgreSQL)
            // Note: We skip this check for the first sync pass to allow parent records to sync first
            // Foreign key violations will be caught by PostgreSQL and handled gracefully
            // This allows records to sync even if parent records are syncing in the same batch

            await this.upsertRecord(targetClient, targetTableName, record);
            syncedCount++;
          } catch (error: any) {
            failedCount++;

            // Log the actual error first (before transaction abort check)
            if (!error.message.includes('current transaction is aborted')) {
              console.warn(`[Sync] ⚠️  Error syncing ${modelName} record ${record.id}: ${error.message}`);
            }

            // Handle transaction errors - need to rollback and restart
            if (error.message && error.message.includes('current transaction is aborted')) {
              console.warn(`[Sync] ⚠️  Transaction aborted for ${modelName} record ${record.id}, rolling back...`);

              // Don't retry transaction aborted errors immediately - they indicate a previous error
              // Just rollback and continue - the record will be added to retry queue if it's a FK violation
              if (!this.isPrismaClient(targetClient) && transactionActive) {
                try {
                  await targetClient.query('ROLLBACK');
                  await targetClient.query('BEGIN');
                  await targetClient.query('SET session_replication_role = replica');
                  transactionActive = true;
                  console.log('[Sync] ✅ Transaction restarted');
                } catch (rollbackError: any) {
                  console.error('[Sync] ❌ Failed to restart transaction:', rollbackError.message);
                  transactionActive = false;
                }
              }

              // Don't add transaction abort errors to retry queue - they're not retryable
              // Only add if it's a specific error we can retry (FK violations, etc.)
              continue;
            }

            // Handle specific error types
            if (error.message && error.message.includes('duplicate key value violates unique constraint')) {
              // Duplicate key - record already exists, this is okay
              console.log(`[Sync] ℹ️  ${modelName} record ${record.id} already exists in PostgreSQL, skipping`);
              syncedCount++; // Count as synced since it already exists
              failedCount--; // Don't count as failed
            } else if (error.message && error.message.includes('violates foreign key constraint')) {
              // Foreign key violation - extract details for debugging
              const fkMatch = error.message.match(/violates foreign key constraint "([^"]+)"/);
              const constraintName = fkMatch ? fkMatch[1] : 'unknown';

              // Extract which foreign key is missing
              let fkDetails = '';
              if (record.branchId) fkDetails += `branchId:${record.branchId} `;
              if (record.companyId) fkDetails += `companyId:${record.companyId} `;
              if (record.userId) fkDetails += `userId:${record.userId} `;
              if (record.categoryId) fkDetails += `categoryId:${record.categoryId} `;

              console.warn(`[Sync] ⚠️  ${modelName} record ${record.id} failed (FK: ${constraintName}) - ${fkDetails.trim()} - will retry after sync`);

              // Store for retry after all tables are synced
              failedRecords.push({
                modelName,
                postgresTableName,
                record,
                error: error.message
              });
            } else if (error.message && (error.message.includes('does not exist in PostgreSQL') || error.message.includes('Table') && error.message.includes('does not exist'))) {
              // Table doesn't exist - don't retry, just log
              console.warn(`[Sync] ⚠️  ${modelName} record ${record.id}: ${error.message}`);
              console.warn(`[Sync] 💡 Run: npm run db:reset-postgresql (to reset and rebuild) or create tables manually.`);
              // Don't add to retry queue - table needs to be created first
            } else {
              // Other errors - log but don't retry unless it's a specific retryable error
              if (failedCount <= 5) { // Only log first 5 errors per table
                console.warn(`[Sync] Failed to sync ${modelName} record ${record.id}:`, error.message);
              }
            }
          }
        }

        totalSynced += syncedCount;
        totalFailed += failedCount;

        if (syncedCount > 0) {
          console.log(`[Sync] ✅ Synced ${syncedCount}/${records.length} ${modelName} records${failedCount > 0 ? ` (${failedCount} failed)` : ''}`);
        } else if (failedCount > 0) {
          console.warn(`[Sync] ⚠️  Table ${modelName}: ${failedCount} records failed to sync`);
        }

        // FIX 1: Force COMMIT and wait after each table sync (for PostgreSQL)
        // This ensures data is visible and FK constraints can be checked
        if (!this.isPrismaClient(targetClient) && syncedCount > 0 && transactionActive) {
          try {
            await targetClient.query('COMMIT');
            await this.delay(100); // 100ms delay for PG to process
            await targetClient.query('BEGIN');
            await targetClient.query('SET session_replication_role = replica');
            transactionActive = true;
          } catch (error: any) {
            console.warn(`[Sync] ⚠️  Error committing after ${modelName}:`, error.message);
            // Try to restart transaction
            try {
              await targetClient.query('ROLLBACK');
              await targetClient.query('BEGIN');
              await targetClient.query('SET session_replication_role = replica');
              transactionActive = true;
            } catch (restartError) {
              console.error(`[Sync] ❌ Failed to restart transaction after ${modelName}`);
              transactionActive = false;
            }
          }
        }
      } catch (error: any) {
        console.error(`[Sync] ❌ Failed to sync table ${modelName}:`, error.message);
        totalFailed++;
      }
    }

    // Re-enable FK checks after all tables are synced
    if (!this.isPrismaClient(targetClient) && transactionActive) {
      try {
        await targetClient.query('SET session_replication_role = DEFAULT');
        await targetClient.query('COMMIT');
        transactionActive = false;
        console.log('[Sync] 🔒 Re-enabled foreign key checks (session_replication_role = DEFAULT)');
      } catch (error: any) {
        console.warn('[Sync] ⚠️  Error re-enabling FK checks:', error.message);
        try {
          await targetClient.query('ROLLBACK');
          transactionActive = false;
        } catch (rollbackError) {
          // Ignore rollback errors
          transactionActive = false;
        }
      }
    }

    // Second pass: Retry records that failed due to foreign key violations
    // Filter out records that failed due to missing tables (those can't be retried)
    const retryableRecords = failedRecords.filter(fr =>
      !fr.error.includes('does not exist in PostgreSQL') &&
      !fr.error.includes('Table') &&
      !fr.error.includes('does not exist')
    );

    if (retryableRecords.length > 0 && !this.isPrismaClient(targetClient)) {
      console.log(`[Sync] 🔄 Retrying ${retryableRecords.length} records that failed due to foreign key violations...`);
      if (retryableRecords.length < failedRecords.length) {
        console.log(`[Sync] ℹ️  Skipping ${failedRecords.length - retryableRecords.length} records that failed due to missing tables`);
      }

      // Ensure we start with a clean transaction for retry
      let retryTransactionActive = false;
      try {
        // Rollback any existing failed transaction first
        try {
          await targetClient.query('ROLLBACK');
        } catch (rollbackError) {
          // Ignore rollback errors if not in transaction - this is expected
        }
        // Start fresh transaction for retry
        await targetClient.query('BEGIN');
        await targetClient.query('SET session_replication_role = replica');
        retryTransactionActive = true;
        console.log('[Sync] 🔓 Disabled FK checks for retry pass');
      } catch (error: any) {
        console.warn('[Sync] ⚠️  Could not start retry transaction:', error.message);
        // Try to rollback if transaction was started
        try {
          await targetClient.query('ROLLBACK');
        } catch (rollbackError) {
          // Ignore
        }
        retryTransactionActive = false;
      }

      let retrySynced = 0;
      let retryFailed = 0;

      for (const { modelName, postgresTableName, record } of retryableRecords) {
        try {
          // Handle transaction abort errors during retry
          let retryAttempted = false;
          let maxRetries = 2;

          for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
              // Check if transaction is still active, restart if needed
              if (!retryTransactionActive) {
                try {
                  await targetClient.query('ROLLBACK');
                } catch (rollbackError) {
                  // Ignore
                }
                await targetClient.query('BEGIN');
                await targetClient.query('SET session_replication_role = replica');
                retryTransactionActive = true;
              }

              // First, verify parent records exist in PostgreSQL
              if (record.companyId) {
                const companyExists = await targetClient.query(
                  'SELECT id FROM companies WHERE id = $1',
                  [record.companyId]
                );
                if (companyExists.rows.length === 0) {
                  console.warn(`[Sync] ⚠️  ${modelName} record ${record.id}: companyId ${record.companyId} does not exist in PostgreSQL companies table`);
                  retryFailed++;
                  retryAttempted = true;
                  break;
                }
              }

              if (record.branchId) {
                const branchExists = await targetClient.query(
                  'SELECT id FROM branches WHERE id = $1',
                  [record.branchId]
                );
                if (branchExists.rows.length === 0) {
                  console.warn(`[Sync] ⚠️  ${modelName} record ${record.id}: branchId ${record.branchId} does not exist in PostgreSQL branches table`);
                  retryFailed++;
                  retryAttempted = true;
                  break;
                }
              }

              if (record.categoryId) {
                const categoryExists = await targetClient.query(
                  'SELECT id FROM categories WHERE id = $1',
                  [record.categoryId]
                );
                if (categoryExists.rows.length === 0) {
                  console.warn(`[Sync] ⚠️  ${modelName} record ${record.id}: categoryId ${record.categoryId} does not exist in PostgreSQL categories table`);
                  retryFailed++;
                  retryAttempted = true;
                  break;
                }
              }

              const targetTableName = this.isPrismaClient(targetClient) ? modelName : postgresTableName;
              await this.upsertRecord(targetClient, targetTableName, record);
              retrySynced++;
              totalSynced++;
              totalFailed--; // Remove from failed count
              console.log(`[Sync] ✅ Retry successful: ${modelName} record ${record.id}`);
              retryAttempted = true;
              break; // Success, exit retry loop

            } catch (error: any) {
              // Handle transaction abort
              if (error.message && error.message.includes('current transaction is aborted')) {
                console.warn(`[Sync] ⚠️  Transaction aborted during retry (attempt ${attempt + 1}/${maxRetries}), restarting...`);
                try {
                  await targetClient.query('ROLLBACK');
                  await this.delay(50); // Small delay before restart
                  await targetClient.query('BEGIN');
                  await targetClient.query('SET session_replication_role = replica');
                  retryTransactionActive = true;
                  // Continue to retry - don't break, let it try again
                  continue;
                } catch (restartError: any) {
                  console.error(`[Sync] ❌ Failed to restart transaction during retry:`, restartError.message);
                  retryFailed++;
                  retryAttempted = true;
                  break;
                }
              } else {
                // Other errors - log and break
                retryFailed++;
                if (error.message && error.message.includes('violates foreign key constraint')) {
                  const fkMatch = error.message.match(/violates foreign key constraint "([^"]+)"/);
                  const constraintName = fkMatch ? fkMatch[1] : 'unknown';
                  console.warn(`[Sync] ⚠️  ${modelName} record ${record.id} still has FK violation (${constraintName}) after retry - parent record may not exist in PostgreSQL`);
                  console.warn(`[Sync]    Full error: ${error.message}`);
                } else {
                  console.warn(`[Sync] ⚠️  ${modelName} record ${record.id} retry failed:`, error.message);
                }
                retryAttempted = true;
                break;
              }
            }
          }

          if (!retryAttempted) {
            console.warn(`[Sync] ⚠️  ${modelName} record ${record.id} retry exhausted after ${maxRetries} attempts`);
            retryFailed++;
          }
        } catch (error: any) {
          retryFailed++;
          console.warn(`[Sync] ⚠️  ${modelName} record ${record.id} retry failed with unexpected error:`, error.message);
        }
      }

      // Re-enable FK checks after retry
      if (retryTransactionActive) {
        try {
          await targetClient.query('SET session_replication_role = DEFAULT');
          await targetClient.query('COMMIT');
          retryTransactionActive = false;
        } catch (error: any) {
          console.warn('[Sync] ⚠️  Error committing retry:', error.message);
          try {
            await targetClient.query('ROLLBACK');
            retryTransactionActive = false;
          } catch (rollbackError) {
            // Ignore rollback errors
            retryTransactionActive = false;
          }
        }
      }

      if (retrySynced > 0) {
        console.log(`[Sync] ✅ Retry pass: ${retrySynced} records successfully synced`);
      }
      if (retryFailed > 0) {
        console.warn(`[Sync] ⚠️  Retry pass: ${retryFailed} records still failed`);
      }
    }

    // Update table check status
    if (missingTablesCount > 0) {
      if (!this.tablesCheckDone) {
        console.warn(`[Sync] ⚠️  ${missingTablesCount} tables missing in PostgreSQL. Run: npm run db:reset-postgresql`);
        console.warn(`[Sync] 💤 Sync to PostgreSQL paused until tables are created. Will retry in 5 minutes.`);
      }
      this.postgresTablesExist = false;
    } else {
      this.postgresTablesExist = true;
    }
    this.tablesCheckDone = true;

    console.log(`[Sync] ✅ Full database sync completed: ${totalSynced} records synced${totalFailed > 0 ? `, ${totalFailed} failed` : ''}`);
    return totalSynced;
  }

  /**
   * Clean record data for sync (handles BigInt, Date, etc.)
   */
  private cleanRecord(record: any): any {
    const cleaned: any = { ...record };

    // Convert BigInt to string for JSON serialization
    for (const key in cleaned) {
      if (typeof cleaned[key] === 'bigint') {
        cleaned[key] = cleaned[key].toString();
      }
      // Handle nested objects
      if (cleaned[key] && typeof cleaned[key] === 'object' && !(cleaned[key] instanceof Date)) {
        if (Array.isArray(cleaned[key])) {
          cleaned[key] = cleaned[key].map((item: any) => {
            if (typeof item === 'bigint') {
              return item.toString();
            }
            return item;
          });
        }
      }
    }

    return cleaned;
  }

  /**
   * Remove relation fields from record (only keep scalar fields)
   * Relations are handled by foreign keys, not nested objects
   */
  private removeRelations(record: any): any {
    const cleaned: any = {};

    // Common relation field names to exclude
    const relationFields = [
      'branch', 'company', 'user', 'customer', 'product', 'sale', 'purchase',
      'category', 'supplier', 'manufacturer', 'shelf', 'role', 'employee',
      'items', 'batches', 'sales', 'purchases', 'receipts', 'refunds',
      'subscriptions', 'card_details', 'attendance', 'shifts', 'commissions'
    ];

    const now = new Date();

    for (const key in record) {
      // Skip relation fields (objects/arrays that are not dates)
      if (relationFields.includes(key)) {
        continue;
      }

      // Skip if it's an object (likely a relation)
      if (record[key] && typeof record[key] === 'object' && !(record[key] instanceof Date) && !Array.isArray(record[key])) {
        continue;
      }

      // Keep scalar values and arrays of scalars
      cleaned[key] = record[key];
    }

    // CRITICAL: Always ensure createdAt and updatedAt have values
    if (!cleaned.createdAt || cleaned.createdAt === null) {
      cleaned.createdAt = now;
    }
    if (!cleaned.updatedAt || cleaned.updatedAt === null) {
      cleaned.updatedAt = now;
    }

    return cleaned;
  }

  /**
   * Update sync status
   */
  private updateStatus(): void {
    this.syncStatus.pendingItems = this.syncQueue.filter(item => !item.synced).length;
  }

  /**
   * Get sync status
   */
  getStatus(): SyncStatus {
    return { ...this.syncStatus };
  }

  /**
   * Clear synced items from queue
   */
  clearSyncedItems(): void {
    this.syncQueue = this.syncQueue.filter(item => !item.synced);
    this.saveQueue();
    this.updateStatus();
  }

  /**
   * Get queue items
   */
  getQueue(): SyncQueueItem[] {
    return [...this.syncQueue];
  }

  /**
   * BIDIRECTIONAL SYNC - Sync all tables both ways
   * SQLite → PostgreSQL (local changes) AND PostgreSQL → SQLite (live changes)
   */
  async bidirectionalSync(): Promise<{
    localToLive: { synced: number; failed: number };
    liveToLocal: { synced: number; failed: number };
    errors: string[];
  }> {
    const result = {
      localToLive: { synced: 0, failed: 0 },
      liveToLocal: { synced: 0, failed: 0 },
      errors: [] as string[]
    };

    if (this.syncStatus.inProgress) {
      console.log('[Sync] ⏳ Sync already in progress');
      return result;
    }

    const dbService = getDatabaseService();

    // Check if online
    if (dbService.getConnectionStatus() !== 'online') {
      console.log('[Sync] ⚠️ Offline - cannot sync with live database');
      return result;
    }

    console.log('[Sync] 🔄 Starting BIDIRECTIONAL SYNC...');
    this.syncStatus.inProgress = true;
    this.syncStatus.currentOperation = 'Bidirectional Sync';

    try {
      // Step 1: Sync LOCAL (SQLite) → LIVE (PostgreSQL)
      console.log('[Sync] ➡️ Step 1: Syncing LOCAL → LIVE (SQLite → PostgreSQL)...');
      const localToLiveResult = await this.syncAllTablesFromSQLiteToPostgreSQL();
      result.localToLive = { synced: localToLiveResult.synced, failed: localToLiveResult.failed };
      result.errors.push(...localToLiveResult.errors);
      console.log(`[Sync] ✅ LOCAL → LIVE: ${localToLiveResult.synced} synced, ${localToLiveResult.failed} failed`);

      // Step 2: Sync LIVE (PostgreSQL) → LOCAL (SQLite)
      console.log('[Sync] ⬅️ Step 2: Syncing LIVE → LOCAL (PostgreSQL → SQLite)...');
      const liveToLocalResult = await this.syncAllTablesFromPostgreSQL();
      result.liveToLocal = { synced: liveToLocalResult.synced, failed: liveToLocalResult.failed };
      result.errors.push(...liveToLocalResult.errors);
      console.log(`[Sync] ✅ LIVE → LOCAL: ${liveToLocalResult.synced} synced, ${liveToLocalResult.failed} failed`);

      this.syncStatus.lastSync = new Date();
      console.log('[Sync] 🎉 BIDIRECTIONAL SYNC COMPLETE!');
      console.log(`[Sync] 📊 Total: LOCAL→LIVE: ${result.localToLive.synced}, LIVE→LOCAL: ${result.liveToLocal.synced}`);

    } catch (error: any) {
      console.error('[Sync] ❌ Bidirectional sync failed:', error.message);
      result.errors.push(error.message);
    } finally {
      this.syncStatus.inProgress = false;
      this.syncStatus.currentOperation = null;
      this.updateStatus();
    }

    return result;
  }

  /**
   * Sync all tables from SQLite to PostgreSQL
   * This pushes local changes to the live database
   */
  async syncAllTablesFromSQLiteToPostgreSQL(): Promise<{
    synced: number;
    failed: number;
    errors: string[];
  }> {
    const result = {
      synced: 0,
      failed: 0,
      errors: [] as string[]
    };

    const dbService = getDatabaseService();
    const sqliteClient = dbService.getSQLiteClient();
    const pgClient = await dbService.getRawPostgreSQLClient();

    if (!sqliteClient || !pgClient) {
      result.errors.push('Database clients not available');
      return result;
    }

    // Table order - dependency order for foreign keys
    const tables = [
      { prisma: 'company', pg: 'companies' },
      { prisma: 'category', pg: 'categories' },
      { prisma: 'supplier', pg: 'suppliers' },
      { prisma: 'manufacturer', pg: 'manufacturers' },
      { prisma: 'shelf', pg: 'shelves' },
      { prisma: 'settings', pg: 'settings' },
      { prisma: 'user', pg: 'users' },
      { prisma: 'branch', pg: 'branches' },
      { prisma: 'employee', pg: 'employees' },
      { prisma: 'product', pg: 'products' },
      { prisma: 'batch', pg: 'batches' },
      { prisma: 'stockMovement', pg: 'stock_movements' },
      { prisma: 'customer', pg: 'customers' },
      { prisma: 'sale', pg: 'sales' },
      { prisma: 'saleItem', pg: 'sale_items' },
      { prisma: 'receipt', pg: 'receipts' },
      { prisma: 'purchase', pg: 'purchases' },
      { prisma: 'purchaseItem', pg: 'purchase_items' },
      { prisma: 'refund', pg: 'refunds' },
      { prisma: 'refundItem', pg: 'refund_items' },
      { prisma: 'attendance', pg: 'attendance' },
      { prisma: 'shift', pg: 'shifts' },
      { prisma: 'scheduledShift', pg: 'scheduled_shifts' },
      { prisma: 'scheduledShiftUser', pg: 'scheduled_shift_users' },
      { prisma: 'commission', pg: 'commissions' },
      { prisma: 'cardDetails', pg: 'card_details' },
      { prisma: 'subscription', pg: 'subscriptions' }
    ];

    console.log('[Sync] 🔄 Syncing SQLite → PostgreSQL (27 tables)...');

    try {
      for (const table of tables) {
        try {
          // Get records from SQLite
          const prismaModel = (sqliteClient as any)[table.prisma];
          if (!prismaModel) {
            continue; // Skip if model doesn't exist
          }

          const records = await prismaModel.findMany();

          if (records.length === 0) {
            continue; // Skip empty tables
          }

          // Check if PostgreSQL table exists
          const tableExists = await this.tableExistsInPostgreSQL(pgClient, table.pg);
          if (!tableExists) {
            console.log(`[Sync] ⚠️ Table ${table.pg} not in PostgreSQL, skipping`);
            continue;
          }

          // Get PostgreSQL column names
          const pgColumns = await this.getActualColumnNames(pgClient, table.pg);

          let tableSuccess = 0;
          let tableFailed = 0;

          for (const record of records) {
            try {
              // Clean record for PostgreSQL - removes relation objects
              const cleanRecord = this.removeRelations(record);

              // CRITICAL: Ensure we have an ID
              if (!cleanRecord.id) {
                tableFailed++;
                continue;
              }

              // CRITICAL: Ensure updatedAt and createdAt have valid values
              const now = new Date().toISOString();

              // Convert date fields to ISO strings if they exist
              if (cleanRecord.createdAt) {
                if (cleanRecord.createdAt instanceof Date) {
                  cleanRecord.createdAt = cleanRecord.createdAt.toISOString();
                } else if (typeof cleanRecord.createdAt !== 'string') {
                  cleanRecord.createdAt = now;
                }
              } else {
                cleanRecord.createdAt = now;
              }

              if (cleanRecord.updatedAt) {
                if (cleanRecord.updatedAt instanceof Date) {
                  cleanRecord.updatedAt = cleanRecord.updatedAt.toISOString();
                } else if (typeof cleanRecord.updatedAt !== 'string') {
                  cleanRecord.updatedAt = now;
                }
              } else {
                cleanRecord.updatedAt = now;
              }

              // Build upsert query - include all columns with values
              const columns = Object.keys(cleanRecord).filter(k => {
                const value = cleanRecord[k];
                // Skip undefined
                if (value === undefined) return false;
                // Skip null for non-required fields (except FK fields which can be null)
                if (value === null && !['branchId', 'companyId', 'supplierId', 'manufacturerId', 'categoryId', 'shelfId', 'customerId', 'userId', 'saleId', 'productId', 'batchId'].includes(k)) {
                  return false;
                }
                return true;
              });

              const values = columns.map(c => cleanRecord[c]);

              // Map column names to PostgreSQL (camelCase → snake_case if needed)
              const pgColumnNames = columns.map(col => {
                const snakeCol = this.camelToSnake(col);
                return pgColumns.includes(snakeCol) ? snakeCol : col;
              });

              // Convert values for PostgreSQL
              const pgValues = values.map(v => {
                if (v === null || v === undefined) return null;
                if (typeof v === 'boolean') return v;
                if (v instanceof Date) return v.toISOString();
                return v;
              });

              // Build INSERT ON CONFLICT UPDATE query
              const columnList = pgColumnNames.map(c => `"${c}"`).join(', ');
              const placeholders = pgColumnNames.map((_, i) => `$${i + 1}`).join(', ');

              // Build update list - always update updatedAt
              let updateList = pgColumnNames
                .filter(c => c !== 'id' && c !== 'createdAt' && c !== 'created_at')
                .map(c => `"${c}" = EXCLUDED."${c}"`)
                .join(', ');

              // Add updatedAt = NOW() if not already in the list
              if (!updateList.includes('updatedAt') && !updateList.includes('updated_at')) {
                updateList = updateList ? `${updateList}, "updatedAt" = NOW()` : '"updatedAt" = NOW()';
              }

              const query = `
                INSERT INTO "${table.pg}" (${columnList})
                VALUES (${placeholders})
                ON CONFLICT ("id") DO UPDATE SET ${updateList}
              `;

              await pgClient.query(query, pgValues);
              tableSuccess++;
            } catch (recordError: any) {
              tableFailed++;
              // Only log first error per table
              if (tableFailed === 1) {
                console.log(`[Sync] ⚠️ ${table.pg} error: ${recordError.message.substring(0, 60)}...`);
              }
            }
          }

          if (tableSuccess > 0) {
            console.log(`[Sync] ✅ SQLite→PG ${table.pg}: ${tableSuccess} synced, ${tableFailed} failed`);
          }
          result.synced += tableSuccess;
          result.failed += tableFailed;

        } catch (tableError: any) {
          console.error(`[Sync] ❌ ${table.pg}: ${tableError.message}`);
          result.errors.push(`${table.pg}: ${tableError.message}`);
        }
      }

      await pgClient.end();
      console.log(`[Sync] ✅ SQLite → PostgreSQL complete: ${result.synced} synced, ${result.failed} failed`);

    } catch (error: any) {
      console.error('[Sync] ❌ SQLite → PostgreSQL failed:', error.message);
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Immediate sync - Sync a single record change to PostgreSQL right away
   * Called from controllers when data is created/updated/deleted
   */
  async syncRecordToPostgreSQL(
    tableName: string,
    operation: 'create' | 'update' | 'delete',
    record: any
  ): Promise<boolean> {
    // If already using PostgreSQL directly (USE_POSTGRESQL=true), no sync needed
    const isPostgreSQLMode = process.env.USE_POSTGRESQL === 'true';
    if (isPostgreSQLMode) {
      console.log(`[Sync] ⏭️  PostgreSQL mode - No sync needed for ${tableName} (data already in PostgreSQL)`);
      return true; // Return true since data is already in PostgreSQL
    }

    const dbService = getDatabaseService();

    // Check if online
    if (dbService.getConnectionStatus() !== 'online') {
      // Queue for later sync
      this.addToQueue(tableName, operation, record);
      console.log(`[Sync] ⏳ Offline - queued ${operation} for ${tableName}`);
      return false;
    }

    try {
      const pgClient = await dbService.getRawPostgreSQLClient();
      if (!pgClient) {
        this.addToQueue(tableName, operation, record);
        return false;
      }

      const pgTableName = this.getPostgreSQLTableName(tableName);

      switch (operation) {
        case 'create':
        case 'update':
          await this.upsertRecord(pgClient, pgTableName, record);
          break;
        case 'delete':
          await this.deleteFromPostgreSQL(pgClient, pgTableName, record.id);
          break;
      }

      await pgClient.end();
      console.log(`[Sync] ✅ Immediately synced ${operation} to PostgreSQL: ${tableName}`);
      return true;
    } catch (error: any) {
      console.error(`[Sync] ❌ Immediate sync failed: ${error.message}`);
      // Queue for retry
      this.addToQueue(tableName, operation, record);
      return false;
    }
  }

  /**
   * Pull a specific table from PostgreSQL to SQLite (LIVE → LOCAL)
   * This is the MISSING DIRECTION - gets changes made in the live database
   * Called by controllers to ensure they have the latest data
   *
   * @param tableName - Prisma model name (e.g., 'product', 'customer')
   */
  async pullTableFromPostgreSQL(tableName: string): Promise<{ synced: number; failed: number }> {
    const result = { synced: 0, failed: 0 };

    const dbService = getDatabaseService();

    // Check if online
    if (dbService.getConnectionStatus() !== 'online') {
      console.log(`[Sync] ⚠️ Offline - cannot pull from PostgreSQL`);
      return result;
    }

    // Check if using PostgreSQL directly (no need to sync to itself)
    if (process.env.USE_POSTGRESQL === 'true') {
      return result;
    }

    try {
      const pgClient = await dbService.getRawPostgreSQLClient();
      const sqliteClient = dbService.getSQLiteClient();

      if (!pgClient || !sqliteClient) {
        console.log(`[Sync] ⚠️ Database clients not available`);
        return result;
      }

      const pgTableName = this.getPostgreSQLTableName(tableName);

      // Check if table exists in PostgreSQL
      const tableExists = await this.tableExistsInPostgreSQL(pgClient, pgTableName);
      if (!tableExists) {
        await pgClient.end();
        return result;
      }

      // Get all records from PostgreSQL
      const pgResult = await pgClient.query(`SELECT * FROM "${pgTableName}"`);
      const records = pgResult.rows;

      // CRITICAL FIX: For 'user' table in SQLite mode, don't pull if PostgreSQL is empty
      // This prevents overwriting local users with empty PostgreSQL data
      if (records.length === 0) {
        if (tableName === 'user') {
          console.log(`[Sync] ⚠️ PostgreSQL has no users - skipping pull to preserve local SQLite users`);
        }
        await pgClient.end();
        return result;
      }

      // Get Prisma model for this table
      const prismaModel = (sqliteClient as any)[tableName];
      if (!prismaModel) {
        console.log(`[Sync] ⚠️ Prisma model not found: ${tableName}`);
        await pgClient.end();
        return result;
      }

      // Upsert each record to SQLite
      for (const record of records) {
        try {
          // Clean record for SQLite/Prisma
          const cleanData: any = {};

          for (const [key, value] of Object.entries(record)) {
            // Convert snake_case to camelCase
            const camelKey = this.snakeToCamel(key);

            // Skip sync metadata columns
            if (['updated_at', 'created_at', 'is_synced', 'synced_at', 'last_modified'].includes(key)) {
              continue;
            }

            // Handle value conversion
            if (value === null || value === undefined) {
              cleanData[camelKey] = null;
            } else if (value === 't' || value === true) {
              cleanData[camelKey] = true;
            } else if (value === 'f' || value === false) {
              cleanData[camelKey] = false;
            } else if (value instanceof Date) {
              cleanData[camelKey] = value;
            } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
              cleanData[camelKey] = new Date(value);
            } else {
              cleanData[camelKey] = value;
            }
          }

          const recordId = cleanData.id;
          if (!recordId) {
            result.failed++;
            continue;
          }

          // Remove id from update data
          const { id, ...updateData } = cleanData;

          // Check if record exists first
          const existingRecord = await prismaModel.findUnique({
            where: { id: recordId }
          });

          if (existingRecord) {
            // Compare timestamps - only update if PostgreSQL record is newer
            const pgUpdatedAt = cleanData.updatedAt || cleanData.createdAt;
            const sqliteUpdatedAt = existingRecord.updatedAt || existingRecord.createdAt;

            if (pgUpdatedAt && sqliteUpdatedAt && new Date(pgUpdatedAt) > new Date(sqliteUpdatedAt)) {
              // PostgreSQL record is newer - update SQLite
              await prismaModel.update({
                where: { id: recordId },
                data: updateData
              });
              result.synced++;
            }
            // If SQLite record is newer or same, don't overwrite (local changes take precedence)
          } else {
            // Record doesn't exist in SQLite - create it
            await prismaModel.create({
              data: cleanData
            });
            result.synced++;
          }
        } catch (recordError: any) {
          result.failed++;
          // Silent fail for individual records
        }
      }

      await pgClient.end();

      if (result.synced > 0) {
        console.log(`[Sync] ⬇️ Pulled ${result.synced} records from PostgreSQL: ${tableName}`);
      }

    } catch (error: any) {
      console.error(`[Sync] ❌ Pull from PostgreSQL failed: ${error.message}`);
      result.failed++;
    }

    return result;
  }

  /**
   * Pull a specific record from PostgreSQL by ID
   * Use this when you need to refresh a single record
   *
   * @param tableName - Prisma model name (e.g., 'product')
   * @param recordId - The ID of the record to pull
   */
  async pullRecordFromPostgreSQL(tableName: string, recordId: string): Promise<boolean> {
    const dbService = getDatabaseService();

    // Check if online
    if (dbService.getConnectionStatus() !== 'online') {
      return false;
    }

    // Check if using PostgreSQL directly
    if (process.env.USE_POSTGRESQL === 'true') {
      return true;
    }

    try {
      const pgClient = await dbService.getRawPostgreSQLClient();
      const sqliteClient = dbService.getSQLiteClient();

      if (!pgClient || !sqliteClient) {
        return false;
      }

      const pgTableName = this.getPostgreSQLTableName(tableName);

      // Get the specific record from PostgreSQL
      const pgResult = await pgClient.query(`SELECT * FROM "${pgTableName}" WHERE id = $1`, [recordId]);

      if (pgResult.rows.length === 0) {
        await pgClient.end();
        return false;
      }

      const record = pgResult.rows[0];
      const prismaModel = (sqliteClient as any)[tableName];

      if (!prismaModel) {
        await pgClient.end();
        return false;
      }

      // Clean record for SQLite
      const cleanData: any = {};
      for (const [key, value] of Object.entries(record)) {
        const camelKey = this.snakeToCamel(key);
        if (['updated_at', 'created_at', 'is_synced', 'synced_at', 'last_modified'].includes(key)) {
          continue;
        }
        if (value === null || value === undefined) {
          cleanData[camelKey] = null;
        } else if (value === 't' || value === true) {
          cleanData[camelKey] = true;
        } else if (value === 'f' || value === false) {
          cleanData[camelKey] = false;
        } else if (value instanceof Date) {
          cleanData[camelKey] = value;
        } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
          cleanData[camelKey] = new Date(value);
        } else {
          cleanData[camelKey] = value;
        }
      }

      const { id, ...updateData } = cleanData;

      // Upsert to SQLite
      const existingRecord = await prismaModel.findUnique({ where: { id: recordId } });

      if (existingRecord) {
        await prismaModel.update({
          where: { id: recordId },
          data: updateData
        });
      } else {
        await prismaModel.create({
          data: cleanData
        });
      }

      await pgClient.end();
      console.log(`[Sync] ⬇️ Pulled record ${recordId} from PostgreSQL: ${tableName}`);
      return true;
    } catch (error: any) {
      console.error(`[Sync] ❌ Pull record failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Immediate bidirectional sync for a single operation
   * Pushes to PostgreSQL AND pulls from PostgreSQL in one call
   *
   * @param tableName - Prisma model name
   * @param operation - 'create' | 'update' | 'delete'
   * @param record - The record data
   */
  async syncBidirectionalImmediate(
    tableName: string,
    operation: 'create' | 'update' | 'delete',
    record: any
  ): Promise<{ pushed: boolean; pulled: { synced: number; failed: number } }> {
    // Step 1: Push LOCAL → LIVE
    const pushed = await this.syncRecordToPostgreSQL(tableName, operation, record);

    // Step 2: Pull LIVE → LOCAL (for any external changes)
    const pulled = await this.pullTableFromPostgreSQL(tableName);

    return { pushed, pulled };
  }
}

// Singleton instance
let syncServiceInstance: SyncService | null = null;

export function getSyncService(): SyncService {
  if (!syncServiceInstance) {
    syncServiceInstance = new SyncService();
  }
  return syncServiceInstance;
}

export default getSyncService;
