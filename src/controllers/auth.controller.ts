// CRITICAL: Import database initialization FIRST to ensure DATABASE_URL is set
// This prevents Prisma schema validation errors when PrismaClient is imported
import '../config/database.init';

import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { LoginData, CreateUserData } from '../models/user.model';
import { validate } from '../middleware/validation.middleware';
import { getPrisma } from '../utils/db.util';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Generate unique session token
const generateSessionToken = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

// Validation schemas
const loginSchema = Joi.object({
  usernameOrEmail: Joi.string().required(),
  password: Joi.string().required()
});

const registerSchema = Joi.object({
  username: Joi.string().min(3).max(30).required(),
  email: Joi.string().email().required(),
  password: Joi.string()
    .min(8)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).*$/)
    .required()
    .messages({
      'string.min': 'Password must be at least 8 characters long',
      'string.pattern.base': 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'
    }),
  name: Joi.string().required(),
  role: Joi.string().valid('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER').required(),
  branchId: Joi.string().allow('', null).optional(),
  branchData: Joi.object({
    name: Joi.string().required(),
    address: Joi.string().required(),
    phone: Joi.string().required()
  }).optional()
});

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('🔍 Login attempt - Request body:', req.body);

    const { error } = loginSchema.validate(req.body);
    if (error) {
      console.log('❌ Validation error:', error.details);
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
      return;
    }

    const { usernameOrEmail, password }: { usernameOrEmail: string; password: string } = req.body;
    console.log('🔍 Login attempt - Username/Email:', usernameOrEmail);

    // Get database client (works with SQLite or PostgreSQL)
    const prisma = await getPrisma();

    // Find user by username or email (check both active and inactive users)
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: usernameOrEmail },
          { email: usernameOrEmail }
        ]
      },
      include: {
        branch: {
          select: {
            id: true,
            name: true,
            phone: true
          }
        }
      }
    });

    if (!user) {
      console.log('❌ User not found for username/email:', usernameOrEmail);
      res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
      return;
    }

    // Check if user account is active
    // ALL users MUST be activated by SuperAdmin before they can login
    // This applies to both online (PostgreSQL) and offline (SQLite) modes
    if (!user.isActive) {
      console.log('❌ User account is not activated:', usernameOrEmail);
      res.status(403).json({
        success: false,
        message: 'Your account is not activated yet. Please contact SuperAdmin at +923107100663 to activate your account.',
        accountDisabled: true,
        pendingActivation: true
      });
      return;
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    console.log('🔐 Password check - Valid:', isPasswordValid);
    if (!isPasswordValid) {
      console.log('❌ Invalid password for user:', usernameOrEmail);
      res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
      return;
    }

    // Generate unique session token for single-session enforcement
    const sessionToken = generateSessionToken();

    // Update user with new session token (invalidates any previous sessions)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        sessionToken,
        lastLoginAt: new Date()
      }
    });

    // Generate JWT token with session token included
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET is not defined');
    }

    const token = (jwt.sign as any)(
      {
        userId: user.id,
        username: user.username,
        role: user.role,
        branchId: user.branchId,
        createdBy: user.createdBy,
        sessionToken // Include session token in JWT for validation
      },
      process.env.JWT_SECRET!,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    console.log('✅ Login successful for user:', usernameOrEmail);

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          branchId: user.branchId,
          createdBy: user.createdBy,
          isActive: user.isActive,
          email: user.email
        },
        token
      }
    });
  } catch (error: any) {
    console.error('❌ Login error:', error);
    console.error('❌ Login error details:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      meta: error.meta
    });

    // Provide more specific error messages
    let errorMessage = 'Internal server error';
    if (error.message?.includes('connect')) {
      errorMessage = 'Database connection failed. Please check if the database is running.';
    } else if (error.message?.includes('Prisma')) {
      errorMessage = 'Database error. Please check database configuration.';
    } else if (error.message) {
      errorMessage = error.message;
    }

    res.status(500).json({
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { error } = registerSchema.validate(req.body);
    if (error) {
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
      return;
    }

    const { username, email, password, name, role, branchId, branchData } = req.body;

    // Get database client (works with SQLite or PostgreSQL)
    const prisma = await getPrisma();

    // Convert empty branchId to null for ADMIN and SUPERADMIN users
    const processedBranchId = (branchId === '' || branchId === null || branchId === undefined) ? null : branchId;

    // Check if username already exists
    const existingUsername = await prisma.user.findUnique({
      where: { username }
    });

    if (existingUsername) {
      res.status(400).json({
        success: false,
        message: 'Username already exists',
        field: 'username'
      });
      return;
    }

    // Check if email already exists
    const existingEmail = await prisma.user.findUnique({
      where: { email }
    });

    if (existingEmail) {
      res.status(400).json({
        success: false,
        message: 'Email already exists',
        field: 'email'
      });
      return;
    }

    let user;

    // Hash password
    const hashedPassword = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS || '12'));

    // ALL new users are created as INACTIVE
    // They MUST be activated by SuperAdmin before they can login
    // This applies to both online (PostgreSQL) and offline (SQLite) modes
    const shouldBeActive = false; // Always inactive - SuperAdmin must activate

    // For ADMIN and SUPERADMIN users, create user without branch/company initially
    // They will create companies and branches from the dashboard
    if (role === 'ADMIN' || role === 'SUPERADMIN') {
      user = await prisma.user.create({
        data: {
          username,
          email,
          password: hashedPassword,
          name,
          role,
          branchId: null, // No branch initially
          companyId: null, // No company initially
          isActive: shouldBeActive, // ALWAYS inactive - SuperAdmin must activate
          createdBy: null // Will be updated to self-reference after user creation
        }
      });

      // Update the user to set createdBy to their own ID (self-referencing)
      user = await prisma.user.update({
        where: { id: user.id },
        data: { createdBy: user.id }
      });
    } else {
      // For other roles (MANAGER, CASHIER), they need to be assigned to a branch
      if (!processedBranchId) {
        res.status(400).json({
          success: false,
          message: 'Branch ID is required for non-admin users'
        });
        return;
      }

      // Check if existing branch exists
      const branch = await prisma.branch.findUnique({
        where: { id: processedBranchId }
      });

      if (!branch) {
        res.status(400).json({
          success: false,
          message: 'Branch not found'
        });
        return;
      }

      // Create user with branch assignment
      // ALWAYS inactive - SuperAdmin must activate
      user = await prisma.user.create({
        data: {
          username,
          email,
          password: hashedPassword,
          name,
          role,
          branchId: processedBranchId,
          companyId: branch.companyId,
          isActive: shouldBeActive, // ALWAYS inactive - SuperAdmin must activate
          createdBy: null // Will be set by the admin who creates this user
        },
        include: {
          branch: true,
          company: true
        }
      });
    }

    // ALL users need SuperAdmin activation - no auto-login
    console.log('✅ Account created (pending SuperAdmin activation):', username);

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('user', 'create', user).catch(err => {
      console.error('[Sync] User registration sync failed:', err.message);
    });

    res.status(201).json({
      success: true,
      pendingActivation: true, // Flag for frontend to show activation required message
      message: 'Account created successfully! Please contact SuperAdmin at +923107100663 to activate your account before you can login.',
      data: {
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          isActive: false, // ALWAYS false - SuperAdmin must activate
          email: user.email
        }
        // NO token - user cannot login until SuperAdmin activates their account
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    console.error('Error details:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : 'Unknown'
    });
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.message : 'Unknown error') : undefined
    });
  }
};

