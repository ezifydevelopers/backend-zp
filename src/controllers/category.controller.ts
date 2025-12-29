import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Validation schemas
const createCategorySchema = Joi.object({
  name: Joi.string().required(),
  description: Joi.string().allow('', null),
  type: Joi.string().valid('MEDICAL', 'NON_MEDICAL', 'GENERAL').default('GENERAL'),
  color: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).default('#3B82F6'),
  branchId: Joi.string().allow('', null).optional(), // Allow empty string and null
  companyId: Joi.string().allow('', null).optional() // Allow empty string and null
});

const updateCategorySchema = Joi.object({
  name: Joi.string(),
  description: Joi.string().allow(''),
  type: Joi.string().valid('MEDICAL', 'NON_MEDICAL', 'GENERAL'),
  color: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/)
});

export const getCategories = async (req: AuthRequest, res: Response) => {
  try {
    // 🔄 PULL LATEST FROM LIVE DATABASE FIRST
    await pullLatestFromLive('category').catch(err => console.log('[Sync] Pull categories:', err.message));

    const prisma = await getPrisma();
    const { page = 1, limit = 50, search = '', branchId = '' } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where: any = {};

    // Determine branch ID - prioritize query param, then user's branch, then selected branch
    const targetBranchId = branchId && typeof branchId === 'string' && branchId.trim() !== ''
      ? branchId
      : req.user?.selectedBranchId || req.user?.branchId;

    // Determine company ID for additional filtering
    const targetCompanyId = req.user?.selectedCompanyId || req.user?.companyId;

    // PRIORITY: Filter by branchId first (main isolation mechanism)
    // Also include legacy categories (without branchId) for backward compatibility
    if (targetBranchId) {
      // For backward compatibility: show categories with matching branchId OR categories without branchId created by same admin
      const branchConditions: any[] = [
        { branchId: targetBranchId } // Categories assigned to this branch
      ];

      // Include legacy categories (without branchId) if they match the user's createdBy
      // This allows backward compatibility with old data
      if (req.user?.role !== 'SUPERADMIN') {
        const userCreatedBy = req.user?.createdBy || req.user?.id;
        if (userCreatedBy) {
          // Legacy categories: no branchId AND created by same admin
          branchConditions.push({
            AND: [
              { branchId: null }, // No branchId (legacy category)
              { createdBy: userCreatedBy } // Created by same admin
            ]
          });
        }
      }

      where.OR = branchConditions;
    } else {
      // Only use createdBy as fallback if no branchId is available
      // This handles backward compatibility with old data
      if (req.user?.role === 'SUPERADMIN') {
        // SUPERADMIN can see all categories if no branch selected
        // No additional filtering needed
      } else if (req.user?.role === 'ADMIN') {
        // For ADMIN users, use their createdBy field
        where.createdBy = req.user.createdBy || req.user.id;
      } else if (req.user?.createdBy) {
        // Other users see categories from their admin
        where.createdBy = req.user.createdBy;
      } else if (req.user?.id) {
        // Fallback to user ID if no createdBy
        where.createdBy = req.user.id;
      } else {
        // No access if no user context
        where.createdBy = 'non-existent-admin-id';
      }
    }

    // Build the final where clause
    let finalWhere: any = { ...where };

    // Add company filtering if available (additional isolation layer)
    // Need to handle this carefully when OR conditions exist
    if (targetCompanyId) {
      if (finalWhere.OR) {
        // For OR conditions, we want: (branchId match OR legacy) AND (companyId match OR no companyId)
        // This ensures legacy categories without companyId are also shown
        finalWhere.AND = [
          { OR: finalWhere.OR },
          {
            OR: [
              { companyId: targetCompanyId }, // Matches company
              { companyId: null } // No companyId (allow legacy categories)
            ]
          }
        ];
        delete finalWhere.OR;
      } else {
        // For simple case, allow categories with matching companyId OR no companyId
        finalWhere.OR = [
          { companyId: targetCompanyId },
          { companyId: null }
        ];
      }
    }

    // Optional: Filter by products if explicitly requested (for inventory management)
    if (targetBranchId && req.query.filterByProducts === 'true') {
      // Only show categories that have products in this branch
      const categoriesWithProductsInBranch = await prisma.product.findMany({
        where: {
          branchId: targetBranchId
        },
        select: {
          categoryId: true
        },
        distinct: ['categoryId']
      });

      // Filter out null/undefined categoryIds and get unique category IDs
      const categoryIds = categoriesWithProductsInBranch
        .map(p => p.categoryId)
        .filter((id): id is string => typeof id === 'string' && id.trim() !== '');
      if (categoryIds.length > 0) {
        if (finalWhere.AND) {
          finalWhere.AND.push({ id: { in: categoryIds } });
        } else {
          finalWhere.id = { in: categoryIds };
        }
      } else {
        // No categories with products, return empty result
        finalWhere.id = 'non-existent';
      }
    }

    // Add search conditions to finalWhere
    if (search) {
      if (finalWhere.AND) {
        finalWhere.AND.push({
          OR: [
            { name: { contains: search } },
            { description: { contains: search } }
          ]
        });
      } else if (finalWhere.OR) {
        // If OR exists (from branch conditions), wrap everything in AND
        finalWhere = {
          AND: [
            { OR: finalWhere.OR },
            {
              OR: [
                { name: { contains: search } },
                { description: { contains: search } }
              ]
            }
          ]
        };
      } else {
        finalWhere.OR = [
          { name: { contains: search } },
          { description: { contains: search } }
        ];
      }
    }

    console.log('🔍 Category query where clause:', JSON.stringify(finalWhere, null, 2));
    console.log('🔍 Target branchId:', targetBranchId);
    console.log('🔍 Target companyId:', targetCompanyId);

    const [categories, total] = await Promise.all([
      prisma.category.findMany({
        where: finalWhere,
        skip,
        take,
        include: {
          _count: {
            select: {
              products: true
            }
          }
        },
        orderBy: { name: 'asc' }
      }),
      prisma.category.count({ where: finalWhere })
    ]);

    console.log('🔍 Found categories:', categories.length, 'out of', total);
    if (categories.length > 0) {
      console.log('🔍 First category:', { id: categories[0].id, name: categories[0].name, branchId: categories[0].branchId });
    }

    return res.json({
      success: true,
      data: {
        categories,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get categories error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getCategory = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    // Build where clause with data isolation
    const where: any = { id };

    // Determine branch ID - prioritize user's selected branch, then user's branch
    const targetBranchId = req.user?.selectedBranchId || req.user?.branchId;
    const targetCompanyId = req.user?.selectedCompanyId || req.user?.companyId;

    // PRIORITY: Filter by branchId first (main isolation mechanism)
    if (targetBranchId) {
      where.branchId = targetBranchId;
    } else {
      // Only use createdBy as fallback if no branchId is available
      if (req.user?.role === 'SUPERADMIN') {
        // SUPERADMIN can see all categories
      } else if (req.user?.role === 'ADMIN') {
        // For ADMIN users, use their createdBy field
        where.createdBy = req.user.createdBy || req.user.id;
      } else if (req.user?.createdBy) {
        // Other users see categories from their admin
        where.createdBy = req.user.createdBy;
      } else if (req.user?.id) {
        // Fallback to user ID if no createdBy
        where.createdBy = req.user.id;
      } else {
        // No access if no user context
        where.createdBy = 'non-existent-admin-id';
      }
    }

    // Add company filtering if available
    if (targetCompanyId) {
      where.companyId = targetCompanyId;
    }

    const category = await prisma.category.findFirst({
      where,
      include: {
        _count: {
          select: {
            products: true
          }
        }
      }
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    return res.json({
      success: true,
      data: category
    });
  } catch (error) {
    console.error('Get category error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const createCategory = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    console.log('=== CREATE CATEGORY REQUEST ===');
    console.log('Request body:', req.body);
    console.log('User context:', { userId: req.user?.id, createdBy: req.user?.createdBy, role: req.user?.role });

    const { error } = createCategorySchema.validate(req.body);
    if (error) {
      console.log('Validation error:', error.details);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const { name, description, type, color, branchId, companyId } = req.body;

    // Get user's branch and company info from headers or user context
    // Priority: Request body > Headers > User context
    const headerBranchId = req.headers['x-branch-id'] as string;
    const headerCompanyId = req.headers['x-company-id'] as string;
    const userBranchId = req.user?.selectedBranchId || req.user?.branchId;
    const userCompanyId = req.user?.selectedCompanyId || req.user?.companyId;

    // Use provided branchId (not empty), or header, or user's branchId
    const categoryBranchId = (branchId && branchId.trim() !== '')
      ? branchId
      : (headerBranchId && headerBranchId.trim() !== '')
        ? headerBranchId
        : userBranchId;

    // Use provided companyId (not empty), or header, or user's companyId
    const categoryCompanyId = (companyId && companyId.trim() !== '')
      ? companyId
      : (headerCompanyId && headerCompanyId.trim() !== '')
        ? headerCompanyId
        : userCompanyId;

    console.log('Branch/Company resolution:', {
      providedBranchId: branchId,
      headerBranchId,
      userBranchId,
      resolvedBranchId: categoryBranchId,
      providedCompanyId: companyId,
      headerCompanyId,
      userCompanyId,
      resolvedCompanyId: categoryCompanyId
    });

    // Require branchId for category creation
    if (!categoryBranchId) {
      console.log('Category creation failed: No branchId provided');
      return res.status(400).json({
        success: false,
        message: 'Branch ID is required to create a category. Please ensure you are associated with a branch.'
      });
    }

    // Check if category with this name already exists for this branch
    // Priority: Check by branchId first (primary isolation)
    const where: any = {
      name: name,
      branchId: categoryBranchId // Always check by branchId
    };

    const existingCategory = await prisma.category.findFirst({
      where
    });

    if (existingCategory) {
      console.log('Category with this name already exists for this branch:', existingCategory);
      return res.status(400).json({
        success: false,
        message: 'Category with this name already exists in this branch'
      });
    }

    // Create category with branch and company IDs (branchId is required)
    const data: any = {
      name,
      description: description || null,
      type: type || 'GENERAL',
      color: color || '#3B82F6',
      branchId: categoryBranchId, // Always required - ensures branch isolation
      createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
    };

    // Add companyId if available (additional isolation layer)
    if (categoryCompanyId) {
      data.companyId = categoryCompanyId;
    }

    console.log('Creating category with data:', {
      name: data.name,
      branchId: data.branchId,
      companyId: data.companyId,
      createdBy: data.createdBy
    });

    const category = await prisma.category.create({
      data
    });

    console.log('Category created successfully:', {
      id: category.id,
      name: category.name,
      branchId: category.branchId,
      companyId: category.companyId
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('category', 'create', category).catch(err => {
      console.error('[Sync] Category create sync failed:', err.message);
    });

    return res.status(201).json({
      success: true,
      data: category
    });
  } catch (error) {
    console.error('Create category error:', error);
    console.error('Error details:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateCategory = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { error } = updateCategorySchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const updateData = req.body;

    // Check if category exists
    const existingCategory = await prisma.category.findUnique({
      where: { id }
    });

    if (!existingCategory) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Check if name already exists for this branch (if being updated)
    if (updateData.name && updateData.name !== existingCategory.name) {
      const targetBranchId = req.user?.selectedBranchId || req.user?.branchId || existingCategory.branchId;

      const nameExistsWhere: any = {
        name: updateData.name,
        id: { not: id } // Exclude current category
      };

      // Check by branchId (preferred method)
      if (targetBranchId) {
        nameExistsWhere.branchId = targetBranchId;
      } else {
        // Fallback to createdBy if no branchId
        nameExistsWhere.createdBy = req.user?.createdBy || req.user?.id;
      }

      const nameExists = await prisma.category.findFirst({
        where: nameExistsWhere
      });

      if (nameExists) {
        return res.status(400).json({
          success: false,
          message: 'Category with this name already exists in this branch'
        });
      }
    }

    const category = await prisma.category.update({
      where: { id },
      data: updateData
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('category', 'update', category).catch(err => {
      console.error('[Sync] Category update sync failed:', err.message);
    });

    return res.json({
      success: true,
      data: category
    });
  } catch (error) {
    console.error('Update category error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteCategory = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const category = await prisma.category.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            products: true
          }
        }
      }
    });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Check if category has products
    if (category._count.products > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete category with existing products'
      });
    }

    await prisma.category.delete({
      where: { id }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('category', 'delete', { id }).catch(err => {
      console.error('[Sync] Category delete sync failed:', err.message);
    });

    return res.json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (error) {
    console.error('Delete category error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
