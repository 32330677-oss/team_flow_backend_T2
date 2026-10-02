const express = require('express');
const router = express.Router();
const controller = require('../controllers/StaffPayrollController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');
const staffMonthlyReport = require('../controllers/staffMonthlyReportController'); // with the other requires

router.use(authMiddleware);

// السماح فقط للأدمن والسوبرفايرز بالوصول إلى كشوفات الرواتب
router.use(restrictTo('Admin'));

router.post('/generate', controller.generateStaffPayrollBatch);
router.get('/report', controller.getStaffPayrollReport);
router.get('/monthly-report.xlsx', staffMonthlyReport.exportStaffMonthlyReport);
router.get('/monthly-report.pdf', staffMonthlyReport.exportStaffMonthlyReportPdf);
router.get('/batch/:batchId', controller.getStaffPayrollBatchDetails);
router.get('/batch/:batchId/export.xlsx', controller.exportStaffPayrollExcel); // ← جديد
router.get('/batch/:batchId/export.pdf', controller.exportStaffPayrollPdf); // ← جديد

router.patch('/batch/:batchId/mark-paid', controller.markStaffBatchAsPaid);
const versioning = require('../controllers/staffPayrollVersioningController');
router.patch('/batch/:batchId/finalize', versioning.finalizeBatch);
router.post('/batch/:batchId/new-version', versioning.createNewVersion);
router.patch('/batch/:batchId/void', versioning.voidBatch);
router.get('/batch/:batchId/versions', versioning.getVersionChain);
module.exports = router;