export const getProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user.id;

    // Get database client (works with SQLite or PostgreSQL)
    const prisma = await getPrisma();

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      res.status(404).json({
        success: false,
        message: 'User not found'
      });
      return;
    }

    res.json({
      success: true,
      data: user
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Change password schema
const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(6).required()
});

export const changePassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { error } = changePasswordSchema.validate(req.body);
    if (error) {
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
      return;
    }

    const userId = (req as any).user.id;
    const { currentPassword, newPassword } = req.body;

    // Get database client (works with SQLite or PostgreSQL)
    const prisma = await getPrisma();

    // Get user with current password
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      res.status(404).json({
        success: false,
        message: 'User not found'
      });
      return;
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
      return;
    }

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, parseInt(process.env.BCRYPT_ROUNDS || '12'));

    // Update password
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedNewPassword }
    });

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Update profile schema
const updateProfileSchema = Joi.object({
  name: Joi.string().optional(),
  email: Joi.string().email().optional(),
  profileImage: Joi.string().uri().optional()
});

export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const { error } = updateProfileSchema.validate(req.body);
    if (error) {
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
      return;
    }

    const userId = (req as any).user.id;
    const { name, email, profileImage } = req.body;

    // Get database client (works with SQLite or PostgreSQL)
    const prisma = await getPrisma();

    // Check if email is already taken by another user
    if (email) {
      const existingUser = await prisma.user.findFirst({
        where: {
          email,
          id: { not: userId }
        }
      });

      if (existingUser) {
        res.status(400).json({
          success: false,
          message: 'Email is already taken by another user'
        });
        return;
      }
    }

    // Update user profile
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(name && { name }),
        ...(email && { email }),
        ...(profileImage !== undefined && { profileImage })
      }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('user', 'update', updatedUser).catch(err => {
      console.error('[Sync] Profile update sync failed:', err.message);
    });

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        username: updatedUser.username,
        profileImage: updatedUser.profileImage,
        role: updatedUser.role
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

