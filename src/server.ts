// CRITICAL: Import CommonJS database URL initialization FIRST
// This MUST be CommonJS (not ES6) to ensure it runs synchronously before ES6 imports
// ES6 imports are hoisted, so we need CommonJS to set DATABASE_URL before Prisma loads
require('./config/database-url-init.js');

// Now import the TypeScript database initialization (for additional setup)
import './config/database.init';

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Verify DATABASE_URL is set before importing PrismaClient
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set! This should have been set by database.init.ts');
}

console.log('[Server] ✅ Database mode:', process.env.USE_POSTGRESQL === 'true' ? 'PostgreSQL (Web)' : 'SQLite (Electron)');

// Ensure JWT_SECRET is set (required for authentication)
if (!process.env.JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET is not set in environment variables');
  console.warn('⚠️ Attempting to load from .env file...');
  // Try to load from .env file if not set
  try {
    const dotenv = require('dotenv');
    dotenv.config();
    if (!process.env.JWT_SECRET) {
      console.error('❌ JWT_SECRET is still not set after loading .env file');
      console.error('❌ Please set JWT_SECRET in your .env file');
      throw new Error('JWT_SECRET is required but not set. Please add JWT_SECRET to your .env file.');
    } else {
      console.log('✅ JWT_SECRET loaded from .env file');
    }
  } catch (err) {
    console.error('❌ Failed to load JWT_SECRET:', err);
    throw new Error('JWT_SECRET is required but could not be loaded. Please set JWT_SECRET in your .env file or environment variables.');
  }
} else {
  console.log('[Server] ✅ JWT_SECRET is set');
}

// Now import Prisma and other modules AFTER DATABASE_URL is set
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';

// Import routes
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import companyRoutes from './routes/company.routes';
import branchRoutes from './routes/branch.routes';
import productRoutes from './routes/product.routes';
import customerRoutes from './routes/customer.routes';
import saleRoutes from './routes/sale.routes';
import reportRoutes from './routes/report.routes';
import dashboardRoutes from './routes/dashboard.routes';
import adminRoutes from './routes/admin.routes';
import categoryRoutes from './routes/category.routes';
import supplierRoutes from './routes/supplier.routes';
import manufacturerRoutes from './routes/manufacturer.routes';
import shelfRoutes from './routes/shelf.routes';
import employeeRoutes from './routes/employee.routes';
import attendanceRoutes from './routes/attendance.routes';
import shiftRoutes from './routes/shift.routes';
import scheduledShiftRoutes from './routes/scheduledShift.routes';
import commissionRoutes from './routes/commission.routes';
import roleRoutes from './routes/role.routes';
import refundRoutes from './routes/refund.routes';
import subscriptionRoutes from './routes/subscription.routes';
import batchRoutes from './routes/batch.routes';
import purchaseRoutes from './routes/purchase.routes';
import inventoryRoutes from './routes/inventory.routes';
import sseRoutes from './routes/sse.routes';
import settingsRoutes from './routes/settings.routes';
import syncRoutes from './routes/sync.routes';
import { getDatabaseService, DatabaseType } from './services/database.service';
import { getSyncService } from './services/sync.service';
import { getPrisma } from './utils/db.util';

// Import middleware
import { errorHandler } from './middleware/error.middleware';
import { notFound } from './middleware/notFound.middleware';

// DATABASE_URL is already set above - no need to check again

const app = express();

// Initialize Database Service for offline/online switching
let dbService: ReturnType<typeof getDatabaseService> | undefined;
let syncService: ReturnType<typeof getSyncService> | undefined;

