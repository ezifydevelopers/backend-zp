import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Validation schemas
const createBranchSchema = Joi.object({
  name: Joi.string().required(),
  address: Joi.string().required(),
  phone: Joi.string().required(),
  email: Joi.string().email().required(),
  companyId: Joi.string().required(),
  managerId: Joi.string().allow(null)
});

const updateBranchSchema = Joi.object({
  name: Joi.string(),
  address: Joi.string(),
  phone: Joi.string(),
  email: Joi.string().email(),
  companyId: Joi.string(),
  managerId: Joi.string().allow(null),
  isActive: Joi.boolean()
});

// Filter branches by user role - ADMIN only sees branches of their companies
export const getBranches = async (req: AuthRequest, res: Response) => {
  try {
    // 🔄 PULL LATEST FROM LIVE DATABASE FIRST
    await Promise.all([
      pullLatestFromLive('branch').catch(err => console.log('[Sync] Pull branches:', err.message)),
      pullLatestFromLive('company').catch(err => console.log('[Sync] Pull companies:', err.message))
    ]);

    const prisma = await getPrisma();
    const { page = 1, limit = 10, search = '' } = req.query;
    const user = req.user;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where: any = {
      isActive: true
    };

    // Apply company context filtering if available (from header or dropdown selection)
    const selectedCompanyId = req.headers['x-company-id'] as string || req.user?.selectedCompanyId;

    if (selectedCompanyId) {
      where.companyId = selectedCompanyId;
      console.log('🏢 Filtering branches by selected company:', selectedCompanyId);
    } else {
      // If no company selected, filter by user role
      if (user?.role === 'SUPERADMIN') {
        // SUPERADMIN can see all branches
        console.log('🏢 SUPERADMIN - showing all branches');
      } else if (user?.role === 'ADMIN') {
        // ADMIN can only see branches of companies they created
        const adminCompanies = await prisma.company.findMany({
          where: { createdBy: user.id, isActive: true },
          select: { id: true }
        });
        const companyIds = adminCompanies.map(c => c.id);

        if (companyIds.length > 0) {
          where.companyId = { in: companyIds };
          console.log('🏢 ADMIN - showing branches of', companyIds.length, 'companies');
        } else {
          where.id = 'no-branches'; // No companies = no branches
        }
      } else if (user?.role === 'MANAGER' || user?.role === 'CASHIER') {
        // MANAGER/CASHIER can only see their assigned branch
        if (user?.branchId) {
          where.id = user.branchId;
          console.log('🏢 MANAGER/CASHIER - showing only their branch:', user.branchId);
        } else {
          where.id = 'no-access';
        }
      } else {
        where.id = 'no-access';
      }
    }

    if (search) {
      where.OR = [
        { name: { contains: search } },
        { address: { contains: search } },
        { phone: { contains: search } },
        { email: { contains: search } }
      ];
    }

    const [branches, total] = await Promise.all([
      prisma.branch.findMany({
        where,
        skip,
        take,
        include: {
          company: {
            select: {
              id: true,
              name: true
            }
          },
          _count: {
            select: {
              users: true,
              products: true,
              customers: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.branch.count({ where })
    ]);

    // Fetch manager info for branches
    // First check managerId, then look for any MANAGER role user assigned to this branch
    const enhancedBranches = await Promise.all(
      branches.map(async (branch: any) => {
        let manager = null;

        // First, try to get manager by managerId if set
        if (branch.managerId) {
          try {
            const managerUser = await prisma.user.findUnique({
              where: { id: branch.managerId },
              select: {
                id: true,
                name: true,
                email: true,
                role: true
              }
            });
            manager = managerUser;
          } catch (err) {
            console.log('Could not find manager with id:', branch.managerId);
          }
        }

        // If no manager found by managerId, look for any user with MANAGER role in this branch
        if (!manager) {
          try {
            console.log(`Looking for MANAGER in branch: ${branch.id} (${branch.name})`);
            const branchManager = await prisma.user.findFirst({
              where: {
                branchId: branch.id,
                role: 'MANAGER'
              },
              select: {
                id: true,
                name: true,
                email: true,
                role: true
              }
            });
            console.log(`Branch ${branch.name} - Manager query result:`, branchManager);
            if (branchManager) {
              manager = branchManager;
              console.log(`✅ Found MANAGER for branch ${branch.name}: ${branchManager.name}`);
            }
          } catch (err) {
            console.log('Error finding branch manager:', err);
          }
        }

        return {
          ...branch,
          manager: manager
        };
      })
    );

    return res.json({
      success: true,
      data: {
        branches: enhancedBranches,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get branches error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getBranch = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const branch = await prisma.branch.findUnique({
      where: { id },
      include: {
        company: {
          select: {
            id: true,
            name: true
          }
        },
        users: {
          select: {
            id: true,
            name: true,
            username: true,
            role: true,
            isActive: true
          }
        },
        _count: {
          select: {
            users: true,
            products: true,
            customers: true,
            sales: true
          }
        }
      }
    });

    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    return res.json({
      success: true,
      data: branch
    });
  } catch (error) {
    console.error('Get branch error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const createBranch = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { error } = createBranchSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const { name, address, phone, email, companyId, managerId } = req.body;

    // Verify that the company exists
    const company = await prisma.company.findUnique({
      where: { id: companyId }
    });

    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }

    // NOTE: Removed access check - any user can create branch in any company

    // Check if branch name already exists for this company
    const existingBranch = await prisma.branch.findFirst({
      where: {
        name: name,
        companyId: companyId
      }
    });

    if (existingBranch) {
      return res.status(400).json({
        success: false,
        message: 'Branch with this name already exists in this company'
      });
    }

    const branch = await prisma.branch.create({
      data: {
        name,
        address,
        phone,
        email,
        companyId,
        managerId,
        createdBy: req.user?.id
      },
      include: {
        company: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('branch', 'create', branch).catch(err => {
      console.error('[Sync] Branch create sync failed:', err.message);
    });

    return res.status(201).json({
      success: true,
      data: branch
    });
  } catch (error) {
    console.error('Create branch error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateBranch = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { error } = updateBranchSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const updateData = req.body;

    // Check if branch exists
    const existingBranch = await prisma.branch.findUnique({
      where: { id }
    });

    if (!existingBranch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    // Check if name already exists for this admin (if being updated)
    if (updateData.name && updateData.name !== existingBranch.name) {
      const nameExists = await prisma.branch.findFirst({
        where: {
          name: updateData.name,
          createdBy: req.user?.createdBy || req.user?.id
        }
      });

      if (nameExists) {
        return res.status(400).json({
          success: false,
          message: 'Branch with this name already exists'
        });
      }
    }

    const branch = await prisma.branch.update({
      where: { id },
      data: updateData
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('branch', 'update', branch).catch(err => {
      console.error('[Sync] Branch update sync failed:', err.message);
    });

    return res.json({
      success: true,
      data: branch
    });
  } catch (error) {
    console.error('Update branch error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteBranch = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const branch = await prisma.branch.findUnique({
      where: { id }
    });

    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    // Soft delete
    const deletedBranch = await prisma.branch.update({
      where: { id },
      data: { isActive: false }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('branch', 'update', deletedBranch).catch(err => {
      console.error('[Sync] Branch delete sync failed:', err.message);
    });

    return res.json({
      success: true,
      message: 'Branch deleted successfully'
    });
  } catch (error) {
    console.error('Delete branch error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