/**
 * Forgot Password - Request password reset
 * Since this is a business app, we don't send emails
 * Instead, we log the request and provide SuperAdmin contact info
 */
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({
        success: false,
        message: 'Email is required'
      });
      return;
    }

    // Get database client
    const prisma = await getPrisma();

    // Check if user exists (but don't reveal this to prevent email enumeration)
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
    });

    if (user) {
      console.log(`🔐 Forgot password request for user: ${email} (ID: ${user.id})`);
    } else {
      console.log(`🔐 Forgot password request for unknown email: ${email}`);
    }

    // Always return success to prevent email enumeration attacks
    res.json({
      success: true,
      message: 'If an account with that email exists, we have logged your password reset request. Please contact SuperAdmin for assistance.',
      contactNumber: '+923107100663'
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

/**
 * Reset Password - Admin/SuperAdmin can reset any user's password
 * Requires authentication and SUPERADMIN or ADMIN role
 */
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, newPassword } = req.body;
    const requestingUser = (req as any).user;

    // Check if requesting user is SUPERADMIN or ADMIN
    if (!requestingUser || (requestingUser.role !== 'SUPERADMIN' && requestingUser.role !== 'ADMIN')) {
      res.status(403).json({
        success: false,
        message: 'Only SuperAdmin or Admin can reset passwords'
      });
      return;
    }

    if (!userId || !newPassword) {
      res.status(400).json({
        success: false,
        message: 'User ID and new password are required'
      });
      return;
    }

    if (newPassword.length < 6) {
      res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long'
      });
      return;
    }

    // Get database client
    const prisma = await getPrisma();

    // Check if target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!targetUser) {
      res.status(404).json({
        success: false,
        message: 'User not found'
      });
      return;
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, parseInt(process.env.BCRYPT_ROUNDS || '12'));

    // Update password and clear session token to force re-login
    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        sessionToken: null // Clear session to force re-login
      }
    });

    console.log(`🔐 Password reset for user: ${targetUser.email} by ${requestingUser.username}`);

    res.json({
      success: true,
      message: `Password has been reset for ${targetUser.name || targetUser.email}`
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

/**
 * Check account status - used by frontend for periodic status checks
 * Returns whether the account is still active
 * If deactivated, frontend should force logout
 */
export const checkAccountStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.userId || (req as any).user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        isActive: false,
        message: 'User not authenticated',
        shouldLogout: true
      });
      return;
    }

    // Get database client
    const prisma = await getPrisma();

    // Check user status from database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isActive: true,
        sessionToken: true,
        username: true
      }
    });

    if (!user) {
      res.status(404).json({
        success: false,
        isActive: false,
        message: 'User not found',
        shouldLogout: true
      });
      return;
    }

    // Check if session token matches (for single-session enforcement)
    const requestSessionToken = (req as any).user?.sessionToken;
    if (requestSessionToken && user.sessionToken !== requestSessionToken) {
      res.status(401).json({
        success: false,
        isActive: false,
        message: 'Session expired - logged in from another device',
        shouldLogout: true
      });
      return;
    }

    // If account is deactivated
    if (!user.isActive) {
      console.log(`❌ Account deactivated for user: ${user.username}`);
      res.status(403).json({
        success: false,
        isActive: false,
        message: 'Your account has been deactivated. Please contact SuperAdmin at +923107100663 to reactivate.',
        shouldLogout: true,
        accountDeactivated: true
      });
      return;
    }

    // Account is active
    res.json({
      success: true,
      isActive: true,
      message: 'Account is active',
      shouldLogout: false
    });
  } catch (error) {
    console.error('Check account status error:', error);
    // On error, don't force logout - could be temporary issue
    res.status(500).json({
      success: false,
      isActive: true, // Assume active on error to prevent unnecessary logouts
      message: 'Could not verify account status',
      shouldLogout: false
    });
  }
};

/**
 * Check if user exists in local database (for offline-first authentication)
 * This endpoint is used to determine if internet is required for login
 */
export const checkLocalUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { usernameOrEmail } = req.body;

    if (!usernameOrEmail) {
      res.status(400).json({
        success: false,
        message: 'Username or email is required'
      });
      return;
    }

    // Get database client (works with SQLite or PostgreSQL)
    const prisma = await getPrisma();

    // Check if user exists in local database
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: usernameOrEmail },
          { email: usernameOrEmail }
        ]
      },
      select: {
        id: true,
        username: true,
        email: true,
        isActive: true
      }
    });

    if (user) {
      res.json({
        success: true,
        exists: true,
        isActive: user.isActive,
        message: user.isActive 
          ? 'User exists and is approved. You can login offline.' 
          : 'User exists but is pending approval. Internet required for activation check.'
      });
    } else {
      res.json({
        success: true,
        exists: false,
        isActive: false,
        message: 'User not found in local database. Internet required for first-time sign-in.'
      });
    }
  } catch (error) {
    console.error('Check local user error:', error);
    res.status(500).json({
      success: false,
      exists: false,
      isActive: false,
      message: 'Error checking local user'
    });
  }
};