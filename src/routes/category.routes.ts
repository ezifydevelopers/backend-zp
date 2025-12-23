import { Router } from 'express';
import {
  getCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory
} from '../controllers/category.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Get categories (all roles can view)
router.get('/', getCategories);
router.get('/:id', getCategory);

// Category management (All roles can manage categories)
router.post('/', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), createCategory);
router.put('/:id', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), updateCategory);
router.delete('/:id', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), deleteCategory);

export default router;
