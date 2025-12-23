import { Router } from 'express';
import { getSettings, updateSettings, getTaxRate } from '../controllers/settings.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Get settings (Admin, SuperAdmin only)
router.get('/', authorize('ADMIN', 'SUPERADMIN'), getSettings);

// Update settings (Admin, SuperAdmin only)
router.put('/', authorize('ADMIN', 'SUPERADMIN'), updateSettings);

// Get tax rate (for sales calculation - all authenticated users)
router.get('/tax-rate', getTaxRate);

export default router;
