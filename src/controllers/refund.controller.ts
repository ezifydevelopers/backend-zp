import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { AuthRequest, buildBranchWhereClause, buildBranchWhereClauseForRelation } from '../middleware/auth.middleware';
import { notifyRefundChange } from '../routes/sse.routes';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Utility function to convert BigInt, Decimal, and Date values to strings for JSON serialization
function serializeBigInt(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  if (obj instanceof Date) {
    return obj.toISOString();
  }

  // Handle Prisma Decimal values
  if (obj && typeof obj === 'object' && obj.constructor && obj.constructor.name === 'Decimal') {
    return obj.toString();
  }

  // Handle Prisma Decimal values (alternative check)
  if (obj && typeof obj === 'object' && obj.toString && typeof obj.toString === 'function' && obj.constructor && obj.constructor.name === 'i') {
    return obj.toString();
  }

  if (Array.isArray(obj)) {
    return obj.map(serializeBigInt);
  }

  if (typeof obj === 'object') {
    // Check if it's a Date-like object (Prisma sometimes returns Date-like objects)
    if (obj.constructor && obj.constructor.name === 'Date') {
      return new Date(obj).toISOString();
    }
    const serialized: any = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        serialized[key] = serializeBigInt(obj[key]);
      }
    }
    return serialized;
  }

  return obj;
}

interface RefundItem {
  productId: string;
  quantity: number;
  unitPrice: number;
  reason: string;
}

interface CreateRefundData {
  originalSaleId: string;
  refundReason: string;
  items: RefundItem[];
  refundedBy: string;
}

const createRefundSchema = Joi.object({
  originalSaleId: Joi.string().required(),
  refundReason: Joi.string().required(),
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().positive().required(),
      unitPrice: Joi.number().positive().required(),
      reason: Joi.string().required(),
      batchId: Joi.string().allow(null, '').optional(), // Optional batch ID for stock return
      saleItemId: Joi.string().allow(null, '').optional() // Optional sale item ID
    })
  ).min(1).required(),
  refundedBy: Joi.string().required()
});

export const createRefund = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    console.log('🔍 DEBUG - Refund request received:', JSON.stringify(req.body, null, 2));

    const { error } = createRefundSchema.validate(req.body);
    if (error) {
      console.log('❌ Validation error:', error.details);
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
      return;
    }

    const { originalSaleId, refundReason, items, refundedBy } = req.body;
    console.log('🔍 DEBUG - Processing refund for sale:', originalSaleId);

    // Verify the original sale exists and get sale items with batch info
    const originalSale = await prisma.sale.findUnique({
      where: { id: originalSaleId },
      include: {
        items: {
          include: {
            product: true,
            batch: true
          }
        }
      }
    });

    if (!originalSale) {
      res.status(404).json({
        success: false,
        message: 'Original sale not found'
      });
      return;
    }

    // Check if sale is already refunded
    if (originalSale.status === 'REFUNDED') {
      res.status(400).json({
        success: false,
        message: 'This sale has already been refunded'
      });
      return;
    }

    // Calculate total refund amount
    const refundAmount = items.reduce((sum: number, item: any) => sum + (item.quantity * item.unitPrice), 0);

    // Use transaction to ensure data consistency
    const result = await prisma.$transaction(async (tx: any) => {
      console.log('🔍 DEBUG - Starting refund transaction');

      // Create refund record
      const refund = await tx.refund.create({
        data: {
          originalSaleId,
          refundReason,
          refundedBy,
          refundAmount,
          createdBy: req.user?.createdBy || req.user?.id,
          status: 'PROCESSED',
          processedAt: new Date()
        }
      });

      console.log('🔍 DEBUG - Refund created with ID:', refund.id);

      // Process each refunded item
      const refundItems = [];
      for (const item of items) {
        console.log('🔍 DEBUG - Processing refund item:', item);

        // Verify the product exists
        const product = await tx.product.findUnique({
          where: { id: item.productId }
        });

        if (!product) {
          console.log('❌ Product not found:', item.productId);
          throw new Error(`Product with ID ${item.productId} not found`);
        }

        console.log('🔍 DEBUG - Found product:', product.name);

        // Create refund item record
        const refundItem = await tx.refundItem.create({
          data: {
            refundId: refund.id,
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            reason: item.reason,
            createdBy: req.user?.createdBy || req.user?.id
          }
        });

        // Find the batch to return items to
        // First try to use the batchId from the refund item if provided
        let batchId = item.batchId;

        // If no batchId provided, try to find it from the original sale items
        if (!batchId) {
          const originalSaleItem = originalSale.items.find(
            (si: any) => si.productId === item.productId && si.batchId
          );
          if (originalSaleItem) {
            batchId = originalSaleItem.batchId;
          }
        }

        // Update batch quantity (add items back to inventory)
        if (batchId) {
          console.log('🔍 DEBUG - Adding', item.quantity, 'items back to batch:', batchId);
          await tx.batch.update({
            where: { id: batchId },
            data: {
              quantity: {
                increment: item.quantity
              }
            }
          });
          console.log('✅ DEBUG - Batch quantity updated');
        } else {
          // If no specific batch, try to find any active batch for this product and branch
          const activeBatch = await tx.batch.findFirst({
            where: {
              productId: item.productId,
              branchId: originalSale.branchId,
              isActive: true
            },
            orderBy: { expireDate: 'asc' }
          });

          if (activeBatch) {
            console.log('🔍 DEBUG - Adding', item.quantity, 'items back to first available batch:', activeBatch.id);
            await tx.batch.update({
              where: { id: activeBatch.id },
              data: {
                quantity: {
                  increment: item.quantity
                }
              }
            });
            console.log('✅ DEBUG - Batch quantity updated');
          } else {
            console.log('⚠️ DEBUG - No batch found to return items to for product:', product.name);
          }
        }

        // Create stock movement record for the return
        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: 'RETURN',
            quantity: item.quantity,
            reason: `Refund: ${item.reason}`,
            reference: `REF-${refund.id}`,
            createdBy: req.user?.createdBy || req.user?.id
          }
        });

        refundItems.push(refundItem);
      }

      // Update original sale status to REFUNDED
      await tx.sale.update({
        where: { id: originalSaleId },
        data: {
          status: 'REFUNDED',
          updatedAt: new Date()
        }
      });

      console.log('✅ DEBUG - Sale status updated to REFUNDED');

      return { refund, refundItems };
    });

    // Send real-time notification to all users of the same admin
    const createdBy = req.user?.createdBy || req.user?.id;
    if (createdBy) {
      notifyRefundChange(createdBy, 'created', result.refund);
    }

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('refund', 'create', result.refund).catch(err => {
      console.error('[Sync] Refund create sync failed:', err.message);
    });

    res.status(201).json({
      success: true,
      data: {
        refund: result.refund,
        items: result.refundItems
      },
      message: 'Refund processed successfully. Items have been added back to inventory.'
    });

  } catch (error: any) {
    console.error('Create refund error:', error);
    res.status(500).json({
      success: false,
      message: error?.message || 'Internal server error'
    });
  }
};

