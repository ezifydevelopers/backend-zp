/**
 * Sync Controller - Handles sync status and manual sync operations
 */

import { Request, Response } from 'express';
import { getDatabaseService, DatabaseType } from '../services/database.service';
import { getSyncService } from '../services/sync.service';
import { getPrisma } from '../utils/db.util';

/**
 * Get sync status
 */
export const getSyncStatus = async (req: Request, res: Response) => {
  try {
    const dbService = getDatabaseService();
    const syncService = getSyncService();

    const dbStatus = dbService.getStatus();
    const syncStatus = syncService.getStatus();
    const queue = syncService.getQueue();
    const currentType = dbService.getCurrentType();

    res.json({
      success: true,
      data: {
        connection: {
          status: dbStatus.connectionStatus as string,
          type: currentType === DatabaseType.SQLITE ? 'sqlite' : currentType === DatabaseType.POSTGRESQL ? 'postgresql' : 'sqlite',
          isOnline: dbService.isOnline(),
          isOffline: dbService.isOffline()
        },
        sync: {
          ...syncStatus,
          queueItems: queue.length,
          pendingItems: queue.filter(item => !item.synced).length
        },
        databases: {
          sqlite: {
            connected: dbStatus.sqlite.connected,
            path: dbStatus.sqlite.url
          },
          postgresql: {
            connected: dbStatus.postgresql.connected,
            configured: !!dbStatus.postgresql.url
          }
        }
      }
    });
  } catch (error: any) {
    console.error('Get sync status error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get sync status'
    });
  }
};

/**
 * Trigger sync to PostgreSQL
 */
export const syncToPostgreSQL = async (req: Request, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const syncService = getSyncService();
    const dbService = getDatabaseService();

    if (!dbService.isOnline()) {
      res.status(400).json({
        success: false,
        message: 'Cannot sync: Not connected to PostgreSQL'
      });
      return;
    }

    // Start sync in background
    syncService.syncToPostgreSQL().catch(err => {
      console.error('Background sync error:', err);
    });

    res.json({
      success: true,
      message: 'Sync to PostgreSQL started'
    });
  } catch (error: any) {
    console.error('Sync to PostgreSQL error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to start sync'
    });
  }
};

/**
 * Trigger sync to SQLite
 */
export const syncToSQLite = async (req: Request, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const syncService = getSyncService();

    // Start sync in background
    syncService.syncToSQLite().catch(err => {
      console.error('Background sync error:', err);
    });

    res.json({
      success: true,
      message: 'Sync to SQLite started'
    });
  } catch (error: any) {
    console.error('Sync to SQLite error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to start sync'
    });
  }
};

/**
 * Get sync queue
 */
export const getSyncQueue = async (req: Request, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const syncService = getSyncService();
    const queue = syncService.getQueue();

    res.json({
      success: true,
      data: {
        queue,
        total: queue.length,
        pending: queue.filter(item => !item.synced).length,
        synced: queue.filter(item => item.synced).length
      }
    });
  } catch (error: any) {
    console.error('Get sync queue error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get sync queue'
    });
  }
};

/**
 * Clear synced items from queue
 */
export const clearSyncQueue = async (req: Request, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const syncService = getSyncService();
    syncService.clearSyncedItems();

    res.json({
      success: true,
      message: 'Synced items cleared from queue'
    });
  } catch (error: any) {
    console.error('Clear sync queue error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to clear sync queue'
    });
  }
};

/**
 * Check connectivity
 */
export const checkConnectivity = async (req: Request, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const dbService = getDatabaseService();
    const status = await dbService.checkConnectivity();
    const dbStatus = dbService.getStatus();

    res.json({
      success: true,
      data: {
        status,
        isOnline: dbService.isOnline(),
        isOffline: dbService.isOffline(),
        type: dbService.getCurrentType(),
        details: {
          connectionStatus: dbStatus.connectionStatus,
          currentDatabase: dbService.getCurrentType() === DatabaseType.SQLITE ? 'SQLite (Offline)' : 'PostgreSQL (Online)',
          sqlite: {
            connected: dbStatus.sqlite.connected,
            path: dbStatus.sqlite.url?.replace('file:', '') || 'N/A'
          },
          postgresql: {
            connected: dbStatus.postgresql.connected,
            configured: !!dbStatus.postgresql.url,
            url: dbStatus.postgresql.url ? 'SET' : 'NOT SET'
          },
          env: {
            DATABASE_URL: process.env.DATABASE_URL ? (process.env.DATABASE_URL.startsWith('file:') ? 'SQLite' : 'PostgreSQL') : 'NOT SET',
            REMOTE_DATABASE_URL: process.env.REMOTE_DATABASE_URL ? 'SET' : 'NOT SET'
          }
        }
      }
    });
  } catch (error: any) {
    console.error('Check connectivity error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to check connectivity'
    });
  }
};
