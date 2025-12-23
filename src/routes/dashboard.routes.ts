import { Router } from 'express';
import { 
  getDashboardStats, 
  getSalesChart, 
  getAdminDashboardStats, 
  getTopSellingProducts, 
  getSalesByPaymentMethod 
} from '../controllers/dashboard.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

router.get('/stats', getDashboardStats);
router.get('/chart', getSalesChart);
router.get('/admin-stats', getAdminDashboardStats);
router.get('/top-products', getTopSellingProducts);
router.get('/sales-by-payment', getSalesByPaymentMethod);

export default router;