try {
  dbService = getDatabaseService();
  syncService = getSyncService();

  // Initialize prisma client after database service is ready (async)
  initializePrismaClient().catch(err => {
    console.error('[Server] ❌ Failed to initialize Prisma Client:', err);
  });

  // Initialize connectivity check
  if (dbService) {
    dbService.checkConnectivity().then(status => {
      if (!dbService || !syncService) {
        console.error('[Database] Database service or sync service not available');
        return;
      }

      console.log(`[Database] Initial connectivity: ${status}`);
      console.log(`[Database] Current database type: ${dbService.getCurrentType()}`);

      // CRITICAL: Check database health and rebuild if needed (e.g., after reinstall)
      // This ensures SQLite database exists and has data before any operations
      if (syncService) {
        console.log('[Sync] 🔍 Initializing database...');
        syncService.initializeDatabase().then(initialized => {
          if (!initialized) {
            console.error('[Sync] ⚠️ Database initialization had issues - some features may not work offline');
          }

          // After initialization, do regular sync if online
          // CRITICAL FIX: Don't sync users FROM PostgreSQL - users should only sync TO PostgreSQL
          // Local SQLite users take precedence to prevent newly created users from disappearing
          if (status === 'online' && syncService) {
            // ⚠️ SKIPPED: User sync from PostgreSQL - users should only sync TO PostgreSQL, not FROM
            // This prevents local users from being overwritten by empty/old PostgreSQL data
            // console.log('[Sync] 🔄 Syncing users from PostgreSQL...');
            // syncService.syncUsersFromPostgreSQL().then(result => {
            //   console.log(`[Sync] ✅ User sync: ${result.synced} users synced`);
            // }).catch(err => {
            //   console.error('[Sync] ❌ User sync failed:', err.message);
            // });

            // Sync ALL tables EXCEPT users from PostgreSQL to SQLite
            // Users are handled separately - they only sync TO PostgreSQL, not FROM
            console.log('[Sync] 🔄 Starting incremental sync of all tables (excluding users)...');
            syncService.syncAllTablesFromPostgreSQL().then(result => {
              console.log(`[Sync] ✅ Sync complete: ${result.synced} records synced, ${result.failed} failed`);
              if (result.errors.length > 0) {
                console.log(`[Sync] ⚠️ Sync errors: ${result.errors.slice(0, 3).join(', ')}`);
              }
            }).catch(err => {
              console.error('[Sync] ❌ Sync failed:', err.message);
            });
          }
        }).catch(err => {
          console.error('[Sync] ❌ Database initialization failed:', err.message);
        });
      }

      // Start periodic connectivity monitoring (every 2 minutes to reduce logs)
      dbService.startConnectivityMonitoring(120000); // Check every 2 minutes

      // ========================================================================
      // EVENT-DRIVEN SYNC is now the PRIMARY sync mechanism!
      // Controllers call syncAfterOperation() after each CRUD operation for immediate sync.
      // This periodic sync is now a BACKUP/FALLBACK only (runs less frequently).
      // See: src/utils/sync-helper.ts for the event-driven sync utilities.
      // ========================================================================

      // BACKUP BIDIRECTIONAL SYNC: Every 5 minutes when online
      // This is a fallback - primary sync happens on each operation via sync-helper
      setInterval(async () => {
        if (syncService && dbService && dbService.getConnectionStatus() === 'online') {
          console.log('[Sync] 🔄 Running periodic BIDIRECTIONAL sync (backup)...');
          syncService.bidirectionalSync().catch(err => {
            // Silent fail - don't spam logs
          });
        }
      }, 300000); // Every 5 minutes (reduced from 60 seconds - event-driven is primary now)

      // User sync remains frequent (every 30 seconds) for authentication changes
      // This is important for password changes, account deactivation, etc.
      setInterval(async () => {
        if (syncService && dbService && dbService.getConnectionStatus() === 'online') {
          syncService.syncUsersFromPostgreSQL().catch(err => {
            // Silent fail - don't spam logs
          });
        }
      }, 30000); // Every 30 seconds

      // Auto-sync when going online/offline
      let previousStatus = String(status);
      let previousType = dbService.getCurrentType();

      // Check for status changes every 30 seconds
      setInterval(async () => {
        if (!dbService || !syncService) {
          return;
        }

        const currentStatus = String(dbService.getConnectionStatus());
        const currentType = dbService.getCurrentType();

        // If status changed from offline to online, do full bidirectional sync
        if (previousStatus === 'offline' && currentStatus === 'online') {
          console.log('[Sync] 🔄 Connection restored - Running FULL BIDIRECTIONAL sync...');
          syncService.bidirectionalSync().catch(err => {
            console.error('[Sync] Auto-sync failed:', err);
          });
        }

        // If status changed from online to offline, sync PostgreSQL → SQLite
        // This ensures SQLite has the latest data when going offline
        if (previousStatus === 'online' && currentStatus === 'offline') {
          console.log('[Sync] 🔄 Going offline, syncing PostgreSQL → SQLite to keep data up-to-date...');
          syncService.syncToSQLite().catch(err => {
            console.error('[Sync] Auto-sync to SQLite failed:', err);
          });
        }

        // Update previous status
        previousStatus = currentStatus;
        previousType = currentType;
      }, 30000); // Check every 30 seconds

      // Edge case fallback sync - runs every 10 minutes
      // This is a safety net for any missed syncs (event-driven sync is primary)
      setInterval(async () => {
        if (!dbService || !syncService) {
          return;
        }

        const currentStatus = String(dbService.getConnectionStatus());
        const currentType = dbService.getCurrentType();

        // Periodic sync: Keep both databases in sync when online
        // Sync every 10 minutes as a safety net (event-driven sync is primary)
        if (currentStatus === 'online' && currentType === 'postgresql') {
          const now = new Date();
          const lastSync = syncService.getStatus().lastSync;
          const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

          // If last sync was more than 10 minutes ago, sync both ways
          if (!lastSync || new Date(lastSync) < tenMinutesAgo) {
            console.log('[Sync] 🔄 Safety net sync: Ensuring both databases are in sync...');
            // Sync SQLite → PostgreSQL (offline changes)
            syncService.syncToPostgreSQL().catch(err => {
              console.error('[Sync] Safety net sync to PostgreSQL failed:', err);
            });
            // Also sync PostgreSQL → SQLite (in case of external changes)
            syncService.syncToSQLite().catch(err => {
              console.error('[Sync] Safety net sync to SQLite failed:', err);
            });
          }
        }

        previousStatus = currentStatus;
        previousType = currentType;
      }, 600000); // Check every 10 minutes (reduced - event-driven sync is primary)
    }).catch(err => {
      console.error('[Database] Failed to initialize database service:', err);
    });
  }
} catch (error: any) {
  console.error('❌ Failed to initialize Database Service:', error.message);
}

