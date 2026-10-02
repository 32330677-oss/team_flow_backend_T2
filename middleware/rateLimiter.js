const rateLimit = require('express-rate-limit');

// Limits by IP; combined with the per-email guard below to also curb
// distributed spam against a single victim's inbox.
const forgotPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        status: 'error',
        message: 'Too many password reset requests. Please try again later.',
    },
});

// R-11: brute-force protection on login (per IP). Successful logins do not count.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
        status: 'error',
        message: 'Too many failed login attempts. Please wait 15 minutes and try again.',
    },
});

module.exports = { forgotPasswordLimiter, loginLimiter };