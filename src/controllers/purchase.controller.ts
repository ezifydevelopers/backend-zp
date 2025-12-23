import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import Joi from 'joi';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';

// Joi schemas for validation
const createPurchaseSchema = Joi.object({
  supplierId: Joi.string().required(),
  invoiceNo: Joi.string().optional().allow(''),
  purchaseDate: Joi.date().iso().optional(),
  totalAmount: Joi.number().min(0).default(0),
  paidAmount: Joi.number().min(0).default(0),
  notes: Joi.string().optional().allow(''),
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().integer().min(1).required(),
      unitPrice: Joi.number().min(0).required(),
      batchNo: Joi.string().optional().allow(''),
      expireDate: Joi.date().iso().optional().allow(null),
      productionDate: Joi.date().iso().optional().allow(null),
    })
  ).min(1).required(),
});

const updatePurchaseSchema = Joi.object({
  supplierId: Joi.string().optional(),
  invoiceNo: Joi.string().optional().allow(''),
  purchaseDate: Joi.date().iso().optional(),
  totalAmount: Joi.number().min(0).optional(),
  paidAmount: Joi.number().min(0).optional(),
  status: Joi.string().valid('PENDING', 'COMPLETED', 'CANCELLED', 'PARTIAL').optional(),
  notes: Joi.string().optional().allow(''),
});

