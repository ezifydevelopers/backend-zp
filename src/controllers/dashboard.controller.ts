import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { AuthRequest, buildAdminWhereClause, buildBranchWhereClause } from '../middleware/auth.middleware';

export const getDashboardStats = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { branchId = '' } = req.query;
    const userId = (req as any).user?.id;

    // Build where clause with data isolation
    const where: any = buildBranchWhereClause(req, {});

    if (branchId) {
      where.branchId = branchId;
    }

    // Get today's date range
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Get sales stats for today (excluding REFUNDED sales)
    const todaySales = await prisma.sale.aggregate({
      where: {
        ...where,
        createdAt: {
          gte: today,
          lt: tomorrow
        },
        status: { not: 'REFUNDED' } // Exclude refunded sales from totals
      },
      _sum: {
        totalAmount: true,
        subtotal: true,
        taxAmount: true
      },
      _count: {
        id: true
      }
    });

    // Get total sales stats (excluding REFUNDED sales)
    const totalSales = await prisma.sale.aggregate({
      where: {
        ...where,
        status: { not: 'REFUNDED' } // Exclude refunded sales from totals
      },
      _sum: {
        totalAmount: true,
        subtotal: true,
        taxAmount: true
      },
      _count: {
        id: true
      }
    });

    // Get total products count
    const totalProducts = await prisma.product.count({
      where: {
        ...where,
        isActive: true
      }
    });

    // Get low stock products count (calculated from batches)
    const allProducts = await prisma.product.findMany({
      where: {
        ...where,
        isActive: true
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

    const lowStockProducts = allProducts.filter(product => {
      const totalStock = product.batches.reduce((sum, batch) => sum + batch.quantity, 0);
      return totalStock <= product.minStock;
    }).length;

    // Get total customers count
    const totalCustomers = await prisma.customer.count({
      where: {
        ...where,
        isActive: true
      }
    });

    // Get recent sales
    const recentSales = await prisma.sale.findMany({
      where,
      take: 5,
      orderBy: {
        createdAt: 'desc'
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true
          }
        },
        user: {
          select: {
            id: true,
            name: true,
            username: true
          }
        }
      }
    });

    return res.json({
      success: true,
      data: {
        todayStats: {
          sales: todaySales._count.id,
          revenue: todaySales._sum.totalAmount || 0,
          subtotal: todaySales._sum.subtotal || 0,
          tax: todaySales._sum.taxAmount || 0
        },
        totalStats: {
          sales: totalSales._count.id,
          revenue: totalSales._sum.totalAmount || 0,
          subtotal: totalSales._sum.subtotal || 0,
          tax: totalSales._sum.taxAmount || 0
        },
        inventory: {
          totalProducts,
          lowStockProducts
        },
        customers: {
          total: totalCustomers
        },
        recentSales
      }
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getSalesChart = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const {
      branchId = '',
      period = '7d', // 7d, 30d, 90d, 1y
      groupBy = 'day' // day, week, month
    } = req.query;

    const where: any = {};
    if (branchId) {
      where.branchId = branchId;
    }

    // Calculate date range based on period
    const endDate = new Date();
    const startDate = new Date();

    switch (period) {
      case '7d':
        startDate.setDate(endDate.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(endDate.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(endDate.getDate() - 90);
        break;
      case '1y':
        startDate.setFullYear(endDate.getFullYear() - 1);
        break;
      default:
        startDate.setDate(endDate.getDate() - 7);
    }

    where.createdAt = {
      gte: startDate,
      lte: endDate
    };

    let chartData;

    if (groupBy === 'day') {
      // Group by day
      const sales = await prisma.sale.findMany({
        where,
        select: {
          createdAt: true,
          totalAmount: true
        },
        orderBy: {
          createdAt: 'asc'
        }
      });

      // Group by date
      const dailyData: { [key: string]: { total: number; count: number } } = {};
      sales.forEach((sale: any) => {
        const dateKey = sale.createdAt.toISOString().split('T')[0];
        if (!dailyData[dateKey]) {
          dailyData[dateKey] = { total: 0, count: 0 };
        }
        dailyData[dateKey].total += sale.totalAmount;
        dailyData[dateKey].count += 1;
      });

      chartData = Object.entries(dailyData).map(([date, data]) => ({
        date,
        revenue: data.total,
        sales: data.count
      }));
    } else if (groupBy === 'week') {
      // Group by week
      const sales = await prisma.sale.findMany({
        where,
        select: {
          createdAt: true,
          totalAmount: true
        },
        orderBy: {
          createdAt: 'asc'
        }
      });

      const weeklyData: { [key: string]: { total: number; count: number } } = {};
      sales.forEach((sale: any) => {
        const weekStart = new Date(sale.createdAt);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        const weekKey = weekStart.toISOString().split('T')[0];

        if (!weeklyData[weekKey]) {
          weeklyData[weekKey] = { total: 0, count: 0 };
        }
        weeklyData[weekKey].total += sale.totalAmount;
        weeklyData[weekKey].count += 1;
      });

      chartData = Object.entries(weeklyData).map(([week, data]) => ({
        week,
        revenue: data.total,
        sales: data.count
      }));
    } else if (groupBy === 'month') {
      // Group by month
      const sales = await prisma.sale.findMany({
        where,
        select: {
          createdAt: true,
          totalAmount: true
        },
        orderBy: {
          createdAt: 'asc'
        }
      });

      const monthlyData: { [key: string]: { total: number; count: number } } = {};
      sales.forEach((sale: any) => {
        const monthKey = `${sale.createdAt.getFullYear()}-${String(sale.createdAt.getMonth() + 1).padStart(2, '0')}`;
        if (!monthlyData[monthKey]) {
          monthlyData[monthKey] = { total: 0, count: 0 };
        }
        monthlyData[monthKey].total += sale.totalAmount;
        monthlyData[monthKey].count += 1;
      });

      chartData = Object.entries(monthlyData).map(([month, data]) => ({
        month,
        revenue: data.total,
        sales: data.count
      }));
    }

    return res.json({
      success: true,
      data: {
        period,
        groupBy,
        chartData: chartData || []
      }
    });
  } catch (error) {
    console.error('Get sales chart error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get admin dashboard stats (all branches)
export const getAdminDashboardStats = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    // Get total revenue across all branches
    const totalRevenue = await prisma.sale.aggregate({
      _sum: {
        totalAmount: true
      }
    });

    // Get total sales count across all branches
    const totalSales = await prisma.sale.count();

    // Get total users across all branches
    const totalUsers = await prisma.user.count({
      where: {
        isActive: true
      }
    });

    // Get total branches
    const totalBranches = await prisma.branch.count({
      where: {
        isActive: true
      }
    });

    // Get recent sales (last 10)
    const recentSales = await prisma.sale.findMany({
      take: 10,
      orderBy: {
        createdAt: 'desc'
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true
          }
        },
        user: {
          select: {
            id: true,
            name: true,
            username: true
          }
        },
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    // Get low stock products across all branches
    const lowStockProducts = await prisma.product.findMany({
      where: {
        isActive: true
      },
      include: {
        batches: {
          where: {
            isActive: true,
            quantity: { gt: 0 }
          },
          select: {
            quantity: true
          }
        },
        branch: {
          select: {
            name: true
          }
        }
      },
      take: 10
    });

    // Filter products with low stock based on batch quantities
    const filteredLowStockProducts = lowStockProducts.filter(product => {
      const totalStock = product.batches.reduce((sum: number, batch: any) => sum + batch.quantity, 0);
      return totalStock <= product.minStock;
    }).map((product: any) => ({
      id: product.id,
      name: product.name,
      stock: product.batches.reduce((sum: number, batch: any) => sum + batch.quantity, 0),
      minStock: product.minStock,
      branch: product.branch
    }));

    // Get branch performance
    const branchPerformance = await prisma.branch.findMany({
      where: {
        isActive: true
      },
      include: {
        _count: {
          select: {
            users: true,
            sales: true
          }
        },
        sales: {
          select: {
            totalAmount: true
          }
        }
      }
    });

    const branchStats = branchPerformance.map((branch: any) => ({
      id: branch.id,
      name: branch.name,
      users: branch._count.users,
      sales: branch._count.sales,
      revenue: branch.sales.reduce((sum: number, sale: any) => sum + sale.totalAmount, 0)
    }));

    // Get recent users who made purchases
    const recentUsers = await prisma.user.findMany({
      where: {
        isActive: true,
        sales: {
          some: {}
        }
      },
      include: {
        branch: {
          select: {
            name: true
          }
        },
        sales: {
          take: 1,
          orderBy: {
            createdAt: 'desc'
          },
          select: {
            createdAt: true,
            totalAmount: true
          }
        }
      },
      orderBy: {
        updatedAt: 'desc'
      },
      take: 10
    });

    return res.json({
      success: true,
      data: {
        totalRevenue: totalRevenue._sum.totalAmount || 0,
        totalSales,
        totalUsers,
        totalBranches,
        recentSales,
        lowStockProducts: filteredLowStockProducts,
        branchPerformance: branchStats,
        recentUsers: recentUsers.map((user: any) => ({
          id: user.id,
          name: user.name,
          username: user.username,
          branch: user.branch?.name || 'No Branch',
          lastPurchase: user.sales[0]?.createdAt,
          lastPurchaseAmount: user.sales[0]?.totalAmount || 0
        }))
      }
    });
  } catch (error) {
    console.error('Get admin dashboard stats error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get top selling products
export const getTopSellingProducts = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { branchId = '', limit = 10 } = req.query;

    const where: any = {};
    if (branchId) {
      where.branchId = branchId;
    }

    const topProducts = await prisma.saleItem.groupBy({
      by: ['productId'],
      where: {
        sale: where
      },
      _sum: {
        quantity: true,
        totalPrice: true
      },
      _count: {
        productId: true
      },
      orderBy: {
        _sum: {
          quantity: 'desc'
        }
      },
      take: parseInt(limit as string)
    });

    // Get product details
    const productIds = topProducts.map((item: any) => item.productId);
    const products = await prisma.product.findMany({
      where: {
        id: {
          in: productIds
        }
      },
      include: {
        batches: {
          where: {
            isActive: true,
            quantity: { gt: 0 }
          },
          select: {
            sellingPrice: true
          },
          take: 1
        },
        category: {
          select: {
            name: true
          }
        }
      }
    });

    const productMap = new Map(products.map((p: any) => [p.id, p]));

    const result = topProducts.map((item: any) => {
      const product = productMap.get(item.productId);
      return {
        productId: item.productId,
        product: product ? {
          ...product,
          price: product.batches[0]?.sellingPrice || 0
        } : null,
        totalQuantity: item._sum.quantity || 0,
        totalRevenue: item._sum.totalPrice || 0,
        salesCount: item._count.productId
      };
    });

    return res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Get top selling products error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get sales by payment method
export const getSalesByPaymentMethod = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { branchId = '' } = req.query;

    const where: any = {};
    if (branchId) {
      where.branchId = branchId;
    }

    const salesByPaymentMethod = await prisma.sale.groupBy({
      by: ['paymentMethod'],
      where,
      _sum: {
        totalAmount: true
      },
      _count: {
        id: true
      }
    });

    return res.json({
      success: true,
      data: salesByPaymentMethod
    });
  } catch (error) {
    console.error('Get sales by payment method error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
