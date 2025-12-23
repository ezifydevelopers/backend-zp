import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { ROLE_PERMISSIONS, getRolePermissions as getRolePermissionsConfig, getAccessibleResources as getAccessibleResourcesConfig, getAllowedActions as getAllowedActionsConfig, hasPermission } from '../config/permissions';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';

// Get all available roles and their permissions
export const getRoles = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    // Only Super Admin and Product Owner can view all roles
    if (!['SUPER_ADMIN', 'PRODUCT_OWNER'].includes(req.user.role)) {
      res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.'
      });
      return;
    }

    res.json({
      success: true,
      data: ROLE_PERMISSIONS
    });
  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get permissions for a specific role
export const getRolePermissions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    const { role } = req.params;

    // Only Super Admin and Product Owner can view role permissions
    if (!['SUPER_ADMIN', 'PRODUCT_OWNER'].includes(req.user.role)) {
      res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.'
      });
      return;
    }

    const permissions = getRolePermissionsConfig(role);
    const accessibleResources = getAccessibleResourcesConfig(role);

    res.json({
      success: true,
      data: {
        role,
        permissions,
        accessibleResources
      }
    });
  } catch (error) {
    console.error('Get role permissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get user's current permissions
export const getUserPermissions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    const { role, branchId } = req.user;
    const permissions = getRolePermissionsConfig(role);
    const accessibleResources = getAccessibleResourcesConfig(role);

    res.json({
      success: true,
      data: {
        user: {
          role,
          branchId
        },
        permissions,
        accessibleResources
      }
    });
  } catch (error) {
    console.error('Get user permissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Check if user has specific permission
export const checkPermission = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    const { resource, action } = req.query;
    const { role, branchId } = req.user;
    const targetBranchId = req.query.targetBranchId as string;
    const isOwnData = req.query.isOwnData === 'true';

    if (!resource || !action) {
      res.status(400).json({
        success: false,
        message: 'Resource and action parameters are required'
      });
      return;
    }

    const hasAccess = hasPermission(role, resource as string, action as string, branchId, targetBranchId, isOwnData);

    res.json({
      success: true,
      data: {
        hasAccess,
        user: { role, branchId },
        permission: { resource, action, targetBranchId, isOwnData }
      }
    });
  } catch (error) {
    console.error('Check permission error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get allowed actions for a resource
export const getAllowedActions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    const { resource } = req.params;
    const { role } = req.user;

    const allowedActions = getAllowedActionsConfig(role, resource);

    res.json({
      success: true,
      data: {
        resource,
        userRole: role,
        allowedActions
      }
    });
  } catch (error) {
    console.error('Get allowed actions error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Update user role (only for Super Admin and Product Owner)
export const updateUserRole = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    // Only Super Admin and Product Owner can update user roles
    if (!['SUPER_ADMIN', 'PRODUCT_OWNER'].includes(req.user.role)) {
      res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.'
      });
      return;
    }

    const { userId } = req.params;
    const { role } = req.body;

    if (!['PRODUCT_OWNER', 'SUPER_ADMIN', 'MANAGER', 'PHARMACIST', 'CASHIER'].includes(role)) {
      res.status(400).json({
        success: false,
        message: 'Invalid role. Must be one of: PRODUCT_OWNER, SUPER_ADMIN, MANAGER, PHARMACIST, CASHIER'
      });
      return;
    }

    // Update user role
    const prisma = await getPrisma();
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { role },
      select: {
        id: true,
        username: true,
        name: true,
        role: true,
        branchId: true,
        isActive: true
      }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('user', 'update', updatedUser).catch(err => {
      console.error('[Sync] User role update sync failed:', err.message);
    });

    res.json({
      success: true,
      data: updatedUser,
      message: 'User role updated successfully'
    });
  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
