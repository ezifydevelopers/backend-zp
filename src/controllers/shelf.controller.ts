import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Validation schemas
const createShelfSchema = Joi.object({
  name: Joi.string().required(),
  description: Joi.string().allow(''),
  location: Joi.string().allow(''),
  branchId: Joi.string().optional(),
  companyId: Joi.string().optional()
});

const updateShelfSchema = Joi.object({
  name: Joi.string(),
  description: Joi.string().allow(''),
  location: Joi.string().allow(''),
  isActive: Joi.boolean(),
  branchId: Joi.string().optional(),
  companyId: Joi.string().optional()
});

export const getShelves = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { page = 1, limit = 50, search = '', active = true } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where: any = {};

    // Get context from headers (set by frontend)
    const selectedCompanyId = req.headers['x-company-id'] as string;
    const selectedBranchId = req.headers['x-branch-id'] as string;

    console.log('🗄️ getShelves - Context:', {
      role: req.user?.role,
      userId: req.user?.id,
      createdBy: req.user?.createdBy,
      branchId: req.user?.branchId,
      selectedCompanyId,
      selectedBranchId
    });

    // Strict branch-level data isolation
    if (req.user?.role === 'SUPERADMIN' || req.user?.role === 'ADMIN') {
      // SUPERADMIN/ADMIN: Must select a branch to see data
      if (selectedBranchId) {
        where.branchId = selectedBranchId;
      } else if (selectedCompanyId) {
        // Show all branches under the company
        where.companyId = selectedCompanyId;
      } else {
        // No branch selected - show empty (force branch selection)
        where.branchId = 'must-select-branch';
      }
    } else if (req.user?.role === 'MANAGER' || req.user?.role === 'CASHIER') {
      // MANAGER/CASHIER: Only see data from their assigned branch
      if (req.user?.branchId) {
        where.branchId = req.user.branchId;
      } else {
        where.branchId = 'non-existent-branch-id'; // No access
      }
    } else {
      // No access if no user context
      where.branchId = 'non-existent-branch-id';
    }

    if (active === 'true') {
      where.isActive = true;
    }

    if (search) {
      where.OR = [
        { name: { contains: search } },
        { description: { contains: search } },
        { location: { contains: search } }
      ];
    }

    const [shelves, total] = await Promise.all([
      prisma.shelf.findMany({
        where,
        skip,
        take,
        include: {
          _count: {
            select: {
              batches: true
            }
          }
        },
        orderBy: { name: 'asc' }
      }),
      prisma.shelf.count({ where })
    ]);

    return res.json({
      success: true,
      data: {
        shelves,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get shelves error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getShelf = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    // Build where clause with data isolation
    const where: any = { id };

    // Data isolation based on user role
    if (req.user?.role === 'SUPERADMIN') {
      // SUPERADMIN can see all shelves
    } else if (req.user?.role === 'ADMIN') {
      // For ADMIN users, use their own ID as createdBy (self-referencing)
      where.createdBy = req.user.id;
    } else if (req.user?.createdBy) {
      // Other users see shelves from their admin
      where.createdBy = req.user.createdBy;
    } else if (req.user?.id) {
      // Fallback to user ID if no createdBy
      where.createdBy = req.user.id;
    } else {
      // No access if no user context
      where.createdBy = 'non-existent-admin-id';
    }

    const shelf = await prisma.shelf.findFirst({
      where,
      include: {
        _count: {
          select: {
            batches: true
          }
        },
        batches: {
          select: {
            id: true,
            batchNo: true,
            product: {
              select: {
                id: true,
                name: true,
                sku: true
              }
            },
            quantity: true,
            expireDate: true,
            isActive: true
          }
        }
      }
    });

    if (!shelf) {
      return res.status(404).json({
        success: false,
        message: 'Shelf not found'
      });
    }

    return res.json({
      success: true,
      data: shelf
    });
  } catch (error) {
    console.error('Get shelf error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const createShelf = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { error } = createShelfSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const { name, description, location } = req.body;

    // Get context from headers
    const selectedCompanyId = req.headers['x-company-id'] as string;
    const selectedBranchId = req.headers['x-branch-id'] as string;

    // Determine branchId and companyId
    let branchId = selectedBranchId || req.user?.branchId;
    let companyId = selectedCompanyId || req.user?.companyId;

    // If branchId is provided but no companyId, get companyId from branch
    if (branchId && !companyId) {
      const branch = await prisma.branch.findUnique({
        where: { id: branchId },
        select: { companyId: true }
      });
      companyId = branch?.companyId || undefined;
    }

    if (!branchId) {
      return res.status(400).json({
        success: false,
        message: 'Branch is required. Please select a branch first.'
      });
    }

    // Check if shelf with this name already exists in this branch
    const existingShelf = await prisma.shelf.findFirst({
      where: {
        name: name,
        branchId: branchId
      }
    });

    if (existingShelf) {
      return res.status(400).json({
        success: false,
        message: 'Shelf with this name already exists in this branch'
      });
    }

    const shelf = await prisma.shelf.create({
      data: {
        name,
        description: description || null,
        location: location || null,
        branchId: branchId,
        companyId: companyId,
        createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
      }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('shelf', 'create', shelf).catch(err => {
      console.error('[Sync] Shelf create sync failed:', err.message);
    });

    return res.status(201).json({
      success: true,
      data: shelf
    });
  } catch (error) {
    console.error('Create shelf error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateShelf = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { error } = updateShelfSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const updateData = req.body;

    // Check if shelf exists
    const existingShelf = await prisma.shelf.findFirst({
      where: {
        id,
        createdBy: req.user?.createdBy || req.user?.id
      }
    });

    if (!existingShelf) {
      return res.status(404).json({
        success: false,
        message: 'Shelf not found'
      });
    }

    // Check if name already exists for this admin (if being updated)
    if (updateData.name && updateData.name !== existingShelf.name) {
      const nameExists = await prisma.shelf.findFirst({
        where: {
          name: updateData.name,
          createdBy: req.user?.createdBy || req.user?.id
        }
      });

      if (nameExists) {
        return res.status(400).json({
          success: false,
          message: 'Shelf with this name already exists in this branch'
        });
      }
    }

    const shelf = await prisma.shelf.update({
      where: { id },
      data: updateData
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('shelf', 'update', shelf).catch(err => {
      console.error('[Sync] Shelf update sync failed:', err.message);
    });

    return res.json({
      success: true,
      data: shelf
    });
  } catch (error) {
    console.error('Update shelf error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteShelf = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const shelf = await prisma.shelf.findFirst({
      where: {
        id,
        createdBy: req.user?.createdBy || req.user?.id
      },
      include: {
        _count: {
          select: {
            batches: true
          }
        }
      }
    });

    if (!shelf) {
      return res.status(404).json({
        success: false,
        message: 'Shelf not found'
      });
    }

    // Check if shelf has batches
    if (shelf._count.batches > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete shelf with existing batches'
      });
    }

    await prisma.shelf.delete({
      where: { id }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('shelf', 'delete', { id }).catch(err => {
      console.error('[Sync] Shelf delete sync failed:', err.message);
    });

    return res.json({
      success: true,
      message: 'Shelf deleted successfully'
    });
  } catch (error) {
    console.error('Delete shelf error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