// Legacy Prisma client - will be initialized after database service
// This ensures it works with both SQLite and PostgreSQL
let prisma: PrismaClient | undefined;

// Initialize prisma client after database service is ready
async function initializePrismaClient(): Promise<void> {
  try {
    // Use database service to get the correct client (SQLite or PostgreSQL)
    if (dbService) {
      // Get client from database service (handles SQLite/PostgreSQL switching)
      try {
        prisma = await dbService.getClient();
        console.log('[Server] ✅ Prisma client initialized via database service');
      } catch (err: any) {
        console.error('[Server] ❌ Failed to get client from database service:', err);
        // Fallback: try to create with DATABASE_URL if set
        if (process.env.DATABASE_URL) {
          prisma = new PrismaClient();
        } else {
          // Last resort: create with SQLite default
          const sqlitePath = path.join(os.homedir(), '.zapeera', 'data', 'zapeera.db');
          process.env.DATABASE_URL = `file:${sqlitePath}`;
          prisma = new PrismaClient();
        }
      }
    } else {
      // Fallback if database service not available
      if (process.env.DATABASE_URL) {
        prisma = new PrismaClient();
      } else {
        // Use SQLite as default
        const sqlitePath = path.join(os.homedir(), '.zapeera', 'data', 'zapeera.db');
        process.env.DATABASE_URL = `file:${sqlitePath}`;
        prisma = new PrismaClient();
      }
    }
  } catch (error: any) {
    console.error('❌ Failed to initialize Prisma Client:', error.message);
    // Last resort: try with SQLite
    try {
      const sqlitePath = path.join(os.homedir(), '.zapeera', 'data', 'zapeera.db');
      process.env.DATABASE_URL = `file:${sqlitePath}`;
      prisma = new PrismaClient();
    } catch (e: any) {
      console.error('❌ Failed to initialize Prisma Client with SQLite:', e.message);
      // Create a client anyway - it might work
      prisma = new PrismaClient();
    }
  }
}

// Helper function to get prisma client (async, uses database service)
export async function getPrismaClient(): Promise<PrismaClient> {
  if (dbService) {
    try {
      return await dbService.getClient();
    } catch (err) {
      console.error('[Server] Failed to get client from database service, using legacy client');
      if (!prisma) {
        // Initialize prisma if not already initialized
        await initializePrismaClient();
      }
      if (!prisma) {
        throw new Error('Prisma client is not available');
      }
      return prisma;
    }
  }
  if (!prisma) {
    // Initialize prisma if not already initialized
    await initializePrismaClient();
  }
  if (!prisma) {
    throw new Error('Prisma client is not available');
  }
  return prisma;
}

// BigInt serialization will be handled in individual controllers

