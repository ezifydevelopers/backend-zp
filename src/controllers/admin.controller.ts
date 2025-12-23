import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import Joi from 'joi';
import { notifyUserDeactivation, notifyUserReactivation } from '../routes/sse.routes';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';

// Validation schemas
const createAdminSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  phone: Joi.string().allow('').optional(),
  company: Joi.string().required(),
  plan: Joi.string().valid('basic', 'premium', 'enterprise').default('basic'),
  branchId: Joi.string().allow(null).optional(),
  password: Joi.string().min(6).required()
});

const updateAdminSchema = Joi.object({
  name: Joi.string(),
  email: Joi.string().email(),
  phone: Joi.string(),
  company: Joi.string(),
  plan: Joi.string().valid('basic', 'premium', 'enterprise'),
  isActive: Joi.boolean(),
  branchId: Joi.string()
});

// Get all admins (SuperAdmin only)
export const getAdmins = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { page = 1, limit = 10, search = '' } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where: any = {
      role: 'ADMIN',
      ...(search && {
        OR: [
          { name: { contains: search as string } },
          { email: { contains: search as string } },
          { branch: { name: { contains: search as string } } }
        ]
      })
    };

    const [admins, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take,
        include: {
          branch: {
            select: {
              id: true,
              name: true,
              phone: true,
            }
          },
          _count: {
            select: {
              sales: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.user.count({ where })
    ]);

    // Calculate additional stats for each admin
    const adminsWithStats = await Promise.all(
      admins.map(async (admin: any) => {
        // Get total sales for this admin
        const salesStats = await prisma.sale.aggregate({
          where: { userId: admin.id },
          _sum: { totalAmount: true },
          _count: { id: true }
        });

        // Get user count for this admin's branch (excluding admins and superadmins)
        const userCount = await prisma.user.count({
          where: {
            branchId: admin.branchId,
            isActive: true,
            role: { notIn: ['ADMIN', 'SUPERADMIN'] }
          }
        });

        // Get manager count for this admin's branch
        const managerCount = await prisma.user.count({
          where: {
            branchId: admin.branchId,
            isActive: true,
            role: 'MANAGER'
          }
        });

        return {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          phone: (admin as any).branch?.phone || '',
          company: (admin as any).branch?.name || '',
          address: (admin as any).branch?.address || '',
          userCount,
          managerCount,
          totalSales: salesStats._sum.totalAmount || 0,
          lastActive: admin.updatedAt.toISOString().split('T')[0],
          status: admin.isActive ? 'active' : 'inactive',
          plan: 'premium', // Default plan, can be extended later
          createdAt: admin.createdAt.toISOString().split('T')[0],
          subscriptionEnd: '2024-12-31' // Default, can be extended later
        };
      })
    );

    res.json({
      success: true,
      data: {
        admins: adminsWithStats,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get admins error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get admin by ID
export const getAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const admin = await prisma.user.findFirst({
      where: {
        id,
        role: 'ADMIN'
      },
      include: {
        branch: {
          select: {
            id: true,
            name: true,
            phone: true,
          }
        }
      }
    });

    if (!admin) {
      res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
      return;
    }

    // Get stats for this admin
    const salesStats = await prisma.sale.aggregate({
      where: { userId: admin.id },
      _sum: { totalAmount: true },
      _count: { id: true }
    });

    const userCount = await prisma.user.count({
      where: {
        branchId: admin.branchId,
        isActive: true,
        role: { notIn: ['ADMIN', 'SUPERADMIN'] }
      }
    });

    const managerCount = await prisma.user.count({
      where: {
        branchId: admin.branchId,
        isActive: true,
        role: 'MANAGER'
      }
    });

    const adminWithStats = {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      phone: admin.branch?.phone || '',
      company: admin.branch?.name || '',
      userCount,
      managerCount,
      totalSales: salesStats._sum.totalAmount || 0,
      lastActive: admin.updatedAt.toISOString().split('T')[0],
      status: admin.isActive ? 'active' : 'inactive',
      plan: 'premium',
      createdAt: admin.createdAt.toISOString().split('T')[0],
      subscriptionEnd: '2024-12-31'
    };

    res.json({
      success: true,
      data: adminWithStats
    });
  } catch (error) {
    console.error('Get admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Create admin
export const createAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const { error } = createAdminSchema.validate(req.body);
    if (error) {
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
      return;
    }

    const { name, email, phone, company, plan, branchId, password } = req.body;

    // Set default phone if empty
    const finalPhone = phone || '+92 300 0000000';

    // Check if admin already exists
    const existingAdmin = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { branch: { name: company } }
        ]
      }
    });

    if (existingAdmin) {
      res.status(400).json({
        success: false,
        message: 'Admin with this email or company already exists'
      });
      return;
    }

    // Generate username and hash password
    const username = email.split('@')[0] + '_admin';
    const hashedPassword = await require('bcryptjs').hash(password, parseInt(process.env.BCRYPT_ROUNDS || '12'));

    // Get the current user (super admin) who is creating this admin
    const currentUser = req.user;
    if (!currentUser) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
      return;
    }

    // Create admin user and branch in a transaction
    const result = await prisma.$transaction(async (tx: any) => {
      // Create a new company first
      const newCompany = await tx.company.create({
        data: {
          name: company,
          description: `Company for ${name}`,
          address: 'Default Address', // Can be updated later
          phone: finalPhone,
          email,
          createdBy: currentUser.id
        }
      });

      // Create a new branch for this admin
      const branch = await tx.branch.create({
        data: {
          name: `${company} - Main Branch`,
          address: 'Default Address', // Can be updated later
          phone: finalPhone,
          email,
          companyId: newCompany.id,
          createdBy: currentUser.id
        }
      });

      // Create admin user with the correct branchId and companyId
      const admin = await tx.user.create({
        data: {
          username,
          email,
          password: hashedPassword,
          name,
          role: 'ADMIN',
          branchId: branch.id, // Use the actual branch ID
          companyId: newCompany.id, // Use the actual company ID
          createdBy: currentUser.id, // Who created this admin
          isActive: true
        },
        include: {
          branch: {
            select: {
              id: true,
              name: true,
              phone: true,
            }
          }
        }
      });

      // Update admin to set createdBy to self-reference
      const finalAdmin = await tx.user.update({
        where: { id: admin.id },
        data: { createdBy: admin.id },
        include: {
          branch: {
            select: {
              id: true,
              name: true,
              phone: true,
            }
          }
        }
      });

      return finalAdmin;
    });

    const admin = result;

    const adminWithStats = {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      phone: admin.branch?.phone || '',
      company: admin.branch?.name || '',
      userCount: 0,
      managerCount: 0,
      totalSales: 0,
      lastActive: admin.updatedAt.toISOString().split('T')[0],
      status: admin.isActive ? 'active' : 'inactive',
      plan,
      createdAt: admin.createdAt.toISOString().split('T')[0],
      subscriptionEnd: '2024-12-31'
    };

    res.status(201).json({
      success: true,
      data: adminWithStats,
      message: 'Admin created successfully'
    });
  } catch (error) {
    console.error('Create admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Update admin
export const updateAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { error } = updateAdminSchema.validate(req.body);

    if (error) {
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
      return;
    }

    const updateData = req.body;

    // Check if admin exists
    const existingAdmin = await prisma.user.findFirst({
      where: { id, role: 'ADMIN' }
    });

    if (!existingAdmin) {
      res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
      return;
    }

    // Update admin
    const admin = await prisma.user.update({
      where: { id },
      data: updateData,
      include: {
        branch: {
          select: {
            id: true,
            name: true,
            phone: true,
          }
        }
      }
    });

    // Update branch if company name changed
    if (updateData.company && admin.branchId) {
      await prisma.branch.update({
        where: { id: admin.branchId },
        data: {
          name: updateData.company,
          phone: updateData.phone || admin.branch?.phone,
        }
      });
    }

    // Notify user if status changed
    if (updateData.isActive !== undefined) {
      if (updateData.isActive === false) {
        // Admin was deactivated - notify them
        notifyUserDeactivation(id);

        // Also deactivate all users under this admin
        const adminUsers = await prisma.user.findMany({
          where: {
            branchId: admin.branchId,
            role: { in: ['MANAGER', 'CASHIER'] }
          }
        });

        // Deactivate all users and notify them
        for (const user of adminUsers) {
          await prisma.user.update({
            where: { id: user.id },
            data: { isActive: false }
          });
          notifyUserDeactivation(user.id);
        }
      } else if (updateData.isActive === true) {
        // Admin was reactivated - notify them
        notifyUserReactivation(id);
      }
    }

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('user', 'update', admin).catch(err => {
      console.error('[Sync] Admin update sync failed:', err.message);
    });

    res.json({
      success: true,
      data: admin,
      message: 'Admin updated successfully'
    });
  } catch (error) {
    console.error('Update admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Delete admin
export const deleteAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    // Check if admin exists
    const existingAdmin = await prisma.user.findFirst({
      where: { id, role: 'ADMIN' }
    });

    if (!existingAdmin) {
      res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
      return;
    }

    console.log(`🗑️  Deleting admin: ${existingAdmin.name} (${existingAdmin.username})...`);

    // Hard delete - permanently remove admin and all related data
    await prisma.$transaction(async (tx) => {
      // Get all products belonging to this admin
      const adminProducts = await tx.product.findMany({
        where: { createdBy: id },
        select: { id: true }
      });

      const productIds = adminProducts.map((p: any) => p.id);

      console.log(`   📊 Found ${productIds.length} products to delete`);

      // Delete in the correct order to avoid foreign key constraints

      // 1. Delete refund items first
      await tx.refundItem.deleteMany({
        where: { createdBy: id }
      });

      // 2. Delete refunds
      await tx.refund.deleteMany({
        where: {
          OR: [
            { refundedBy: id },
            { createdBy: id }
          ]
        }
      });

      // 3. Delete sale items
      await tx.saleItem.deleteMany({
        where: { createdBy: id }
      });

      // 4. Delete receipts
      await tx.receipt.deleteMany({
        where: {
          OR: [
            { userId: id },
            { createdBy: id }
          ]
        }
      });

      // 5. Delete sales
      await tx.sale.deleteMany({
        where: {
          OR: [
            { userId: id },
            { createdBy: id }
          ]
        }
      });

      // 6. Delete stock movements that reference admin's products
      if (productIds.length > 0) {
        await tx.stockMovement.deleteMany({
          where: {
            OR: [
              { createdBy: id },
              { productId: { in: productIds } }
            ]
          }
        });
      } else {
        await tx.stockMovement.deleteMany({
          where: { createdBy: id }
        });
      }

      // 7. Delete customers
      await tx.customer.deleteMany({
        where: { createdBy: id }
      });

      // 8. Delete products
      await tx.product.deleteMany({
        where: { createdBy: id }
      });

      // 9. Delete suppliers
      await tx.supplier.deleteMany({
        where: { createdBy: id }
      });

      // 10. Delete categories
      await tx.category.deleteMany({
        where: { createdBy: id }
      });

      // 11. Delete branches
      await tx.branch.deleteMany({
        where: { createdBy: id }
      });

      // 12. Delete settings
      await tx.settings.deleteMany({
        where: { createdBy: id }
      });

      // 13. Delete all users under this admin (managers, cashiers, etc.) including the admin itself
      await tx.user.deleteMany({
        where: {
          OR: [
            { createdBy: id },
            { createdBy: id },
            { id: id } // Include the admin itself
          ]
        }
      });
    });

    console.log(`✅ Admin ${existingAdmin.name} and all related data deleted successfully`);

    res.json({
      success: true,
      message: 'Admin and all related data permanently deleted from database'
    });
  } catch (error) {
    console.error('Delete admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get admin users
export const getAdminUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const { createdBy } = req.params;

    // Check if admin exists
    const admin = await prisma.user.findFirst({
      where: { id: createdBy, role: 'ADMIN' }
    });

    if (!admin) {
      res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
      return;
    }

    // Get all users for this admin's branch
    const users = await prisma.user.findMany({
      where: {
        branchId: admin.branchId,
        role: { notIn: ['ADMIN', 'SUPERADMIN'] } // Exclude admins and superadmins
      },
      select: {
        id: true,
        name: true,
        isActive: true,
        role: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: { createdAt: 'desc' }
    });

    const usersWithStats = users.map((user: any) => ({
      id: user.id,
      name: user.name,
      createdBy: createdBy,
      lastActive: user.updatedAt.toISOString().split('T')[0],
      status: user.isActive ? 'active' : 'inactive',
      role: user.role
    }));

    res.json({
      success: true,
      data: usersWithStats
    });
  } catch (error) {
    console.error('Get admin users error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get superadmin dashboard stats
export const getSuperAdminStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    // Get total admins
    const totalAdmins = await prisma.user.count({
      where: { role: 'ADMIN', isActive: true }
    });

    // Get total users
    const totalUsers = await prisma.user.count({
      where: {
        role: { notIn: ['ADMIN', 'SUPERADMIN'] },
        isActive: true
      }
    });

    // Get total sales
    const salesStats = await prisma.sale.aggregate({
      _sum: { totalAmount: true },
      _count: { id: true }
    });

    // Get active admins
    const activeAdmins = await prisma.user.count({
      where: {
        role: 'ADMIN',
        isActive: true
      }
    });

    // Get recent admins
    const recentAdmins = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      take: 3,
      include: {
        branch: {
          select: {
            name: true
          }
        },
        _count: {
          select: {
            sales: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const recentAdminsWithStats = await Promise.all(
      recentAdmins.map(async (admin: any) => {
        const salesStats = await prisma.sale.aggregate({
          where: { userId: admin.id },
          _sum: { totalAmount: true }
        });

        const userCount = await prisma.user.count({
          where: { branchId: admin.branchId, isActive: true }
        });

        return {
          id: admin.id,
          name: admin.name,
          company: admin.branch?.name || 'No Company',
          userCount,
          totalSales: salesStats._sum.totalAmount || 0
        };
      })
    );

    res.json({
      success: true,
      data: {
        totalAdmins,
        totalUsers,
        totalSales: salesStats._sum.totalAmount || 0,
        activeAdmins,
        recentAdmins: recentAdminsWithStats
      }
    });
  } catch (error) {
    console.error('Get superadmin stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
