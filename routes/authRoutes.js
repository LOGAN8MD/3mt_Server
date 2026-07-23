import express from 'express';
import {
    forgotPassword,
    googleLogin,
    loginUser,
    registerUser,
    resendRegistrationOtp,
    resetPassword,
    verifyRegistrationOtp,
    verifyResetOtp,
} from '../controllers/authController.js';
import {
    authRateLimiter,
    passwordResetRateLimiter,
} from '../middlewares/rateLimitMiddleware.js';
const router = express.Router();

router.post('/register', authRateLimiter, registerUser);
router.post('/verify-otp', authRateLimiter, verifyRegistrationOtp);
router.post('/resend-otp', authRateLimiter, resendRegistrationOtp);
router.post('/forgot-password', passwordResetRateLimiter, forgotPassword);
router.post('/verify-reset-otp', passwordResetRateLimiter, verifyResetOtp);
router.post('/reset-password', passwordResetRateLimiter, resetPassword);
router.post('/login', authRateLimiter, loginUser);
router.post('/google', authRateLimiter, googleLogin);


export default router;
