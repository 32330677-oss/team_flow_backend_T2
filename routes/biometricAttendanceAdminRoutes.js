const express = require('express');
const router = express.Router();
const controller = require('../controllers/biometricAttendanceAdminController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);
router.use(restrictTo('Admin'));

router.get('/', controller.listByDate);
router.patch('/worker/:id', controller.editWorkerTimes);
router.patch('/staff/:id', controller.editStaffTimes);

module.exports = router;