export const getRefunds = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const {
      page = 1,
      limit = 10,
      search = '',
      startDate = '',
      endDate = '',
      branchId = ''
    } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    console.log('🔍 getRefunds - User context:', {
      userId: req.user?.id,
      role: req.user?.role,
      branchId: req.user?.branchId,
      companyId: req.user?.companyId,
      createdBy: req.user?.createdBy
    });

    // Build where clause - filter by original sale's branch/company
    const whereClause: any = {};

    // Get the target branch/company based on user role
    let targetBranchId = req.user?.selectedBranchId || req.user?.branchId;
    let targetCompanyId = req.user?.selectedCompanyId || req.user?.companyId;

    // If user has branchId but no companyId, get it from branch
    if (targetBranchId && !targetCompanyId) {
      const branch = await prisma.branch.findUnique({
        where: { id: targetBranchId },
        select: { companyId: true }
      });
      if (branch?.companyId) {
        targetCompanyId = branch.companyId;
      }
    }

    // Filter refunds through their original sale
    if (req.user?.role === 'SUPERADMIN') {
      // SuperAdmin can see all refunds
    } else if (req.user?.role === 'ADMIN') {
      // Admin sees refunds from sales created by them or their staff
      whereClause.originalSale = {
        createdBy: req.user.createdBy || req.user.id
      };
    } else if (req.user?.role === 'MANAGER' && targetBranchId) {
      // Manager sees refunds for their branch
      whereClause.originalSale = {
        branchId: targetBranchId
      };
    } else if (req.user?.role === 'CASHIER' && targetBranchId) {
      // Cashier sees refunds for their branch
      whereClause.originalSale = {
        branchId: targetBranchId
      };
    }

    // Apply branch filter if provided
    if (branchId) {
      whereClause.originalSale = {
        ...whereClause.originalSale,
        branchId: branchId as string
      };
    }

    // Search filter
    if (search) {
      whereClause.OR = [
        { refundReason: { contains: search as string } },
        { id: { contains: search as string } }
      ];
    }

    // Date range filter
    if (startDate || endDate) {
      whereClause.createdAt = {};
      if (startDate) {
        whereClause.createdAt.gte = new Date(startDate as string);
      }
      if (endDate) {
        const endDateWithTime = new Date(endDate as string);
        endDateWithTime.setHours(23, 59, 59, 999);
        whereClause.createdAt.lte = endDateWithTime;
      }
    }

    console.log('🔍 getRefunds - Where clause:', JSON.stringify(whereClause, null, 2));

    const [refunds, total] = await Promise.all([
      prisma.refund.findMany({
        where: whereClause,
        include: {
          originalSale: {
            include: {
              customer: true,
              user: {
                select: {
                  id: true,
                  name: true,
                  username: true
                }
              },
              receipts: true,
              items: {
                include: {
                  product: true
                }
              }
            }
          },
          items: {
            include: {
              product: true
            }
          },
          refundedByUser: {
            select: {
              id: true,
              name: true,
              username: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit)
      }),
      prisma.refund.count({ where: whereClause })
    ]);

    console.log('🔍 getRefunds - Found', refunds.length, 'refunds, total:', total);

    const serializedRefunds = serializeBigInt(refunds);

    res.json({
      success: true,
      data: {
        refunds: serializedRefunds,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });

  } catch (error) {
    console.error('Get refunds error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getRefundById = async (req: Request, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const refund = await prisma.refund.findUnique({
      where: { id },
      include: {
        originalSale: {
          include: {
            customer: true,
            user: true,
            receipts: true,
            items: {
              include: {
                product: true
              }
            }
          }
        },
        items: {
          include: {
            product: true
          }
        },
        refundedByUser: {
          select: {
            id: true,
            name: true,
            username: true
          }
        }
      }
    });

    if (!refund) {
      res.status(404).json({
        success: false,
        message: 'Refund not found'
      });
      return;
    }

    res.json({
      success: true,
      data: serializeBigInt(refund)
    });

  } catch (error) {
    console.error('Get refund by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
