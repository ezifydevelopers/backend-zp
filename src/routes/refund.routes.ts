import { Router } from 'express';
import { createRefund, getRefunds, getRefundById } from '../controllers/refund.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';

const router = Router();

// All refund routes require authentication
router.use(authenticate);

// Create refund - requires appropriate permissions
router.post('/', requireRole('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER'), createRefund);

// Get all refunds - requires read permissions
router.get('/', requireRole('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER'), getRefunds);

// Get refund by ID - requires read permissions
router.get('/:id', requireRole('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER'), getRefundById);

export default router;
