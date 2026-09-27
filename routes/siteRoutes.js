const express = require('express');
const router = express.Router();
const siteController = require('../controllers/siteController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);

router.get('/my-sites', restrictTo('Admin', 'Supervisor'), siteController.getMySites);
router.get('/all-sites', restrictTo('Admin', 'Supervisor'), siteController.getAllSites); // <-- تم إضافة Supervisor هنا
router.get('/contract/:contractId', restrictTo('Admin', 'Supervisor'), siteController.getSitesByContract);

router.post('/', restrictTo('Admin'), siteController.createSite);
router.put('/:siteId', restrictTo('Admin'), siteController.updateSite);
router.patch('/:siteId/status', restrictTo('Admin'), siteController.toggleSiteStatus);
router.get('/:siteId/shifts', authMiddleware, restrictTo('Admin'), siteController.getSiteShifts);
router.put('/:siteId/shifts', authMiddleware, restrictTo('Admin'), siteController.upsertSiteShiftSupervisor);
module.exports = router;