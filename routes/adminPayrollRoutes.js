const express = require('express');
const router = express.Router();
const controller = require('../controllers/adminPayrollController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');
const monthlyReport = require('../controllers/workerMonthlyReportController'); 

router.use(authMiddleware);
router.use(restrictTo('Admin'));

router.post('/generate', controller.generatePayrollBatch);
router.get('/report', controller.getPayrollReport);
router.get('/batch/:batchId', controller.getPayrollBatchDetails);
router.get('/batch/:batchId/export.xlsx', controller.exportPayrollExcel);
router.get('/batch/:batchId/export.pdf', controller.exportPayrollPdf);
router.get('/daily-attendance/export.xlsx', controller.exportDailyAttendanceExcel);
router.get('/monthly-report.xlsx', monthlyReport.exportWorkerMonthlyReport);
router.get('/monthly-report.pdf', monthlyReport.exportWorkerMonthlyReportPdf);
router.patch('/batch/:batchId/mark-paid', controller.markBatchAsPaid);
router.patch('/batch/:batchId/finalize', controller.finalizePayrollBatch);
router.patch('/batch/:batchId/void', controller.voidPayrollBatch);
router.post('/batch/:batchId/supersede', controller.supersedeFinalizedBatch);
router.get('/batch/:batchId/versions', controller.getPayrollVersionChain);
router.get('/last-date', controller.getLastBatchEndDate);

module.exports = router;