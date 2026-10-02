const express = require('express');
const router = express.Router();
const controller = require('../controllers/biometricPunchProcessingController');
const review = require('../controllers/biometricReviewController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);
router.use(restrictTo('Admin'));

router.post('/process', controller.processPunches);
router.get('/status', controller.getProcessingStatus);
router.get('/failed', controller.getFailedPunches);

// Phase 2 — Daily Review (all Admin-only, all audited)
router.get('/review', review.getDailyReview);
router.post('/items/dismiss', review.dismissItems);
router.post('/items/:punchId/retry', review.retryItem);
router.post('/items/:punchId/use-as-checkout', review.useAsCheckout);
router.post('/items/:punchId/keep-as-new-in', review.keepAsNewIn);
router.post('/items/:punchId/mark-duplicate', review.markDuplicate);
router.post('/items/:punchId/review-later', review.reviewLater);
router.post('/items/:punchId/requeue', review.requeueItem);
router.post('/items/:punchId/restore', review.restoreInvalidItem);
router.get('/items/:punchId/history', review.getItemHistory);
router.get('/mapping-impact/:mappingId', review.getMappingImpact);
router.post('/batches/:batchId/close', review.closeStaleBatch);
router.post('/records/submit-for-review', review.adminSubmitForReview);

module.exports = router;
