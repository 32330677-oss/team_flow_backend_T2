const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');
const correctionController = require('../controllers/attendanceCorrectionController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);
// Worker attendance is operated by Admin and site Supervisors only. Each write
// additionally checks the supervisor's site/shift scope inside the controller.
router.use(restrictTo('Admin', 'Supervisor'));

router.get('/sites/:siteId/workers', attendanceController.getSiteWorkers);
router.post('/checkin', attendanceController.checkIn);
router.post('/status', attendanceController.setAttendanceStatus);
router.post('/checkout', attendanceController.checkOut);
router.post('/submit', attendanceController.submitDay);
router.post('/leave/start', attendanceController.startLeave);
router.post('/leave/end', attendanceController.endLeave);
router.post('/lunch/bulk', attendanceController.saveLunchBulk);
router.get('/rejected', attendanceController.getRejectedRecords);
router.patch('/:attendance_id/management-leave', restrictTo('Admin'), attendanceController.setManagementLeaveHours);
// C-13: Admin may resubmit as well (sites without an active supervisor).
router.patch('/:attendance_id/resubmit', attendanceController.resubmitAttendance);
router.post('/bulk/checkin', attendanceController.bulkCheckIn);
router.post('/bulk/checkout', attendanceController.bulkCheckOut);
router.post('/bulk/status', attendanceController.bulkSetAttendanceStatus);
router.patch('/:attendance_id/edit-times', attendanceController.editAttendanceTimes);

// D-02 / §12: explicit Admin correction workflow (reason + audit, original kept).
router.post('/:attendance_id/admin-correction', restrictTo('Admin'), correctionController.correctWorkerAttendance);
router.get('/corrections', restrictTo('Admin'), correctionController.listCorrections);
router.patch('/corrections/:correction_id/resolve', restrictTo('Admin'), correctionController.resolveAdjustment);

module.exports = router;
