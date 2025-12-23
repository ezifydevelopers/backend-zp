import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';
import { hasPermission, RESOURCES, ACTIONS } from '../config/permissions';

// Enhanced role-based authorization middleware
export const requirePermission = (resource: string, action: string) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No user found.'
      });
    }

    const { role, branchId } = req.user;
    const targetBranchId = req.params.branchId || req.body.branchId || req.query.branchId;
    const isOwnData = req.params.userId === req.user.id || req.body.userId === req.user.id;

    // Check if user has permission
    const hasAccess = hasPermission(role, resource, action, branchId, targetBranchId, isOwnData);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Insufficient permissions for ${action} on ${resource}.`,
        required: { resource, action },
        user: { role, branchId }
      });
    }

    // Add permission context to request
    req.permissionContext = {
      resource,
      action,
      userRole: role,
      userBranchId: branchId,
      targetBranchId,
      isOwnData
    };

    return next();
  };
};

// Convenience middleware for common operations
export const requireRead = (resource: string) => requirePermission(resource, ACTIONS.READ);
export const requireCreate = (resource: string) => requirePermission(resource, ACTIONS.CREATE);
export const requireUpdate = (resource: string) => requirePermission(resource, ACTIONS.UPDATE);
export const requireDelete = (resource: string) => requirePermission(resource, ACTIONS.DELETE);
export const requireManage = (resource: string) => requirePermission(resource, ACTIONS.MANAGE);

// Role-specific middleware
export const requireRole = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No user found.'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required roles: ${roles.join(', ')}. Your role: ${req.user.role}`,
        required: roles,
        user: { role: req.user.role }
      });
    }

    return next();
  };
};

// Branch access control
export const requireBranchAccess = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. No user found.'
    });
  }

  const { role, branchId } = req.user;
  const targetBranchId = req.params.branchId || req.body.branchId || req.query.branchId;

  // Super Admin and Product Owner can access all branches
  if (role === 'SUPER_ADMIN' || role === 'PRODUCT_OWNER') {
    return next();
  }

  // Other roles can only access their own branch
  if (targetBranchId && targetBranchId !== branchId) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. You can only access your own branch data.',
      user: { role, branchId },
      target: { branchId: targetBranchId }
    });
  }

  return next();
};

// Data ownership check
export const requireOwnership = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. No user found.'
    });
  }

  const { role, id: userId } = req.user;
  const targetUserId = req.params.userId || req.body.userId;

  // Super Admin and Product Owner can access all data
  if (role === 'SUPER_ADMIN' || role === 'PRODUCT_OWNER') {
    return next();
  }

  // Other roles can only access their own data
  if (targetUserId && targetUserId !== userId) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. You can only access your own data.',
      user: { role, id: userId },
      target: { userId: targetUserId }
    });
  }

  return next();
};

// Permission context interface
export interface PermissionContext {
  resource: string;
  action: string;
  userRole: string;
  userBranchId?: string;
  targetBranchId?: string;
  isOwnData: boolean;
}

// Extend AuthRequest to include permission context
declare global {
  namespace Express {
    interface Request {
      permissionContext?: PermissionContext;
    }
  }
}
