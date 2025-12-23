import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Validation schemas
const checkInSchema = Joi.object({
  employeeId: Joi.string().required(),
  branchId: Joi.string().required(),
  notes: Joi.string().optional()
});

const checkOutSchema = Joi.object({
  attendanceId: Joi.string().required(),
  notes: Joi.string().optional()
});

const updateAttendanceSchema = Joi.object({
  status: Joi.string().valid('PRESENT', 'ABSENT', 'LATE', 'HALF_DAY', 'LEAVE').optional(),
  notes: Joi.string().optional()
});

// Check in employee
export const checkIn = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { error } = checkInSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const { employeeId, branchId, notes } = req.body;

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

    // Check if employee is already checked in today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existingAttendance = await prisma.attendance.findFirst({
      where: {
        employeeId,
        checkIn: {
          gte: today,
          lt: tomorrow
        },
        checkOut: null
      }
    });

    if (existingAttendance) {
      return res.status(400).json({
        success: false,
        message: 'Employee is already checked in today'
      });
    }

    // Create attendance record
    const attendance = await prisma.attendance.create({
      data: {
        employeeId,
        branchId,
        checkIn: new Date(),
        status: 'PRESENT',
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
    syncAfterOperation('attendance', 'create', attendance).catch(err => {
      console.error('[Sync] Attendance check-in sync failed:', err.message);
    });

    return res.status(201).json({
      success: true,
      data: attendance,
      message: 'Check-in successful'
    });
  } catch (error) {
    console.error('Error checking in employee:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Check out employee
export const checkOut = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { error } = checkOutSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const { attendanceId, notes } = req.body;

    // Find attendance record
    const attendance = await prisma.attendance.findUnique({
      where: { id: attendanceId },
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

    if (!attendance) {
      return res.status(404).json({
        success: false,
        message: 'Attendance record not found'
      });
    }

    if (attendance.checkOut) {
      return res.status(400).json({
        success: false,
        message: 'Employee is already checked out'
      });
    }

    // Calculate total hours
    const checkOutTime = new Date();
    const checkInTime = new Date(attendance.checkIn);
    const totalHours = (checkOutTime.getTime() - checkInTime.getTime()) / (1000 * 60 * 60);

    // Update attendance record
    const updatedAttendance = await prisma.attendance.update({
      where: { id: attendanceId },
      data: {
        checkOut: checkOutTime,
        totalHours: Math.round(totalHours * 100) / 100, // Round to 2 decimal places
        notes: notes || attendance.notes
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
      data: updatedAttendance,
      message: 'Check-out successful'
    });
  } catch (error) {
    console.error('Error checking out employee:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get attendance records
export const getAttendance = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const {
      page = 1,
      limit = 10,
      employeeId = '',
      branchId = '',
      startDate = '',
      endDate = '',
      status = ''
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
      where.checkIn = {};
      if (startDate) {
        where.checkIn.gte = new Date(startDate as string);
      }
      if (endDate) {
        const endDateObj = new Date(endDate as string);
        endDateObj.setHours(23, 59, 59, 999);
        where.checkIn.lte = endDateObj;
      }
    }

    const [attendance, total] = await Promise.all([
      prisma.attendance.findMany({
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
        orderBy: { checkIn: 'desc' }
      }),
      prisma.attendance.count({ where })
    ]);

    return res.json({
      success: true,
      data: {
        attendance,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });
  } catch (error) {
    console.error('Error fetching attendance:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get today's attendance for an employee
export const getTodayAttendance = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { employeeId } = req.params;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const attendance = await prisma.attendance.findFirst({
      where: {
        employeeId,
        checkIn: {
          gte: today,
          lt: tomorrow
        }
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
      data: attendance
    });
  } catch (error) {
    console.error('Error fetching today\'s attendance:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Update attendance record
export const updateAttendance = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { error } = updateAttendanceSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const updateData = req.body;

    // Check if attendance record exists
    const existingAttendance = await prisma.attendance.findUnique({
      where: { id }
    });

    if (!existingAttendance) {
      return res.status(404).json({
        success: false,
        message: 'Attendance record not found'
      });
    }

    // Update attendance record
    const attendance = await prisma.attendance.update({
      where: { id },
      data: updateData,
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
    syncAfterOperation('attendance', 'update', attendance).catch(err => {
      console.error('[Sync] Attendance update sync failed:', err.message);
    });

    return res.json({
      success: true,
      data: attendance,
      message: 'Attendance updated successfully'
    });
  } catch (error) {
    console.error('Error updating attendance:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get attendance statistics
export const getAttendanceStats = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { branchId, startDate, endDate } = req.query;

    const where: any = {};
    if (branchId) {
      where.branchId = branchId;
    }

    if (startDate || endDate) {
      where.checkIn = {};
      if (startDate) {
        where.checkIn.gte = new Date(startDate as string);
      }
      if (endDate) {
        const endDateObj = new Date(endDate as string);
        endDateObj.setHours(23, 59, 59, 999);
        where.checkIn.lte = endDateObj;
      }
    }

    const [
      totalRecords,
      presentCount,
      absentCount,
      lateCount,
      halfDayCount,
      leaveCount
    ] = await Promise.all([
      prisma.attendance.count({ where }),
      prisma.attendance.count({ where: { ...where, status: 'PRESENT' } }),
      prisma.attendance.count({ where: { ...where, status: 'ABSENT' } }),
      prisma.attendance.count({ where: { ...where, status: 'LATE' } }),
      prisma.attendance.count({ where: { ...where, status: 'HALF_DAY' } }),
      prisma.attendance.count({ where: { ...where, status: 'LEAVE' } })
    ]);

    return res.json({
      success: true,
      data: {
        totalRecords,
        presentCount,
        absentCount,
        lateCount,
        halfDayCount,
        leaveCount
      }
    });
  } catch (error) {
    console.error('Error fetching attendance stats:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
