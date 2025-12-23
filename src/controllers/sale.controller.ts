// CRITICAL: Import database initialization FIRST to ensure DATABASE_URL is set
import '../config/database.init';

import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { CreateSaleData, SaleResponse, PaymentStatus } from '../models/sale.model';
import { AuthRequest, buildBranchWhereClause } from '../middleware/auth.middleware';
import { notifySaleChange } from '../routes/sse.routes';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Validation schemas
const createSaleSchema = Joi.object({
  customerId: Joi.string().allow(null),
  branchId: Joi.string().required(),
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().min(1).required(),
      unitPrice: Joi.number().positive().required(),
      batchId: Joi.string().allow(null, ''), // Link to specific batch
      batchNumber: Joi.string().allow(''), // Keep for backward compatibility
      expiryDate: Joi.string().allow(''),
      discountPercentage: Joi.number().min(0).max(100).optional(), // Item-level discount
      discountAmount: Joi.number().min(0).optional(), // Item-level discount amount
      totalPrice: Joi.number().min(0).optional() // Item total after discount
    })
  ).min(1).required(),
  paymentMethod: Joi.string().valid('CASH', 'CARD', 'MOBILE', 'BANK_TRANSFER').required(),
  paymentStatus: Joi.string().valid('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED').optional(),
  discountAmount: Joi.number().min(0).default(0),
  discountPercentage: Joi.number().min(0).max(100).default(0),
  saleDate: Joi.date().optional()
});

