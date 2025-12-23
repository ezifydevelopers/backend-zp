import { Router } from 'express';
import {
  getManufacturers,
  getManufacturer,
  createManufacturer,
  updateManufacturer,
  deleteManufacturer
} from '../controllers/manufacturer.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Get manufacturers (all roles can view)
router.get('/', getManufacturers);
router.get('/:id', getManufacturer);

// Manufacturer management (All roles can manage manufacturers)
router.post('/', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), createManufacturer);
router.put('/:id', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), updateManufacturer);
router.delete('/:id', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), deleteManufacturer);

export default router;
