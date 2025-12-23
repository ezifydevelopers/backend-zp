import { Request, Response } from 'express';
import Joi from 'joi';
import { getPrisma } from '../utils/db.util';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';

// Validation schemas
const createCompanySchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  description: Joi.string().max(500).optional(),
  address: Joi.string().max(200).optional(),
  phone: Joi.string().max(20).optional(),
  email: Joi.string().email().optional()
});

const updateCompanySchema = Joi.object({
  name: Joi.string().min(2).max(100).optional(),
  description: Joi.string().max(500).optional(),
  address: Joi.string().max(200).optional(),
  phone: Joi.string().max(20).optional(),
  email: Joi.string().email().optional(),
  businessType: Joi.string().valid('PHARMACY', 'STORE', 'HOTEL', 'CLINIC').optional()
});

// Get all companies for the authenticated user
// Filter by user role - ADMIN only sees their own companies
export const getCompanies = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const user = req.user;

    // 🔄 PULL LATEST FROM LIVE DATABASE FIRST (only if using SQLite mode)
    // If already using PostgreSQL (USE_POSTGRESQL=true), no pull needed - data is already there!
    const isPostgreSQLMode = process.env.USE_POSTGRESQL === 'true';
    if (!isPostgreSQLMode) {
      // Only pull if using SQLite (Electron mode)
      await Promise.all([
        pullLatestFromLive('company').catch(err => console.log('[Sync] Pull companies:', err.message)),
        pullLatestFromLive('branch').catch(err => console.log('[Sync] Pull branches:', err.message))
      ]);
    } else {
      console.log('[Sync] ⏭️  PostgreSQL mode - No pull needed (data already in PostgreSQL)');
    }

    // Build where clause based on user role
    // Normalize role to uppercase for comparison
    const userRole = user?.role ? String(user.role).toUpperCase() : '';
    const where: any = { isActive: true };

    if (!user) {
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    if (userRole === 'SUPERADMIN') {
      // SUPERADMIN can see all companies
      console.log('🏢 SUPERADMIN - showing all companies');
    } else if (userRole === 'ADMIN') {
      // ADMIN can only see companies they created
      where.createdBy = user.id;
      console.log('🏢 ADMIN - showing companies created by:', user.id);
    } else if (userRole === 'MANAGER' || userRole === 'CASHIER') {
      // MANAGER/CASHIER can only see their branch's company
      if (user.branchId) {
        // Get the company through their branch
        const userBranch = await prisma.branch.findUnique({
          where: { id: user.branchId },
          select: { companyId: true }
        });
        if (userBranch?.companyId) {
          where.id = userBranch.companyId;
          console.log('🏢 MANAGER/CASHIER - showing company:', userBranch.companyId);
        } else {
          // No company access
          where.id = 'no-access';
        }
      } else {
        // No branch assigned - no access
        where.id = 'no-access';
      }
    } else {
      // Unknown role - no access
      where.id = 'no-access';
    }

    const companies = await prisma.company.findMany({
        where,
        include: {
          branches: {
            where: { isActive: true },
            select: {
              id: true,
              name: true,
              phone: true,
            }
          },
          _count: {
            select: {
              users: true,
              employees: true,
              products: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      });

    console.log(`🏢 Returning ${companies.length} companies for user ${user?.id} (${user?.role})`);
    console.log(`🔍 Query where clause:`, JSON.stringify(where, null, 2));
    console.log(`🔍 Found companies:`, companies.map(c => ({ id: c.id, name: c.name, createdBy: c.createdBy })));

    res.json({
      success: true,
      data: companies
    });
  } catch (error) {
    console.error('Get companies error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get a single company by ID
// NOTE: Removed access check - all users can view any company
export const getCompany = async (req: Request, res: Response): Promise<void> => {
  try {
    // 🔄 PULL LATEST FROM LIVE DATABASE FIRST (company and related branches)
    await Promise.all([
      pullLatestFromLive('company').catch(err => console.log('[Sync] Pull company:', err.message)),
      pullLatestFromLive('branch').catch(err => console.log('[Sync] Pull branches:', err.message))
    ]);

    const prisma = await getPrisma();
    const { id } = req.params;

    const company = await prisma.company.findUnique({
      where: { id },
      include: {
        branches: {
          where: { isActive: true },
          include: {
            _count: {
              select: {
                users: true,
                employees: true,
                products: true
              }
            }
          }
        },
        _count: {
          select: {
            users: true,
            employees: true,
            products: true
          }
        }
      }
    });

    if (!company) {
      res.status(404).json({
        success: false,
        message: 'Company not found'
      });
      return;
    }

    res.json({
      success: true,
      data: company
    });
  } catch (error) {
    console.error('Get company error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Create a new company
export const createCompany = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    console.log('🔍 Create company request body:', JSON.stringify(req.body, null, 2));
    console.log('🔍 Create company - User:', req.user?.id, 'Role:', req.user?.role);

    // Check if user is authenticated
    if (!req.user || !req.user.id) {
      console.log('❌ Unauthenticated request');
      res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
      return;
    }

    // Normalize empty strings to undefined for optional fields
    const normalizedBody = {
      ...req.body,
      description: req.body.description?.trim() || undefined,
      address: req.body.address?.trim() || undefined,
      phone: req.body.phone?.trim() || undefined,
      email: req.body.email?.trim() || undefined,
    };

    const { error } = createCompanySchema.validate(normalizedBody);
    if (error) {
      console.log('❌ Validation error details:', error.details);
      console.log('❌ Validation errors:', error.details.map(detail => detail.message));
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
      return;
    }

    const userId = req.user.id;
    const { name, description, address, phone, email } = normalizedBody;

    console.log('🔍 Creating company with userId:', userId);

    // Check if company name already exists
    const existingCompany = await prisma.company.findUnique({
      where: { name }
    });

    if (existingCompany) {
      res.status(400).json({
        success: false,
        message: 'Company with this name already exists'
      });
      return;
    }

    console.log('🔍 Creating company with data:', {
      name,
      description,
      address,
      phone,
      email,
      createdBy: userId
    });

    // Log database connection info
    const dbUrl = process.env.DATABASE_URL || 'NOT SET';
    const dbMode = process.env.USE_POSTGRESQL === 'true' ? 'PostgreSQL' : 'SQLite';
    console.log('🔍 Database Info:', {
      mode: dbMode,
      url: dbUrl.replace(/:[^:@]+@/, ':****@'), // Hide password
      userId: userId
    });

    const company = await prisma.company.create({
      data: {
        name,
        description,
        address,
        phone,
        email,
        createdBy: userId,
        isActive: true
      },
      include: {
        branches: true,
        _count: {
          select: {
            users: true,
            employees: true,
            products: true
          }
        }
      }
    });

    console.log('✅ Company created successfully:', {
      id: company.id,
      name: company.name,
      createdBy: company.createdBy
    });

    // Verify company was created in the correct database
    const verifyCompany = await prisma.company.findUnique({
      where: { id: company.id },
      select: { id: true, name: true, createdAt: true }
    });
    console.log('✅ Verified company in database:', verifyCompany);
    console.log('🔍 Database URL used:', process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':****@'));

    // 🔄 SYNC TO POSTGRESQL (only if using SQLite mode)
    // If already using PostgreSQL (USE_POSTGRESQL=true), no sync needed - data is already there!
    const isPostgreSQLMode = process.env.USE_POSTGRESQL === 'true';
    if (!isPostgreSQLMode) {
      // Only sync if using SQLite (Electron mode)
      try {
        await syncAfterOperation('company', 'create', company);
        console.log('[Sync] ✅ Company create synced to PostgreSQL');
      } catch (err: any) {
        console.error('[Sync] Company create sync failed:', err.message);
        // Don't fail the request if sync fails
      }
    } else {
      console.log('[Sync] ⏭️  PostgreSQL mode - No sync needed (data already in PostgreSQL)');
    }

    res.status(201).json({
      success: true,
      data: company,
      message: 'Company created successfully'
    });
  } catch (error: any) {
    console.error('❌ Create company error:', error);
    console.error('❌ Error details:', {
      message: error.message,
      code: error.code,
      meta: error.meta
    });

    // Handle Prisma unique constraint errors
    if (error.code === 'P2002') {
      res.status(400).json({
        success: false,
        message: 'Company with this name already exists'
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

// Update a company
export const updateCompany = async (req: Request, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const { error } = updateCompanySchema.validate(req.body);
    if (error) {
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
      return;
    }

    const { id } = req.params;
    const { name, description, address, phone, email, businessType } = req.body;

    // Check if company exists
    const existingCompany = await prisma.company.findUnique({
      where: { id }
    });

    if (!existingCompany) {
      res.status(404).json({
        success: false,
        message: 'Company not found'
      });
      return;
    }

    // NOTE: Removed access check - any user can update any company

    // Check if new name conflicts with existing company
    if (name && name !== existingCompany.name) {
      const nameConflict = await prisma.company.findUnique({
        where: { name }
      });

      if (nameConflict) {
        res.status(400).json({
          success: false,
          message: 'Company with this name already exists'
        });
        return;
      }
    }

    const company = await prisma.company.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(address !== undefined && { address }),
        ...(phone !== undefined && { phone }),
        ...(email !== undefined && { email }),
        ...(businessType !== undefined && { businessType }),
        updatedAt: new Date() // Ensure updatedAt is set for sync comparison
      },
      include: {
        branches: {
          where: { isActive: true }
        },
        _count: {
          select: {
            users: true,
            employees: true,
            products: true
          }
        }
      }
    });

    // 🔄 IMMEDIATE SYNC TO LIVE DATABASE (wait for completion)
    try {
      await syncAfterOperation('company', 'update', company);
      console.log('[Sync] ✅ Company update synced to live');
    } catch (err: any) {
      console.error('[Sync] Company update sync failed:', err.message);
    }

    res.json({
      success: true,
      data: company,
      message: 'Company updated successfully'
    });
  } catch (error) {
    console.error('Update company error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Delete a company (soft delete)
// NOTE: Removed access check - any user can delete any company
export const deleteCompany = async (req: Request, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    // Check if company exists
    const existingCompany = await prisma.company.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            branches: true,
            users: true,
            employees: true,
            products: true
          }
        }
      }
    });

    if (!existingCompany) {
      res.status(404).json({
        success: false,
        message: 'Company not found'
      });
      return;
    }

    // Check if company has associated data
    const hasData = existingCompany._count.branches > 0 ||
                   existingCompany._count.users > 0 ||
                   existingCompany._count.employees > 0 ||
                   existingCompany._count.products > 0;

    if (hasData) {
      res.status(400).json({
        success: false,
        message: 'Cannot delete company with associated branches, users, employees, or products'
      });
      return;
    }

    // Soft delete the company
    const deletedCompany = await prisma.company.update({
      where: { id },
      data: {
        isActive: false,
        updatedAt: new Date()
      }
    });

    // 🔄 IMMEDIATE SYNC TO LIVE DATABASE (wait for completion)
    try {
      await syncAfterOperation('company', 'update', deletedCompany);
      console.log('[Sync] ✅ Company delete synced to live');
    } catch (err: any) {
      console.error('[Sync] Company delete sync failed:', err.message);
    }

    res.json({
      success: true,
      message: 'Company deleted successfully'
    });
  } catch (error) {
    console.error('Delete company error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Update company business type
export const updateCompanyBusinessType = async (req: Request, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const userId = (req as any).user.id;
    const userRole = (req as any).user.role;
    const { businessType } = req.body;

    // Validate business type
    if (!businessType || !['PHARMACY', 'STORE', 'HOTEL', 'CLINIC'].includes(businessType)) {
      res.status(400).json({
        success: false,
        message: 'Invalid business type. Must be one of: PHARMACY, STORE, HOTEL, CLINIC'
      });
      return;
    }

    // Check if company exists
    const existingCompany = await prisma.company.findUnique({
      where: { id }
    });

    if (!existingCompany) {
      res.status(404).json({
        success: false,
        message: 'Company not found'
      });
      return;
    }

    // NOTE: Removed access check - any user can update business type

    const company = await prisma.company.update({
      where: { id },
      data: {
        businessType,
        updatedAt: new Date()
      },
      include: {
        branches: {
          where: { isActive: true }
        },
        _count: {
          select: {
            users: true,
            employees: true,
            products: true
          }
        }
      }
    });

    // 🔄 IMMEDIATE SYNC TO LIVE DATABASE (wait for completion)
    try {
      await syncAfterOperation('company', 'update', company);
      console.log('[Sync] ✅ Company business type synced to live');
    } catch (err: any) {
      console.error('[Sync] Company business type sync failed:', err.message);
    }

    res.json({
      success: true,
      data: company,
      message: 'Business type updated successfully'
    });
  } catch (error) {
    console.error('Update company business type error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get company statistics
// NOTE: Removed access check - any user can view company stats
export const getCompanyStats = async (req: Request, res: Response): Promise<void> => {
  try {
    // 🔄 PULL LATEST FROM LIVE DATABASE FIRST
    await pullLatestFromLive('company').catch(err => console.log('[Sync] Pull company stats:', err.message));

    const prisma = await getPrisma();
    const { id } = req.params;

    // Check if company exists
    const company = await prisma.company.findUnique({
      where: { id }
    });

    if (!company) {
      res.status(404).json({
        success: false,
        message: 'Company not found'
      });
      return;
    }

    // Get statistics
    const stats = await prisma.company.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            branches: true,
            users: true,
            employees: true,
            products: true,
            customers: true,
            sales: true
          }
        }
      }
    });

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Get company stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
