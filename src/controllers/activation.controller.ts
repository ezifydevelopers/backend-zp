/**
 * Device Activation Controller
 * Handles device registration, activation, and deactivation by superadmin
 */

import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { getPrisma, getPrismaSync } from '../utils/db.util';

const prisma = getPrismaSync();

/**
 * Get all device activations (superadmin only)
 */
export const getAllDevices = async (req: Request, res: Response) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (status) {
      where.status = status;
    }
    if (search) {
      where.OR = [
        { deviceId: { contains: search as string, mode: 'insensitive' } },
        { hostname: { contains: search as string, mode: 'insensitive' } },
        { licenseKey: { contains: search as string, mode: 'insensitive' } }
      ];
    }

    const [devices, total] = await Promise.all([
      prisma.deviceActivation.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, name: true, email: true }
          },
          company: {
            select: { id: true, name: true }
          },
          branch: {
            select: { id: true, name: true }
          }
        }
      }),
      prisma.deviceActivation.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        devices,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / Number(limit))
        }
      }
    });
  } catch (error: any) {
    console.error('[Activation] Get all devices error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get single device activation
 */
export const getDevice = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const device = await prisma.deviceActivation.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, name: true, email: true }
        },
        company: {
          select: { id: true, name: true }
        },
        branch: {
          select: { id: true, name: true }
        }
      }
    });

    if (!device) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }

    return res.json({ success: true, data: device });
  } catch (error: any) {
    console.error('[Activation] Get device error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Activate device (superadmin only)
 */
export const activateDevice = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userId, companyId, branchId, licenseKey, notes } = req.body;
    const activatedBy = (req as any).user?.id;

    const device = await prisma.deviceActivation.findUnique({
      where: { id }
    });

    if (!device) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }

    // Calculate offline access expiry (72 hours from now)
    const offlineExpiresAt = new Date();
    offlineExpiresAt.setHours(offlineExpiresAt.getHours() + 72);

    const updated = await prisma.deviceActivation.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        userId: userId || device.userId,
        companyId: companyId || device.companyId,
        branchId: branchId || device.branchId,
        licenseKey: licenseKey || device.licenseKey,
        activatedBy,
        activatedAt: new Date(),
        lastVerifiedAt: new Date(),
        lastVerifiedStatus: 'ACTIVE',
        offlineAccessExpiresAt: offlineExpiresAt,
        notes: notes || device.notes,
        updatedAt: new Date()
      },
      include: {
        user: {
          select: { id: true, name: true, email: true }
        },
        company: {
          select: { id: true, name: true }
        },
        branch: {
          select: { id: true, name: true }
        }
      }
    });

    return res.json({
      success: true,
      data: updated,
      message: 'Device activated successfully'
    });
  } catch (error: any) {
    console.error('[Activation] Activate device error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Deactivate device (superadmin only)
 */
export const deactivateDevice = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const device = await prisma.deviceActivation.findUnique({
      where: { id }
    });

    if (!device) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }

    const updated = await prisma.deviceActivation.update({
      where: { id },
      data: {
        status: 'INACTIVE',
        lastVerifiedAt: new Date(),
        lastVerifiedStatus: 'INACTIVE',
        offlineAccessExpiresAt: null,
        notes: reason ? `${device.notes || ''}\nDeactivated: ${reason}`.trim() : device.notes,
        updatedAt: new Date()
      }
    });

    return res.json({
      success: true,
      data: updated,
      message: 'Device deactivated successfully'
    });
  } catch (error: any) {
    console.error('[Activation] Deactivate device error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Register device (called from desktop app)
 */
export const registerDevice = async (req: Request, res: Response) => {
  try {
    const {
      deviceId,
      fingerprint,
      platform,
      hostname,
      macAddress,
      licenseKey,
      userId,
      companyId,
      branchId,
      notes
    } = req.body;

    if (!deviceId || !fingerprint) {
      return res.status(400).json({ success: false, message: 'Device ID and fingerprint are required' });
    }

    // Check if device already exists
    const existing = await prisma.deviceActivation.findUnique({
      where: { deviceId }
    });

    if (existing) {
      return res.json({
        success: true,
        data: existing,
        message: 'Device already registered'
      });
    }

    // Create new device registration
    const device = await prisma.deviceActivation.create({
      data: {
        deviceId,
        fingerprint,
        status: 'PENDING',
        licenseKey: licenseKey || null,
        userId: userId || null,
        companyId: companyId || null,
        branchId: branchId || null,
        platform: platform || null,
        hostname: hostname || null,
        macAddress: macAddress || null,
        notes: notes || null
      }
    });

    return res.status(201).json({
      success: true,
      data: device,
      message: 'Device registered successfully. Waiting for activation.'
    });
  } catch (error: any) {
    console.error('[Activation] Register device error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Verify device status (called periodically from desktop app)
 */
export const verifyDevice = async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({ success: false, message: 'Device ID is required' });
    }

    const device = await prisma.deviceActivation.findUnique({
      where: { deviceId }
    });

    if (!device) {
      return res.json({
        success: false,
        data: { activated: false, status: 'PENDING', message: 'Device not registered' }
      });
    }

    // Update last verified timestamp
    await prisma.deviceActivation.update({
      where: { deviceId },
      data: {
        lastVerifiedAt: new Date(),
        lastVerifiedStatus: device.status
      }
    });

    // Check if offline access expired
    let offlineExpired = false;
    if (device.offlineAccessExpiresAt) {
      offlineExpired = new Date() > new Date(device.offlineAccessExpiresAt);
    }

    return res.json({
      success: true,
      data: {
        activated: device.status === 'ACTIVE' && !offlineExpired,
        status: device.status,
        offlineExpired,
        offlineExpiresAt: device.offlineAccessExpiresAt,
        lastVerifiedAt: device.lastVerifiedAt,
        requiresLogout: device.status !== 'ACTIVE' || offlineExpired
      }
    });
  } catch (error: any) {
    console.error('[Activation] Verify device error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
