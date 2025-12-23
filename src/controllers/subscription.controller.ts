import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Validation schemas
const updateSubscriptionSchema = Joi.object({
  plan: Joi.string().valid('basic', 'premium', 'enterprise'),
  autoRenew: Joi.boolean()
});

const addPaymentMethodSchema = Joi.object({
  type: Joi.string().valid('card', 'bank', 'mobile').required(),
  last4: Joi.string().length(4).required(),
  brand: Joi.string().required(),
  expiryMonth: Joi.number().min(1).max(12).required(),
  expiryYear: Joi.number().min(new Date().getFullYear()).required(),
  holderName: Joi.string().required(),
  isDefault: Joi.boolean().default(false)
});

// Get subscription details
export const getSubscription = async (req: Request, res: Response): Promise<void> => {
      const prisma = await getPrisma();
try {
    const userId = (req as any).user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
      return;
    }

    // Get user details
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    if (!user) {
      res.status(404).json({
        success: false,
        message: 'User not found'
      });
      return;
    }

    // Mock subscription data - in real app, this would come from a subscription service
    const subscription = {
      id: `sub_${userId}`,
      plan: 'premium',
      status: 'active',
      startDate: '2024-01-15',
      endDate: '2024-12-15',
      amount: 10000,
      billingCycle: 'monthly',
      autoRenew: true,
      remainingDays: 45,
      features: [
        'Up to 50 users',
        '3 branches',
        'Advanced reporting',
        'Priority support',
        'API access'
      ]
    };

    res.json({
      success: true,
      data: subscription
    });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Update subscription
export const updateSubscription = async (req: Request, res: Response): Promise<void> => {
      const prisma = await getPrisma();
try {
    const { error } = updateSubscriptionSchema.validate(req.body);
    if (error) {
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
      return;
    }

    const userId = (req as any).user?.id;
    const { plan, autoRenew } = req.body;

    // In real app, this would update the subscription in a payment service
    // For now, we'll just return success
    res.json({
      success: true,
      message: 'Subscription updated successfully',
      data: {
        plan,
        autoRenew,
        updatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Update subscription error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};


// Add payment method
export const addPaymentMethod = async (req: Request, res: Response): Promise<void> => {
      const prisma = await getPrisma();
try {
    const { error } = addPaymentMethodSchema.validate(req.body);
    if (error) {
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
      return;
    }

    const userId = (req as any).user?.id;
    const paymentMethodData = req.body;

    // In real app, this would add the payment method to a payment service
    const newPaymentMethod = {
      id: `pm_${Date.now()}`,
      ...paymentMethodData,
      createdAt: new Date().toISOString()
    };

    res.status(201).json({
      success: true,
      message: 'Payment method added successfully',
      data: newPaymentMethod
    });
  } catch (error) {
    console.error('Add payment method error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Set default payment method
export const setDefaultPaymentMethod = async (req: Request, res: Response): Promise<void> => {
      const prisma = await getPrisma();
try {
    const { methodId } = req.params;
    const userId = (req as any).user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
      return;
    }

    // In real app, this would update the default payment method in a payment service
    res.json({
      success: true,
      message: 'Default payment method updated successfully'
    });
  } catch (error) {
    console.error('Set default payment method error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Delete payment method
export const deletePaymentMethod = async (req: Request, res: Response): Promise<void> => {
      const prisma = await getPrisma();
try {
    const { methodId } = req.params;
    const userId = (req as any).user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
      return;
    }

    // In real app, this would delete the payment method from a payment service
    res.json({
      success: true,
      message: 'Payment method deleted successfully'
    });
  } catch (error) {
    console.error('Delete payment method error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get billing history
export const getBillingHistory = async (req: Request, res: Response): Promise<void> => {
      const prisma = await getPrisma();
try {
    const userId = (req as any).user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
      return;
    }

    // Mock billing history - in real app, this would come from a payment service
    const billingHistory = [
      {
        id: 'inv_1',
        amount: 10000,
        status: 'success',
        method: 'Visa ****4242',
        date: '2024-01-15',
        invoiceNumber: 'INV-2024-001',
        description: 'Premium Plan - Monthly'
      },
      {
        id: 'inv_2',
        amount: 10000,
        status: 'success',
        method: 'Visa ****4242',
        date: '2023-12-15',
        invoiceNumber: 'INV-2023-012',
        description: 'Premium Plan - Monthly'
      },
      {
        id: 'inv_3',
        amount: 10000,
        status: 'failed',
        method: 'Mastercard ****5555',
        date: '2023-11-15',
        invoiceNumber: 'INV-2023-011',
        description: 'Premium Plan - Monthly'
      }
    ];

    res.json({
      success: true,
      data: billingHistory
    });
  } catch (error) {
    console.error('Get billing history error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Process payment
export const processPayment = async (req: Request, res: Response): Promise<void> => {
      const prisma = await getPrisma();
try {
    const userId = (req as any).user?.id;
    const { method, phoneNumber, amount, transactionId } = req.body;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
      return;
    }

    // Validate payment data
    if (!method || !phoneNumber || !amount) {
      res.status(400).json({
        success: false,
        message: 'Missing required payment information'
      });
      return;
    }

    // Generate payment record
    const paymentRecord = {
      id: `pay_${Date.now()}`,
      userId,
      method,
      phoneNumber,
      amount,
      transactionId: transactionId || `TXN_${Date.now()}`,
      status: 'completed',
      createdAt: new Date().toISOString(),
      plan: 'premium' // This would be determined based on amount
    };

    // In real app, this would:
    // 1. Verify payment with EasyPaisa/JazzCash API
    // 2. Update subscription status
    // 3. Send confirmation email
    // 4. Generate invoice

    // Mock successful payment processing
    res.json({
      success: true,
      message: 'Payment processed successfully',
      data: {
        paymentId: paymentRecord.id,
        transactionId: paymentRecord.transactionId,
        amount: paymentRecord.amount,
        method: paymentRecord.method,
        status: 'completed',
        subscription: {
          plan: 'premium',
          status: 'active',
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days from now
        }
      }
    });
  } catch (error) {
    console.error('Process payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get payment methods for EasyPaisa and JazzCash
export const getPaymentMethods = async (req: Request, res: Response): Promise<void> => {
      const prisma = await getPrisma();
try {
    const userId = (req as any).user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
      return;
    }

    // Return available payment methods
    const paymentMethods = [
      {
        id: 'easypaisa',
        name: 'EasyPaisa',
        type: 'mobile',
        icon: 'smartphone',
        description: 'Pay using your EasyPaisa account',
        features: ['Instant payment', 'Secure', 'Easy to use'],
        instructions: [
          'Open EasyPaisa app',
          'Go to Send Money',
          'Enter amount and recipient',
          'Complete transaction'
        ]
      },
      {
        id: 'jazzcash',
        name: 'JazzCash',
        type: 'mobile',
        icon: 'smartphone',
        description: 'Pay using your JazzCash account',
        features: ['Quick payment', 'Reliable', 'Bank-level security'],
        instructions: [
          'Open JazzCash app',
          'Go to Send Money',
          'Enter amount and recipient',
          'Complete transaction'
        ]
      },
      {
        id: 'bank_transfer',
        name: 'Bank Transfer',
        type: 'bank',
        icon: 'building',
        description: 'Traditional bank transfer',
        features: ['Secure', 'Traditional', 'Bank guarantee'],
        instructions: [
          'Transfer to provided account',
          'Use reference number',
          'Upload receipt',
          'Wait for confirmation'
        ]
      }
    ];

    res.json({
      success: true,
      data: paymentMethods
    });
  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Download invoice
export const downloadInvoice = async (req: Request, res: Response): Promise<void> => {
      const prisma = await getPrisma();
try {
    const { invoiceId } = req.params;
    const userId = (req as any).user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
      return;
    }

    // In real app, this would generate and return the actual invoice PDF
    res.json({
      success: true,
      message: 'Invoice download initiated',
      data: {
        invoiceId,
        downloadUrl: `/api/subscription/invoices/${invoiceId}/download`
      }
    });
  } catch (error) {
    console.error('Download invoice error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
