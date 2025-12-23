import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Validation schemas
const startShiftSchema = Joi.object({
  employeeId: Joi.string().required(),
  branchId: Joi.string().required(),
  shiftDate: Joi.date().required(),
  startTime: Joi.date().required(),
  openingBalance: Joi.number().min(0).default(0),
  notes: Joi.string().optional()
});

const endShiftSchema = Joi.object({
  shiftId: Joi.string().required(),
  endTime: Joi.date().required(),
  actualBalance: Joi.number().min(0).required(),
  notes: Joi.string().optional()
});

const updateShiftSchema = Joi.object({
  cashIn: Joi.number().min(0).optional(),
  cashOut: Joi.number().min(0).optional(),
  notes: Joi.string().optional()
});

// Start a new shift
export const startShift = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { error } = startShiftSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const { employeeId, branchId, shiftDate, startTime, openingBalance, notes } = req.body;

    // Check if employee exists and is active
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { branch: true }
    });

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    if (!employee.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Employee is not active'
      });
    }

    // Check if employee already has an active shift
    const activeShift = await prisma.shift.findFirst({
      where: {
        employeeId,
        status: 'ACTIVE'
      }
    });

    if (activeShift) {
      return res.status(400).json({
        success: false,
        message: 'Employee already has an active shift'
      });
    }

    // Create shift record
    const shift = await prisma.shift.create({
      data: {
        employeeId,
        branchId,
        shiftDate: new Date(shiftDate),
        startTime: new Date(startTime),
        openingBalance,
        notes
      },
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            employeeId: true,
            position: true
          }
        },
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('shift', 'create', shift).catch(err => {
      console.error('[Sync] Shift create sync failed:', err.message);
    });

    return res.status(201).json({
      success: true,
      data: shift,
      message: 'Shift started successfully'
    });
  } catch (error) {
    console.error('Error starting shift:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// End a shift
export const endShift = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { error } = endShiftSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const { shiftId, endTime, actualBalance, notes } = req.body;

    // Find shift record
    const shift = await prisma.shift.findUnique({
      where: { id: shiftId },
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            employeeId: true,
            position: true
          }
        },
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    if (shift.status !== 'ACTIVE') {
      return res.status(400).json({
        success: false,
        message: 'Shift is not active'
      });
    }

    // Calculate expected balance and difference
    const expectedBalance = shift.openingBalance + shift.cashIn - shift.cashOut;
    const difference = actualBalance - expectedBalance;

    // Update shift record
    const updatedShift = await prisma.shift.update({
      where: { id: shiftId },
      data: {
        endTime: new Date(endTime),
        actualBalance,
        expectedBalance,
        difference,
        status: 'COMPLETED',
        notes: notes || shift.notes
      },
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            employeeId: true,
            position: true
          }
        },
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    return res.json({
      success: true,
      data: updatedShift,
      message: 'Shift ended successfully'
    });
  } catch (error) {
    console.error('Error ending shift:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get shifts
export const getShifts = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const {
      page = 1,
      limit = 10,
      employeeId = '',
      branchId = '',
      status = '',
      startDate = '',
      endDate = ''
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where: any = {};

    if (employeeId) {
      where.employeeId = employeeId;
    }

    if (branchId) {
      where.branchId = branchId;
    }

    if (status) {
      where.status = status;
    }

    if (startDate || endDate) {
      where.shiftDate = {};
      if (startDate) {
        where.shiftDate.gte = new Date(startDate as string);
      }
      if (endDate) {
        const endDateObj = new Date(endDate as string);
        endDateObj.setHours(23, 59, 59, 999);
        where.shiftDate.lte = endDateObj;
      }
    }

    const [shifts, total] = await Promise.all([
      prisma.shift.findMany({
        where,
        skip,
        take,
        include: {
          employee: {
            select: {
              id: true,
              name: true,
              employeeId: true,
              position: true
            }
          },
          branch: {
            select: {
              id: true,
              name: true
            }
          }
        },
        orderBy: { shiftDate: 'desc' }
      }),
      prisma.shift.count({ where })
    ]);

    return res.json({
      success: true,
      data: {
        shifts,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });
  } catch (error) {
    console.error('Error fetching shifts:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get active shift for employee
export const getActiveShift = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { employeeId } = req.params;

    const activeShift = await prisma.shift.findFirst({
      where: {
        employeeId,
        status: 'ACTIVE'
      },
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            employeeId: true,
            position: true
          }
        },
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    return res.json({
      success: true,
      data: activeShift
    });
  } catch (error) {
    console.error('Error fetching active shift:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Update shift (cash in/out)
export const updateShift = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { error } = updateShiftSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const updateData = req.body;

    // Check if shift exists and is active
    const existingShift = await prisma.shift.findUnique({
      where: { id }
    });

    if (!existingShift) {
      return res.status(404).json({
        success: false,
        message: 'Shift not found'
      });
    }

    if (existingShift.status !== 'ACTIVE') {
      return res.status(400).json({
        success: false,
        message: 'Shift is not active'
      });
    }

    // Calculate new expected balance
    const newCashIn = updateData.cashIn !== undefined ? updateData.cashIn : existingShift.cashIn;
    const newCashOut = updateData.cashOut !== undefined ? updateData.cashOut : existingShift.cashOut;
    const expectedBalance = existingShift.openingBalance + newCashIn - newCashOut;

    // Update shift record
    const shift = await prisma.shift.update({
      where: { id },
      data: {
        ...updateData,
        expectedBalance
      },
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            employeeId: true,
            position: true
          }
        },
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    return res.json({
      success: true,
      data: shift,
      message: 'Shift updated successfully'
    });
  } catch (error) {
    console.error('Error updating shift:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get shift statistics
export const getShiftStats = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { branchId, startDate, endDate } = req.query;

    const where: any = {};
    if (branchId) {
      where.branchId = branchId;
    }

    if (startDate || endDate) {
      where.shiftDate = {};
      if (startDate) {
        where.shiftDate.gte = new Date(startDate as string);
      }
      if (endDate) {
        const endDateObj = new Date(endDate as string);
        endDateObj.setHours(23, 59, 59, 999);
        where.shiftDate.lte = endDateObj;
      }
    }

    const [
      totalShifts,
      activeShifts,
      completedShifts,
      cancelledShifts,
      totalCashIn,
      totalCashOut,
      totalDifference
    ] = await Promise.all([
      prisma.shift.count({ where }),
      prisma.shift.count({ where: { ...where, status: 'ACTIVE' } }),
      prisma.shift.count({ where: { ...where, status: 'COMPLETED' } }),
      prisma.shift.count({ where: { ...where, status: 'CANCELLED' } }),
      prisma.shift.aggregate({
        where: { ...where, status: 'COMPLETED' },
        _sum: { cashIn: true }
      }),
      prisma.shift.aggregate({
        where: { ...where, status: 'COMPLETED' },
        _sum: { cashOut: true }
      }),
      prisma.shift.aggregate({
        where: { ...where, status: 'COMPLETED' },
        _sum: { difference: true }
      })
    ]);

    return res.json({
      success: true,
      data: {
        totalShifts,
        activeShifts,
        completedShifts,
        cancelledShifts,
        totalCashIn: totalCashIn._sum.cashIn || 0,
        totalCashOut: totalCashOut._sum.cashOut || 0,
        totalDifference: totalDifference._sum.difference || 0
      }
    });
  } catch (error) {
    console.error('Error fetching shift stats:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