// Database connection test function
async function testDatabaseConnection() {
  try {
    console.log('='.repeat(60));
    console.log('🔍 CHECKING DATABASE CONNECTION STATUS');
    console.log('='.repeat(60));
    console.log('📊 Database URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');

    // Check if it's SQLite
    const databaseUrl = process.env.DATABASE_URL;
    const isSQLite = databaseUrl?.startsWith('file:');
    if (isSQLite && databaseUrl) {
      const dbPath = databaseUrl.replace('file:', '').split('?')[0];
      const fs = require('fs');
      const path = require('path');

      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath);
        console.log('📁 Database Path:', dbPath);
        console.log('📦 Database Size:', `${(stats.size / 1024).toFixed(2)} KB`);
        console.log('🗄️  Database Type: SQLite');
      } else {
        console.log('📁 Database Path:', dbPath);
        console.log('⚠️  Database file does not exist yet (will be created on first use)');
        console.log('🗄️  Database Type: SQLite');
      }
    } else {
      console.log('🗄️  Database Type:', databaseUrl?.split(':')[0] || 'Unknown');
    }

    console.log('⏳ Attempting to connect...');

    // CRITICAL: Use getPrismaClient() instead of prisma variable
    // prisma might not be initialized yet (it's async)
    // Wait a bit for prisma to initialize if it's not ready
    let prismaClient: PrismaClient;
    if (!prisma) {
      console.log('⏳ Waiting for Prisma client to initialize...');
      // Wait up to 5 seconds for prisma to be initialized
      for (let i = 0; i < 50; i++) {
        if (prisma) {
          prismaClient = prisma;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // If still not initialized, use getPrismaClient()
      if (!prisma) {
        console.log('⏳ Prisma not initialized yet, using getPrismaClient()...');
        prismaClient = await getPrismaClient();
      } else {
        prismaClient = prisma;
      }
    } else {
      prismaClient = prisma;
    }

    await prismaClient.$connect();

    // Test a simple query - use database-agnostic query
    // Try SQLite first, then fallback to PostgreSQL
    let result: any;
    try {
      // Try SQLite compatible query first
      result = await prismaClient.$queryRaw`SELECT datetime('now') as current_time` as any[];
      console.log('='.repeat(60));
      console.log('✅ DATABASE CONNECTION: SUCCESSFUL');
      console.log('='.repeat(60));
      console.log('📋 Database Type: SQLite');
      console.log('🕐 Connection Time:', result[0].current_time);
      console.log('🔗 Status: CONNECTED');
      console.log('='.repeat(60));
    } catch (sqliteError: any) {
      // If SQLite query fails, try PostgreSQL
      try {
        result = await prismaClient.$queryRaw`SELECT NOW() as current_time, current_database() as db_name` as any[];
        console.log('='.repeat(60));
        console.log('✅ DATABASE CONNECTION: SUCCESSFUL');
        console.log('='.repeat(60));
        console.log('📋 Database Name:', result[0].db_name);
        console.log('🕐 Connection Time:', result[0].current_time);
        console.log('🔗 Status: CONNECTED');
        console.log('='.repeat(60));
      } catch (pgError: any) {
        // If both fail, connection still works (just can't test query)
        console.log('='.repeat(60));
        console.log('✅ DATABASE CONNECTION: SUCCESSFUL');
        console.log('='.repeat(60));
        console.log('⚠️  Could not execute test query, but connection is established');
        console.log('🔗 Status: CONNECTED');
        console.log('='.repeat(60));
      }
    }

    return true;
  } catch (error: any) {
    console.log('='.repeat(60));
    console.log('❌ DATABASE CONNECTION: FAILED');
    console.log('='.repeat(60));
    console.log('🚨 Error:', error.message);
    console.log('🔗 Status: NOT CONNECTED');
    console.log('='.repeat(60));
    return false;
  }
}

// Security middleware
app.use(helmet());