// Get all purchases
export const getPurchases = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { page = 1, limit = 10, status, supplierId } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {
      branchId: req.user?.selectedBranchId || req.user?.branchId,
      companyId: req.user?.selectedCompanyId || req.user?.companyId,
    };

    if (status) {
      where.status = status;
    }

    if (supplierId) {
      where.supplierId = supplierId;
    }

    const [purchases, total] = await Promise.all([
      prisma.purchase.findMany({
        where,
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              contactPerson: true,
              phone: true,
            },
          },
          purchaseItems: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  sku: true,
                  barcode: true,
                },
              },
              batch: {
                select: {
                  id: true,
                  batchNo: true,
                  quantity: true,
                  expireDate: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.purchase.count({ where }),
    ]);

    return res.json({
      success: true,
      data: purchases,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get purchases error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Get purchase by ID
export const getPurchaseById = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const purchase = await prisma.purchase.findUnique({
      where: { id },
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            contactPerson: true,
            phone: true,
          },
        },
        purchaseItems: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                sku: true,
                barcode: true,
              },
            },
            batch: {
              select: {
                id: true,
                batchNo: true,
                quantity: true,
                expireDate: true,
                productionDate: true,
              },
            },
          },
        },
      },
    });

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found',
      });
    }

    return res.json({
      success: true,
      data: purchase,
    });
  } catch (error) {
    console.error('Get purchase by ID error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Create new purchase
export const createPurchase = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { error, value } = createPurchaseSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message),
      });
    }

    const purchaseData = value;
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

    // Verify supplier exists
    const supplier = await prisma.supplier.findUnique({
      where: { id: purchaseData.supplierId },
    });

    if (!supplier) {
      return res.status(400).json({
        success: false,
        message: 'Supplier not found',
      });
    }

    // Calculate total amount
    const totalAmount = purchaseData.items.reduce((sum: number, item: any) => {
      return sum + (item.quantity * item.unitPrice);
    }, 0);

    const result = await prisma.$transaction(async (tx: any) => {
      // Create purchase
      const purchase = await tx.purchase.create({
        data: {
          supplierId: purchaseData.supplierId,
          branchId,
          companyId,
          invoiceNo: purchaseData.invoiceNo,
          purchaseDate: purchaseData.purchaseDate ? new Date(purchaseData.purchaseDate) : new Date(),
          totalAmount,
          paidAmount: purchaseData.paidAmount,
          outstanding: totalAmount - purchaseData.paidAmount,
          status: purchaseData.paidAmount >= totalAmount ? 'COMPLETED' : 'PENDING',
          notes: purchaseData.notes,
          createdBy: req.user?.id,
        },
      });

      // Create purchase items and batches
      const purchaseItems = [];
      for (const item of purchaseData.items) {
        // Verify product exists
        const product = await tx.product.findUnique({
          where: { id: item.productId },
        });

        if (!product) {
          throw new Error(`Product not found: ${item.productId}`);
        }

        // Create batch if batchNo is provided
        let batchId = null;
        if (item.batchNo) {
          const batch = await tx.batch.create({
            data: {
              batchNo: item.batchNo,
              productId: item.productId,
              branchId,
              companyId,
              supplierId: purchaseData.supplierId,
              quantity: item.quantity,
              purchasePrice: item.unitPrice,
              sellingPrice: item.unitPrice * 1.2, // Calculate selling price (20% markup)
              expireDate: item.expireDate ? new Date(item.expireDate) : null,
              productionDate: item.productionDate ? new Date(item.productionDate) : null,
              createdBy: req.user?.id,
            },
          });
          batchId = batch.id;

          // Stock is now managed through batches, no need to update product stock directly
        }

        // Create purchase item
        const purchaseItem = await tx.purchaseItem.create({
          data: {
            purchaseId: purchase.id,
            productId: item.productId,
            batchId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: item.quantity * item.unitPrice,
          },
        });

        purchaseItems.push(purchaseItem);
      }

      return { purchase, purchaseItems };
    });

    // Fetch the complete purchase with relations
    const completePurchase = await prisma.purchase.findUnique({
      where: { id: result.purchase.id },
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            contactPerson: true,
            phone: true,
          },
        },
        purchaseItems: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                sku: true,
                barcode: true,
              },
            },
            batch: {
              select: {
                id: true,
                batchNo: true,
                quantity: true,
                expireDate: true,
              },
            },
          },
        },
      },
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('purchase', 'create', completePurchase).catch(err => {
      console.error('[Sync] Purchase create sync failed:', err.message);
    });

    return res.status(201).json({
      success: true,
      data: completePurchase,
      message: 'Purchase created successfully',
    });
  } catch (error) {
    console.error('Create purchase error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Update purchase
export const updatePurchase = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { error, value } = updatePurchaseSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message),
      });
    }

    const updateData = value;

    // Check if purchase exists
    const existingPurchase = await prisma.purchase.findUnique({
      where: { id },
    });

    if (!existingPurchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found',
      });
    }

    // Calculate outstanding amount
    if (updateData.paidAmount !== undefined) {
      updateData.outstanding = existingPurchase.totalAmount - updateData.paidAmount;

      // Update status based on payment
      if (updateData.paidAmount >= existingPurchase.totalAmount) {
        updateData.status = 'COMPLETED';
      } else if (updateData.paidAmount > 0) {
        updateData.status = 'PARTIAL';
      } else {
        updateData.status = 'PENDING';
      }
    }

    const purchase = await prisma.purchase.update({
      where: { id },
      data: updateData,
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            contactPerson: true,
            phone: true,
          },
        },
        purchaseItems: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                sku: true,
                barcode: true,
              },
            },
            batch: {
              select: {
                id: true,
                batchNo: true,
                quantity: true,
                expireDate: true,
              },
            },
          },
        },
      },
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('purchase', 'update', purchase).catch(err => {
      console.error('[Sync] Purchase update sync failed:', err.message);
    });

    return res.json({
      success: true,
      data: purchase,
      message: 'Purchase updated successfully',
    });
  } catch (error) {
    console.error('Update purchase error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};

// Delete purchase
export const deletePurchase = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const purchase = await prisma.purchase.findUnique({
      where: { id },
      include: {
        purchaseItems: {
          include: {
            batch: true,
          },
        },
      },
    });

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found',
      });
    }

    await prisma.$transaction(async (tx: any) => {
      // Reverse stock updates for batches
      for (const item of purchase.purchaseItems) {
        // Stock is now managed through batches, no need to update product stock directly
      }

      // Delete purchase items and batches
      await tx.purchaseItem.deleteMany({
        where: { purchaseId: id },
      });

      // Delete batches created for this purchase
      const batchIds = purchase.purchaseItems
        .filter((item: any) => item.batchId)
        .map((item: any) => item.batchId!);

      if (batchIds.length > 0) {
        await tx.batch.deleteMany({
          where: { id: { in: batchIds } },
        });
      }

      // Delete purchase
      await tx.purchase.delete({
        where: { id },
      });
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('purchase', 'delete', { id }).catch(err => {
      console.error('[Sync] Purchase delete sync failed:', err.message);
    });

    return res.json({
      success: true,
      message: 'Purchase deleted successfully',
    });
  } catch (error) {
    console.error('Delete purchase error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
};
