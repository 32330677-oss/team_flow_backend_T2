// backend/middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const db = require('../config/db');

// #11: the JWT only proves WHO the caller is. Role and status are re-read
// from the users table (primary-key lookup) on every request, so a
// deactivated or demoted user loses the old privileges immediately instead
// of at token expiry. No cache, no blacklist: one indexed lookup.
const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({
            status: 'error',
            message: 'وصول مرفوض! لم يتم توفير رمز التحقق (Token).'
        });
    }

    // Force absolute crash on launch if secure environment configuration is missing
    const secretKey = process.env.JWT_SECRET;
   if (!secretKey) {
    console.error("FATAL ERROR: JWT_SECRET variable is completely missing from process.env.");

    return res.status(500).json({
        status: 'error',
        message: 'Server authentication configuration error'
    });
}

  let decoded;
  try {
    decoded = jwt.verify(token, secretKey);
} catch (error) {
    console.error('JWT Verification Error:', error);

    if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
            status: 'error',
            code: 'TOKEN_EXPIRED',
            message: 'Your session has expired. Please log in again.'
        });
    }

    return res.status(401).json({
        status: 'error',
        code: 'TOKEN_INVALID',
        message: 'Invalid authentication token.'
    });
}

    const userId = Number(decoded && decoded.user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(401).json({
            status: 'error',
            code: 'TOKEN_INVALID',
            message: 'Invalid authentication token.'
        });
    }

    let current;
    try {
        const [rows] = await db.execute(
            'SELECT user_id, role, status FROM users WHERE user_id = ? LIMIT 1',
            [userId]
        );
        current = rows[0];
    } catch (error) {
        console.error('Auth user lookup error:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Authentication check failed. Please try again.'
        });
    }

    if (!current) {
        return res.status(401).json({
            status: 'error',
            code: 'USER_NOT_FOUND',
            message: 'This account no longer exists. Please log in again.'
        });
    }
    if (current.status !== 'Active') {
        return res.status(401).json({
            status: 'error',
            code: 'ACCOUNT_INACTIVE',
            message: 'This account is currently deactivated by management'
        });
    }

    // Keep any other claims, but authorization always uses the DB values.
    req.user = { ...decoded, user_id: current.user_id, role: current.role, status: current.status };
    next();
};

module.exports = authMiddleware;