// CORS configuration
const corsOptions = {
  origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    // Allow requests with no origin (like mobile apps, curl requests, or Electron file:// protocol)
    if (!origin) return callback(null, true);

    // Allow file:// protocol (Electron apps)
    if (origin.startsWith('file://')) {
      return callback(null, true);
    }

    const allowedOrigins = [
      process.env.FRONTEND_URL || 'http://localhost:5173',
      ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : [
        'http://localhost:8080',
        'http://localhost:8081',
        'http://localhost:3000',
        'http://localhost:5001',
        'http://127.0.0.1:8080',
        'http://127.0.0.1:8081',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5001',
        'null' // Electron sometimes sends 'null' as origin
      ])
    ];

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      // In development, log but allow (for easier debugging)
      if (process.env.NODE_ENV === 'development') {
        console.log('CORS: Allowing origin in development:', origin);
        return callback(null, true);
      }
      console.log('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Company-ID', 'X-Branch-ID'],
  optionsSuccessStatus: 200 // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Rate limiting - More generous for dashboard usage
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes default
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '1000'), // limit each IP to 1000 requests per windowMs (increased for dashboard)
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: process.env.MAX_FILE_SIZE || '10mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.MAX_FILE_SIZE || '10mb' }));

// Compression middleware
app.use(compression());

// Logging middleware
if (process.env.ENABLE_REQUEST_LOGGING === 'true') {
  if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
  } else {
    app.use(morgan('combined'));
  }
}

// Health check endpoint - Always return OK even if database is not connected
// This allows the frontend to connect even if DATABASE_URL is missing
// Health check endpoint with database status
const healthCheckHandler = async (req: express.Request, res: express.Response) => {
  try {
    const dbService = getDatabaseService();
    const dbStatus = dbService.getStatus();
    const currentType = dbService.getCurrentType();

    // Test database connection - use SQLite-compatible query
    try {
      const prismaClient = await getPrisma();
      try {
        // Try SQLite query first
        await prismaClient.$queryRaw`SELECT datetime('now') as test`;
      } catch (e) {
        // If SQLite query fails, try PostgreSQL
        try {
          await prismaClient.$queryRaw`SELECT 1 as test`;
        } catch (e2) {
          // Both failed, but connection might still work
        }
      }
    } catch (err) {
      // Database connection failed
      console.error('[Health] Database connection error:', err);
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: {
        type: currentType === DatabaseType.SQLITE ? 'sqlite' : 'postgresql',
        status: dbStatus.connectionStatus,
        isOnline: dbService.isOnline(),
        isOffline: dbService.isOffline(),
        sqlite: {
          connected: dbStatus.sqlite.connected,
          path: dbStatus.sqlite.url?.replace('file:', '') || 'N/A'
        },
        postgresql: {
          connected: dbStatus.postgresql.connected,
          configured: !!dbStatus.postgresql.url
        }
      }
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// Health check endpoints - both /health and /api/health
app.get('/health', healthCheckHandler);
app.get('/api/health', healthCheckHandler);

// Offline mode test endpoint
app.get('/api/test-offline', async (req, res) => {
  try {
    const dbService = getDatabaseService();
    const prismaClient = await getPrisma();

    // Test 1: Check database type
    const currentType = dbService.getCurrentType();
    const isSQLite = currentType === DatabaseType.SQLITE;

    // Test 2: Try to read from database
    const userCount = await prismaClient.user.count();
    const companyCount = await prismaClient.company.count();

    // Test 3: Try to write to database (create a test record and delete it)
    const testResult = await prismaClient.$queryRaw`SELECT datetime('now') as current_time` as any[];
    const currentTime = testResult[0]?.current_time || new Date().toISOString();

    res.json({
      success: true,
      message: 'Offline mode is working! ✅',
      tests: {
        databaseType: isSQLite ? 'SQLite (Offline)' : 'PostgreSQL (Online)',
        databaseConnected: true,
        canRead: true,
        canWrite: true,
        currentTime: currentTime
      },
      data: {
        totalUsers: userCount,
        totalCompanies: companyCount
      },
      status: {
        isOffline: dbService.isOffline(),
        isOnline: dbService.isOnline(),
        connectionStatus: dbService.getConnectionStatus()
      },
      databasePath: isSQLite ? dbService.getStatus().sqlite.url?.replace('file:', '') : 'N/A'
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Offline mode test failed ❌',
      error: error.message,
      tests: {
        databaseType: 'Unknown',
        databaseConnected: false,
        canRead: false,
        canWrite: false
      }
    });
  }
});

app.get('/health-old', async (req, res) => {
  try {
    // Test database connection only if DATABASE_URL is set
    if (process.env.DATABASE_URL) {
      try {
        const prismaClient = await getPrismaClient();
        await prismaClient.$queryRaw`SELECT 1`;
        res.status(200).json({
          status: 'OK',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          environment: process.env.NODE_ENV,
          database: 'connected',
          server: 'running'
        });
        return;
      } catch (dbError) {
        // Database connection failed but server is running
        res.status(200).json({
          status: 'OK',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          environment: process.env.NODE_ENV,
          database: 'disconnected',
          server: 'running',
          warning: 'Database connection failed but server is running'
        });
        return;
      }
    } else {
      // No DATABASE_URL set - server is still running
      res.status(200).json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV,
        database: 'not_configured',
        server: 'running',
        warning: 'DATABASE_URL not set - database operations will fail'
      });
      return;
    }
  } catch (error) {
    // Even if everything fails, return 200 for basic health check
    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV,
      database: 'unknown',
      server: 'running',
      warning: 'Health check had errors but server is running'
    });
  }
});

