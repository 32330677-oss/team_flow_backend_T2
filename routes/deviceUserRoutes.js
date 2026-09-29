const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');
const controller = require('../controllers/deviceUserController');

const router = express.Router();

router.use(authMiddleware);
router.use(restrictTo('Admin'));

router.get('/', controller.listDeviceUserMappings);
router.get('/available', controller.listAvailableEntities);
router.get('/resolve', controller.resolveDeviceUser);

router.post('/', controller.createDeviceUserMapping);

router.patch('/:id/end', controller.endDeviceUserMapping);
router.patch('/:id/void', controller.voidDeviceUserMapping);

module.exports = router;