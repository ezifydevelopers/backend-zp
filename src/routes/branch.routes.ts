import { Router } from 'express';
import {
  getBranches,
  getBranch,
  createBranch,
  updateBranch,
  deleteBranch
} from '../controllers/branch.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Get branches (now protected)
router.get('/', getBranches);
router.get('/:id', getBranch);

// Branch management (Admin, SuperAdmin only)
router.post('/', authorize('ADMIN', 'SUPERADMIN'), createBranch);
router.put('/:id', authorize('ADMIN', 'SUPERADMIN'), updateBranch);
router.delete('/:id', authorize('ADMIN', 'SUPERADMIN'), deleteBranch);

export default router;
