


import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { CreateProductData, UpdateProductData, StockMovementData } from '../models/product.model';
import { validate } from '../middleware/validation.middleware';
import { AuthRequest, buildAdminWhereClause, buildBranchWhereClause } from '../middleware/auth.middleware';
import { notifyProductChange, notifyInventoryChange } from '../routes/sse.routes';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Utility function to convert BigInt and Date values to strings for JSON serialization
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

// Validation schemas
const createProductSchema = Joi.object({
  name: Joi.string().required(),
  description: Joi.string().allow(''),
  formula: Joi.string().allow(''), // New field for product composition
  sku: Joi.string().allow(''),
  categoryId: Joi.string().required(),
  categoryName: Joi.string().allow(''), // For bulk import - category name when categoryId doesn't exist
  supplierId: Joi.string().allow('', null).optional(), // Optional - supplier is assigned to batches, not products
  branchId: Joi.string().required(),
  barcode: Joi.string().allow(''),
  requiresPrescription: Joi.boolean().default(false),
  isActive: Joi.boolean().default(true),
  minStock: Joi.number().min(0).default(1).optional(),
  maxStock: Joi.number().min(0).allow(null).optional(),
  unitsPerPack: Joi.number().min(1).default(1).optional()
});

const updateProductSchema = Joi.object({
  name: Joi.string().allow(''),
  description: Joi.string().allow(''),
  formula: Joi.string().allow(''), // New field for product composition
  sku: Joi.string().allow(''),
  categoryId: Joi.string().allow(''),
  supplierId: Joi.string().allow(''),
  branchId: Joi.string().allow(''),
  barcode: Joi.string().allow(''),
  requiresPrescription: Joi.boolean(),
  isActive: Joi.boolean(),
  minStock: Joi.number().min(0).optional(),
  maxStock: Joi.number().min(0).allow(null).optional(),
  unitsPerPack: Joi.number().min(1).default(1).optional()
});

