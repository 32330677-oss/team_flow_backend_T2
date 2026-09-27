const express = require('express');
const router = express.Router();
const controller = require('../controllers/attendanceImportController');
const connectorAuth = require('../middleware/connectorAuth');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

// NOTE: middleware is applied per route (NOT router.use) so requests that
// belong to attendanceRoutes are never intercepted by connector auth.
router.post('/batches', connectorAuth, controller.createBatch);
router.post('/batches/:batchId/complete', connectorAuth, controller.completeBatch);
router.get('/batches/:batchId', connectorAuth, controller.getBatch);
router.post('/punches', connectorAuth, controller.addPunches);
router.get('/punches/unmapped', authMiddleware, restrictTo('Admin'), controller.getUnmappedDeviceIds);

module.exports = router;