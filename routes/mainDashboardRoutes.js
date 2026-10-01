const express = require('express');
const router = express.Router();
const controller = require('../controllers/mainDashboardController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

// Management dashboard: Admin only. Supervisors keep their own scoped
// dashboard and are refused here by the backend, not just hidden in the UI.
router.use(authMiddleware);
router.use(restrictTo('Admin'));

// Live site operations (current business date, Asia/Beirut).
router.get('/live', controller.getLiveOperations);
// Drill-down for one Active site (all its shifts).
router.get('/sites/:siteId', controller.getSiteOperations);

module.exports = router;