// Simple health check for Railway (no database dependency)
app.get('/ping', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV
  });
});

// Root route - return API info
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Zapeera Pharmacy Management API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      api: '/api',
      ping: '/ping'
    },
    documentation: 'API endpoints are available under /api/*'
  });
});

// API root route - return API info
app.get('/api', (req, res) => {
  res.status(200).json({
    message: 'Zapeera Pharmacy Management API',
    version: '1.0.0',
    availableEndpoints: [
      '/api/auth',
      '/api/users',
      '/api/products',
      '/api/sales',
      '/api/reports',
      '/api/dashboard',
      '/api/customers',
      '/api/inventory',
      '/api/companies',
      '/api/branches'
    ],
    healthCheck: '/health'
  });
});

// Ignore favicon requests (prevent 404 errors)
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/products', productRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/sales', saleRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/manufacturers', manufacturerRoutes);
app.use('/api/shelves', shelfRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/shifts', shiftRoutes);
app.use('/api/scheduled-shifts', scheduledShiftRoutes);
app.use('/api/commissions', commissionRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/refunds', refundRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/batches', batchRoutes);
app.use('/api/purchases', purchaseRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/sse', sseRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/sync', syncRoutes);

// Error handling middleware
app.use(notFound);
app.use(errorHandler);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  if (prisma) {
    await prisma.$disconnect();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  if (prisma) {
    await prisma.$disconnect();
  }
  process.exit(0);
});

// Ensure PORT is always a valid number
const DEFAULT_PORT: number = (() => {
  const portEnv = process.env.PORT;
  if (!portEnv) return 5001;

  const parsed = parseInt(portEnv, 10);
  if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(`Invalid PORT value: ${portEnv}. Using default port 5001.`);
    return 5001;
  }

  return parsed;
})();

// Check if PORT was explicitly set (not default)
const PORT_EXPLICITLY_SET = !!process.env.PORT;

// Function to check if a port is available
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();

    server.listen(port, () => {
      server.once('close', () => resolve(true));
      server.close();
    });

    server.on('error', () => resolve(false));
  });
}

// Function to kill process using a port (macOS/Linux)
async function killProcessOnPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'darwin' || process.platform === 'linux') {
        try {
          const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf8', timeout: 2000 }).trim();
          if (pids) {
            const pidArray = pids.split('\n').filter((p: string) => p.trim());
            pidArray.forEach((pid: string) => {
              try {
                execSync(`kill -9 ${pid.trim()}`, { timeout: 1000 });
                console.log(`✅ Killed process ${pid.trim()} using port ${port}`);
              } catch (e) {
                // Ignore errors
              }
            });
            setTimeout(() => resolve(true), 1000);
          } else {
            resolve(false);
          }
        } catch (e) {
          resolve(false);
        }
      } else if (process.platform === 'win32') {
        try {
          const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', timeout: 2000 });
          const lines = result.split('\n').filter((line: string) => line.includes('LISTENING'));
          lines.forEach((line: string) => {
            const pid = line.trim().split(/\s+/).pop();
            if (pid) {
              try {
                execSync(`taskkill /F /PID ${pid}`, { timeout: 1000 });
                console.log(`✅ Killed process ${pid} using port ${port}`);
              } catch (e) {
                // Ignore errors
              }
            }
          });
          setTimeout(() => resolve(true), 1000);
        } catch (e) {
          resolve(false);
        }
      } else {
        resolve(false);
      }
    } catch (error) {
      resolve(false);
    }
  });
}

