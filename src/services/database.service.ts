/**
 * Database Service - Handles SQLite (offline) with PostgreSQL sync
 *
 * DUAL MODE:
 * - Electron: SQLite primary, sync to PostgreSQL when online
 * - Website: Can use PostgreSQL directly with USE_POSTGRESQL=true
 */

import '../config/database.init';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export enum DatabaseType {
  SQLITE = 'sqlite',
  POSTGRESQL = 'postgresql'
}

export enum ConnectionStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  CHECKING = 'checking',
  ERROR = 'error'
}

class DatabaseService {
  private client: PrismaClient | null = null;
  private pgClient: Client | null = null;
  private connectionStatus: ConnectionStatus = ConnectionStatus.CHECKING;
  private isPostgreSQLMode: boolean;
  private postgresUrl: string;
  private lastSyncTime: Date | null = null;

  constructor() {
    this.isPostgreSQLMode = process.env.USE_POSTGRESQL === 'true';
    this.postgresUrl = process.env.REMOTE_DATABASE_URL ||
                       'postgresql://poszap_user:Ezify143@31.97.72.136:5432/poszap_db?schema=public';

    if (this.isPostgreSQLMode) {
      console.log('[Database] 🌐 Website Mode - PostgreSQL direct');
    } else {
      console.log('[Database] 💻 Electron Mode - SQLite with PostgreSQL sync');
    }
  }

  /**
   * Initialize Prisma client (SQLite or PostgreSQL based on mode)
   */
  async initialize(): Promise<void> {
    try {
      console.log('[Database] 🔌 Connecting to database...');

      // For SQLite mode, ensure database and schema are properly initialized
      if (!this.isPostgreSQLMode) {
        const sqlitePath = path.join(os.homedir(), '.zapeera', 'data', 'zapeera.db');
        const sqliteDir = path.dirname(sqlitePath);

        // Ensure directory exists
        if (!fs.existsSync(sqliteDir)) {
          fs.mkdirSync(sqliteDir, { recursive: true });
          console.log('[Database] 📁 Created SQLite directory:', sqliteDir);
        }

        // Check if database file exists and is valid
        if (fs.existsSync(sqlitePath)) {
          try {
            // Try to connect and verify schema
            this.client = new PrismaClient();
            await this.client.$connect();

            // Enable foreign keys for SQLite (required for cascade deletes)
            await this.client.$executeRaw`PRAGMA foreign_keys = ON`;

            // Quick schema check - try to query a table
            await this.client.$queryRaw`SELECT name FROM sqlite_master WHERE type='table' LIMIT 1`;
            console.log('[Database] ✅ SQLite database exists and is valid (foreign keys enabled)');
          } catch (schemaError: any) {
            console.log('[Database] ⚠️ SQLite database exists but schema may be invalid:', schemaError.message);
            console.log('[Database] 💡 Run: npm run db:push to fix schema');
            // Continue anyway - let Prisma handle the error
            this.client = new PrismaClient();
            await this.client.$connect();
            // Enable foreign keys
            await this.client.$executeRaw`PRAGMA foreign_keys = ON`.catch(() => {});
          }
        } else {
          // Database doesn't exist - will be created by Prisma on first operation
          console.log('[Database] 📝 SQLite database will be created on first operation');
          this.client = new PrismaClient();
          await this.client.$connect();
          // Enable foreign keys
          await this.client.$executeRaw`PRAGMA foreign_keys = ON`.catch(() => {});
        }
      } else {
        // PostgreSQL mode
        this.client = new PrismaClient();
        await this.client.$connect();
      }

      this.connectionStatus = ConnectionStatus.ONLINE;
      console.log('[Database] ✅ Connected to', this.isPostgreSQLMode ? 'PostgreSQL' : 'SQLite');

      // Check PostgreSQL connectivity for sync (only in Electron mode)
      if (!this.isPostgreSQLMode) {
        await this.checkPostgreSQLConnectivity();
      }
    } catch (error: any) {
      this.connectionStatus = ConnectionStatus.ERROR;
      console.error('[Database] ❌ Failed to connect:', error.message);

      // For SQLite, provide helpful error message
      if (!this.isPostgreSQLMode) {
        console.error('[Database] 💡 Make sure:');
        console.error('[Database]    1. Schema is set to SQLite: npm run db:switch-sqlite');
        console.error('[Database]    2. Database is initialized: npm run db:push');
        console.error('[Database]    3. Prisma client is generated: npm run db:generate');
      }

      throw error;
    }
  }

  /**
   * Check if PostgreSQL is available for sync
   */
  async checkPostgreSQLConnectivity(): Promise<boolean> {
    try {
      const pgClient = new Client({ connectionString: this.postgresUrl });
      await pgClient.connect();
      await pgClient.query('SELECT 1');
      await pgClient.end();
      console.log('[Database] ✅ PostgreSQL available for sync');
      return true;
    } catch (error: any) {
      console.log('[Database] ⚠️ PostgreSQL not available:', error.message);
      return false;
    }
  }

  /**
   * Get Prisma client
   */
  async getClient(): Promise<PrismaClient> {
    if (!this.client) {
      await this.initialize();
    }
    return this.client!;
  }

  /**
   * Get current database type
   */
  getCurrentType(): DatabaseType {
    return this.isPostgreSQLMode ? DatabaseType.POSTGRESQL : DatabaseType.SQLITE;
  }

