import { Router } from 'express';
import { login, register, getProfile, changePassword, updateProfile, checkAccountStatus, forgotPassword, resetPassword, checkLocalUser } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// Public routes
router.post('/login', login);
router.post('/register', register);
router.post('/forgot-password', forgotPassword);
router.post('/check-local-user', checkLocalUser); // Check if user exists locally (for offline-first auth)

// Protected routes
router.get('/profile', authenticate, getProfile);
router.post('/change-password', authenticate, changePassword);
router.put('/update-profile', authenticate, updateProfile);
router.post('/reset-password', authenticate, resetPassword);

// Account status check (for periodic checking by frontend)
router.get('/check-status', authenticate, checkAccountStatus);

export default router;
