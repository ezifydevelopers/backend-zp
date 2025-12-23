import { Router } from 'express';
import {
  getAdmins,
  getAdmin,
  createAdmin,
  updateAdmin,
  deleteAdmin,
  getAdminUsers,
  getSuperAdminStats
} from '../controllers/admin.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// SuperAdmin only routes
router.get('/', authorize('SUPERADMIN'), getAdmins);
router.get('/stats', authorize('SUPERADMIN'), getSuperAdminStats);
router.get('/:createdBy/users', authorize('SUPERADMIN'), getAdminUsers);
router.post('/', authorize('SUPERADMIN'), createAdmin);
router.get('/:id', authorize('SUPERADMIN'), getAdmin);
router.put('/:id', authorize('SUPERADMIN'), updateAdmin);
router.delete('/:id', authorize('SUPERADMIN'), deleteAdmin);

export default router;
