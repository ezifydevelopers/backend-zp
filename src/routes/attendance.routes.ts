import express from 'express';
import {
  checkIn,
  checkOut,
  getAttendance,
  getTodayAttendance,
  updateAttendance,
  getAttendanceStats
} from '../controllers/attendance.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = express.Router();

// All attendance routes require authentication
router.use(authenticate);

// Attendance operations
router.post('/check-in', checkIn);
router.post('/check-out', checkOut);
router.get('/', getAttendance);
router.get('/today/:employeeId', getTodayAttendance);
router.get('/stats', getAttendanceStats);
router.put('/:id', updateAttendance);

export default router;
