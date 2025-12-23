import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Validation schemas - allow empty strings and null for optional fields
const createManufacturerSchema = Joi.object({
  name: Joi.string().required(),
  description: Joi.string().allow('', null).optional(),
  website: Joi.string().allow('', null).optional(), // Removed URI validation to allow any string
  country: Joi.string().allow('', null).optional(),
  branchId: Joi.string().optional(),
  companyId: Joi.string().optional()
});

const updateManufacturerSchema = Joi.object({
  name: Joi.string(),
  description: Joi.string().allow('', null).optional(),
  website: Joi.string().allow('', null).optional(), // Removed URI validation to allow any string
  country: Joi.string().allow('', null).optional(),
  isActive: Joi.boolean(),
  branchId: Joi.string().optional(),
  companyId: Joi.string().optional()
});

export const getManufacturers = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { page = 1, limit = 50, search = '', active = true } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where: any = {};

    // Get context from headers (set by frontend)
    const selectedCompanyId = req.headers['x-company-id'] as string;
    const selectedBranchId = req.headers['x-branch-id'] as string;

    console.log('🏭 getManufacturers - Full Debug:', {
      role: req.user?.role,
      userId: req.user?.id,
      createdBy: req.user?.createdBy,
      userBranchId: req.user?.branchId,
      headerBranchId: selectedBranchId,
      headerCompanyId: selectedCompanyId,
      allHeaders: JSON.stringify(req.headers)
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
        { country: { contains: search } }
      ];
    }

    const [manufacturers, total] = await Promise.all([
      prisma.manufacturer.findMany({
        where,
        skip,
        take,
        include: {
          _count: {
            select: {
              suppliers: true
            }
          }
        },
        orderBy: { name: 'asc' }
      }),
      prisma.manufacturer.count({ where })
    ]);

    return res.json({
      success: true,
      data: {
        manufacturers,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get manufacturers error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getManufacturer = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    // Build where clause with data isolation
    const where: any = { id };

    // Data isolation based on user role
    if (req.user?.role === 'SUPERADMIN') {
      // SUPERADMIN can see all manufacturers
    } else if (req.user?.role === 'ADMIN') {
      // For ADMIN users, use their own ID as createdBy (self-referencing)
      where.createdBy = req.user.id;
    } else if (req.user?.createdBy) {
      // Other users see manufacturers from their admin
      where.createdBy = req.user.createdBy;
    } else if (req.user?.id) {
      // Fallback to user ID if no createdBy
      where.createdBy = req.user.id;
    } else {
      // No access if no user context
      where.createdBy = 'non-existent-admin-id';
    }

    const manufacturer = await prisma.manufacturer.findFirst({
      where,
      include: {
        _count: {
          select: {
            suppliers: true
          }
        },
        suppliers: {
          select: {
            id: true,
            name: true,
            contactPerson: true,
            phone: true,
            isActive: true
          }
        }
      }
    });

    if (!manufacturer) {
      return res.status(404).json({
        success: false,
        message: 'Manufacturer not found'
      });
    }

    return res.json({
      success: true,
      data: manufacturer
    });
  } catch (error) {
    console.error('Get manufacturer error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const createManufacturer = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { error } = createManufacturerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const { name, description, website, country } = req.body;

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

    // Check if manufacturer with this name already exists in this branch
    const existingManufacturer = await prisma.manufacturer.findFirst({
      where: {
        name: name,
        branchId: branchId
      }
    });

    if (existingManufacturer) {
      return res.status(400).json({
        success: false,
        message: 'Manufacturer with this name already exists in this branch'
      });
    }

    const manufacturer = await prisma.manufacturer.create({
      data: {
        name,
        description: description && description.trim() !== '' ? description.trim() : null,
        website: website && website.trim() !== '' ? website.trim() : null,
        country: country && country.trim() !== '' ? country.trim() : null,
        branchId: branchId,
        companyId: companyId,
        createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
      }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('manufacturer', 'create', manufacturer).catch(err => {
      console.error('[Sync] Manufacturer create sync failed:', err.message);
    });

    return res.status(201).json({
      success: true,
      data: manufacturer
    });
  } catch (error) {
    console.error('Create manufacturer error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateManufacturer = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { error } = updateManufacturerSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const updateData = req.body;

    // Check if manufacturer exists
    const existingManufacturer = await prisma.manufacturer.findFirst({
      where: {
        id,
        createdBy: req.user?.createdBy || req.user?.id
      }
    });

    if (!existingManufacturer) {
      return res.status(404).json({
        success: false,
        message: 'Manufacturer not found'
      });
    }

    // Check if name already exists for this admin (if being updated)
    if (updateData.name && updateData.name !== existingManufacturer.name) {
      const nameExists = await prisma.manufacturer.findFirst({
        where: {
          name: updateData.name,
          createdBy: req.user?.createdBy || req.user?.id
        }
      });

      if (nameExists) {
        return res.status(400).json({
          success: false,
          message: 'Manufacturer with this name already exists in this branch'
        });
      }
    }

    const manufacturer = await prisma.manufacturer.update({
      where: { id },
      data: updateData
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('manufacturer', 'update', manufacturer).catch(err => {
      console.error('[Sync] Manufacturer update sync failed:', err.message);
    });

    return res.json({
      success: true,
      data: manufacturer
    });
  } catch (error) {
    console.error('Update manufacturer error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteManufacturer = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const manufacturer = await prisma.manufacturer.findFirst({
      where: {
        id,
        createdBy: req.user?.createdBy || req.user?.id
      },
      include: {
        _count: {
          select: {
            suppliers: true
          }
        }
      }
    });

    if (!manufacturer) {
      return res.status(404).json({
        success: false,
        message: 'Manufacturer not found'
      });
    }

    // Check if manufacturer has suppliers
    if (manufacturer._count.suppliers > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete manufacturer with existing suppliers'
      });
    }

    await prisma.manufacturer.delete({
      where: { id }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('manufacturer', 'delete', { id }).catch(err => {
      console.error('[Sync] Manufacturer delete sync failed:', err.message);
    });

    return res.json({
      success: true,
      message: 'Manufacturer deleted successfully'
    });
  } catch (error) {
    console.error('Delete manufacturer error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
