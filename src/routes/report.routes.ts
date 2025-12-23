import { Router } from 'express';
import {
  getSalesReport,
  getInventoryReport,
  getCustomerReport,
  getProductPerformanceReport,
  getTopSellingProducts,
  getSalesByPaymentMethod,
  getDashboardData
} from '../controllers/report.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Reports (All authenticated users can access basic reports)
router.get('/sales', authorize('CASHIER', 'MANAGER', 'ADMIN', 'SUPERADMIN'), getSalesReport);
router.get('/inventory', authorize('CASHIER', 'MANAGER', 'ADMIN', 'SUPERADMIN'), getInventoryReport);
router.get('/customers', authorize('MANAGER', 'ADMIN', 'SUPERADMIN'), getCustomerReport);
router.get('/products', authorize('CASHIER', 'MANAGER', 'ADMIN', 'SUPERADMIN'), getProductPerformanceReport);
router.get('/top-products', authorize('CASHIER', 'MANAGER', 'ADMIN', 'SUPERADMIN'), getTopSellingProducts);
router.get('/payment-methods', authorize('CASHIER', 'MANAGER', 'ADMIN', 'SUPERADMIN'), getSalesByPaymentMethod);
router.get('/dashboard', authorize('CASHIER', 'MANAGER', 'ADMIN', 'SUPERADMIN'), getDashboardData);

export default router;