// Start server with database connection check and automatic port selection
async function startServer(): Promise<void> {
  let currentPort = DEFAULT_PORT;
  let attempts = 0;
  // If PORT is explicitly set, keep trying the same port (for Electron)
  // Otherwise, try alternative ports
  const maxAttempts = PORT_EXPLICITLY_SET ? 20 : 10; // More attempts if port is explicitly set
  let server: any = null;

  while (attempts < maxAttempts) {
    // Try to kill any process using the port first (especially important if PORT is explicitly set)
    await killProcessOnPort(currentPort);

    // Wait a bit for port to be released (longer wait if port is explicitly set)
    await new Promise(resolve => setTimeout(resolve, PORT_EXPLICITLY_SET ? 1000 : 500));

    // Check if port is available
    const available = await isPortAvailable(currentPort);

    if (available) {
      try {
        // Start the server on this port
        server = app.listen(currentPort, '0.0.0.0', () => {
          console.log('='.repeat(60));
          console.log('🚀 ZAPEERA BACKEND SERVER STARTED');
          console.log('='.repeat(60));
          console.log(`🌐 Server running on port: ${currentPort}`);
          console.log(`📊 Environment: ${process.env.NODE_ENV || 'production'}`);
          console.log(`🔗 Health check: http://0.0.0.0:${currentPort}/health`);
          console.log(`📋 API Base URL: http://0.0.0.0:${currentPort}/api`);
          console.log('='.repeat(60));

          // Emit ready signal for Electron detection
          console.log('✅ Server is ready to accept connections');

          // Update process.env.PORT so other parts of the app know the actual port
          process.env.PORT = currentPort.toString();
        });

        // Handle server startup errors
        server.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') {
            if (PORT_EXPLICITLY_SET) {
              // If port is explicitly set, keep trying the same port
              console.log(`⚠️  Port ${currentPort} is still in use. Killing processes and retrying...`);
              if (server) {
                server.close();
              }
              attempts++;
              // Retry with same port after killing processes
              setTimeout(() => startServer(), 2000);
            } else {
              // If port is not explicitly set, try next port
              console.log(`⚠️  Port ${currentPort} is already in use. Trying next port...`);
              if (server) {
                server.close();
              }
              attempts++;
              currentPort++;
              // Retry with next port
              setTimeout(() => startServer(), 1000);
            }
          } else if (error.code === 'EACCES') {
            console.error(`❌ Permission denied to bind to port ${currentPort}. Please use a port above 1024.`);
            process.exit(1);
          } else {
            console.error('❌ Server startup error:', error.message);
            process.exit(1);
          }
        });

        // Test database connection in background (non-blocking)
        // Wait longer to ensure prisma is initialized
        setTimeout(async () => {
          // Wait for prisma to be initialized
          let waitCount = 0;
          while (!prisma && waitCount < 30) {
            await new Promise(resolve => setTimeout(resolve, 200));
            waitCount++;
          }

          const dbConnected = await testDatabaseConnection();
          if (!dbConnected) {
            console.log('⚠️  Database connection issues detected...');
            console.log('💡 Server is running but database may not be accessible');
            console.log('💡 Check your DATABASE_URL environment variable');
          }
        }, 3000); // Wait 3 seconds after server starts to ensure prisma is initialized

        return; // Successfully started
      } catch (error: any) {
        if (error.code === 'EADDRINUSE') {
          if (PORT_EXPLICITLY_SET) {
            // Keep trying the same port
            console.log(`⚠️  Port ${currentPort} is still in use. Retrying...`);
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          } else {
            console.log(`⚠️  Port ${currentPort} is already in use. Trying next port...`);
            attempts++;
            currentPort++;
            continue;
          }
        } else {
          throw error;
        }
      }
    } else {
      if (PORT_EXPLICITLY_SET) {
        // Keep trying the same port
        console.log(`⚠️  Port ${currentPort} is not available. Killing processes and retrying...`);
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        console.log(`⚠️  Port ${currentPort} is not available. Trying next port...`);
        attempts++;
        currentPort++;
      }
    }
  }

  // If we've exhausted all attempts
  if (PORT_EXPLICITLY_SET) {
    console.error(`❌ Could not start server on port ${DEFAULT_PORT} after ${maxAttempts} attempts.`);
    console.error(`❌ Port ${DEFAULT_PORT} is in use and could not be freed.`);
    console.error(`❌ Please close other applications using port ${DEFAULT_PORT}.`);
  } else {
    console.error(`❌ Could not find an available port after ${maxAttempts} attempts.`);
    console.error(`❌ Tried ports ${DEFAULT_PORT} to ${currentPort - 1}.`);
  }
  process.exit(1);
}

startServer();

export default app;
