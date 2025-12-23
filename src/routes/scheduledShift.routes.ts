import express from 'express';
import {
  createScheduledShift,
  getScheduledShifts,
  getScheduledShift,
  updateScheduledShift,
  deleteScheduledShift
} from '../controllers/scheduledShift.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = express.Router();

// All scheduled shift routes require authentication
router.use(authenticate);

// Scheduled shift operations
router.post('/', createScheduledShift);
router.get('/', getScheduledShifts);
router.get('/:id', getScheduledShift);
router.put('/:id', updateScheduledShift);
router.delete('/:id', deleteScheduledShift);

export default router;
