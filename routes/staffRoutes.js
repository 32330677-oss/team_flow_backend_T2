const express = require('express');
const router = express.Router();

const staffController = require('../controllers/staffController');
const staffLifecycleController = require('../controllers/staffLifecycleController');
const staffAssignmentController = require('../controllers/staffAssignmentController');
// 1. استيراد الـ Controller الخاص بالمشرفين في الأعلى مع البقية
const staffSupervisorAssignmentController = require('../controllers/staffSupervisorAssignmentController');

const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);
router.get('/my-assigned-staff', restrictTo('StaffSupervisor'), staffSupervisorAssignmentController.getMyAssignedStaff);
router.get('/', restrictTo('Admin'), staffController.getAllStaff);
router.post('/', restrictTo('Admin'), staffController.createStaff);
router.put('/:id', restrictTo('Admin'), staffController.updateStaff);
router.get('/:id/compensation-history', restrictTo('Admin'), staffController.getCompensationHistory);

// NEW — lifecycle tracking
router.patch('/:id/lifecycle', restrictTo('Admin'), staffLifecycleController.changeStatus);
router.get('/:id/lifecycle-history', restrictTo('Admin'), staffLifecycleController.getStatusHistory);

// NEW — site assignment history
router.get('/:id/assignments', restrictTo('Admin'), staffAssignmentController.getHistory);
router.post('/:id/assignments', restrictTo('Admin'), staffAssignmentController.assignToSite);
router.delete('/:id/assignments/current', restrictTo('Admin'), staffAssignmentController.unassignCurrent);

// ==========================================
// NEW — STAFF SUPERVISOR ASSIGNMENTS
// ==========================================

// 2. راوت الـ bulk يجب أن يُكتب هنا (قبل راوتات الـ :id)
router.post('/supervisor-assignments/bulk', restrictTo('Admin'), staffSupervisorAssignmentController.bulkAssignSupervisor);

// 3. باقي راوتات المشرفين التي تحتوي على :id
router.get('/:id/supervisor-assignments', restrictTo('Admin'), staffSupervisorAssignmentController.getHistory);
router.post('/:id/supervisor-assignments', restrictTo('Admin'), staffSupervisorAssignmentController.assignSupervisor);
router.delete('/:id/supervisor-assignments/current', restrictTo('Admin'), staffSupervisorAssignmentController.unassignCurrent);

module.exports = router;