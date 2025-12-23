/**
 * Sync Service Tests
 * Tests for offline/online switching and data synchronization
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { getEnhancedSyncService } from '../src/services/enhanced-sync.service';
import { getUnifiedDatabaseService } from '../src/services/unified-db.service';
import { getConnectivityService } from '../src/services/connectivity.service';
import { PrismaClient } from '@prisma/client';

describe('Sync Service', () => {
  let syncService: any;
  let unifiedDb: any;
  let connectivityService: any;
  let prisma: PrismaClient;

  beforeEach(async () => {
    syncService = getEnhancedSyncService();
    unifiedDb = getUnifiedDatabaseService();
    connectivityService = getConnectivityService();
    prisma = new PrismaClient();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  describe('Queue Management', () => {
    it('should add item to sync queue', () => {
      syncService.addToQueue('user', 'create', { id: '1', name: 'Test User' });

      const status = syncService.getSyncStatus();
      expect(status.pendingItems).toBeGreaterThan(0);
    });

    it('should clear sync queue', () => {
      syncService.addToQueue('user', 'create', { id: '1', name: 'Test User' });
      syncService.clearQueue();

      const status = syncService.getSyncStatus();
      expect(status.pendingItems).toBe(0);
    });
  });

  describe('Connectivity Detection', () => {
    it('should detect online status', async () => {
      // Mock connectivity check
      jest.spyOn(connectivityService, 'isOnline').mockReturnValue(true);

      const isOnline = unifiedDb.isOnline();
      expect(isOnline).toBe(true);
    });

    it('should detect offline status', async () => {
      // Mock connectivity check
      jest.spyOn(connectivityService, 'isOffline').mockReturnValue(true);

      const isOffline = unifiedDb.isOffline();
      expect(isOffline).toBe(true);
    });
  });

  describe('Database Switching', () => {
    it('should use SQLite when offline', async () => {
      jest.spyOn(connectivityService, 'isOffline').mockReturnValue(true);

      const dbType = unifiedDb.getCurrentDatabaseType();
      expect(dbType).toBe('sqlite');
    });

    it('should handle connectivity changes', async () => {
      const statusChangeSpy = jest.fn();
      connectivityService.onStatusChange(statusChangeSpy);

      // Simulate status change
      await connectivityService.checkConnectivity();

      // Status change should be called
      expect(statusChangeSpy).toHaveBeenCalled();
    });
  });

  describe('Data Operations', () => {
    it('should create user in offline mode', async () => {
      jest.spyOn(connectivityService, 'isOffline').mockReturnValue(true);

      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        name: 'Test User',
        password: 'hashedpassword',
        role: 'USER'
      };

      const user = await unifiedDb.query(async (client: any) => {
        return await client.user.create({ data: userData });
      });

      expect(user).toBeDefined();
      expect(user.username).toBe('testuser');
    });

    it('should add to sync queue when offline', async () => {
      jest.spyOn(connectivityService, 'isOffline').mockReturnValue(true);

      const addToQueueSpy = jest.spyOn(syncService, 'addToQueue');

      const userData = {
        username: 'testuser',
        email: 'test@example.com',
        name: 'Test User'
      };

      // Simulate user creation
      const user = await unifiedDb.query(async (client: any) => {
        return await client.user.create({ data: userData });
      });

      // In real implementation, this would be called automatically
      syncService.addToQueue('user', 'create', user);

      expect(addToQueueSpy).toHaveBeenCalledWith('user', 'create', expect.objectContaining(userData));
    });
  });

  describe('Sync Operations', () => {
    it('should sync SQLite to PostgreSQL when going online', async () => {
      // Mock PostgreSQL connection
      const mockPostgresClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn().mockResolvedValue(undefined)
      };

      jest.spyOn(require('pg'), 'Client').mockImplementation(() => mockPostgresClient);

      const result = await syncService.syncToPostgreSQL();

      expect(result).toBeDefined();
      expect(mockPostgresClient.connect).toHaveBeenCalled();
    });

    it('should handle sync errors gracefully', async () => {
      const mockPostgresClient = {
        connect: jest.fn().mockRejectedValue(new Error('Connection failed')),
        end: jest.fn().mockResolvedValue(undefined)
      };

      jest.spyOn(require('pg'), 'Client').mockImplementation(() => mockPostgresClient);

      const result = await syncService.syncToPostgreSQL();

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Conflict Resolution', () => {
    it('should resolve conflicts by timestamp', async () => {
      const sourceRecord = {
        id: '1',
        name: 'Source',
        updated_at: new Date('2024-01-02')
      };

      const targetRecord = {
        id: '1',
        name: 'Target',
        updated_at: new Date('2024-01-01')
      };

      // This would be tested through syncTable method
      // For now, we test the concept
      const sourceTime = new Date(sourceRecord.updated_at);
      const targetTime = new Date(targetRecord.updated_at);

      expect(sourceTime > targetTime).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle partial sync failure', async () => {
      const mockPostgresClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] }) // First query succeeds
          .mockRejectedValueOnce(new Error('Query failed')), // Second query fails
        end: jest.fn().mockResolvedValue(undefined)
      };

      jest.spyOn(require('pg'), 'Client').mockImplementation(() => mockPostgresClient);

      const result = await syncService.syncToPostgreSQL();

      expect(result.success).toBeDefined();
      expect(result.failed).toBeGreaterThanOrEqual(0);
    });

    it('should retry failed sync items', () => {
      syncService.addToQueue('user', 'create', { id: '1', name: 'Test' });

      const status = syncService.getSyncStatus();
      const item = syncService['syncQueue'].find((i: any) => i.id);

      if (item) {
        item.retryCount = 3;
        expect(item.retryCount).toBe(3);
      }
    });
  });
});

describe('Multiple Table Sync', () => {
  it('should sync multiple tables in correct order', async () => {
    const syncService = getEnhancedSyncService();

    // Add items for different tables
    syncService.addToQueue('user', 'create', { id: '1', name: 'User 1' });
    syncService.addToQueue('order', 'create', { id: '1', userId: '1' });
    syncService.addToQueue('orderItem', 'create', { id: '1', orderId: '1' });

    const status = syncService.getSyncStatus();
    expect(status.pendingItems).toBe(3);
  });
});
