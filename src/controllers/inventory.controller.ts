import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { AuthRequest } from '../middleware/auth.middleware';

// Get inventory summary (stock levels by product)
export const getInventorySummary = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { page = 1, limit = 10, search, categoryId, lowStock } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    let branchId: string | undefined = req.user?.selectedBranchId || req.user?.branchId;
    let companyId: string | undefined = req.user?.selectedCompanyId || req.user?.companyId;

    // If user doesn't have branch/company context, get it from their admin
    if (!branchId || !companyId) {
      if (req.user?.createdBy) {
        const adminUser = await prisma.user.findUnique({
          where: { id: req.user.createdBy },
          select: { branchId: true, companyId: true }
        });

        if (adminUser) {
          branchId = branchId || adminUser.branchId || undefined;
          companyId = companyId || adminUser.companyId || undefined;
        }
      }
    }

    if (!branchId || !companyId) {
      return res.status(400).json({
        success: false,
        message: 'Branch and company context required. Please ensure you have proper access permissions.',
      });
    }

    const where: any = {
      branchId,
      companyId,
      isActive: true,
    };

    if (search) {
      where.OR = [
        { name: { contains: search as string } },
        { sku: { contains: search as string } },
        { barcode: { contains: search as string } },
        { formula: { contains: search as string } } // Search by formula/composition
      ];
    }

    if (categoryId) {
      where.categoryId = categoryId;
    }

    // Note: lowStock filtering will be handled after fetching products with batch data

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          category: {
            select: {
              id: true,
              name: true,
              type: true,
            },
          },
          supplier: {
            select: {
              id: true,
              name: true,
            },
          },
          batches: {
            where: {
              isActive: true,
              quantity: {
                gt: 0,
              },
            },
            select: {
              id: true,
              batchNo: true,
              quantity: true,
              expireDate: true,
              purchasePrice: true,
              sellingPrice: true,
            },
            orderBy: { expireDate: 'asc' },
          },
        },
        orderBy: { name: 'asc' },
        skip,
        take: Number(limit),
      }),
      prisma.product.count({ where }),
    ]);

    // Calculate batch totals and expiry warnings
    const inventoryData = products.map(product => {
      // Filter out expired batches for stock calculation
      const activeBatches = product.batches.filter(batch => {
        if (!batch.expireDate) return true; // Include batches without expiry date
        return new Date(batch.expireDate) > new Date(); // Only include non-expired batches
      });

      const totalBatchQuantity = activeBatches.reduce((sum, batch) => sum + batch.quantity, 0);
      const nearExpiryBatches = product.batches.filter(batch => {
        if (!batch.expireDate) return false;
        const daysUntilExpiry = Math.ceil((new Date(batch.expireDate).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
        return daysUntilExpiry <= 30 && daysUntilExpiry > 0;
      });
      const expiredBatches = product.batches.filter(batch => {
        if (!batch.expireDate) return false;
        return new Date(batch.expireDate) < new Date();
      });

      return {
        ...product,
        stock: totalBatchQuantity, // Use only active (non-expired) batch quantities
        totalBatchQuantity,
        nearExpiryBatches: nearExpiryBatches.length,
        expiredBatches: expiredBatches.length,
        isLowStock: totalBatchQuantity <= product.minStock,
        stockStatus: totalBatchQuantity <= product.minStock ? 'LOW' :
                    totalBatchQuantity <= product.minStock * 2 ? 'MEDIUM' : 'GOOD',
      };
    });

    return res.json({
      success: true,
      data: inventoryData,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get inventory summary error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Get inventory by batches
export const getInventoryByBatches = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { page = 1, limit = 10, search, productId, nearExpiry, expired, branchId: queryBranchId } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    // Priority: query param > header > user's assigned branch
    let branchId: string | undefined = queryBranchId as string || req.user?.selectedBranchId || req.user?.branchId;
    let companyId: string | undefined = req.user?.selectedCompanyId || req.user?.companyId;

    console.log('🔍 getInventoryByBatches - Initial context:', {
      queryBranchId,
      branchId,
      companyId,
      userId: req.user?.id,
      role: req.user?.role,
      createdBy: req.user?.createdBy
    });

    // If user doesn't have branch/company context, get it from their admin
    if (!branchId || !companyId) {
      if (req.user?.createdBy) {
        const adminUser = await prisma.user.findUnique({
          where: { id: req.user.createdBy },
          select: { branchId: true, companyId: true }
        });

        if (adminUser) {
          branchId = branchId || adminUser.branchId || undefined;
          companyId = companyId || adminUser.companyId || undefined;
        }
      }
    }

    // If we have branchId but no companyId, get companyId from the branch
    if (branchId && !companyId) {
      const branch = await prisma.branch.findUnique({
        where: { id: branchId },
        select: { companyId: true }
      });
      if (branch?.companyId) {
        companyId = branch.companyId;
        console.log('🔍 Got companyId from branch:', companyId);
      }
    }

    // For ADMIN and SUPERADMIN, if still no branch, try to get from the product if productId is provided
    if (!branchId && productId && (req.user?.role === 'ADMIN' || req.user?.role === 'SUPERADMIN')) {
      const product = await prisma.product.findUnique({
        where: { id: productId as string },
        select: { branchId: true, companyId: true }
      });
      if (product) {
        branchId = product.branchId;
        companyId = product.companyId;
        console.log('🔍 Got context from product:', { branchId, companyId });
      }
    }

    console.log('🔍 getInventoryByBatches - Final context:', { branchId, companyId });

    if (!branchId || !companyId) {
      return res.status(400).json({
        success: false,
        message: 'Branch and company context required. Please select a branch from the dropdown or ensure you have proper access permissions.',
      });
    }

    const where: any = {
      branchId,
      companyId,
      isActive: true,
      quantity: {
        gt: 0,
      },
    };

    if (search) {
      where.OR = [
        { batchNo: { contains: search as string } },
        { product: { name: { contains: search as string } } },
        { product: { sku: { contains: search as string } } },
        { product: { formula: { contains: search as string } } } // Search by product formula
      ];
    }

    if (productId) {
      where.productId = productId;
    }

    if (nearExpiry === 'true') {
      const thirtyDaysFromNow = new Date();
      thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

      where.expireDate = {
        lte: thirtyDaysFromNow,
        gte: new Date(),
      };
    }

    if (expired === 'true') {
      where.expireDate = {
        lt: new Date(),
      };
    }

    const [batches, total] = await Promise.all([
      prisma.batch.findMany({
        where,
        include: {
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              barcode: true,
              minStock: true,
            },
          },
          supplier: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: [
          { expireDate: 'asc' },
          { createdAt: 'asc' },
        ],
        skip,
        take: Number(limit),
      }),
      prisma.batch.count({ where }),
    ]);

    // Add expiry status to each batch
    const batchData = batches.map(batch => {
      let expiryStatus = 'GOOD';
      if (batch.expireDate) {
        const daysUntilExpiry = Math.ceil((new Date(batch.expireDate).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
        if (daysUntilExpiry < 0) {
          expiryStatus = 'EXPIRED';
        } else if (daysUntilExpiry <= 7) {
          expiryStatus = 'CRITICAL';
        } else if (daysUntilExpiry <= 30) {
          expiryStatus = 'WARNING';
        }
      }

      return {
        ...batch,
        expiryStatus,
        daysUntilExpiry: batch.expireDate ?
          Math.ceil((new Date(batch.expireDate).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)) :
          null,
      };
    });

    return res.json({
      success: true,
      data: batchData,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get inventory by batches error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Get inventory reports
export const getInventoryReports = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    let branchId: string | undefined = req.user?.selectedBranchId || req.user?.branchId;
    let companyId: string | undefined = req.user?.selectedCompanyId || req.user?.companyId;

    // If user doesn't have branch/company context, get it from their admin
    if (!branchId || !companyId) {
      if (req.user?.createdBy) {
        const adminUser = await prisma.user.findUnique({
          where: { id: req.user.createdBy },
          select: { branchId: true, companyId: true }
        });

        if (adminUser) {
          branchId = branchId || adminUser.branchId || undefined;
          companyId = companyId || adminUser.companyId || undefined;
        }
      }
    }

    if (!branchId || !companyId) {
      return res.status(400).json({
        success: false,
        message: 'Branch and company context required. Please ensure you have proper access permissions.',
      });
    }

    // Get various inventory statistics
    const [
      totalProducts,
      lowStockProducts,
      nearExpiryBatches,
      expiredBatches,
      totalStockValue,
      categoryStats,
    ] = await Promise.all([
      // Total products
      prisma.product.count({
        where: {
          branchId,
          companyId,
          isActive: true,
        },
      }),

      // Low stock products
      // Count low stock products by checking batch quantities
      (async () => {
        const products = await prisma.product.findMany({
          where: {
            branchId,
            companyId,
            isActive: true,
          },
          include: {
            batches: {
              where: {
                isActive: true,
                quantity: { gt: 0 },
                OR: [
                  { expireDate: null },
                  { expireDate: { gt: new Date() } }
                ]
              },
              select: {
                quantity: true
              }
            }
          }
        });

        return products.filter(product => {
          const totalStock = product.batches.reduce((sum, batch) => sum + batch.quantity, 0);
          return totalStock <= product.minStock;
        }).length;
      })(),

      // Near expiry batches (within 30 days)
      prisma.batch.count({
        where: {
          branchId,
          companyId,
          isActive: true,
          quantity: { gt: 0 },
          expireDate: {
            lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            gte: new Date(),
          },
        },
      }),

      // Expired batches
      prisma.batch.count({
        where: {
          branchId,
          companyId,
          isActive: true,
          quantity: { gt: 0 },
          expireDate: {
            lt: new Date(),
          },
        },
      }),

      // Total stock value
      prisma.batch.aggregate({
        where: {
          branchId,
          companyId,
          isActive: true,
          quantity: { gt: 0 },
        },
        _sum: {
          quantity: true,
        },
      }),

      // Category statistics
      prisma.product.groupBy({
        by: ['categoryId'],
        where: {
          branchId,
          companyId,
          isActive: true,
        },
        _count: {
          id: true,
        },
        _sum: {
          minStock: true,
        },
      }),
    ]);

    // Get category names
    const categoryIds = categoryStats.map(stat => stat.categoryId);
    const categories = await prisma.category.findMany({
      where: {
        id: { in: categoryIds },
      },
      select: {
        id: true,
        name: true,
        type: true,
      },
    });

    const categoryStatsWithNames = categoryStats.map(stat => {
      const category = categories.find(cat => cat.id === stat.categoryId);
      return {
        categoryId: stat.categoryId,
        categoryName: category?.name || 'Unknown',
        categoryType: category?.type || 'GENERAL',
        productCount: stat._count.id,
        totalStock: stat._sum.minStock || 0,
      };
    });

    return res.json({
      success: true,
      data: {
        totalProducts,
        lowStockProducts,
        nearExpiryBatches,
        expiredBatches,
        totalStockValue: totalStockValue._sum.quantity || 0,
        categoryStats: categoryStatsWithNames,
      },
    });
  } catch (error) {
    console.error('Get inventory reports error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};