export const getSales = async (req: AuthRequest, res: Response) => {
  try {
    // 🔄 PULL LATEST FROM LIVE DATABASE FIRST
    await Promise.all([
      pullLatestFromLive('sale').catch(err => console.log('[Sync] Pull sales:', err.message)),
      pullLatestFromLive('saleItem').catch(err => console.log('[Sync] Pull saleItems:', err.message))
    ]);

    const prisma = await getPrisma();
    const {
      page = 1,
      limit = 10,
      startDate = '',
      endDate = '',
      branchId = '',
      customerId = '',
      paymentMethod = ''
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    // Build where clause with data isolation
    const where: any = buildBranchWhereClause(req, {});

    // Additional branch filter only if not already filtered by buildBranchWhereClause
    if (branchId && req.user?.role !== 'MANAGER') {
      where.branchId = branchId;
    }

    if (customerId) {
      where.customerId = customerId;
    }

    if (paymentMethod) {
      where.paymentMethod = paymentMethod;
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        where.createdAt.gte = new Date(startDate as string);
      }
      if (endDate) {
        // Add 23:59:59 to end date to include the entire day
        const endDateWithTime = new Date(endDate as string);
        endDateWithTime.setHours(23, 59, 59, 999);
        where.createdAt.lte = endDateWithTime;
      }
    }

    const [sales, total] = await Promise.all([
      prisma.sale.findMany({
        where,
        skip,
        take,
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              phone: true,
              totalPurchases: true,
              loyaltyPoints: true,
              isVIP: true,
              lastVisit: true
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
          },
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                }
              }
            }
          },
          receipts: {
            select: {
              receiptNumber: true,
              printedAt: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.sale.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        sales,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get sales error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getSale = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const sale = await prisma.sale.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
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
            name: true,
          }
        },
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                barcode: true
              }
            }
          }
        },
        receipts: {
          select: {
            id: true,
            receiptNumber: true,
            printedAt: true
          }
        }
      }
    });

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Sale not found'
      });
    }

    return res.json({
      success: true,
      data: sale
    });
  } catch (error) {
    console.error('Get sale error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getSaleByReceiptNumber = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { receiptNumber } = req.params;

    console.log('Looking up receipt number:', receiptNumber);

    // First, let's see what receipt numbers exist in the database
    const allReceipts = await prisma.receipt.findMany({
      select: {
        receiptNumber: true,
        saleId: true
      },
      take: 10
    });
    console.log('Available receipt numbers in database:', allReceipts);

    const sale = await prisma.sale.findFirst({
      where: {
        receipts: {
          some: {
            receiptNumber: receiptNumber
          }
        }
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
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
            name: true,
          }
        },
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                barcode: true
              }
            }
          }
        },
        receipts: {
          select: {
            id: true,
            receiptNumber: true,
            printedAt: true
          }
        }
      }
    });

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: `Sale not found for receipt number: ${receiptNumber}. Available receipts: ${allReceipts.map(r => r.receiptNumber).join(', ')}`
      });
    }

    return res.json({
      success: true,
      data: sale
    });
  } catch (error) {
    console.error('Get sale by receipt number error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getAvailableReceiptNumbers = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const receipts = await prisma.receipt.findMany({
      select: {
        id: true,
        receiptNumber: true,
        saleId: true,
        printedAt: true
      },
      orderBy: {
        printedAt: 'desc'
      },
      take: 50
    });

    return res.json({
      success: true,
      data: { receipts }
    });
  } catch (error) {
    console.error('Get available receipt numbers error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const createSale = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    console.log('Sale creation request body:', req.body);
    const { error } = createSaleSchema.validate(req.body);
    if (error) {
      console.log('Sale validation error:', error.details);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const saleData: CreateSaleData = req.body;
    const userId = (req as any).user.id;

    // Get tax rate from settings
    const currentAdminId = req.user?.createdBy || req.user?.id;
    let taxRate = 0; // Tax disabled - set to 0

    if (currentAdminId) {
      try {
        const taxSetting = await prisma.settings.findUnique({
          where: {
            createdBy_key: {
              createdBy: currentAdminId,
              key: 'defaultTax'
            }
          }
        });

        if (taxSetting) {
          taxRate = parseFloat(taxSetting.value);
        }
      } catch (error) {
        console.warn('Could not fetch tax rate from settings, using default:', error);
      }
    }

    // Calculate totals with item-level discounts
    // For each item: calculate subtotal, apply item discount, then sum
    const itemTotals = saleData.items.map(item => {
      // If totalPrice is provided (already includes item discount), use it directly
      if (item.totalPrice !== undefined && item.totalPrice >= 0) {
        return item.totalPrice;
      }

      // Otherwise, calculate from unitPrice and discounts
      const itemSubtotal = item.quantity * item.unitPrice;
      let itemDiscountAmount = 0;

      // Calculate item discount if provided
      if (item.discountPercentage && item.discountPercentage > 0) {
        itemDiscountAmount = itemSubtotal * (item.discountPercentage / 100);
      } else if (item.discountAmount && item.discountAmount > 0) {
        itemDiscountAmount = item.discountAmount;
      }

      return itemSubtotal - itemDiscountAmount;
    });

    const subtotal = itemTotals.reduce((sum, total) => sum + total, 0);
    const discountAmount = saleData.discountAmount || 0; // Global discount
    const subtotalAfterDiscount = subtotal - discountAmount;
    const taxAmount = subtotalAfterDiscount * (taxRate / 100); // Tax on discounted amount
    const totalAmount = subtotalAfterDiscount + taxAmount;

    // Use transaction to ensure data consistency
    // Wrap in try-catch to handle transaction errors gracefully
    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
      // Use selected company/branch context if available, otherwise use the provided branchId
      let targetCompanyId: string;
      let targetBranchId: string;

      if (req.user?.selectedCompanyId && req.user?.selectedBranchId) {
        // Use selected company/branch context
        targetCompanyId = req.user.selectedCompanyId;
        targetBranchId = req.user.selectedBranchId;
        console.log('🏢 Using selected company/branch context for sale:', { targetCompanyId, targetBranchId });
      } else {
        // Fallback to provided branchId
        const branch = await tx.branch.findUnique({
          where: { id: saleData.branchId },
          select: { companyId: true }
        });

        if (!branch) {
          throw new Error('Branch not found');
        }

        targetCompanyId = branch.companyId;
        targetBranchId = saleData.branchId;
        console.log('🏢 Using provided branch context for sale:', { targetCompanyId, targetBranchId });
      }

      // Determine payment status and sale status
      const paymentStatus: PaymentStatus = (saleData.paymentStatus || 'COMPLETED') as PaymentStatus;
      const saleStatus = paymentStatus === 'COMPLETED' ? 'COMPLETED' : 'PENDING';

      // Create sale
      const sale = await tx.sale.create({
        data: {
          customerId: saleData.customerId,
          userId: userId,
          branchId: targetBranchId,
          companyId: targetCompanyId,
          createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id',
          subtotal,
          taxAmount,
          discountAmount: discountAmount,
          discountPercentage: saleData.discountPercentage || 0,
          totalAmount,
          paymentMethod: saleData.paymentMethod,
          paymentStatus: paymentStatus,
          status: saleStatus,
          saleDate: saleData.saleDate ? new Date(saleData.saleDate) : undefined
        }
      });

      // Create sale items and update stock
      const saleItems = [];
      for (const item of saleData.items) {
        // Check product availability
        console.log(`Looking for product with ID: ${item.productId}`);
        const product = await tx.product.findUnique({
          where: { id: item.productId }
        });

        if (!product) {
          // Get all products to see what IDs exist
          const allProducts = await tx.product.findMany({
            select: { id: true, name: true }
          });
          console.log('Available products:', allProducts);
          throw new Error(`Product with ID ${item.productId} not found`);
        }

        // Check stock availability through batches
        const availableBatches = await tx.batch.findMany({
          where: {
            productId: item.productId,
            branchId: targetBranchId,
            quantity: { gt: 0 },
            isActive: true
          },
          orderBy: { expireDate: 'asc' } // FIFO - First In, First Out
        });

        const totalAvailableStock = availableBatches.reduce((sum: number, batch: any) => sum + batch.quantity, 0);

        if (totalAvailableStock < item.quantity) {
          throw new Error(`Insufficient stock for ${product.name}. Available: ${totalAvailableStock}, Required: ${item.quantity}`);
        }

        // Handle batch tracking
        let batchId = null;
        if (item.batchId) {
          // Use provided batch ID
          batchId = item.batchId;

          // Update batch quantity
          await tx.batch.update({
            where: { id: item.batchId },
            data: {
              quantity: {
                decrement: item.quantity
              }
            }
          });
        } else if (item.batchNumber) {
          // Find batch by batch number and product
          const batch = await tx.batch.findFirst({
            where: {
              batchNo: item.batchNumber,
              productId: item.productId,
              branchId: targetBranchId,
              quantity: {
                gte: item.quantity
              }
            },
            orderBy: { expireDate: 'asc' } // FIFO - First In, First Out
          });

          if (batch) {
            batchId = batch.id;

            // Update batch quantity
            await tx.batch.update({
              where: { id: batch.id },
              data: {
                quantity: {
                  decrement: item.quantity
                }
              }
            });
          }
        }

        // Create sale item
        const saleItem = await tx.saleItem.create({
          data: {
            saleId: sale.id,
            productId: item.productId,
            batchId: batchId,
            createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id',
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: item.quantity * item.unitPrice,
            batchNumber: item.batchNumber,
            expiryDate: (() => {
              if (!item.expiryDate || item.expiryDate === 'Invalid Date') return null;
              const date = new Date(item.expiryDate);
              return isNaN(date.getTime()) ? null : date;
            })()
          }
        });

        saleItems.push(saleItem);

        // Update product stock
        // Stock is now managed through batches, no need to update product stock directly

        // Create stock movement
        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: 'OUT',
            quantity: item.quantity,
            reason: 'Sale',
            reference: sale.id,
            createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
          }
        });
      }

      // Update customer stats if customer exists
      if (saleData.customerId) {
        await tx.customer.update({
          where: { id: saleData.customerId },
          data: {
            totalPurchases: {
              increment: totalAmount
            },
            loyaltyPoints: {
              increment: Math.floor(totalAmount / 100) // 1 point per 100 PKR
            },
            lastVisit: new Date()
          }
        });
      }

      // Generate receipt number
      const receiptNumber = `RCP-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}-${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;

      // Create receipt
      const receipt = await tx.receipt.create({
        data: {
          saleId: sale.id,
          userId: userId,
          branchId: saleData.branchId,
          createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id',
          receiptNumber
        }
      });

      return { sale, saleItems, receipt };
      }, {
        timeout: 60000 // 60 seconds timeout for long-running transactions
        // Note: SQLite only supports Serializable isolation level, so we omit isolationLevel
      });
    } catch (error: any) {
      // Handle transaction errors specifically
      if (error.code === 'P2028') {
        console.error('❌ Transaction timeout or connection lost:', error.message);
        return res.status(500).json({
          success: false,
          message: 'Transaction failed due to connection timeout. Please try again.',
          error: 'TRANSACTION_TIMEOUT'
        });
      }
      // Re-throw other errors to be handled by outer catch
      throw error;
    }

    // Fetch complete sale data with relations
    const completeSale = await prisma.sale.findUnique({
      where: { id: result.sale.id },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            totalPurchases: true,
            loyaltyPoints: true,
            isVIP: true,
            lastVisit: true
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
            name: true,
          }
        },
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                barcode: true
              }
            }
          }
        },
        receipts: {
          select: {
            id: true,
            receiptNumber: true,
            printedAt: true
          }
        }
      }
    });

    if (!completeSale) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch complete sale data'
      });
    }

    console.log('Complete sale data:', completeSale);
    console.log('Customer in sale:', completeSale.customer);

    // Send real-time notification to all users of the same admin
    const createdBy = req.user?.createdBy || req.user?.id;
    if (createdBy) {
      notifySaleChange(createdBy, 'created', completeSale);
    }

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('sale', 'create', completeSale).catch(err => {
      console.error('[Sync] Sale create sync failed:', err.message);
    });

    return res.status(201).json({
      success: true,
      data: {
        ...completeSale,
        receiptNumber: result.receipt.receiptNumber
      }
    });
  } catch (error) {
    console.error('Create sale error:', error);
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Internal server error'
    });
  }
};

export const updateSale = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { discountPercentage, saleDate, notes, paymentStatus } = req.body;

    console.log('Update sale request:', { id, discountPercentage, saleDate, notes, paymentStatus });

    // Validate input
    if (discountPercentage !== undefined && (discountPercentage < 0 || discountPercentage > 100)) {
      return res.status(400).json({
        success: false,
        message: 'Discount percentage must be between 0 and 100'
      });
    }

    // Validate payment status if provided
    if (paymentStatus !== undefined && !['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'].includes(paymentStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment status. Must be PENDING, COMPLETED, FAILED, or REFUNDED'
      });
    }

    // Get the existing sale
    const existingSale = await prisma.sale.findUnique({
      where: { id },
      include: {
        items: true,
        customer: true,
        user: true,
        branch: true,
        company: true
      }
    });

    if (!existingSale) {
      return res.status(404).json({
        success: false,
        message: 'Sale not found'
      });
    }

    // Check if user has permission to update this sale
    const canUpdate = req.user?.role === 'SUPERADMIN' ||
      req.user?.role === 'ADMIN' ||
      (req.user?.role === 'MANAGER' && existingSale.userId === req.user?.id) ||
      (req.user?.role === 'CASHIER' && existingSale.userId === req.user?.id);

    if (!canUpdate) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update this sale'
      });
    }

    // Calculate new totals if discount percentage changed
    let newDiscountAmount = existingSale.discountAmount;
    let newTaxAmount = existingSale.taxAmount;
    let newTotalAmount = existingSale.totalAmount;

    if (discountPercentage !== undefined && discountPercentage !== existingSale.discountPercentage) {
      newDiscountAmount = (existingSale.subtotal * discountPercentage) / 100;
      const subtotalAfterDiscount = existingSale.subtotal - newDiscountAmount;
      newTaxAmount = subtotalAfterDiscount * 0; // Tax disabled - 0%
      newTotalAmount = subtotalAfterDiscount + newTaxAmount;
    }

    // Determine new payment status and sale status
    const newPaymentStatus: PaymentStatus = (paymentStatus || existingSale.paymentStatus) as PaymentStatus;
    const newSaleStatus = newPaymentStatus === 'COMPLETED' ? 'COMPLETED' :
      newPaymentStatus === 'PENDING' ? 'PENDING' :
        existingSale.status;

    // Update the sale
    const updatedSale = await prisma.sale.update({
      where: { id },
      data: {
        discountPercentage: discountPercentage !== undefined ? discountPercentage : existingSale.discountPercentage,
        discountAmount: newDiscountAmount,
        taxAmount: newTaxAmount,
        totalAmount: newTotalAmount,
        paymentStatus: newPaymentStatus,
        status: newSaleStatus,
        saleDate: saleDate ? new Date(saleDate) : existingSale.saleDate,
        updatedAt: new Date()
      },
      include: {
        items: {
          include: {
            product: true
          }
        },
        customer: true,
        user: true,
        branch: true,
        company: true,
        receipts: true
      }
    });

    // Convert BigInt values to strings for JSON serialization
    const serializedSale = {
      ...updatedSale,
      id: updatedSale.id.toString(),
      userId: updatedSale.userId.toString(),
      branchId: updatedSale.branchId.toString(),
      companyId: updatedSale.companyId.toString(),
      customerId: updatedSale.customerId?.toString() || null,
      subtotal: Number(updatedSale.subtotal),
      taxAmount: Number(updatedSale.taxAmount),
      discountAmount: Number(updatedSale.discountAmount),
      discountPercentage: updatedSale.discountPercentage ? Number(updatedSale.discountPercentage) : null,
      totalAmount: Number(updatedSale.totalAmount),
      createdAt: updatedSale.createdAt.toISOString(),
      updatedAt: updatedSale.updatedAt.toISOString(),
      saleDate: updatedSale.saleDate?.toISOString() || null,
      items: updatedSale.items.map((item: any) => ({
        ...item,
        id: item.id.toString(),
        saleId: item.saleId.toString(),
        productId: item.productId.toString(),
        batchId: item.batchId?.toString() || null,
        createdBy: item.createdBy?.toString() || null,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
        totalPrice: Number(item.totalPrice),
        product: {
          ...item.product,
          id: item.product.id.toString(),
          branchId: item.product.branchId.toString(),
          companyId: item.product.companyId.toString(),
          categoryId: item.product.categoryId?.toString() || null,
          createdBy: item.product.createdBy?.toString() || null,
          // costPrice, sellingPrice, and stock are now managed through batches
          minStock: Number(item.product.minStock),
          maxStock: Number(item.product.maxStock),
          createdAt: item.product.createdAt.toISOString(),
          updatedAt: item.product.updatedAt.toISOString()
        }
      })),
      customer: updatedSale.customer ? {
        ...updatedSale.customer,
        id: updatedSale.customer.id.toString(),
        branchId: updatedSale.customer.branchId.toString(),
        companyId: updatedSale.customer.companyId.toString(),
        createdBy: updatedSale.customer.createdBy?.toString() || null,
        totalPurchases: Number(updatedSale.customer.totalPurchases),
        loyaltyPoints: Number(updatedSale.customer.loyaltyPoints),
        createdAt: updatedSale.customer.createdAt.toISOString(),
        updatedAt: updatedSale.customer.updatedAt.toISOString()
      } : null,
      user: {
        ...updatedSale.user,
        id: updatedSale.user.id.toString(),
        branchId: updatedSale.user.branchId?.toString() || null,
        companyId: updatedSale.user.companyId?.toString() || null,
        createdBy: updatedSale.user.createdBy?.toString() || null,
        createdAt: updatedSale.user.createdAt.toISOString(),
        updatedAt: updatedSale.user.updatedAt.toISOString()
      },
      branch: {
        ...updatedSale.branch,
        id: updatedSale.branch.id.toString(),
        companyId: updatedSale.branch.companyId.toString(),
        createdBy: updatedSale.branch.createdBy?.toString() || null,
        createdAt: updatedSale.branch.createdAt.toISOString(),
        updatedAt: updatedSale.branch.updatedAt.toISOString()
      },
      company: {
        ...updatedSale.company,
        id: updatedSale.company.id.toString(),
        createdBy: updatedSale.company.createdBy?.toString() || null,
        createdAt: updatedSale.company.createdAt.toISOString(),
        updatedAt: updatedSale.company.updatedAt.toISOString()
      },
      receipts: updatedSale.receipts.map((receipt: any) => ({
        ...receipt,
        id: receipt.id.toString(),
        saleId: receipt.saleId.toString(),
        printedAt: receipt.printedAt?.toISOString() || null
      }))
    };

    // Notify about the update
    const createdBy = req.user?.createdBy || req.user?.id;
    if (createdBy) {
      notifySaleChange(createdBy, 'updated', serializedSale);
    }

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('sale', 'update', updatedSale).catch(err => {
      console.error('[Sync] Sale update sync failed:', err.message);
    });

    return res.json({
      success: true,
      data: serializedSale
    });

  } catch (error) {
    console.error('Update sale error:', error);
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Internal server error'
    });
  }
};

export const deleteSale = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    // Get the existing sale
    const existingSale = await prisma.sale.findUnique({
      where: { id },
      include: {
        items: true,
        customer: true,
        user: true,
        branch: true,
        company: true,
        receipts: true
      }
    });

    if (!existingSale) {
      return res.status(404).json({
        success: false,
        message: 'Sale not found'
      });
    }

    // Check if user has permission to delete this sale
    const canDelete = req.user?.role === 'SUPERADMIN' ||
      req.user?.role === 'ADMIN' ||
      (req.user?.role === 'MANAGER' && existingSale.userId === req.user?.id) ||
      (req.user?.role === 'CASHIER' && existingSale.userId === req.user?.id);

    if (!canDelete) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to delete this sale'
      });
    }

    // Use transaction to ensure data consistency
    await prisma.$transaction(async (tx: any) => {
      // Delete sale items first (foreign key constraint)
      await tx.saleItem.deleteMany({
        where: { saleId: id }
      });

      // Delete receipts
      await tx.receipt.deleteMany({
        where: { saleId: id }
      });

      // Restore stock from batches if sale was completed
      if (existingSale.status === 'COMPLETED') {
        for (const item of existingSale.items) {
          if (item.batchId) {
            // Restore quantity to batch
            await tx.batch.update({
              where: { id: item.batchId },
              data: {
                quantity: {
                  increment: item.quantity
                }
              }
            });

            // Create stock movement for restoration
            await tx.stockMovement.create({
              data: {
                productId: item.productId,
                type: 'IN',
                quantity: item.quantity,
                reason: 'Sale Deletion - Stock Restored',
                reference: id,
                createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
              }
            });
          }
        }

        // Update customer stats if customer exists
        if (existingSale.customerId) {
          await tx.customer.update({
            where: { id: existingSale.customerId },
            data: {
              totalPurchases: {
                decrement: existingSale.totalAmount
              },
              loyaltyPoints: {
                decrement: Math.floor(existingSale.totalAmount / 100) // 1 point per 100 PKR
              }
            }
          });
        }
      }

      // Delete the sale
      await tx.sale.delete({
        where: { id }
      });
    }, {
      timeout: 60000 // 60 seconds timeout for long-running transactions
      // Note: SQLite only supports Serializable isolation level, so we omit isolationLevel
    });

    // Send real-time notification
    const createdBy = req.user?.createdBy || req.user?.id;
    if (createdBy) {
      notifySaleChange(createdBy, 'deleted', existingSale);
    }

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('sale', 'delete', existingSale).catch(err => {
      console.error('[Sync] Sale delete sync failed:', err.message);
    });

    return res.json({
      success: true,
      message: 'Sale deleted successfully'
    });
  } catch (error) {
    console.error('Delete sale error:', error);
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Internal server error'
    });
  }
};