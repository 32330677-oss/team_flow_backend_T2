const express = require('express');
const router = express.Router();
const workerController = require('../controllers/workerController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);

router.get('/', restrictTo('Admin', 'Supervisor'), workerController.getAllWorkers);
router.post('/', restrictTo('Admin'), workerController.uploadWorkerFiles, workerController.createWorker);
router.put('/:id', restrictTo('Admin'), workerController.updateWorker);

// NEW: compensation history (section 16/17 traceability)
router.get('/:id/compensation-history', restrictTo('Admin'), workerController.getCompensationHistory);
router.get('/:id/status-history', restrictTo('Admin'), workerController.getStatusHistory);
// C-18: identity / personal photos only through this authenticated Admin endpoint.
router.get('/:id/files/:type', restrictTo('Admin'), workerController.getWorkerFile);
router.post('/bulk-compensation', restrictTo('Admin'), workerController.bulkUpdateCompensation);
module.exports = router;