import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import {
  getRoles,
  getRolePermissions,
  getUserPermissions,
  checkPermission,
  getAllowedActions,
  updateUserRole
} from '../controllers/role.controller';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Get all available roles (Super Admin and Product Owner only)
router.get('/roles', requireRole('SUPERADMIN', 'PRODUCT_OWNER'), getRoles);

// Get permissions for a specific role (Super Admin and Product Owner only)
router.get('/roles/:role/permissions', requireRole('SUPERADMIN', 'PRODUCT_OWNER'), getRolePermissions);

// Get current user's permissions
router.get('/permissions', getUserPermissions);

// Check if user has specific permission
router.get('/check-permission', checkPermission);

// Get allowed actions for a resource
router.get('/resources/:resource/actions', getAllowedActions);

// Update user role (Super Admin and Product Owner only)
router.put('/users/:userId/role', requireRole('SUPERADMIN', 'PRODUCT_OWNER'), updateUserRole);

export default router;
