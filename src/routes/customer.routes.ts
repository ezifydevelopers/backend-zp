import { Router } from 'express';
import {
  getCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerPurchaseHistory
} from '../controllers/customer.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Get customers (all roles can view)
router.get('/', getCustomers);
router.get('/:id', getCustomer);
router.get('/:id/purchase-history', getCustomerPurchaseHistory);

// Customer management (Manager, Admin, SuperAdmin, Cashier)
router.post('/', authorize('MANAGER', 'ADMIN', 'SUPERADMIN', 'CASHIER'), createCustomer);
router.put('/:id', authorize('MANAGER', 'ADMIN', 'SUPERADMIN'), updateCustomer);
router.delete('/:id', authorize('MANAGER', 'ADMIN', 'SUPERADMIN'), deleteCustomer);

export default router;
