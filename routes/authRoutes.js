const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');
const { forgotPasswordLimiter, loginLimiter } = require('../middleware/rateLimiter');

// مسار تسجيل الدخول: POST /api/auth/login
router.post('/login', loginLimiter, authController.login);

router.post('/forgot-password', forgotPasswordLimiter, authController.forgotPassword);
router.post('/reset-password-otp', forgotPasswordLimiter, authController.resetPasswordWithOtp);
router.post('/change-password', authMiddleware, authController.changePassword);

module.exports = router;