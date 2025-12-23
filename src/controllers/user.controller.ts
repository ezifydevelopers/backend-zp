import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getPrisma } from '../utils/db.util';
import { CreateUserData, UpdateUserData } from '../models/user.model';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Validation schemas
const createUserSchema = Joi.object({
  username: Joi.string().min(3).max(30).required(),
  email: Joi.string().pattern(/^[^\s@]+@[^\s@]+$/).required().messages({
    'string.pattern.base': 'Email must contain @ symbol'
  }),
  password: Joi.string().min(6).required(),
  name: Joi.string().required(),
  role: Joi.string().valid('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER').required(),
  branchId: Joi.string().allow(null, '').optional()
});

const updateUserSchema = Joi.object({
  username: Joi.string().min(3).max(30),
  email: Joi.string().email({ tlds: { allow: false } }),
  password: Joi.string().min(6),
  name: Joi.string(),
  role: Joi.string().valid('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER'),
  branchId: Joi.string(),
  isActive: Joi.boolean()
});

export const getUsers = async (req: AuthRequest, res: Response) => {
  try {
    // ⚠️ DISABLED: Don't pull from PostgreSQL for users in SQLite mode
    // This was causing newly created users to disappear because:
    // 1. User is created in SQLite (local)
    // 2. Pull from PostgreSQL runs (PostgreSQL might be empty or have old data)
    // 3. Local user gets overwritten or filtered out
    //
    // Users should be synced TO PostgreSQL, not FROM PostgreSQL when in SQLite mode
    // Only pull if explicitly requested or when going online
    // pullLatestFromLive('user').catch(err => console.log('[Sync] Pull users:', err.message));

    const prisma = await getPrisma();
    const {
      page = 1,
      limit = 10,
      search = '',
      role = '',
      branchId = '',
      isActive = true
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where: any = {};

    // Get context from headers (set by frontend) - same as other controllers
    const selectedCompanyId = req.headers['x-company-id'] as string || req.user?.selectedCompanyId;
    const selectedBranchId = req.headers['x-branch-id'] as string || req.user?.selectedBranchId;

    // Debug: Log user context
    console.log('🔍 getUsers - User context:', {
      userId: req.user?.id,
      role: req.user?.role,
      headerCompanyId: req.headers['x-company-id'],
      headerBranchId: req.headers['x-branch-id'],
      selectedCompanyId,
      selectedBranchId,
      createdBy: req.user?.createdBy
    });

    // Apply company/branch context filtering
    if (req.user?.role === 'SUPERADMIN') {
      // SuperAdmin can see all users
      if (selectedCompanyId) {
        where.branch = { companyId: selectedCompanyId };
      }
      if (selectedBranchId) {
        where.branchId = selectedBranchId;
      }
    } else if (req.user?.role === 'ADMIN') {
      // CRITICAL FIX: Admin users - ALWAYS show users created by this admin
      // This is the most important filter - newly created users MUST be visible
      const adminCreatedBy = req.user?.createdBy || req.user?.id;

      console.log('🏢 Admin user context:', {
        userId: req.user?.id,
        createdBy: adminCreatedBy,
        selectedBranchId,
        selectedCompanyId,
        queryBranchId: branchId
      });

      // Build OR conditions: always include createdBy, optionally include branch/company
      const orConditions: any[] = [
        { createdBy: adminCreatedBy } // This MUST always be in the OR
      ];

      // Add branch/company conditions as additional OR options
      if (selectedBranchId && selectedBranchId.trim() !== '') {
        orConditions.push({ branchId: selectedBranchId });
        console.log('🏢 Admin: OR query - (branchId OR createdBy)');
      } else if (selectedCompanyId && selectedCompanyId.trim() !== '') {
        orConditions.push({ branch: { companyId: selectedCompanyId } });
        console.log('🏢 Admin: OR query - (company OR createdBy)');
      } else {
        console.log('🏢 Admin: OR query - (createdBy only)');
      }

      // Set the base OR condition - this will be preserved throughout
      where.OR = orConditions;
    } else if (req.user?.role === 'MANAGER' || req.user?.role === 'CASHIER') {
      // Manager/Cashier - only see users in their branch
      if (req.user?.branchId) {
        where.branchId = req.user.branchId;
      } else {
        where.branchId = 'no-access';
      }
    }

    // Build additional filters that will be combined with AND
    const additionalFilters: any[] = [];

    // Handle isActive filter
    const isActiveStr = String(isActive);
    if (isActiveStr === 'all') {
      // Show all users regardless of isActive - don't add filter
    } else if (isActiveStr === 'false') {
      // Show only inactive users
      additionalFilters.push({ isActive: false });
    } else {
      // Default: show active users (isActive = true)
      // Note: Since isActive has a default value of false in the schema,
      // we only need to filter for true. Null values are treated as inactive.
      additionalFilters.push({ isActive: true });
    }

    // Handle role filter
    if (role && typeof role === 'string' && role.trim() !== '') {
      additionalFilters.push({ role: role });
    }

    // Handle branchId query param (different from header branchId)
    if (branchId && typeof branchId === 'string' && branchId.trim() !== '') {
      // If we have an OR clause (for ADMIN users), add branchId to it
      if (where.OR && Array.isArray(where.OR)) {
        const hasBranchId = where.OR.some((cond: any) => cond.branchId === branchId);
        if (!hasBranchId) {
          where.OR.push({ branchId: branchId });
          console.log('✅ Added branchId to OR clause');
        }
      } else {
        // No OR clause - add as direct filter
        additionalFilters.push({ branchId: branchId });
      }
    }

    // Handle search
    if (search && typeof search === 'string' && search.trim() !== '') {
      additionalFilters.push({
        OR: [
          { name: { contains: search } },
          { username: { contains: search } },
          { email: { contains: search } }
        ]
      });
    }

    // Combine base filters (OR clause) with additional filters (AND)
    if (additionalFilters.length > 0) {
      if (where.OR && Array.isArray(where.OR)) {
        // We have an OR clause (from ADMIN role), combine with AND
        where.AND = [
          { OR: where.OR },
          ...additionalFilters
        ];
        delete where.OR;
      } else {
        // No OR clause, just add additional filters directly
        Object.assign(where, ...additionalFilters);
      }
    }

    // Debug: Log final where clause
    console.log('🔍 getUsers - Final where clause:', JSON.stringify(where, null, 2));
    console.log('🔍 getUsers - User making request:', {
      id: req.user?.id,
      role: req.user?.role,
      createdBy: req.user?.createdBy,
      branchId: req.user?.branchId
    });

    // CRITICAL DEBUG: Query all users first to see what exists
    const allUsersDebug = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        branchId: true,
        companyId: true,
        createdBy: true,
        isActive: true
      },
      take: 20
    });
    console.log('🔍 DEBUG - All users in database:', JSON.stringify(allUsersDebug, null, 2));

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take,
        include: {
          branch: {
            select: {
              id: true,
              name: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.user.count({ where })
    ]);

    console.log('🔍 getUsers - Query result:', {
      found: users.length,
      total,
      userIds: users.map(u => u.id),
      usernames: users.map(u => u.username)
    });

    // Remove password from response
    const usersWithoutPassword = users.map(user => {
      const { password, ...userWithoutPassword } = user;
      return userWithoutPassword;
    });

    return res.json({
      success: true,
      data: {
        users: usersWithoutPassword,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getUser = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    // Build where clause with data isolation
    const where: any = { id };

    // Data isolation: Only allow access to users belonging to the same admin
    if (req.user?.role === 'SUPERADMIN') {
      // SuperAdmin can see all users
    } else if (req.user?.createdBy) {
      where.createdBy = req.user.createdBy;
    } else {
      // If no createdBy, show only users created by this user
      where.createdBy = req.user?.id;
    }

    const user = await prisma.user.findFirst({
      where,
      include: {
        branch: {
          select: {
            id: true,
            name: true,
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found or access denied'
      });
    }

    // Remove password from response
    const { password, ...userWithoutPassword } = user;

    return res.json({
      success: true,
      data: userWithoutPassword
    });
  } catch (error) {
    console.error('Get user error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const createUser = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    console.log('=== CREATE USER REQUEST ===');
    console.log('Request body:', req.body);
    console.log('User context:', { role: req.user?.role, createdBy: req.user?.createdBy, branchId: req.user?.branchId });

    const { error } = createUserSchema.validate(req.body);
    if (error) {
      console.log('Validation errors:', error.details);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const userData: CreateUserData = req.body;

    // Check if user already exists in the same branch
    // Allow same username/email in different branches
    const branchId = userData.branchId && userData.branchId.trim() !== '' ? userData.branchId : null;

    // Check for duplicate username in the same branch
    const existingUserByUsername = await prisma.user.findFirst({
      where: {
        username: userData.username,
        branchId: branchId
      }
    });

    if (existingUserByUsername) {
      console.log('❌ User with username already exists in this branch:', userData.username);
      return res.status(400).json({
        success: false,
        message: `User with username "${userData.username}" already exists in this branch`,
        field: 'username',
        code: 'USER_EXISTS'
      });
    }

    // Check for duplicate email in the same branch
    const existingUserByEmail = await prisma.user.findFirst({
      where: {
        email: userData.email,
        branchId: branchId
      }
    });

    if (existingUserByEmail) {
      console.log('❌ User with email already exists in this branch:', userData.email);
      return res.status(400).json({
        success: false,
        message: `User with email "${userData.email}" already exists in this branch`,
        field: 'email',
        code: 'USER_EXISTS'
      });
    }

    // Check if branch exists (only if branchId is provided and not null/empty)
    if (userData.branchId && userData.branchId.trim() !== '') {
      const branch = await prisma.branch.findUnique({
        where: { id: userData.branchId }
      });

      if (!branch) {
        return res.status(400).json({
          success: false,
          message: 'Branch not found'
        });
      }
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(userData.password, parseInt(process.env.BCRYPT_ROUNDS || '12'));

    // Get the current user ID and createdBy from the request (set by auth middleware)
    const currentUserId = req.user?.id;
    const currentUserAdminId = req.user?.createdBy;
    const currentUserCompanyId = req.user?.companyId;

    // For data isolation: createdBy should be the admin who created this user
    // If current user is an ADMIN with no createdBy (self-created), use their own ID
    // Otherwise, use the createdBy chain
    const createdByValue = currentUserAdminId || currentUserId;

    // Get companyId from branch if not set on current user
    let companyIdValue = currentUserCompanyId;
    const branchIdValue = userData.branchId && userData.branchId.trim() !== '' ? userData.branchId : null;

    // If we have a branch but no company, get the company from the branch
    if (branchIdValue && !companyIdValue) {
      const branch = await prisma.branch.findUnique({
        where: { id: branchIdValue },
        select: { companyId: true }
      });
      if (branch) {
        companyIdValue = branch.companyId;
      }
    }

    console.log('Creating user with isolation data:', {
      createdBy: createdByValue,
      companyId: companyIdValue,
      branchId: branchIdValue,
      currentUserId,
      currentUserAdminId,
      currentUserCompanyId
    });

    // Create user in a transaction to ensure it's committed
    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          username: userData.username,
          email: userData.email,
          password: hashedPassword,
          name: userData.name,
          role: userData.role,
          branchId: branchIdValue,
          companyId: companyIdValue, // Set companyId for data isolation
          createdBy: createdByValue, // Set createdBy for data isolation
          isActive: true // New users are active by default when created by admin
        },
        include: {
          branch: {
            select: {
              id: true,
              name: true
            }
          }
        }
      });

      // Immediately verify it exists in the same transaction
      const verifyUser = await tx.user.findUnique({
        where: { id: newUser.id }
      });

      if (!verifyUser) {
        throw new Error('User was created but cannot be verified in database');
      }

      return newUser;
    });

    console.log('✅ User created and verified in database:', {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      branchId: user.branchId,
      companyId: user.companyId,
      createdBy: user.createdBy,
      isActive: user.isActive
    });

    // Remove password from response
    const { password, ...userWithoutPassword } = user;

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC (non-blocking, in background)
    // Don't wait for sync - return immediately so user sees the new user
    syncAfterOperation('user', 'create', userWithoutPassword).catch(err => {
      console.error('[Sync] User create sync failed:', err.message);
    });

    return res.status(201).json({
      success: true,
      data: userWithoutPassword,
      message: `User created successfully! Username: ${user.username}`
    });
  } catch (error: any) {
    console.error('Create user error:', error);
    console.error('Error details:', {
      message: error?.message,
      code: error?.code,
      meta: error?.meta
    });

    // Handle specific Prisma errors
    if (error?.code === 'P2002') {
      // Unique constraint violation
      const field = error?.meta?.target?.[0] || 'field';
      return res.status(400).json({
        success: false,
        message: `A user with this ${field} already exists`,
        code: 'USER_EXISTS',
        field
      });
    }

    return res.status(500).json({
      success: false,
      message: error?.message || 'Internal server error'
    });
  }
};

export const updateUser = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { error } = updateUserSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const updateData: any = req.body;

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { id }
    });

    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if username/email already exists (if being updated)
    if (updateData.username || updateData.email) {
      const where: any = { id: { not: id } };

      if (updateData.username) {
        where.username = updateData.username;
      }
      if (updateData.email) {
        where.email = updateData.email;
      }

      const userExists = await prisma.user.findFirst({ where });

      if (userExists) {
        return res.status(400).json({
          success: false,
          message: 'User with this username or email already exists'
        });
      }
    }

    // Hash password if provided
    if (updateData.password) {
      updateData.password = await bcrypt.hash(updateData.password, parseInt(process.env.BCRYPT_ROUNDS || '12'));
    }

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      include: {
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    // Remove password from response
    const { password, ...userWithoutPassword } = user;

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('user', 'update', userWithoutPassword).catch(err => {
      console.error('[Sync] User update sync failed:', err.message);
    });

    return res.json({
      success: true,
      data: userWithoutPassword
    });
  } catch (error) {
    console.error('Update user error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteUser = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Hard delete - actually remove the user from database
    await prisma.user.delete({
      where: { id }
    });

    return res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const activateUser = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { isActive } = req.body;

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update user active status
    const updatedUser = await prisma.user.update({
      where: { id },
      data: { isActive },
      include: {
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    // Remove password from response
    const { password, ...userWithoutPassword } = updatedUser;

    return res.json({
      success: true,
      data: userWithoutPassword,
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`
    });
  } catch (error) {
    console.error('Activate user error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
