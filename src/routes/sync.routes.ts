/**
 * Sync Routes - API endpoints for sync operations
 */

import { Router } from 'express';
import {
  getSyncStatus,
  syncToPostgreSQL,
  syncToSQLite,
  getSyncQueue,
  clearSyncQueue,
  checkConnectivity
} from '../controllers/sync.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// All sync routes require authentication
router.use(authenticate);

// Get sync status
router.get('/status', getSyncStatus);

// Check connectivity
router.get('/connectivity', checkConnectivity);

// Sync operations
router.post('/to-postgresql', syncToPostgreSQL);
router.post('/to-sqlite', syncToSQLite);

// Queue management
router.get('/queue', getSyncQueue);
router.delete('/queue', clearSyncQueue);

export default router;
