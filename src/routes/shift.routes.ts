import express from 'express';
import {
  startShift,
  endShift,
  getShifts,
  getActiveShift,
  updateShift,
  getShiftStats
} from '../controllers/shift.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = express.Router();

// All shift routes require authentication
router.use(authenticate);

// Shift operations
router.post('/start', startShift);
router.post('/end', endShift);
router.get('/', getShifts);
router.get('/active/:employeeId', getActiveShift);
router.get('/stats', getShiftStats);
router.put('/:id', updateShift);

export default router;