  /**
   * Get connection status
   */
  getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  /**
   * Check if online (database connected)
   */
  isOnline(): boolean {
    return this.connectionStatus === ConnectionStatus.ONLINE;
  }

  /**
   * Check if offline
   */
  isOffline(): boolean {
    return this.connectionStatus !== ConnectionStatus.ONLINE;
  }

  /**
   * Get database status for health checks
   */
  getStatus(): {
    currentType: DatabaseType;
    connectionStatus: ConnectionStatus;
    sqlite: { url: string | null; isConnected: boolean; connected: boolean };
    postgres: { url: string; isConnected: boolean; connected: boolean };
    postgresql: { url: string; isConnected: boolean; connected: boolean };
    syncEnabled: boolean;
    lastSync: Date | null;
  } {
    const isConnected = this.connectionStatus === ConnectionStatus.ONLINE;
    const sqliteUrl = process.env.DATABASE_URL?.startsWith('file:') ? process.env.DATABASE_URL : null;
    const postgresInfo = {
      url: this.postgresUrl.replace(/:[^:@]+@/, ':****@'),
      isConnected: this.isPostgreSQLMode ? isConnected : false,
      connected: this.isPostgreSQLMode ? isConnected : false
    };

    return {
      currentType: this.getCurrentType(),
      connectionStatus: this.connectionStatus,
      sqlite: {
        url: sqliteUrl,
        isConnected: !this.isPostgreSQLMode && isConnected,
        connected: !this.isPostgreSQLMode && isConnected
      },
      postgres: postgresInfo,
      postgresql: postgresInfo,
      syncEnabled: !this.isPostgreSQLMode,
      lastSync: this.lastSyncTime
    };
  }

  /**
   * Check connectivity
   */
  async checkConnectivity(): Promise<ConnectionStatus> {
    try {
      if (!this.client) {
        this.client = new PrismaClient();
      }
      await this.client.$queryRaw`SELECT 1`;
      this.connectionStatus = ConnectionStatus.ONLINE;
      return ConnectionStatus.ONLINE;
    } catch (error: any) {
      console.error('[Database] Connectivity check failed:', error.message);
      this.connectionStatus = ConnectionStatus.ERROR;
      return ConnectionStatus.ERROR;
    }
  }

  /**
   * Start connectivity monitoring
   */
  startConnectivityMonitoring(intervalMs: number = 60000): void {
    console.log('[Database] Starting connectivity monitoring');
    setInterval(async () => {
      try {
        await this.checkConnectivity();

        // If in Electron mode and online, try to sync
        if (!this.isPostgreSQLMode && this.connectionStatus === ConnectionStatus.ONLINE) {
          const pgAvailable = await this.checkPostgreSQLConnectivity();
          if (pgAvailable) {
            console.log('[Database] 🔄 PostgreSQL available, ready for sync');
          }
        }
      } catch (e) {
        // Ignore monitoring errors
      }
    }, intervalMs);
  }

  /**
   * Force reconnect
   */
  async forceReconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.$disconnect();
      } catch (e) {}
      this.client = null;
    }
    await this.initialize();
  }

  /**
   * Disconnect
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.$disconnect();
      this.client = null;
      this.connectionStatus = ConnectionStatus.OFFLINE;
      console.log('[Database] 🔌 Disconnected');
    }
  }

  /**
   * Get PostgreSQL client for direct operations (sync)
   */
  async getPostgreSQLClient(): Promise<PrismaClient | null> {
    if (this.isPostgreSQLMode) {
      return this.client;
    }

    // For Electron mode, return null (use raw pg client for sync)
    return null;
  }

  /**
   * Get raw PostgreSQL client for sync operations
   */
  async getRawPostgreSQLClient(): Promise<Client | null> {
    try {
      const client = new Client({ connectionString: this.postgresUrl });
      await client.connect();
      return client;
    } catch (error: any) {
      console.log('[Database] Could not connect to PostgreSQL:', error.message);
      return null;
    }
  }

  // Compatibility methods
  getSQLiteClient(): PrismaClient | null {
    return this.isPostgreSQLMode ? null : this.client;
  }

  getPostgresClient(): PrismaClient | null {
    return this.isPostgreSQLMode ? this.client : null;
  }

  /**
   * Get PostgreSQL URL for sync operations
   */
  getPostgreSQLUrl(): string {
    return this.postgresUrl;
  }

  async syncNow(): Promise<void> {
    if (this.isPostgreSQLMode) {
      console.log('[Database] ℹ️ Sync not needed - using PostgreSQL directly');
      return;
    }
    console.log('[Database] 🔄 Manual sync requested');
    // Trigger sync through sync service
  }

  async switchToOnline(): Promise<void> {
    console.log('[Database] ℹ️ Mode switching not supported at runtime');
  }

  async switchToOffline(): Promise<void> {
    console.log('[Database] ℹ️ Mode switching not supported at runtime');
  }
}

// Singleton instance
let databaseServiceInstance: DatabaseService | null = null;

export function getDatabaseService(): DatabaseService {
  if (!databaseServiceInstance) {
    databaseServiceInstance = new DatabaseService();
  }
  return databaseServiceInstance;
}

export async function initializeDatabaseService(): Promise<DatabaseService> {
  const service = getDatabaseService();
  await service.initialize();
  return service;
}
