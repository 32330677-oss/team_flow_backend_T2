const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

function normalizeShift(value) {
    return ['Day', 'Night'].includes(value) ? value : 'Day';
}

// 1. جلب التعيينات
router.get('/', authMiddleware, restrictTo('Admin', 'Supervisor'), async (req, res) => {
    const query = `
        SELECT 
            wsa.assignment_id,
            wsa.worker_id,
            w.full_name AS worker_name,
            wsa.site_id,
            wsa.shift_type,
            s.site_name AS project_name,
            s.supports_shifts,
            wsa.assigned_date AS start_date
        FROM workersiteassignments wsa
        LEFT JOIN workers w ON wsa.worker_id = w.worker_id
        LEFT JOIN sites s ON wsa.site_id = s.site_id
        WHERE wsa.unassigned_date IS NULL
    `;
    try {
        const [results] = await db.query(query);
        res.status(200).json({ status: 'success', data: results });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 2. إنهاء التعيين (Soft Delete) — بدون تغيير، مفتاحه assignment_id
router.delete('/:assignment_id', authMiddleware, restrictTo('Admin'), async (req, res) => {
    try {
        const [result] = await db.query(
            'UPDATE workersiteassignments SET unassigned_date = NOW(), updated_at = NOW() WHERE assignment_id = ? AND unassigned_date IS NULL',
            [req.params.assignment_id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ status: 'fail', message: 'التعيين غير موجود أو أنه منتهي بالفعل!' });
        }
        res.status(200).json({ status: 'success', message: 'تم إنهاء تعيين العامل بنجاح وأرشفة السجل.' });
    } catch (err) {
        console.error("ERROR IN UNASSIGN:", err);
        res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء إنهاء التعيين.' });
    }
});

// 3. إضافة التعيين — أصبحت shift-aware
router.post('/', authMiddleware, restrictTo('Admin'), async (req, res) => {
    const { worker_id, site_id, assigned_date } = req.body;
    const shift_type = normalizeShift(req.body.shift_type);
    const assigned_by_user_id = req.user.user_id;

    if (!worker_id || !site_id) {
        return res.status(400).json({ status: 'fail', message: 'Required fields are missing' });
    }

    let effectiveAssignedDate = null;
    if (assigned_date !== undefined && assigned_date !== null && String(assigned_date).trim() !== '') {
        const raw = String(assigned_date).trim();
        const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00`));
        if (!isValidDate) {
            return res.status(400).json({ status: 'fail', message: 'Invalid assigned_date format (YYYY-MM-DD).' });
        }
        const todayStr = new Date().toISOString().slice(0, 10);
        if (raw > todayStr) {
            return res.status(400).json({ status: 'fail', message: 'assigned_date cannot be a future date.' });
        }
        effectiveAssignedDate = raw;
    }

    try {
        // منع تكرار نفس (site + shift) لنفس العامل
        const [sameSiteShift] = await db.query(
            `SELECT assignment_id FROM workersiteassignments
             WHERE worker_id = ? AND site_id = ? AND shift_type = ? AND unassigned_date IS NULL
             LIMIT 1`,
            [worker_id, site_id, shift_type]
        );
        if (sameSiteShift.length > 0) {
            return res.status(400).json({
                status: 'fail',
                message: `This worker is already assigned to this site's ${shift_type} shift.`
            });
        }

        // منع وجود العامل بموقع فيزيائي مختلف تماماً (السلوك القديم محفوظ)
        const [activeAssignment] = await db.query(
            `SELECT wsa.assignment_id, wsa.site_id, wsa.shift_type, s.site_name AS current_site_name
             FROM workersiteassignments wsa
             LEFT JOIN sites s ON s.site_id = wsa.site_id
             WHERE wsa.worker_id = ? AND wsa.unassigned_date IS NULL AND wsa.site_id <> ?
             LIMIT 1`,
            [worker_id, site_id]
        );
        if (activeAssignment.length > 0) {
            const current = activeAssignment[0];
            return res.status(400).json({
                status: 'fail',
                message: `This worker is already assigned to "${current.current_site_name || 'unknown site'}" (${current.shift_type}). You must end the current assignment there before transferring the worker to a new site.`,
                current_site_id: current.site_id,
                current_shift_type: current.shift_type,
                current_site_name: current.current_site_name
            });
        }

        if (effectiveAssignedDate) {
            const [workerRows] = await db.query('SELECT hire_date FROM workers WHERE worker_id = ? LIMIT 1', [worker_id]);
            if (workerRows.length === 0) {
                return res.status(404).json({ status: 'fail', message: 'Worker not found.' });
            }
            const hireDateStr = workerRows[0].hire_date
                ? new Date(workerRows[0].hire_date).toISOString().slice(0, 10)
                : null;
            if (hireDateStr && effectiveAssignedDate < hireDateStr) {
                return res.status(400).json({
                    status: 'fail',
                    message: `Assignment date (${effectiveAssignedDate}) cannot be earlier than the worker's hire date (${hireDateStr}).`
                });
            }
        }

        const [siteData] = await db.query('SELECT contract_id FROM sites WHERE site_id = ? LIMIT 1', [site_id]);
        if (siteData.length === 0) {
            return res.status(400).json({ status: 'fail', message: 'Site not found' });
        }
        const contract_id = siteData[0].contract_id;

        let result;
        try {
            [result] = await db.query(
                `INSERT INTO workersiteassignments
                 (worker_id, site_id, contract_id, assigned_by_user_id, assigned_date, shift_type, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                [
                    worker_id,
                    site_id,
                    contract_id,
                    assigned_by_user_id,
                    effectiveAssignedDate || new Date().toISOString().slice(0, 10),
                    shift_type,
                ]
            );
        } catch (insertError) {
            if (insertError.code === 'ER_DUP_ENTRY' || insertError.errno === 1062) {
                return res.status(409).json({
                    status: 'fail',
                    message: 'This worker was just assigned by another concurrent request. Please refresh the page.'
                });
            }
            throw insertError;
        }

        res.status(201).json({ status: 'success', data: { assignment_id: result.insertId, shift_type } });
    } catch (err) {
        console.error('CREATE ASSIGNMENT ERROR:', err);
        res.status(500).json({ status: 'error', message: 'An error occurred on the server while saving the assignment.' });
    }
});

module.exports = router;