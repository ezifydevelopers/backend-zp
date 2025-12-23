import { Router, Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { getPrisma } from '../utils/db.util';

const router = Router();

// Store active connections
const activeConnections = new Map<string, Response>();

// Store connections by createdBy for group notifications
const adminConnections = new Map<string, Set<string>>();

// Custom authentication for SSE (since EventSource doesn't support headers)
const authenticateSSE = async (req: Request): Promise<{ userId: string; createdBy: string } | null> => {
  try {
    const token = req.query.token as string;

    if (!token) {
      return null;
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    // Get database client (works with SQLite or PostgreSQL)
    const prisma = await getPrisma();

    // Verify user still exists and is active
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        username: true,
        role: true,
        branchId: true,
        createdBy: true,
        isActive: true
      }
    });

    if (!user || !user.isActive) {
      return null;
    }

    // For ADMIN users, if createdBy is null, use their own ID (self-referencing)
    let createdBy = user.createdBy;
    if (user.role === 'ADMIN' && (!createdBy || createdBy === '')) {
      createdBy = user.id;
    }

    return {
      userId: user.id,
      createdBy: createdBy || user.id
    };
  } catch (error) {
    console.error('SSE authentication error:', error);
    return null;
  }
};

// SSE endpoint for real-time notifications
router.get('/events', async (req: Request, res: Response) => {
  const auth = await authenticateSSE(req);

  if (!auth) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const { userId, createdBy } = auth;

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Store connection
  activeConnections.set(userId, res);

  // Add to admin group
  if (createdBy) {
    if (!adminConnections.has(createdBy)) {
      adminConnections.set(createdBy, new Set());
    }
    adminConnections.get(createdBy)!.add(userId);
  }

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Connected to real-time updates' })}\n\n`);

  // Handle client disconnect
  req.on('close', () => {
    activeConnections.delete(userId);

    // Remove from admin group
    if (createdBy && adminConnections.has(createdBy)) {
      adminConnections.get(createdBy)!.delete(userId);
      if (adminConnections.get(createdBy)!.size === 0) {
        adminConnections.delete(createdBy);
      }
    }

    console.log(`SSE connection closed for user ${userId}`);
  });

  // Keep connection alive
  const keepAlive = setInterval(() => {
    if (activeConnections.has(userId)) {
      res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`);
    } else {
      clearInterval(keepAlive);
    }
  }, 30000); // Send ping every 30 seconds
});

// Function to notify user of deactivation
export const notifyUserDeactivation = (userId: string) => {
  const connection = activeConnections.get(userId);
  if (connection) {
    try {
      (connection as any).write(`data: ${JSON.stringify({
        type: 'account_deactivated',
        message: 'Your account has been deactivated by Super Admin',
        timestamp: new Date().toISOString()
      })}\n\n`);
      console.log(`Notified user ${userId} of account deactivation`);
    } catch (error) {
      console.error('Error sending deactivation notification:', error);
      activeConnections.delete(userId);
    }
  }
};

// Function to notify user of reactivation
export const notifyUserReactivation = (userId: string) => {
  const connection = activeConnections.get(userId);
  if (connection) {
    try {
      (connection as any).write(`data: ${JSON.stringify({
        type: 'account_reactivated',
        message: 'Your account has been reactivated by Super Admin',
        timestamp: new Date().toISOString()
      })}\n\n`);
      console.log(`Notified user ${userId} of account reactivation`);
    } catch (error) {
      console.error('Error sending reactivation notification:', error);
      activeConnections.delete(userId);
    }
  }
};

// Function to notify all users of the same admin about data changes
export const notifyAdminGroup = (createdBy: string, eventType: string, data: any) => {
  const userConnections = adminConnections.get(createdBy);
  if (userConnections) {
    userConnections.forEach(userId => {
      const connection = activeConnections.get(userId);
      if (connection) {
        try {
          (connection as any).write(`data: ${JSON.stringify({
            type: eventType,
            data: data,
            timestamp: new Date().toISOString()
          })}\n\n`);
          console.log(`Notified user ${userId} of ${eventType}`);
        } catch (error) {
          console.error(`Error sending ${eventType} notification to user ${userId}:`, error);
          activeConnections.delete(userId);
          userConnections.delete(userId);
        }
      }
    });
  }
};

// Specific notification functions for different data types
export const notifyProductChange = (createdBy: string, action: 'created' | 'updated' | 'deleted', product: any) => {
  notifyAdminGroup(createdBy, 'product_change', {
    action,
    product,
    message: `Product ${action}: ${product.name}`
  });
};

export const notifySaleChange = (createdBy: string, action: 'created' | 'updated' | 'deleted', sale: any) => {
  // Create a simplified sale object for notifications to avoid BigInt serialization issues
  const notificationSale = {
    id: sale.id?.toString(),
    totalAmount: typeof sale.totalAmount === 'bigint' ? Number(sale.totalAmount) : sale.totalAmount,
    discountPercentage: sale.discountPercentage,
    discountAmount: typeof sale.discountAmount === 'bigint' ? Number(sale.discountAmount) : sale.discountAmount,
    paymentMethod: sale.paymentMethod,
    status: sale.status,
    customerName: sale.customer?.name || 'Walk-in Customer',
    createdAt: sale.createdAt?.toISOString?.() || sale.createdAt,
    updatedAt: sale.updatedAt?.toISOString?.() || sale.updatedAt
  };

  notifyAdminGroup(createdBy, 'sale_change', {
    action,
    sale: notificationSale,
    message: `Sale ${action}: ${sale.id}`
  });
};

export const notifyRefundChange = (createdBy: string, action: 'created' | 'updated' | 'deleted', refund: any) => {
  notifyAdminGroup(createdBy, 'refund_change', {
    action,
    refund,
    message: `Refund ${action}: ${refund.id}`
  });
};

export const notifyCustomerChange = (createdBy: string, action: 'created' | 'updated' | 'deleted', customer: any) => {
  notifyAdminGroup(createdBy, 'customer_change', {
    action,
    customer,
    message: `Customer ${action}: ${customer.name}`
  });
};

export const notifyInventoryChange = (createdBy: string, action: 'stock_updated' | 'product_added' | 'product_removed', data: any) => {
  notifyAdminGroup(createdBy, 'inventory_change', {
    action,
    data,
    message: `Inventory ${action}: ${data.productName || data.name || 'Unknown'}`
  });
};

export default router;
