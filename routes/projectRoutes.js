const express = require('express');
const router = express.Router();
const projectController = require('../controllers/projectController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware'); // استدعاء حارس البوابة

// حماية جميع مسارات المشاريع بالتوكن
router.use(authMiddleware);

// 1. جلب جميع المشاريع:
// مسموح للأدمن والمشرفين (لكي يتمكن المشرف من رؤية المشاريع الموكلة إليه)
// D-07: least privilege — the supervisor app does not use the project list.
router.get('/', restrictTo('Admin'), projectController.getAllProjects);

// 2. إنشاء مشروع جديد:
// عملية إدارية حساسة، للأدمن فقط
router.post('/', restrictTo('Admin'), projectController.createProject);
router.put('/:id', restrictTo('Admin'), projectController.updateProject);
router.patch('/:id/status', restrictTo('Admin'), projectController.toggleProjectStatus);
module.exports = router;