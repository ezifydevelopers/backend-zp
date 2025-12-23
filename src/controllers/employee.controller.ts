import { Request, Response } from 'express';
import { getPrisma } from '../utils/db.util';
import { syncAfterOperation, pullLatestFromLive } from '../utils/sync-helper';
import Joi from 'joi';

// Validation schemas
const createEmployeeSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  phone: Joi.string().optional().allow(''),
  address: Joi.string().optional().allow(''),
  position: Joi.string().required(),
  department: Joi.string().optional().allow(''),
  salary: Joi.number().min(0).optional().allow(null, ''),
  hireDate: Joi.string().required(), // Changed to string to accept ISO date strings
  status: Joi.string().valid('ACTIVE', 'INACTIVE', 'TERMINATED', 'ON_LEAVE').default('ACTIVE'),
  branchId: Joi.string().required(),
  emergencyContactName: Joi.string().optional().allow(''),
  emergencyContactPhone: Joi.string().optional().allow(''),
  emergencyContactRelation: Joi.string().optional().allow('')
});

const updateEmployeeSchema = Joi.object({
  name: Joi.string(),
  email: Joi.string().email(),
  phone: Joi.string().allow(''),
  address: Joi.string().allow(''),
  position: Joi.string(),
  department: Joi.string().allow(''),
  salary: Joi.number().min(0),
  hireDate: Joi.string(), // Changed to string to accept ISO date strings
  status: Joi.string().valid('ACTIVE', 'INACTIVE', 'TERMINATED', 'ON_LEAVE'),
  branchId: Joi.string(),
  emergencyContactName: Joi.string().allow(''),
  emergencyContactPhone: Joi.string().allow(''),
  emergencyContactRelation: Joi.string().allow(''),
  isActive: Joi.boolean()
});

// Generate unique employee ID
const generateEmployeeId = async (prisma: any): Promise<string> => {
  const lastEmployee = await prisma.employee.findFirst({
    orderBy: { employeeId: 'desc' }
  });

  if (!lastEmployee) {
    return 'EMP001';
  }

  const lastNumber = parseInt(lastEmployee.employeeId.replace('EMP', ''));
  const newNumber = lastNumber + 1;
  return `EMP${newNumber.toString().padStart(3, '0')}`;
};

