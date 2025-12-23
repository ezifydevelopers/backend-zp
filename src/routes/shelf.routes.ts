import { Router } from 'express';
import {
  getShelves,
  getShelf,
  createShelf,
  updateShelf,
  deleteShelf
} from '../controllers/shelf.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Get shelves (all roles can view)
router.get('/', getShelves);
router.get('/:id', getShelf);

// Shelf management (All roles can manage shelves)
router.post('/', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), createShelf);
router.put('/:id', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), updateShelf);
router.delete('/:id', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), deleteShelf);

export default router;
