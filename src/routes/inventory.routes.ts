import { Router } from 'express';
import {
  getInventorySummary,
  getInventoryByBatches,
  getInventoryReports
} from '../controllers/inventory.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Inventory routes
router.get('/summary', getInventorySummary);
router.get('/batches', getInventoryByBatches);
router.get('/reports', getInventoryReports);

export default router;
