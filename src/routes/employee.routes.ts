import express from 'express';
import {
  getEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  getEmployeeStats
} from '../controllers/employee.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = express.Router();

// All employee routes require authentication
router.use(authenticate);

// Employee CRUD operations
router.get('/', getEmployees);
router.get('/stats', getEmployeeStats);
router.get('/:id', getEmployee);
router.post('/', createEmployee);
router.put('/:id', updateEmployee);
router.delete('/:id', deleteEmployee);

export default router;