export const getProducts = async (req: AuthRequest, res: Response) => {
  try {
    // 🔄 Pull latest products from live database (background, non-blocking)
    // Don't wait for sync - return data immediately, sync in background
    const isPostgreSQLMode = process.env.USE_POSTGRESQL === 'true';
    if (!isPostgreSQLMode) {
      // Only pull if using SQLite (Electron mode) - run in background
      Promise.all([
        pullLatestFromLive('product').catch(err => console.log('[Sync] Pull products:', err.message)),
        pullLatestFromLive('category').catch(err => console.log('[Sync] Pull categories:', err.message)),
        pullLatestFromLive('batch').catch(err => console.log('[Sync] Pull batches:', err.message))
      ]).catch(() => {}); // Don't wait, run in background
    }

    const prisma = await getPrisma();

    const {
      page = 1,
      limit = 10,
      search = '',
      category = '',
      categoryType = '',
      branchId = '',
      lowStock = false,
      includeInactive = false
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    // Build where clause with data isolation
    const where: any = buildBranchWhereClause(req, {});

    // Only filter by isActive if includeInactive is false
    if (includeInactive !== 'true') {
      where.isActive = true;
    }

    if (branchId) {
      where.branchId = branchId;
    }

    if (category) {
      where.categoryId = category;
    }

    if (categoryType) {
      where.category = {
        type: String(categoryType).toUpperCase()
      };
    }

    if (search) {
      where.OR = [
        { name: { contains: search } },
        { barcode: { contains: search } },
        { description: { contains: search } },
        { formula: { contains: search } } // Search by formula/composition
      ];
    }

    // Note: lowStock filtering will be handled after fetching products with batch data

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take,
        include: {
          category: true,
          supplier: true,
          branch: {
            select: {
              id: true,
              name: true
            }
          },
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
              id: true,
              batchNo: true,
              quantity: true,
              totalBoxes: true,      // Original boxes purchased
              unitsPerBox: true,     // Units per box for calculating original quantity
              purchasePrice: true,   // Add purchasePrice for total value calculation
              sellingPrice: true,
              expireDate: true,
              supplierName: true,
              supplier: {
                select: {
                  id: true,
                  name: true,
                  manufacturer: {
                    select: {
                      id: true,
                      name: true
                    }
                  }
                }
              }
            },
            orderBy: { expireDate: 'asc' }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.product.count({ where })
    ]);

    // Calculate total stock and get current selling price from batches
    const productsWithBatchData = products.map(product => {
      const totalStock = product.batches.reduce((sum, batch) => sum + batch.quantity, 0);
      const currentBatch = product.batches.find(batch => batch.quantity > 0) || product.batches[0];
      const currentPrice = currentBatch?.sellingPrice || 0;

      return {
        ...product,
        stock: totalStock,
        price: currentPrice,
        currentBatch: currentBatch
      };
    });

    // Apply low stock filter if requested
    let filteredProducts = productsWithBatchData;
    if (lowStock === 'true') {
      filteredProducts = productsWithBatchData.filter(product =>
        product.stock <= product.minStock
      );
    }

    return res.json({
      success: true,
      data: {
        products: serializeBigInt(filteredProducts),
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: lowStock === 'true' ? filteredProducts.length : total,
          pages: Math.ceil((lowStock === 'true' ? filteredProducts.length : total) / Number(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get products error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getProduct = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        category: true,
        supplier: true,
        branch: {
          select: {
            id: true,
            name: true
          }
        },
        stockMovements: {
          orderBy: { createdAt: 'desc' },
          take: 10
        }
      }
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    return res.json({
      success: true,
      data: serializeBigInt(product)
    });
  } catch (error) {
    console.error('Get product error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const createProduct = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    console.log('=== CREATE PRODUCT REQUEST ===');
    console.log('Request body:', req.body);
    console.log('Request headers:', req.headers);

    const { error } = createProductSchema.validate(req.body);
    if (error) {
      console.log('Validation errors:', error.details.map(detail => detail.message));
      console.log('Validation error details:', error.details);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const productData: CreateProductData = req.body;

    // Generate SKU if not provided
    if (!productData.sku) {
      const generateSKU = (name: string): string => {
        const cleanName = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        const timestamp = Date.now().toString().slice(-6);
        return `${cleanName.slice(0, 6)}${timestamp}`;
      };
      productData.sku = generateSKU(productData.name);
    }

    // Supplier is optional for products - it's assigned at batch level
    // Clear invalid supplierId values
    let validSupplierId: string | null = null;
    if (productData.supplierId && productData.supplierId !== 'default-supplier' && productData.supplierId !== '' && productData.supplierId !== 'null') {
      validSupplierId = productData.supplierId;
    }

    // Check if barcode already exists for this admin
    if (productData.barcode) {
      const existingProduct = await prisma.product.findFirst({
        where: {
          barcode: productData.barcode,
          createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
        }
      });

      if (existingProduct) {
        return res.status(400).json({
          success: false,
          message: 'Product with this barcode already exists'
        });
      }
    }

    // Use selected company/branch context if available, otherwise use the provided branchId
    let targetCompanyId: string;
    let targetBranchId: string;

    if (req.user?.selectedCompanyId && req.user?.selectedBranchId) {
      // Use selected company/branch context
      targetCompanyId = req.user.selectedCompanyId;
      targetBranchId = req.user.selectedBranchId;
      console.log('🏢 Using selected company/branch context:', { targetCompanyId, targetBranchId });
    } else {
      // Fallback to provided branchId
      const branch = await prisma.branch.findUnique({
        where: { id: productData.branchId },
        select: { companyId: true }
      });

      if (!branch) {
        return res.status(400).json({
          success: false,
          message: 'Branch not found'
        });
      }

      targetCompanyId = branch.companyId;
      targetBranchId = productData.branchId;
      console.log('🏢 Using provided branch context:', { targetCompanyId, targetBranchId });
    }

    // Build product data object
    const productCreateData: any = {
      name: productData.name,
      description: productData.description || null,
      formula: productData.formula || null,
      sku: productData.sku,
      categoryId: productData.categoryId,
      branchId: targetBranchId,
      companyId: targetCompanyId,
      createdBy: req.user?.createdBy || req.user?.id || null,
      barcode: productData.barcode || null,
      requiresPrescription: productData.requiresPrescription || false,
      minStock: productData.minStock || 1,
      maxStock: productData.maxStock || null,
      unitsPerPack: productData.unitsPerPack || 1,
      supplierId: validSupplierId // Set to null if invalid/empty
    };

    console.log('🔍 Creating product with data:', {
      ...productCreateData,
      supplierId: productCreateData.supplierId || 'null (optional)'
    });

    const product = await prisma.product.create({
      data: productCreateData,
      include: {
        category: true,
        supplier: true,
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    // Stock is now managed through batches, not directly on products

    // Return response IMMEDIATELY (non-blocking)
    // All background operations will run after response is sent
    res.status(201).json({
      success: true,
      data: serializeBigInt(product)
    });

    // Run all background operations AFTER response is sent (non-blocking)
    setImmediate(() => {
      // Send real-time notification to all users of the same admin (background)
      const createdBy = req.user?.createdBy || req.user?.id;
      if (createdBy) {
        try {
          notifyProductChange(createdBy, 'created', product);
          notifyInventoryChange(createdBy, 'product_added', product);
        } catch (notifyError: any) {
          console.error('[Notification] Failed to send notification:', notifyError.message);
        }
      }

      // 🔄 BIDIRECTIONAL SYNC - Push to PostgreSQL (background, non-blocking)
      // If already using PostgreSQL (USE_POSTGRESQL=true), no sync needed - data is already there!
      const isPostgreSQLMode = process.env.USE_POSTGRESQL === 'true';
      if (!isPostgreSQLMode) {
        // Only sync if using SQLite (Electron mode) - run in background
        syncAfterOperation('product', 'create', product).catch(err => {
          console.error('[Sync] Product create sync failed:', err.message);
        });
      }
    });

    return; // Response already sent, exit function
  } catch (error: any) {
    console.error('❌ Create product error:', error);
    console.error('❌ Error details:', {
      message: error.message,
      code: error.code,
      meta: error.meta,
      stack: error.stack
    });
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

export const updateProduct = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { error } = updateProductSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const updateData: UpdateProductData = req.body;

    // Check if product exists
    const existingProduct = await prisma.product.findUnique({
      where: { id }
    });

    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Check if barcode already exists for this admin (if being updated)
    if (updateData.barcode && updateData.barcode !== existingProduct.barcode) {
      const barcodeExists = await prisma.product.findFirst({
        where: {
          barcode: updateData.barcode,
          createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
        }
      });

      if (barcodeExists) {
        return res.status(400).json({
          success: false,
          message: 'Product with this barcode already exists'
        });
      }
    }

    const product = await prisma.product.update({
      where: { id },
      data: {
        name: updateData.name,
        description: updateData.description,
        sku: updateData.sku,
        categoryId: updateData.categoryId,
        supplierId: updateData.supplierId,
        branchId: updateData.branchId,
        // Price and stock are now managed through batches
        minStock: updateData.minStock,
        maxStock: updateData.maxStock !== undefined ? Number(updateData.maxStock) : undefined,
        unitsPerPack: updateData.unitsPerPack,
        barcode: updateData.barcode,
        requiresPrescription: updateData.requiresPrescription,
        isActive: updateData.isActive
      },
      include: {
        category: true,
        supplier: true,
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    // Send real-time notification to all users of the same admin
    const createdBy = req.user?.createdBy || req.user?.id;
    if (createdBy) {
      notifyProductChange(createdBy, 'updated', product);
    }

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC - Push update to PostgreSQL
    syncAfterOperation('product', 'update', product).catch(err => {
      console.error('[Sync] Product update sync failed:', err.message);
    });

    return res.json({
      success: true,
      data: serializeBigInt(product)
    });
  } catch (error) {
    console.error('Update product error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteProduct = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const product = await prisma.product.findUnique({
      where: { id }
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    console.log(`Deleting product: ${product.name} (ID: ${id})`);

    // Always perform hard delete - permanently remove from database
    await prisma.$transaction(async (tx) => {
      // Delete all related records first
      console.log('Deleting related stock movements...');
      await tx.stockMovement.deleteMany({
        where: { productId: id }
      });

      console.log('Deleting related sale items...');
      await tx.saleItem.deleteMany({
        where: { productId: id }
      });

      console.log('Deleting related refund items...');
      await tx.refundItem.deleteMany({
        where: { productId: id }
      });

      console.log('Deleting product...');
      // Delete the product itself
      await tx.product.delete({
        where: { id }
      });
    });

    console.log(`Product ${product.name} permanently deleted from database`);

    // Send real-time notification to all users of the same admin
    const createdBy = req.user?.createdBy || req.user?.id;
    if (createdBy) {
      notifyProductChange(createdBy, 'deleted', product);
      notifyInventoryChange(createdBy, 'product_removed', product);
    }

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC - Push delete to PostgreSQL
    syncAfterOperation('product', 'delete', product).catch(err => {
      console.error('[Sync] Product delete sync failed:', err.message);
    });

    return res.json({
      success: true,
      message: 'Product permanently deleted from database'
    });
  } catch (error) {
    console.error('Delete product error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateStock = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { type, quantity, reason, reference }: StockMovementData = req.body;

    if (!type || !quantity) {
      return res.status(400).json({
        success: false,
        message: 'Type and quantity are required'
      });
    }

    const product = await prisma.product.findUnique({
      where: { id }
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Stock adjustments are now managed through batches
    // This function is deprecated - use batch management instead
    return res.status(400).json({
      success: false,
      message: 'Stock adjustments are now managed through batches. Please use batch management instead.'
    });
  } catch (error) {
    console.error('Update stock error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Bulk import products - Fixed TypeScript errors
export const bulkImportProducts = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    console.log('=== BULK IMPORT REQUEST RECEIVED ===');
    console.log('Request body:', req.body);
    console.log('Request headers:', req.headers);
    console.log('User from request:', (req as any).user);

    const { products } = req.body;
    const userId = (req as any).user?.id;

    console.log('Bulk import request received:', {
      productCount: products?.length || 0,
      userId: userId
    });

    if (!products || !Array.isArray(products) || products.length === 0) {
      console.log('No products provided for bulk import');
      return res.status(400).json({
        success: false,
        message: 'Products array is required and must not be empty'
      });
    }

    const results = {
      successful: [] as any[],
      failed: [] as Array<{ product: any; error: string }>,
      total: products.length
    };

    // Process each product
    for (const productData of products) {
      try {
        console.log('=== PROCESSING PRODUCT ===');
        console.log('Product data received:', productData);
        console.log('Product name:', productData.name);
        console.log('Product selling price:', productData.sellingPrice);
        console.log('Product category ID:', productData.categoryId);
        console.log('Product branch ID:', productData.branchId);

        // Auto-generate missing fields
        if (!productData.name || productData.name.trim() === '') {
          productData.name = `Product_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        }

        // Price and stock are now managed through batches

        if (!productData.minStock || productData.minStock < 0) {
          productData.minStock = 10; // Default minimum stock
        }

        if (!productData.maxStock || productData.maxStock < 0) {
          productData.maxStock = null; // No maximum limit
        }


        if (!productData.unitsPerPack || productData.unitsPerPack <= 0) {
          productData.unitsPerPack = 1; // Default pack size
        }

        if (!productData.description || productData.description.trim() === '') {
          productData.description = 'Imported product'; // Default description
        }

        if (!productData.barcode || productData.barcode.trim() === '') {
          productData.barcode = `AUTO_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        }

        // Handle category - create if it doesn't exist
        let category = null;

        // If categoryId is provided and not 'auto-create', try to find it
        if (productData.categoryId && productData.categoryId !== 'auto-create') {
          category = await prisma.category.findUnique({
            where: { id: productData.categoryId }
          });
        }

        // If category not found or categoryId is 'auto-create', create/find by name
        if (!category) {
          const categoryName = productData.categoryName || 'Imported Category';
          console.log(`Creating/finding category: ${categoryName}`);

          // Try to find category by name first (in case it was created by another product in this batch)
          category = await prisma.category.findFirst({
            where: {
              name: categoryName,
              createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
            }
          });

          if (!category) {
            // Create new category
            category = await prisma.category.create({
              data: {
                name: categoryName,
                description: `Auto-created during product import - ${new Date().toISOString()}`,
                createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
              }
            });
            console.log(`Created new category: ${category.name} with ID: ${category.id}`);
          } else {
            console.log(`Found existing category by name: ${category.name}`);
          }

          productData.categoryId = category.id;
        }

        // Supplier is optional for products - assigned at batch level
        if (productData.supplierId === 'default-supplier' || productData.supplierId === '') {
          productData.supplierId = undefined;
        }

        // Auto-assign branchId if missing
        if (!productData.branchId) {
          // Find the first available branch for this admin
          const availableBranch = await prisma.branch.findFirst({
            where: {
              createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id',
              isActive: true
            }
          });

          if (availableBranch) {
            productData.branchId = availableBranch.id;
          } else {
            // Create a default company and branch if none exists
            const defaultCompany = await prisma.company.create({
              data: {
                name: 'Default Company',
                description: 'Auto-created for imports',
                address: 'Auto-created for imports',
                phone: '+92 300 0000000',
                email: process.env.COMPANY_EMAIL || 'default@company.com',
                createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id',
                isActive: true
              }
            });

            const defaultBranch = await prisma.branch.create({
              data: {
                name: 'Default Branch',
                address: 'Auto-created for imports',
                phone: '+92 300 0000000',
                email: process.env.BRANCH_EMAIL || 'default@branch.com',
                companyId: defaultCompany.id,
                createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id',
                isActive: true
              }
            });
            productData.branchId = defaultBranch.id;
          }
        }

        // Check if branch exists
        const branch = await prisma.branch.findUnique({
          where: { id: productData.branchId }
        });

        if (!branch) {
          const error = `Branch with ID ${productData.branchId} does not exist`;
          console.log(`Validation failed for ${productData.name}:`, error);
          results.failed.push({
            product: productData,
            error: error
          });
          continue;
        }

        // Check if product with same name already exists for THIS ADMIN only
        const existingProduct = await prisma.product.findFirst({
          where: {
            name: productData.name,
            branchId: productData.branchId,
            createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
          }
        });

        if (existingProduct) {
          console.log(`Product ${productData.name} already exists, updating stock instead of skipping...`);

          // Instead of skipping, update the existing product's stock
          try {
            const updatedProduct = await prisma.product.update({
              where: { id: existingProduct.id },
              data: {
                // Price and stock are now managed through batches
                description: productData.description || existingProduct.description,
                unitsPerPack: productData.unitsPerPack || existingProduct.unitsPerPack,
                // Don't update barcode for existing products to avoid conflicts
                requiresPrescription: productData.requiresPrescription !== undefined ? productData.requiresPrescription : existingProduct.requiresPrescription
              },
              include: {
                category: true,
                supplier: true,
                branch: {
                  select: {
                    id: true,
                    name: true
                  }
                }
              }
            });

            // Stock movements are now managed through batches

            results.successful.push(updatedProduct);
            console.log(`Updated existing product: ${productData.name}`);
            continue;
          } catch (updateError) {
            console.error(`Error updating existing product ${productData.name}:`, updateError);
            results.failed.push({
              product: productData,
              error: `Failed to update existing product: ${updateError instanceof Error ? updateError.message : 'Unknown error'}`
            });
            continue;
          }
        }

        // Check barcode uniqueness if provided
        if (productData.barcode && productData.barcode.trim()) {
          const existingBarcode = await prisma.product.findFirst({
            where: {
              barcode: productData.barcode,
              createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
            }
          });

          if (existingBarcode) {
            // Skip barcode if it exists
            delete productData.barcode;
          }
        }

        // Create product
        console.log(`Creating product ${productData.name} with data:`, {
          name: productData.name,
          categoryId: productData.categoryId,
          supplierId: productData.supplierId,
          branchId: productData.branchId,
          // Price and stock are now managed through batches
        });
        console.log(`BranchId for product ${productData.name}:`, productData.branchId);
        console.log(`BranchId type:`, typeof productData.branchId);

        // Generate SKU from product name
        const generateSKU = (name: string): string => {
          const cleanName = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
          const timestamp = Date.now().toString().slice(-6);
          return `${cleanName.slice(0, 6)}${timestamp}`;
        };

        // Check and fix barcode uniqueness
        let finalBarcode = productData.barcode;
        if (finalBarcode) {
          let barcodeExists = await prisma.product.findFirst({
            where: {
              barcode: finalBarcode,
              createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
            }
          });

          // If barcode exists, generate a new unique one
          while (barcodeExists) {
            finalBarcode = `AUTO_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
            barcodeExists = await prisma.product.findFirst({
              where: {
                barcode: finalBarcode,
                createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id'
              }
            });
          }
        }

        // Get companyId from branch
        const branchForCompany = await prisma.branch.findUnique({
          where: { id: productData.branchId },
          select: { companyId: true }
        });

        if (!branchForCompany) {
          return res.status(400).json({
            success: false,
            message: 'Branch not found'
          });
        }

        const product = await prisma.product.create({
          data: {
            name: productData.name,
            description: productData.description || '',
            categoryId: productData.categoryId,
            supplierId: productData.supplierId,
            branchId: productData.branchId,
            companyId: branchForCompany.companyId,
            createdBy: req.user?.createdBy || req.user?.id || 'default-admin-id',
            // Price and stock are now managed through batches
            minStock: productData.minStock || 10,
            maxStock: productData.maxStock || null,
            unitsPerPack: productData.unitsPerPack || 1,
            barcode: finalBarcode || null,
            requiresPrescription: productData.requiresPrescription || false,
            isActive: true,
            sku: productData.sku || generateSKU(productData.name)
          },
          include: {
            category: true,
            supplier: true,
            branch: {
              select: {
                id: true,
                name: true
              }
            }
          }
        });

        results.successful.push(product);

        // Stock movements are now managed through batches

      } catch (error: any) {
        console.error(`=== ERROR PROCESSING PRODUCT ${productData.name} ===`);
        console.error('Product data that failed:', productData);
        console.error('Error details:', {
          message: error.message,
          code: error.code,
          meta: error.meta,
          stack: error.stack
        });

        let errorMessage = error.message || 'Unknown error';

        // Handle specific Prisma constraint errors
        if (error.code === 'P2002') {
          if (error.meta?.target?.includes('barcode')) {
            errorMessage = `Barcode '${productData.barcode}' already exists for another product`;
          } else if (error.meta?.target?.includes('name')) {
            errorMessage = `Product name '${productData.name}' already exists in this branch`;
          } else {
            errorMessage = `Duplicate entry: ${error.meta?.target?.join(', ')} already exists`;
          }
        } else if (error.code === 'P2003') {
          errorMessage = `Invalid reference: ${error.meta?.field_name} does not exist`;
        } else if (error.code === 'P2025') {
          errorMessage = `Record not found: ${error.meta?.cause}`;
        } else if (error.message?.includes('Invalid value')) {
          errorMessage = `Invalid data format: ${error.message}`;
        } else if (error.message?.includes('Required field')) {
          errorMessage = `Missing required field: ${error.message}`;
        }

        console.error(`Final error message for ${productData.name}:`, errorMessage);

        results.failed.push({
          product: productData,
          error: errorMessage
        });
      }
    }

    const skippedCount = results.failed.filter(f => f.error.includes('already exists')).length;
    const actualFailedCount = results.failed.length - skippedCount;

    console.log('Bulk import completed:', {
      total: results.total,
      successful: results.successful.length,
      skipped: skippedCount,
      failed: actualFailedCount
    });

    const responseData = {
      success: true,
      data: {
        successful: results.successful,
        failed: results.failed,
        total: results.total,
        successCount: results.successful.length,
        skippedCount: skippedCount,
        failureCount: actualFailedCount
      }
    };

    console.log('=== SENDING RESPONSE ===');
    console.log('Response data:', responseData);

    return res.json(serializeBigInt(responseData));

  } catch (error) {
    console.error('Bulk import error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get all products including inactive ones - for debugging
export const getAllProducts = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const products = await prisma.product.findMany({
      include: {
        category: true,
        supplier: true,
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return res.json({
      success: true,
      data: {
        products: serializeBigInt(products),
        total: products.length
      }
    });
  } catch (error) {
    console.error('Get all products error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Activate all products - temporary fix
export const activateAllProducts = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const result = await prisma.product.updateMany({
      where: {},
      data: {
        isActive: true
      }
    });

    console.log(`Activated ${result.count} products`);

    return res.json({
      success: true,
      message: `Activated ${result.count} products`,
      data: { count: result.count }
    });
  } catch (error) {
    console.error('Activate products error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Bulk delete products
export const bulkDeleteProducts = async (req: AuthRequest, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { productIds } = req.body;

    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Product IDs array is required'
      });
    }

    console.log(`Bulk deleting ${productIds.length} products:`, productIds);

    // Verify all products exist
    const existingProducts = await prisma.product.findMany({
      where: {
        id: { in: productIds }
      },
      select: { id: true, name: true }
    });

    if (existingProducts.length !== productIds.length) {
      const foundIds = existingProducts.map(p => p.id);
      const missingIds = productIds.filter(id => !foundIds.includes(id));
      return res.status(404).json({
        success: false,
        message: `Some products not found: ${missingIds.join(', ')}`
      });
    }

    // Delete all related records and products in a transaction
    await prisma.$transaction(async (tx) => {
      // Delete stock movements for all products
      console.log('Deleting related stock movements...');
      await tx.stockMovement.deleteMany({
        where: { productId: { in: productIds } }
      });

      // Delete sale items for all products
      console.log('Deleting related sale items...');
      await tx.saleItem.deleteMany({
        where: { productId: { in: productIds } }
      });

      // Delete refund items for all products
      console.log('Deleting related refund items...');
      await tx.refundItem.deleteMany({
        where: { productId: { in: productIds } }
      });

      // Delete the products themselves
      console.log('Deleting products...');
      await tx.product.deleteMany({
        where: { id: { in: productIds } }
      });
    });

    console.log(`Successfully bulk deleted ${productIds.length} products`);

    return res.json({
      success: true,
      message: `${productIds.length} products permanently deleted from database`,
      data: serializeBigInt({
        deletedCount: productIds.length,
        deletedProducts: existingProducts.map(p => ({ id: p.id, name: p.name }))
      })
    });
  } catch (error) {
    console.error('Bulk delete products error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get stock movements with date filtering
export const getStockMovements = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const {
      page = 1,
      limit = 50,
      productId = '',
      startDate = '',
      endDate = '',
      type = '',
      branchId = ''
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    // Build where clause with data isolation
    const where: any = buildBranchWhereClause(req, {});

    // Product filter
    if (productId) {
      where.productId = productId;
    }

    // Type filter
    if (type) {
      where.type = type;
    }

    // Branch filter (through product) - only if not already filtered by buildBranchWhereClause
    if (branchId && req.user?.role !== 'MANAGER') {
      where.product = {
        branchId: branchId
      };
    } else if (req.user?.role === 'MANAGER' && req.user?.branchId) {
      // For managers, ensure we only get stock movements for products in their branch
      where.product = {
        branchId: req.user.branchId
      };
    }

    // Date range filter
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

    const [stockMovements, total] = await Promise.all([
      prisma.stockMovement.findMany({
        where,
        include: {
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              branch: {
                select: {
                  id: true,
                  name: true
                }
              }
            }
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take
      }),
      prisma.stockMovement.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        stockMovements,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });

  } catch (error) {
    console.error('Get stock movements error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};