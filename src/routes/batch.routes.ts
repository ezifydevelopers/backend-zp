import { Router } from 'express';
import {
  getBatches,
  getBatchById,
  createBatch,
  updateBatch,
  deleteBatch,
  getNearExpiryBatches,
  restockBatch,
  getLowStockBatches
} from '../controllers/batch.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Batch routes
router.get('/', getBatches);
router.get('/low-stock', getLowStockBatches);
router.get('/near-expiry', getNearExpiryBatches);
router.get('/:id', getBatchById);
router.post('/', createBatch);
router.put('/:id', updateBatch);
router.post('/:id/restock', restockBatch);
router.delete('/:id', deleteBatch);

export default router;
