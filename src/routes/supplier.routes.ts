import { Router } from 'express';
import {
  getSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  deleteSupplier
} from '../controllers/supplier.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Get suppliers (all roles can view)
router.get('/', getSuppliers);
router.get('/:id', getSupplier);

// Supplier management (All roles can manage suppliers)
router.post('/', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), createSupplier);
router.put('/:id', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), updateSupplier);
router.delete('/:id', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), deleteSupplier);

export default router;
