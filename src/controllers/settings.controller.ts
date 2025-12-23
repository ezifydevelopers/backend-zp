import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

const updateSettingsSchema = Joi.object({
  defaultTax: Joi.number().min(0).max(100).required(),
  lowStockAlert: Joi.number().min(0).required(),
  expiryAlert: Joi.number().min(0).required(),
  autoSync: Joi.boolean().required(),
  offlineMode: Joi.boolean().required(),
  receiptPrinter: Joi.string().required(),
  pharmacyName: Joi.string().required(),
  pharmacyAddress: Joi.string().required(),
  pharmacyPhone: Joi.string().required(),
  pharmacyEmail: Joi.string().email().required(),
  pharmacyLicense: Joi.string().required(),
  pharmacyTaxNumber: Joi.string().required()
});

export const getSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const createdBy = req.user?.createdBy || req.user?.id;

    if (!createdBy) {
      res.status(401).json({
        success: false,
        message: 'Admin ID not found'
      });
      return;
    }

    // Get all settings for this admin
    const settings = await prisma.settings.findMany({
      where: { createdBy },
      select: {
        key: true,
        value: true,
        description: true
      }
    });

    // Convert to object format
    const settingsObj: any = {};
    settings.forEach(setting => {
      settingsObj[setting.key] = setting.value;
    });

    // Set default values if not found
    const defaultSettings = {
      defaultTax: settingsObj.defaultTax || '17',
      lowStockAlert: settingsObj.lowStockAlert || '20',
      expiryAlert: settingsObj.expiryAlert || '30',
      autoSync: settingsObj.autoSync || 'true',
      offlineMode: settingsObj.offlineMode || 'true',
      receiptPrinter: settingsObj.receiptPrinter || 'EPSON TM-T20II',
      pharmacyName: settingsObj.pharmacyName || process.env.DEFAULT_PHARMACY_NAME || 'MediBill Pulse Pharmacy',
      pharmacyAddress: settingsObj.pharmacyAddress || 'Block A, Gulberg III, Lahore',
      pharmacyPhone: settingsObj.pharmacyPhone || process.env.DEFAULT_PHARMACY_PHONE || '+92 42 1234567',
      pharmacyEmail: settingsObj.pharmacyEmail || process.env.DEFAULT_PHARMACY_EMAIL || 'info@medibillpulse.com',
      pharmacyLicense: settingsObj.pharmacyLicense || process.env.DEFAULT_PHARMACY_LICENSE || 'PHR-LHR-2024-001',
      pharmacyTaxNumber: settingsObj.pharmacyTaxNumber || '1234567890123'
    };

    res.json({
      success: true,
      data: defaultSettings
    });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const createdBy = req.user?.createdBy || req.user?.id;

    if (!createdBy) {
      res.status(401).json({
        success: false,
        message: 'Admin ID not found'
      });
      return;
    }

    const { error } = updateSettingsSchema.validate(req.body);
    if (error) {
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
      return;
    }

    const settingsData = req.body;

    // Use transaction to update all settings
    await prisma.$transaction(async (tx: any) => {
      for (const [key, value] of Object.entries(settingsData)) {
        await tx.settings.upsert({
          where: {
            createdBy_key: {
              createdBy,
              key
            }
          },
          update: {
            value: String(value),
            updatedAt: new Date()
          },
          create: {
            createdBy,
            key,
            value: String(value),
            description: getSettingDescription(key)
          }
        });
      }
    });

    res.json({
      success: true,
      message: 'Settings updated successfully'
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getTaxRate = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const prisma = await getPrisma();
    const createdBy = req.user?.createdBy || req.user?.id;

    if (!createdBy) {
      res.status(401).json({
        success: false,
        message: 'Admin ID not found'
      });
      return;
    }

    // Get tax rate setting
    const taxSetting = await prisma.settings.findUnique({
      where: {
        createdBy_key: {
          createdBy,
          key: 'defaultTax'
        }
      }
    });

    const taxRate = taxSetting ? parseFloat(taxSetting.value) : 0; // Tax disabled - default to 0%

    res.json({
      success: true,
      data: {
        taxRate
      }
    });
  } catch (error) {
    console.error('Get tax rate error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

function getSettingDescription(key: string): string {
  const descriptions: { [key: string]: string } = {
    defaultTax: 'Default tax rate percentage for sales',
    lowStockAlert: 'Minimum stock level to trigger low stock alert',
    expiryAlert: 'Days before expiry to trigger alert',
    autoSync: 'Automatically sync data when online',
    offlineMode: 'Allow operations without internet connection',
    receiptPrinter: 'Default receipt printer model',
    pharmacyName: 'Pharmacy business name',
    pharmacyAddress: 'Pharmacy business address',
    pharmacyPhone: 'Pharmacy contact phone number',
    pharmacyEmail: 'Pharmacy contact email address',
    pharmacyLicense: 'Pharmacy license number',
    pharmacyTaxNumber: 'Pharmacy tax registration number'
  };

  return descriptions[key] || 'System setting';
}
