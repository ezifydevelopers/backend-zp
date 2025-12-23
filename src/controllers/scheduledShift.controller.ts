import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Validation schemas
const createScheduledShiftSchema = Joi.object({
  name: Joi.string().required(),
  startTime: Joi.string().pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).required(),
  endTime: Joi.string().pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).required(),
  date: Joi.date().required(),
  branchId: Joi.string().required(),
  notes: Joi.string().optional().allow('')
});

const updateScheduledShiftSchema = Joi.object({
  name: Joi.string().optional(),
  startTime: Joi.string().pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
  endTime: Joi.string().pattern(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
  date: Joi.date().optional(),
  branchId: Joi.string().allow('', null).optional(),
  maxUsers: Joi.number().min(1).optional(),
  notes: Joi.string().optional(),
  assignedUserIds: Joi.array().items(Joi.string()).optional()
});

// Create a new scheduled shift
export const createScheduledShift = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    console.log('Creating scheduled shift with data:', req.body);

    // Test database connection
    try {
      await prisma.$connect();
      console.log('Database connection successful');
    } catch (dbError) {
      console.error('Database connection failed:', dbError);
      return res.status(500).json({
        success: false,
        message: 'Database connection failed',
        error: dbError instanceof Error ? dbError.message : 'Unknown database error'
      });
    }

    const { error } = createScheduledShiftSchema.validate(req.body);
    if (error) {
      console.log('Validation error:', error.details);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const { name, startTime, endTime, date, branchId, notes } = req.body;

    // Check if branch exists
    const branch = await prisma.branch.findUnique({
      where: { id: branchId }
    });

    if (!branch) {
      console.log('Branch not found for ID:', branchId);
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    console.log('Branch found:', branch.name);
    console.log('Creating scheduled shift with data:', { name, startTime, endTime, date, branchId, notes });

    // Test if we can query the scheduled shifts table
    try {
      const existingShifts = await prisma.scheduledShift.findMany({ take: 1 });
      console.log('Database table accessible, existing shifts count:', existingShifts.length);
    } catch (tableError) {
      console.error('Database table access failed:', tableError);
      return res.status(500).json({
        success: false,
        message: 'Database table access failed',
        error: tableError instanceof Error ? tableError.message : 'Unknown table error'
      });
    }

    // Create the scheduled shift
    const scheduledShift = await prisma.scheduledShift.create({
      data: {
        name,
        startTime,
        endTime,
        date: new Date(date),
        branchId,
        maxUsers: 1, // Default value
        notes: notes || null,
        status: 'SCHEDULED' // Default status
      },
      include: {
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    console.log('Scheduled shift created successfully:', scheduledShift.id);
    console.log('Scheduled shift data:', JSON.stringify(scheduledShift, null, 2));

    // Verify the shift was actually stored in the database
    try {
      const verifyShift = await prisma.scheduledShift.findUnique({
        where: { id: scheduledShift.id },
        include: { branch: true }
      });
      console.log('Verification - Shift found in database:', verifyShift ? 'YES' : 'NO');
      if (verifyShift) {
        console.log('Verification - Shift details:', {
          id: verifyShift.id,
          name: verifyShift.name,
          date: verifyShift.date,
          branchName: verifyShift.branch?.name
        });
      }
    } catch (verifyError) {
      console.error('Verification failed:', verifyError);
    }

    // Transform the data to match frontend expectations
    const transformedShift = {
      id: scheduledShift.id,
      name: scheduledShift.name,
      startTime: scheduledShift.startTime,
      endTime: scheduledShift.endTime,
      date: scheduledShift.date.toISOString().split('T')[0],
      branchId: scheduledShift.branchId,
      branchName: scheduledShift.branch?.name || 'Unknown Branch',
      assignedUsers: [], // Empty array since we're not assigning users
      maxUsers: scheduledShift.maxUsers,
      status: scheduledShift.status,
      notes: scheduledShift.notes,
      createdAt: scheduledShift.createdAt.toISOString(),
      updatedAt: scheduledShift.updatedAt.toISOString()
    };

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('scheduledShift', 'create', scheduledShift).catch(err => {
      console.error('[Sync] ScheduledShift create sync failed:', err.message);
    });

    return res.status(201).json({
      success: true,
      data: transformedShift,
      message: 'Scheduled shift created successfully'
    });
  } catch (error) {
    console.error('Error creating scheduled shift:', error);
    console.error('Error details:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : 'Unknown'
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// Get all scheduled shifts
export const getScheduledShifts = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const {
      page = 1,
      limit = 10,
      branchId = '',
      status = '',
      startDate = '',
      endDate = ''
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where: any = {};

    if (branchId) {
      where.branchId = branchId;
    }

    if (status) {
      where.status = status;
    }

    if (startDate || endDate) {
      where.date = {};
      if (startDate) {
        where.date.gte = new Date(startDate as string);
      }
      if (endDate) {
        const endDateObj = new Date(endDate as string);
        endDateObj.setHours(23, 59, 59, 999);
        where.date.lte = endDateObj;
      }
    }

    const [scheduledShifts, total] = await Promise.all([
      prisma.scheduledShift.findMany({
        where,
        skip,
        take,
        include: {
          branch: {
            select: {
              id: true,
              name: true
            }
          },
          assignedUsers: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  role: true
                }
              }
            }
          }
        },
        orderBy: { date: 'desc' }
      }),
      prisma.scheduledShift.count({ where })
    ]);

    // Transform the data to match frontend expectations
    const transformedShifts = scheduledShifts.map((shift: any) => ({
      id: shift.id,
      name: shift.name,
      startTime: shift.startTime,
      endTime: shift.endTime,
      date: shift.date.toISOString().split('T')[0],
      branchId: shift.branchId,
      branchName: shift.branch.name,
      assignedUsers: shift.assignedUsers.map((su: any) => ({
        id: su.user.id,
        name: su.user.name,
        role: su.user.role
      })),
      maxUsers: shift.maxUsers,
      status: shift.status.toLowerCase(),
      notes: shift.notes,
      createdAt: shift.createdAt.toISOString(),
      updatedAt: shift.updatedAt.toISOString()
    }));

    return res.json({
      success: true,
      data: transformedShifts,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching scheduled shifts:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Get a single scheduled shift
export const getScheduledShift = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const scheduledShift = await prisma.scheduledShift.findUnique({
      where: { id },
      include: {
        branch: {
          select: {
            id: true,
            name: true
          }
        },
        assignedUsers: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                role: true
              }
            }
          }
        }
      }
    });

    if (!scheduledShift) {
      return res.status(404).json({
        success: false,
        message: 'Scheduled shift not found'
      });
    }

    // Transform the data to match frontend expectations
    const transformedShift = {
      id: scheduledShift.id,
      name: scheduledShift.name,
      startTime: scheduledShift.startTime,
      endTime: scheduledShift.endTime,
      date: scheduledShift.date.toISOString().split('T')[0],
      branchId: scheduledShift.branchId,
      branchName: scheduledShift.branch.name,
      assignedUsers: scheduledShift.assignedUsers.map((su: any) => ({
        id: su.user.id,
        name: su.user.name,
        role: su.user.role
      })),
      maxUsers: scheduledShift.maxUsers,
      status: scheduledShift.status.toLowerCase(),
      notes: scheduledShift.notes,
      createdAt: scheduledShift.createdAt.toISOString(),
      updatedAt: scheduledShift.updatedAt.toISOString()
    };

    return res.json({
      success: true,
      data: transformedShift
    });
  } catch (error) {
    console.error('Error fetching scheduled shift:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Update a scheduled shift
export const updateScheduledShift = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { error } = updateScheduledShiftSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const updateData = req.body;
    const { assignedUserIds, ...shiftData } = updateData;

    // Check if scheduled shift exists
    const existingShift = await prisma.scheduledShift.findUnique({
      where: { id }
    });

    if (!existingShift) {
      return res.status(404).json({
        success: false,
        message: 'Scheduled shift not found'
      });
    }

    // Update the scheduled shift
    const updatedShift = await prisma.scheduledShift.update({
      where: { id },
      data: {
        ...shiftData,
        ...(shiftData.date && { date: new Date(shiftData.date) }),
        ...(assignedUserIds !== undefined && {
          assignedUsers: {
            deleteMany: {},
            create: assignedUserIds.map((userId: string) => ({
              userId
            }))
          }
        })
      },
      include: {
        branch: {
          select: {
            id: true,
            name: true
          }
        },
        assignedUsers: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                role: true
              }
            }
          }
        }
      }
    });

    // Transform the data to match frontend expectations
    const transformedShift = {
      id: updatedShift.id,
      name: updatedShift.name,
      startTime: updatedShift.startTime,
      endTime: updatedShift.endTime,
      date: updatedShift.date.toISOString().split('T')[0],
      branchId: updatedShift.branchId,
      branchName: updatedShift.branch.name,
      assignedUsers: updatedShift.assignedUsers.map((su: any) => ({
        id: su.user.id,
        name: su.user.name,
        role: su.user.role
      })),
      maxUsers: updatedShift.maxUsers,
      status: updatedShift.status.toLowerCase(),
      notes: updatedShift.notes,
      createdAt: updatedShift.createdAt.toISOString(),
      updatedAt: updatedShift.updatedAt.toISOString()
    };

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('scheduledShift', 'update', updatedShift).catch(err => {
      console.error('[Sync] ScheduledShift update sync failed:', err.message);
    });

    return res.json({
      success: true,
      data: transformedShift,
      message: 'Scheduled shift updated successfully'
    });
  } catch (error) {
    console.error('Error updating scheduled shift:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Delete a scheduled shift
export const deleteScheduledShift = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    // Check if scheduled shift exists
    const existingShift = await prisma.scheduledShift.findUnique({
      where: { id }
    });

    if (!existingShift) {
      return res.status(404).json({
        success: false,
        message: 'Scheduled shift not found'
      });
    }

    // Delete the scheduled shift (cascade will handle assigned users)
    await prisma.scheduledShift.delete({
      where: { id }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('scheduledShift', 'delete', { id }).catch(err => {
      console.error('[Sync] ScheduledShift delete sync failed:', err.message);
    });

    return res.json({
      success: true,
      message: 'Scheduled shift deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting scheduled shift:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
