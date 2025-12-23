import { Router } from 'express';
import {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  updateStock,
  bulkImportProducts,
  activateAllProducts,
  getAllProducts,
  bulkDeleteProducts,
  getStockMovements
} from '../controllers/product.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Get products (all roles can view)
router.get('/', getProducts);
router.get('/all', getAllProducts); // Get all products including inactive ones
router.get('/stock-movements', getStockMovements); // Get stock movements with date filtering
router.get('/:id', getProduct);

// Product management (All roles can manage products)
router.post('/', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), createProduct);
router.post('/bulk-import', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), bulkImportProducts);
router.post('/bulk-delete', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), bulkDeleteProducts);
router.put('/:id', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), updateProduct);
router.delete('/:id', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), deleteProduct);

// Stock management (All roles can manage stock)
router.patch('/:id/stock', authorize('SUPERADMIN', 'ADMIN', 'MANAGER', 'CASHIER', 'PHARMACIST'), updateStock);

// Activate all products (Admin, SuperAdmin only)
router.post('/activate-all', authorize('ADMIN', 'SUPERADMIN'), activateAllProducts);

export default router;
