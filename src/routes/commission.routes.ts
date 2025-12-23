import express from 'express';
import {
  calculateCommission,
  getCommissions,
  getCommission,
  updateCommission,
  getCommissionStats,
  getEmployeePerformance
} from '../controllers/commission.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = express.Router();

// All commission routes require authentication
router.use(authenticate);

// Commission operations
router.post('/calculate', calculateCommission);
router.get('/', getCommissions);
router.get('/stats', getCommissionStats);
router.get('/performance/:employeeId', getEmployeePerformance);
router.get('/:id', getCommission);
router.put('/:id', updateCommission);

export default router;
