/**
 * Database Utility - Provides Prisma client
 * Supports both SQLite (Electron) and PostgreSQL (Web) modes
 */

import '../config/database.init';
import { PrismaClient } from '@prisma/client';
import { getDatabaseService } from '../services/database.service';

let cachedClient: PrismaClient | null = null;

/**
 * Get Prisma client
 */
export async function getPrisma(): Promise<PrismaClient> {
  try {
    if (cachedClient) {
      return cachedClient;
    }

    const dbService = getDatabaseService();
    const client = await dbService.getClient();

    cachedClient = client;
    console.log('[DB Util] ✅ Connected to database');

    return client;
  } catch (error: any) {
    console.error('[DB Util] ❌ Failed to get database client:', error.message);
    throw new Error(`Failed to connect to database: ${error.message}`);
  }
}

/**
 * Synchronous version - returns cached client
 */
export function getPrismaSync(): PrismaClient {
  if (cachedClient) {
    return cachedClient;
  }

  // Create new client
  cachedClient = new PrismaClient();
  return cachedClient;
}

/**
 * Disconnect from database
 */
export async function disconnectPrisma(): Promise<void> {
  if (cachedClient) {
    await cachedClient.$disconnect();
    cachedClient = null;
    console.log('[DB Util] 🔌 Disconnected from database');
  }
}
