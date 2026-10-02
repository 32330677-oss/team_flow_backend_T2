const express = require('express');
const router = express.Router();
const staffAttendanceController = require('../controllers/staffAttendanceController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);

// ==================== Admin / Staff Supervisor Review (Staff Attendance) ====================
// CHANGED: 'Supervisor' -> 'StaffSupervisor'. Worker Supervisors never had
// staff attendance data in scope; this closes that gap. Scope filtering to
// only assigned staff is applied inside the controller for StaffSupervisor.
router.get('/pending', restrictTo('Admin', 'StaffSupervisor'), staffAttendanceController.getPendingStaffAttendance);
router.post('/review', restrictTo('Admin'), staffAttendanceController.reviewStaffAttendance);
router.get('/by-date', restrictTo('Admin', 'StaffSupervisor'), staffAttendanceController.getStaffAttendanceByDate);

const staffAttendanceSupervisorController = require('../controllers/staffAttendanceSupervisorController');
router.get('/supervisor/day', restrictTo('StaffSupervisor'), staffAttendanceSupervisorController.getDayView);
router.post('/supervisor/bulk-set', restrictTo('StaffSupervisor'), staffAttendanceSupervisorController.bulkSetAttendance);
router.post('/supervisor/resubmit-rejected', restrictTo('StaffSupervisor'), staffAttendanceSupervisorController.resubmitRejected);

// ==================== Pre-payroll: Management-Paid Absences ====================
const staffAbsenceController = require('../controllers/staffAbsenceController');
router.get('/admin/absences', restrictTo('Admin'), staffAbsenceController.getAbsenceSummary);
router.post('/admin/absences/mark-paid', restrictTo('Admin'), staffAbsenceController.markAbsencesPaid);
router.post('/admin/absences/unmark-paid', restrictTo('Admin'), staffAbsenceController.unmarkAbsencePaid);

// D-11: explicit Mark as Paid / Unpaid for Sick / Vacation / Holiday (audited)
router.post('/admin/:id/paid', restrictTo('Admin'), staffAttendanceController.setPaidDecision);
// D-02: explicit Admin correction (finalized periods / approved records)
const correctionController = require('../controllers/attendanceCorrectionController');
router.post('/admin/:id/correction', restrictTo('Admin'), correctionController.correctStaffAttendance);

// ==================== B4: Lunch for biometric staff records (Admin) ====================
const staffLunchAdminController = require('../controllers/staffLunchAdminController');
router.get('/admin/lunch', restrictTo('Admin'), staffLunchAdminController.getLunchDay);
router.post('/admin/lunch/apply', restrictTo('Admin'), staffLunchAdminController.applyLunch);

module.exports = router;