export const getEmployees = async (req: Request, res: Response) => {
  try {
    // 🔄 PULL LATEST FROM LIVE DATABASE FIRST - REMOVED to prevent data disappearing issues
    // Rely on periodic background sync instead
    // await pullLatestFromLive('employee').catch(err => console.log('[Sync] Pull employees:', err.message));

    const prisma = await getPrisma();
    const {
      page = 1,
      limit = 10,
      search = '',
      status = '',
      branchId = '',
      isActive = true
    } = req.query;

    console.log('Getting employees with params:', { page, limit, search, status, branchId, isActive });

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where: any = {};

    if (isActive !== 'all') {
      where.isActive = isActive === 'true';
    }

    if (branchId) {
      where.branchId = branchId;
    }

    console.log('Where clause:', where);

    if (status) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { name: { contains: search } },
        { email: { contains: search } },
        { employeeId: { contains: search } },
        { position: { contains: search } }
      ];
    }

    const [employees, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        skip,
        take,
        include: {
          branch: {
            select: {
              id: true,
              name: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.employee.count({ where })
    ]);

    console.log('Found employees:', employees.length, 'Total:', total);

    return res.json({
      success: true,
      data: {
        employees,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });
  } catch (error) {
    console.error('Error fetching employees:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getEmployee = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    const employee = await prisma.employee.findUnique({
      where: { id },
      include: {
        branch: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    return res.json({
      success: true,
      data: employee
    });
  } catch (error) {
    console.error('Error fetching employee:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const createEmployee = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    console.log('Creating employee with data:', req.body);

    const { error } = createEmployeeSchema.validate(req.body);
    if (error) {
      console.log('Validation error:', error.details);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const employeeData = req.body;

    // Check if employee with email already exists
    const existingEmployee = await prisma.employee.findUnique({
      where: { email: employeeData.email }
    });

    if (existingEmployee) {
      return res.status(400).json({
        success: false,
        message: 'Employee with this email already exists'
      });
    }

    // Check if branch exists
    const branch = await prisma.branch.findUnique({
      where: { id: employeeData.branchId }
    });

    if (!branch) {
      return res.status(400).json({
        success: false,
        message: 'Branch not found'
      });
    }

    // Generate unique employee ID
    const employeeId = await generateEmployeeId(prisma);

    // Create employee
    const employee = await prisma.employee.create({
      data: {
        ...employeeData,
        employeeId,
        hireDate: new Date(employeeData.hireDate),
        salary: employeeData.salary && employeeData.salary > 0 ? employeeData.salary : null
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

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('employee', 'create', employee).catch(err => {
      console.error('[Sync] Employee create sync failed:', err.message);
    });

    return res.status(201).json({
      success: true,
      data: employee,
      message: 'Employee created successfully'
    });
  } catch (error) {
    console.error('Error creating employee:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const updateEmployee = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;
    const { error } = updateEmployeeSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => detail.message)
      });
    }

    const updateData = req.body;

    // Check if employee exists
    const existingEmployee = await prisma.employee.findUnique({
      where: { id }
    });

    if (!existingEmployee) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    // Check if email is being changed and if it already exists
    if (updateData.email && updateData.email !== existingEmployee.email) {
      const emailExists = await prisma.employee.findUnique({
        where: { email: updateData.email }
      });

      if (emailExists) {
        return res.status(400).json({
          success: false,
          message: 'Employee with this email already exists'
        });
      }
    }

    // Check if branch exists (if being changed)
    if (updateData.branchId && updateData.branchId !== existingEmployee.branchId) {
      const branch = await prisma.branch.findUnique({
        where: { id: updateData.branchId }
      });

      if (!branch) {
        return res.status(400).json({
          success: false,
          message: 'Branch not found'
        });
      }
    }

    // Update employee
    const employee = await prisma.employee.update({
      where: { id },
      data: {
        ...updateData,
        hireDate: updateData.hireDate ? new Date(updateData.hireDate) : undefined
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

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('employee', 'update', employee).catch(err => {
      console.error('[Sync] Employee update sync failed:', err.message);
    });

    return res.json({
      success: true,
      data: employee,
      message: 'Employee updated successfully'
    });
  } catch (error) {
    console.error('Error updating employee:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const deleteEmployee = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { id } = req.params;

    // Check if employee exists
    const existingEmployee = await prisma.employee.findUnique({
      where: { id }
    });

    if (!existingEmployee) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    // Soft delete by setting isActive to false
    const deletedEmployee = await prisma.employee.update({
      where: { id },
      data: { isActive: false }
    });

    // 🔄 IMMEDIATE BIDIRECTIONAL SYNC
    syncAfterOperation('employee', 'update', deletedEmployee).catch(err => {
      console.error('[Sync] Employee delete sync failed:', err.message);
    });

    return res.json({
      success: true,
      message: 'Employee deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting employee:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

export const getEmployeeStats = async (req: Request, res: Response) => {
  try {
    const prisma = await getPrisma();
    const { branchId } = req.query;

    const where: any = { isActive: true };
    if (branchId) {
      where.branchId = branchId;
    }

    const [
      totalEmployees,
      activeEmployees,
      inactiveEmployees,
      terminatedEmployees,
      onLeaveEmployees
    ] = await Promise.all([
      prisma.employee.count({ where }),
      prisma.employee.count({ where: { ...where, status: 'ACTIVE' } }),
      prisma.employee.count({ where: { ...where, status: 'INACTIVE' } }),
      prisma.employee.count({ where: { ...where, status: 'TERMINATED' } }),
      prisma.employee.count({ where: { ...where, status: 'ON_LEAVE' } })
    ]);

    return res.json({
      success: true,
      data: {
        totalEmployees,
        activeEmployees,
        inactiveEmployees,
        terminatedEmployees,
        onLeaveEmployees
      }
    });
  } catch (error) {
    console.error('Error fetching employee stats:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};
