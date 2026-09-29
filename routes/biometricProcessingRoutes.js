const express = require('express');
const router = express.Router();
const controller = require('../controllers/biometricPunchProcessingController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);
router.use(restrictTo('Admin'));

router.post('/process', controller.processPunches);
router.get('/status', controller.getProcessingStatus);
router.get('/failed', controller.getFailedPunches);

module.exports = router;