const express = require('express');
const router = express.Router();
const transferController = require('../controllers/transferController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);

router.post('/', restrictTo('Supervisor'), transferController.createTransferRequest);
router.get('/pending', restrictTo('Admin'), transferController.getPendingTransfers);
router.get('/', restrictTo('Admin'), transferController.listTransfers);
router.put('/:id/review', restrictTo('Admin'), transferController.reviewTransferRequest);
router.get('/:id/document', restrictTo('Admin', 'Supervisor'), transferController.downloadTransferDocument);

module.exports = router;