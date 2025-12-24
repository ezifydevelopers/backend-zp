import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { createSearchConditions } from '../utils/query-helper';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Validation schemas
const createSupplierSchema = Joi.object({
  name: Joi.string().required(),
  contactPerson: Joi.string().required(),
  phone: Joi.string().required(),
  manufacturerId: Joi.string().allow('', null).optional()
});

const updateSupplierSchema = Joi.object({
  name: Joi.string(),
  contactPerson: Joi.string(),
  phone: Joi.string(),
  manufacturerId: Joi.string().allow('', null).optional(),
  isActive: Joi.boolean()
});

export const getSuppliers = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { page = 1, limit = 50, search = '', active = true, manufacturerId = '' } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where: any = {};

    // Get context from headers (set by frontend)
    const selectedCompanyId = req.headers['x-company-id'] as string;
    const selectedBranchId = req.headers['x-branch-id'] as string;

    console.log('📦 getSuppliers - Context:', {
      role: req.user?.role,
      userId: req.user?.id,
      createdBy: req.user?.createdBy,
      branchId: req.user?.branchId,
      selectedCompanyId,
      selectedBranchId
    });

    // Strict branch-level data isolation - Only show suppliers that belong to a specific branch
    // Exclude suppliers with NULL branchId (legacy data)
    where.branchId = { not: null };

    if (req.user?.role === 'SUPERADMIN' || req.user?.role === 'ADMIN') {
      // SUPERADMIN/ADMIN: Must select a branch to see data
      if (selectedBranchId) {
        where.branchId = selectedBranchId;
      } else if (selectedCompanyId) {
        // Show suppliers from branches under the company
        where.branch = { companyId: selectedCompanyId };
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

    // Filter suppliers by manufacturer if manufacturerId is provided
    if (manufacturerId) {
      where.manufacturerId = manufacturerId;
    }

    if (search) {
      const searchConditions = createSearchConditions(
        ['name', 'contactPerson', 'phone', 'email', 'address'],
        search as string
      );
      if (searchConditions.OR) {
        where.OR = searchConditions.OR;
      }
    }

    const [suppliers, total] = await Promise.all([
      prisma.supplier.findMany({
        where,
        skip,
        take,
        include: {
          manufacturer: {
            select: {
              id: true,
              name: true,
              country: true
            }
          },
          _count: {
            select: {
              products: true
            }
          }
        },
        orderBy: { name: 'asc' }
      }),
      prisma.supplier.count({ where })
    ]);

    return res.json({
      success: true,
      data: {
        suppliers,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get suppliers error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getSupplier = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    // Build where clause with data isolation
    const where: any = { id };

    // Data isolation based on user role
    if (req.user?.role === 'SUPERADMIN') {
      // SUPERADMIN can see all suppliers
    } else if (req.user?.role === 'ADMIN') {
      // For ADMIN users, use their own ID as createdBy (self-referencing)
      where.createdBy = req.user.id;
    } else if (req.user?.createdBy) {
      // Other users see suppliers from their admin
      where.createdBy = req.user.createdBy;
    } else if (req.user?.id) {
      // Fallback to user ID if no createdBy
      where.createdBy = req.user.id;
    } else {
      // No access if no user context
      where.createdBy = 'non-existent-admin-id';
    }

    const supplier = await prisma.supplier.findFirst({
      where,
      include: {
        manufacturer: {
          select: {
            id: true,
            name: true,
            country: true
          }
        },
        _count: {
          select: {
            products: true
          }
        }
      }
    });

    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    return res.json({
      success: true,
      data: supplier
    });
  } catch (error) {
    console.error('Get supplier error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const createSupplier = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    console.log('🔍 Create supplier request body:', req.body);
    const { error } = createSupplierSchema.validate(req.body);
    if (error) {
      console.log('🔍 Validation error:', error.details);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const { name, contactPerson, phone, manufacturerId } = req.body;

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

    // Check if supplier with this name already exists in this branch
    const existingSupplier = await prisma.supplier.findFirst({
      where: {
        name: name,
        branchId: branchId
      }
    });

    if (existingSupplier) {
      return res.status(400).json({
        success: false,
        message: 'Supplier with this name already exists in this branch'
      });
    }

    const supplier = await prisma.supplier.create({
      data: {
        name,
        contactPerson,
        phone,
        manufacturerId: manufacturerId && manufacturerId.trim() !== '' ? manufacturerId : null,
        branchId: branchId,
        companyId: companyId,
        createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
      }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('supplier', 'create', supplier).catch(err => {
      console.error('[Sync] Supplier create sync failed:', err.message);
    });

    return res.status(201).json({
      success: true,
      data: supplier
    });
  } catch (error) {
    console.error('Create supplier error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateSupplier = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    console.log('🔍 Update supplier request body:', req.body);
    const { error } = updateSupplierSchema.validate(req.body);

    if (error) {
      console.log('🔍 Update validation error:', error.details);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const updateData = { ...req.body };

    // Handle empty manufacturerId
    if (updateData.manufacturerId && updateData.manufacturerId.trim() === '') {
      updateData.manufacturerId = null;
    }

    // Build where clause with data isolation
    const where: any = { id };

    // Data isolation based on user role
    if (req.user?.role === 'SUPERADMIN') {
      // SUPERADMIN can see all suppliers
    } else if (req.user?.role === 'ADMIN') {
      // For ADMIN users, use their own ID as createdBy (self-referencing)
      where.createdBy = req.user.id;
    } else if (req.user?.createdBy) {
      // Other users see suppliers from their admin
      where.createdBy = req.user.createdBy;
    } else if (req.user?.id) {
      // Fallback to user ID if no createdBy
      where.createdBy = req.user.id;
    } else {
      // No access if no user context
      where.createdBy = 'non-existent-admin-id';
    }

    // Check if supplier exists
    const existingSupplier = await prisma.supplier.findFirst({
      where
    });

    if (!existingSupplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    // Note: Suppliers are shared across all branches under the same admin
    // No need to check for duplicates as suppliers can have the same name across different contexts

    const supplier = await prisma.supplier.update({
      where: { id },
      data: updateData
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('supplier', 'update', supplier).catch(err => {
      console.error('[Sync] Supplier update sync failed:', err.message);
    });

    return res.json({
      success: true,
      data: supplier
    });
  } catch (error) {
    console.error('Update supplier error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteSupplier = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    console.log('🔍 Delete supplier ID:', id);

    // Build where clause with data isolation
    const where: any = { id };

    // Data isolation based on user role
    if (req.user?.role === 'SUPERADMIN') {
      // SUPERADMIN can see all suppliers
    } else if (req.user?.role === 'ADMIN') {
      // For ADMIN users, use their own ID as createdBy (self-referencing)
      where.createdBy = req.user.id;
    } else if (req.user?.createdBy) {
      // Other users see suppliers from their admin
      where.createdBy = req.user.createdBy;
    } else if (req.user?.id) {
      // Fallback to user ID if no createdBy
      where.createdBy = req.user.id;
    } else {
      // No access if no user context
      where.createdBy = 'non-existent-admin-id';
    }

    const supplier = await prisma.supplier.findFirst({
      where,
      include: {
        _count: {
          select: {
            products: true
          }
        }
      }
    });

    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    // Check if supplier has products
    if (supplier._count.products > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete supplier with existing products'
      });
    }

    await prisma.supplier.delete({
      where: { id }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('supplier', 'delete', { id }).catch(err => {
      console.error('[Sync] Supplier delete sync failed:', err.message);
    });

    return res.json({
      success: true,
      message: 'Supplier deleted successfully'
    });
  } catch (error) {
    console.error('Delete supplier error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
