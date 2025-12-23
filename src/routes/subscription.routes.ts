import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getSubscription,
  updateSubscription,
  getPaymentMethods,
  addPaymentMethod,
  setDefaultPaymentMethod,
  deletePaymentMethod,
  getBillingHistory,
  downloadInvoice,
  processPayment
} from '../controllers/subscription.controller';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Subscription routes
router.get('/', getSubscription);
router.put('/', updateSubscription);

// Payment method routes
router.get('/payment-methods', getPaymentMethods);
router.post('/payment-methods', addPaymentMethod);
router.put('/payment-methods/:methodId/default', setDefaultPaymentMethod);
router.delete('/payment-methods/:methodId', deletePaymentMethod);

// Payment processing routes
router.post('/process-payment', processPayment);

// Billing history routes
router.get('/billing-history', getBillingHistory);
router.get('/invoices/:invoiceId/download', downloadInvoice);

export default router;
