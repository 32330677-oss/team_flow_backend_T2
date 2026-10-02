const db = require('../config/db');
const multer = require('multer');
const path = require('path');
const { acquireCreateLock, releaseCreateLock } = require('../middleware/duplicateGuard');
const { businessToday, addDays, isValidDateOnly, toDateOnly } = require('../services/businessDate');
const { getLastStatusChange, recordWorkerStatusChange } = require('../services/workerStatusService');
const { currentOrFuture } = require('../services/assignmentDates');
const fs = require('fs');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname).toLowerCase());
    }
});
// C-18: images only, max 5 MB each.
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024, files: 2 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (ALLOWED_IMAGE_TYPES.includes(file.mimetype) && ALLOWED_IMAGE_EXT.includes(ext)) return cb(null, true);
        const error = new Error('Only JPG, PNG or WEBP images are allowed.');
        error.code = 'INVALID_FILE_TYPE';
        return cb(error);
    },
});

// Worker photos are served ONLY through the authenticated Admin endpoint
// GET /api/workers/:id/files/:type (C-18). The API returns that URL.
function protectedFileUrl(req, workerId, type) {
    return `${req.protocol}://${req.get('host')}/api/workers/${workerId}/files/${type}`;
}

const uploadFields = upload.fields([
    { name: 'personal_photo', maxCount: 1 },
    { name: 'id_photo', maxCount: 1 }
]);
exports.uploadWorkerFiles = (req, res, next) => uploadFields(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 5 MB or smaller.'
        : err.code === 'INVALID_FILE_TYPE' ? err.message : 'Error uploading files.';
    return res.status(400).json({ status: 'error', message });
});

// GET /api/workers/:id/files/:type   (Admin only, see routes)
exports.getWorkerFile = async (req, res) => {
    try {
        const workerId = Number(req.params.id);
        const type = req.params.type;
        if (!Number.isInteger(workerId) || workerId <= 0 || !['personal_photo', 'id_photo'].includes(type)) {
            return res.status(400).json({ status: 'error', message: 'Invalid request.' });
        }
        const [[row]] = await db.execute(`SELECT ${type} AS file_path FROM workers WHERE worker_id = ? LIMIT 1`, [workerId]);
        if (!row || !row.file_path) return res.status(404).json({ status: 'error', message: 'File not found.' });
        // Accept legacy values stored as full URLs or relative paths; resolve the
        // file name inside uploads/ only (no path traversal).
        const fileName = path.basename(String(row.file_path).replace(/\\/g, '/'));
        const absolute = path.join(UPLOAD_DIR, fileName);
        if (!absolute.startsWith(UPLOAD_DIR) || !fs.existsSync(absolute)) {
            return res.status(404).json({ status: 'error', message: 'File not found.' });
        }
        res.setHeader('Cache-Control', 'private, no-store');
        return res.sendFile(absolute);
    } catch (error) {
        console.error('GET WORKER FILE ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to load the file.' });
    }
};

// ---------------------------------------------------------
// Server-side validation — NEVER trust the frontend (section 3)
// ---------------------------------------------------------
function validateCompensationInput({ payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate }) {
    if (!['Hourly', 'Daily'].includes(payment_type)) {
        return 'payment_type must be either "Hourly" or "Daily".';
    }

    const toNumberOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
    const dailyRate = toNumberOrNull(daily_rate);
    const regularRate = toNumberOrNull(regular_hourly_rate);
    const overtimeRate = toNumberOrNull(overtime_hourly_rate);

    if (payment_type === 'Hourly') {
        if (regularRate === null || !Number.isFinite(regularRate) || regularRate <= 0) {
            return 'regular_hourly_rate is required and must be a positive number for Hourly workers.';
        }
        if (overtimeRate === null || !Number.isFinite(overtimeRate) || overtimeRate <= 0) {
            return 'overtime_hourly_rate is required and must be a positive number for Hourly workers.';
        }
        if (dailyRate !== null) {
            return 'daily_rate must not be provided for Hourly workers.';
        }
    } else {
        // Daily
        if (dailyRate === null || !Number.isFinite(dailyRate) || dailyRate <= 0) {
            return 'daily_rate is required and must be a positive number for Daily workers.';
        }
        if (regularRate !== null || overtimeRate !== null) {
            return 'regular_hourly_rate and overtime_hourly_rate must not be provided for Daily workers.';
        }
    }
    return null; // valid
}

function normalizedCompensationValues(payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate) {
    if (payment_type === 'Hourly') {
        return { daily_rate: null, regular_hourly_rate: Number(regular_hourly_rate), overtime_hourly_rate: Number(overtime_hourly_rate) };
    }
    return { daily_rate: Number(daily_rate), regular_hourly_rate: null, overtime_hourly_rate: null };
}

// D-07: role-specific projection at the API level.
//   Admin      -> full worker record (photos as protected API URLs).
//   Supervisor -> operational fields only, and only workers currently assigned
//                 to the sites/shifts the supervisor manages. No rates, no
//                 identity documents, no mother's name / birth data / phone.
// §31: optional server-side search & pagination: q, status, site_id, page, page_size
//      (without `page` every matching row is returned, as before).
const SUPERVISOR_WORKER_FIELDS = ['worker_id', 'worker_unique_id', 'full_name', 'job_position', 'status'];

exports.getAllWorkers = async (req, res) => {
    try {
        const isAdmin = req.user.role === 'Admin';
        const today = require('../services/businessDate').businessToday();
        const where = [];
        const params = [today];
        const q = String(req.query.q || '').trim();
        if (q) { where.push('(w.full_name LIKE ? OR w.worker_unique_id LIKE ? OR w.phone_number LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
        if (['Active', 'Inactive'].includes(req.query.status)) { where.push('w.status = ?'); params.push(req.query.status); }
        if (Number(req.query.site_id) > 0) {
            where.push(`EXISTS (SELECT 1 FROM workersiteassignments x WHERE x.worker_id = w.worker_id AND x.site_id = ? AND ${currentOrFuture('x', '?')})`);
            params.push(Number(req.query.site_id), today);
        }
        if (!isAdmin) {
            where.push(`EXISTS (SELECT 1 FROM workersiteassignments x JOIN sites sx ON sx.site_id = x.site_id
                         WHERE x.worker_id = w.worker_id AND ${currentOrFuture('x', '?')}
                           AND ((sx.supports_shifts = 0 AND sx.supervisor_id = ?)
                                OR (sx.supports_shifts = 1 AND EXISTS (SELECT 1 FROM site_shifts ss
                                     WHERE ss.site_id = x.site_id AND ss.shift_type = x.shift_type AND ss.supervisor_id = ?))))`);
            params.push(today, req.user.user_id, req.user.user_id);
        }
        const columns = isAdmin ? 'w.*' : SUPERVISOR_WORKER_FIELDS.map((c) => `w.${c}`).join(', ');
        const page = Number(req.query.page);
        const pageSize = Math.min(200, Math.max(10, Number(req.query.page_size) || 50));
        const limitSql = Number.isInteger(page) && page > 0 ? ` LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}` : '';
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const query = `
            SELECT ${columns},
                   (
                     SELECT JSON_ARRAYAGG(
                       JSON_OBJECT('site_id', wsa2.site_id, 'site_name', s2.site_name, 'shift_type', wsa2.shift_type,
                                   'assignment_id', wsa2.assignment_id,
                                   'assigned_date', DATE_FORMAT(wsa2.assigned_date, '%Y-%m-%d'),
                                   'last_day', DATE_FORMAT(wsa2.unassigned_date, '%Y-%m-%d'))
                     )
                     FROM workersiteassignments wsa2
                     JOIN sites s2 ON s2.site_id = wsa2.site_id
                     WHERE wsa2.worker_id = w.worker_id AND ${currentOrFuture('wsa2', '?')}
                   ) AS assignments_json
            FROM workers w
            ${whereSql}
            ORDER BY w.created_at DESC${limitSql}`;
        // The first ? belongs to the sub-select (assignments_json) — keep order.
        const queryParams = [today, ...params.slice(1)];
        const [rows] = await db.query(query, queryParams);

        let total = null;
        if (limitSql) {
            const [[c]] = await db.query(`SELECT COUNT(*) AS total FROM workers w ${whereSql}`, params.slice(1));
            total = Number(c.total);
        }

        const processedRows = rows.map((row) => {
            let assignments = [];
            try {
                if (Array.isArray(row.assignments_json)) assignments = row.assignments_json;
                else if (row.assignments_json) assignments = JSON.parse(row.assignments_json);
            } catch (_) {
                assignments = [];
            }
            row.assigned_site_id = assignments[0]?.site_id ?? null;
            row.assigned_site_name = assignments.length
                ? assignments.map((a) => `${a.site_name} (${a.shift_type})`).join(', ')
                : null;
            row.assignments = assignments;
            delete row.assignments_json;

            if (isAdmin) {
                row.personal_photo = row.personal_photo ? protectedFileUrl(req, row.worker_id, 'personal_photo') : null;
                row.id_photo = row.id_photo ? protectedFileUrl(req, row.worker_id, 'id_photo') : null;
            }
            return row;
        });

        return res.status(200).json({
            status: 'success',
            data: processedRows,
            pagination: limitSql ? { page, page_size: pageSize, total } : null,
        });
    } catch (error) {
        console.error("FETCH WORKERS ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Failed to load workers.' });
    }
};



// 5. تحديث جماعي لطريقة الدفع والراتب لكل العمال (أو مجموعة محددة) دفعة واحدة
// بيحافظ على نفس منطق التوثيق: reason إلزامي + إغلاق compensation القديم + سجل جديد + audit log لكل عامل
exports.bulkUpdateCompensation = async (req, res) => {
    const {
        payment_type,          // 'Daily' أو 'Hourly'
        daily_rate,
        regular_hourly_rate,
        overtime_hourly_rate,
        reason,
        effective_from,
        worker_ids             // اختياري: إذا ما انبعتت، بينطبق على كل العمال Active
    } = req.body;

    if (!reason || !String(reason).trim()) {
        return res.status(400).json({ status: 'error', message: 'A reason is required for a bulk compensation change.' });
    }

    const validationError = validateCompensationInput({ payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate });
    if (validationError) {
        return res.status(400).json({ status: 'error', message: validationError });
    }

    const comp = normalizedCompensationValues(payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate);
    const effectiveDate = effective_from || businessToday();   // B10: business date
    if (!isValidDateOnly(effectiveDate)) {
        return res.status(400).json({ status: 'error', message: 'effective_from must be a valid date (YYYY-MM-DD).' });
    }

    const connection = await db.getConnection();
    const results = { updated: [], skipped: [] };

    try {
        await connection.beginTransaction();

        // حدد العمال المستهدفين (Active فقط افتراضياً، أو قائمة IDs محددة)
        let targetQuery = `SELECT worker_id, worker_unique_id, job_position, payment_type,
                                   daily_rate, regular_hourly_rate, overtime_hourly_rate
                            FROM workers WHERE status = 'Active'`;
        const params = [];
        if (Array.isArray(worker_ids) && worker_ids.length > 0) {
            targetQuery += ` AND worker_id IN (${worker_ids.map(() => '?').join(',')})`;
            params.push(...worker_ids);
        }
        targetQuery += ' FOR UPDATE';

        const [workers] = await connection.execute(targetQuery, params);

        for (const worker of workers) {
            // إذا نفس القيم أصلاً، تجاهله لتجنب سجلات تاريخية بلا فائدة
            const sameAlready =
                worker.payment_type === payment_type &&
                Number(worker.daily_rate) === Number(comp.daily_rate) &&
                Number(worker.regular_hourly_rate) === Number(comp.regular_hourly_rate) &&
                Number(worker.overtime_hourly_rate) === Number(comp.overtime_hourly_rate);

            if (sameAlready) {
                results.skipped.push(worker.worker_unique_id);
                continue;
            }

            // أغلق سجل التعويض النشط الحالي إذا موجود
            const [activeCompRows] = await connection.execute(
                `SELECT compensation_id, effective_from FROM workercompensationhistory
                 WHERE worker_id = ? AND effective_to IS NULL
                 ORDER BY compensation_id DESC LIMIT 1 FOR UPDATE`,
                [worker.worker_id]
            );

            if (activeCompRows.length > 0) {
                const activeComp = activeCompRows[0];
                if (effectiveDate <= toDateOnly(activeComp.effective_from)) {
                    // تخطي هذا العامل بدل ما توقف كل العملية
                    results.skipped.push(worker.worker_unique_id);
                    continue;
                }
                // #15: pure date-string arithmetic (no local-timezone Date shift).
                await connection.execute(
                    `UPDATE workercompensationhistory SET effective_to = ? WHERE compensation_id = ?`,
                    [addDays(effectiveDate, -1), activeComp.compensation_id]
                );
            }

            await connection.execute(
                `INSERT INTO workercompensationhistory
                    (worker_id, payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate,
                     job_position, effective_from, effective_to, reason, changed_by_user_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
                [worker.worker_id, payment_type, comp.daily_rate, comp.regular_hourly_rate,
                 comp.overtime_hourly_rate, worker.job_position, effectiveDate, reason, req.user.user_id]
            );

            await connection.execute(
                `UPDATE workers
                 SET payment_type = ?, daily_rate = ?, regular_hourly_rate = ?, overtime_hourly_rate = ?
                 WHERE worker_id = ?`,
                [payment_type, comp.daily_rate, comp.regular_hourly_rate, comp.overtime_hourly_rate, worker.worker_id]
            );

            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('workers', ?, 'COMPENSATION_CHANGED', ?, ?, ?)`,
                [
                    worker.worker_id, req.user.user_id,
                    JSON.stringify({
                        payment_type: worker.payment_type, daily_rate: worker.daily_rate,
                        regular_hourly_rate: worker.regular_hourly_rate, overtime_hourly_rate: worker.overtime_hourly_rate
                    }),
                    JSON.stringify({ payment_type, ...comp, reason, bulk: true })
                ]
            );

            results.updated.push(worker.worker_unique_id);
        }

        await connection.commit();
        return res.status(200).json({
            status: 'success',
            message: `Compensation updated for ${results.updated.length} workers.`,
            data: results
        });
    } catch (error) {
        await connection.rollback();
        console.error('🚨 BULK COMPENSATION UPDATE ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'Server error while applying bulk compensation update' });
    } finally {
        connection.release();
    }
};





exports.createWorker = async (req, res) => {
    const {
        full_name, phone_number, nationality, job_position, hire_date, notes,
        mothers_name, birth_date, birth_place, location,
        payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate
    } = req.body;

    if (!full_name) {
        return res.status(400).json({ status: 'error', message: 'Please enter the full name of the worker' });
    }

    const validationError = validateCompensationInput({ payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate });
    if (validationError) {
        return res.status(400).json({ status: 'error', message: validationError });
    }

    const comp = normalizedCompensationValues(payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate);
    const personalPhotoPath = req.files && req.files['personal_photo'] ? req.files['personal_photo'][0].path : null;
    const idPhotoPath = req.files && req.files['id_photo'] ? req.files['id_photo'][0].path : null;
    const effectiveHireDate = hire_date || businessToday();   // B10: business date

    const connection = await db.getConnection();
    const lockKey = `create_worker:${full_name}:${phone_number || ''}`;

    try {
        const locked = await acquireCreateLock(connection, lockKey, 5);
        if (!locked) {
            return res.status(409).json({
                status: 'error',
                message: 'A similar request is already being processed. Please check the workers list before retrying.'
            });
        }

        await connection.beginTransaction();

        // Race-free now: concurrent identical requests are serialized by the
        // lock above, so the second one will see the first's committed row.
        const [dupRows] = await connection.execute(
            `SELECT worker_id FROM workers
             WHERE full_name = ? AND phone_number <=> ?
               AND created_at >= (NOW() - INTERVAL 15 SECOND)
             LIMIT 1`,
            [full_name, phone_number || null]
        );
        if (dupRows.length > 0) {
            await connection.rollback();
            return res.status(409).json({
                status: 'error',
                message: 'يبدو أن هذا العامل تمت إضافته للتو. تحقق من قائمة العمال قبل إعادة المحاولة.'
            });
        }

        const [result] = await connection.execute(
            `INSERT INTO workers (
                worker_unique_id, full_name, phone_number, nationality, job_position, hire_date, notes, status,
                mothers_name, birth_date, birth_place, location, personal_photo, id_photo,
                payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate
            )
            VALUES ('TEMP', ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                full_name, phone_number || null, nationality || null, job_position || null,
                effectiveHireDate, notes || null, mothers_name || null, birth_date || null,
                birth_place || null, location || null, personalPhotoPath, idPhotoPath,
                payment_type, comp.daily_rate, comp.regular_hourly_rate, comp.overtime_hourly_rate
            ]
        );

        const newId = result.insertId;
        const worker_unique_id = `W-${newId}`;
        await connection.execute('UPDATE workers SET worker_unique_id = ? WHERE worker_id = ?', [worker_unique_id, newId]);

        await connection.execute(
            `INSERT INTO workercompensationhistory
                (worker_id, payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate,
                 job_position, effective_from, effective_to, reason, changed_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'Initial compensation on hire', ?)`,
            [newId, payment_type, comp.daily_rate, comp.regular_hourly_rate, comp.overtime_hourly_rate,
             job_position || null, effectiveHireDate, req.user.user_id]
        );

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('workers', ?, 'WORKER_CREATED', ?, NULL, ?)`,
            [newId, req.user.user_id, JSON.stringify({ payment_type, ...comp })]
        );

        await connection.commit();
        return res.status(201).json({
            status: 'success',
            message: 'Worker added successfully with auto ID',
            worker_unique_id,
            worker_id: newId
        });
    } catch (error) {
        await connection.rollback();
        console.error("🚨 CREATE WORKER ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Server error occurred while adding the worker' });
    } finally {
        await releaseCreateLock(connection, lockKey);
        connection.release();
    }
};

// 3. تعديل بيانات عامل (مع دعم Rate History عند تغيير الراتب/النوع/المنصب)
exports.updateWorker = async (req, res) => {
    const workerId = req.params.id; // worker_unique_id
    const uploadMiddleware = upload.fields([
        { name: 'personal_photo', maxCount: 1 },
        { name: 'id_photo', maxCount: 1 }
    ]);

    uploadMiddleware(req, res, async (err) => {
        if (err) {
            const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 5 MB or smaller.'
                : err.code === 'INVALID_FILE_TYPE' ? err.message : 'Error uploading files';
            return res.status(400).json({ status: 'error', message });
        }

        const connection = await db.getConnection();
        try {
            const {
                full_name, phone_number, nationality, job_position, hire_date, notes, status,
                mothers_name, birth_date, birth_place, location,
                payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate,
                reason, effective_from
            } = req.body || {};

            await connection.beginTransaction();

            const [existingRows] = await connection.execute(
                'SELECT * FROM workers WHERE worker_unique_id = ? FOR UPDATE',
                [workerId]
            );
            if (existingRows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ status: 'error', message: 'العامل غير موجود' });
            }
            const existing = existingRows[0];

            // Does this request touch compensation-sensitive fields?
const touchesCompensation =
    payment_type !== undefined ||
    daily_rate !== undefined ||
    regular_hourly_rate !== undefined ||
    overtime_hourly_rate !== undefined ||
    (
        job_position !== undefined &&
        (job_position ?? '') !== (existing.job_position ?? '')
    );

            let newPaymentType = existing.payment_type;
            let newComp = {
                daily_rate: existing.daily_rate,
                regular_hourly_rate: existing.regular_hourly_rate,
                overtime_hourly_rate: existing.overtime_hourly_rate
            };
            let newJobPosition = job_position !== undefined ? job_position : existing.job_position;

            if (touchesCompensation) {
                // Section 16: reason is mandatory for any compensation/position change
                if (!reason || !String(reason).trim()) {
                    await connection.rollback();
                    return res.status(400).json({
                        status: 'error',
                        message: 'A reason is required when changing payment type, rates, or job position.'
                    });
                }

                newPaymentType = payment_type !== undefined ? payment_type : existing.payment_type;
                const validationError = validateCompensationInput({
                    payment_type: newPaymentType,
                    daily_rate: daily_rate !== undefined ? daily_rate : (newPaymentType === 'Daily' ? existing.daily_rate : null),
                    regular_hourly_rate: regular_hourly_rate !== undefined ? regular_hourly_rate : (newPaymentType === 'Hourly' ? existing.regular_hourly_rate : null),
                    overtime_hourly_rate: overtime_hourly_rate !== undefined ? overtime_hourly_rate : (newPaymentType === 'Hourly' ? existing.overtime_hourly_rate : null),
                });
                if (validationError) {
                    await connection.rollback();
                    return res.status(400).json({ status: 'error', message: validationError });
                }

                newComp = normalizedCompensationValues(
                    newPaymentType,
                    daily_rate !== undefined ? daily_rate : existing.daily_rate,
                    regular_hourly_rate !== undefined ? regular_hourly_rate : existing.regular_hourly_rate,
                    overtime_hourly_rate !== undefined ? overtime_hourly_rate : existing.overtime_hourly_rate
                );

                const effectiveDate = effective_from || businessToday();   // B10: business date
                if (!isValidDateOnly(effectiveDate)) {
                    await connection.rollback();
                    return res.status(400).json({ status: 'error', message: 'effective_from must be a valid date (YYYY-MM-DD).' });
                }

                // Section 19: lock current active compensation row, close it, open a new one
                const [activeCompRows] = await connection.execute(
                    `SELECT compensation_id, effective_from FROM workercompensationhistory
                     WHERE worker_id = ? AND effective_to IS NULL
                     ORDER BY compensation_id DESC LIMIT 1 FOR UPDATE`,
                    [existing.worker_id]
                );

                if (activeCompRows.length > 0) {
                    const activeComp = activeCompRows[0];
                    if (effectiveDate <= toDateOnly(activeComp.effective_from)) {
                        await connection.rollback();
                        return res.status(400).json({
                            status: 'error',
                            message: 'The new effective date must be after the current compensation period start date.'
                        });
                    }
                    // #15: pure date-string arithmetic (no local-timezone Date shift).
                    const closeDateStr = addDays(effectiveDate, -1);

                    await connection.execute(
                        `UPDATE workercompensationhistory SET effective_to = ? WHERE compensation_id = ?`,
                        [closeDateStr, activeComp.compensation_id]
                    );
                }

                await connection.execute(
                    `INSERT INTO workercompensationhistory
                        (worker_id, payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate,
                         job_position, effective_from, effective_to, reason, changed_by_user_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
                    [existing.worker_id, newPaymentType, newComp.daily_rate, newComp.regular_hourly_rate,
                     newComp.overtime_hourly_rate, newJobPosition, effectiveDate, reason, req.user.user_id]
                );

                await connection.execute(
                    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                     VALUES ('workers', ?, 'COMPENSATION_CHANGED', ?, ?, ?)`,
                    [
                        existing.worker_id, req.user.user_id,
                        JSON.stringify({
                            job_position: existing.job_position, payment_type: existing.payment_type,
                            daily_rate: existing.daily_rate, regular_hourly_rate: existing.regular_hourly_rate,
                            overtime_hourly_rate: existing.overtime_hourly_rate
                        }),
                        JSON.stringify({ job_position: newJobPosition, payment_type: newPaymentType, ...newComp, reason })
                    ]
                );
            }

            // D1: every status change is recorded in worker_status_history with the
            // date it takes effect, so historical dates never depend on the
            // CURRENT workers.status.
            if (status !== undefined && status !== null && status !== '' && status !== existing.status) {
                if (!['Active', 'Inactive'].includes(status)) {
                    await connection.rollback();
                    return res.status(400).json({ status: 'error', message: 'status must be Active or Inactive.' });
                }
                // §27: the effective date is mandatory (no silent "today" default).
                const statusEffectiveDate = req.body.status_effective_date;
                if (!isValidDateOnly(statusEffectiveDate)) {
                    await connection.rollback();
                    return res.status(400).json({ status: 'error', message: 'status_effective_date (YYYY-MM-DD) is required for a status change: the first day the new status applies.' });
                }
                if (statusEffectiveDate > businessToday()) {
                    await connection.rollback();
                    return res.status(400).json({ status: 'error', message: 'A status change cannot take effect in the future.' });
                }
                const hireDate = toDateOnly(existing.hire_date);
                if (hireDate && statusEffectiveDate < hireDate) {
                    await connection.rollback();
                    return res.status(400).json({ status: 'error', message: `status_effective_date cannot be before the hire date (${hireDate}).` });
                }
                const last = await getLastStatusChange(existing.worker_id, connection);
                if (last && statusEffectiveDate < toDateOnly(last.effective_date)) {
                    await connection.rollback();
                    return res.status(400).json({ status: 'error', message: `status_effective_date cannot be before the last recorded status change (${toDateOnly(last.effective_date)}).` });
                }
                const statusReason = req.body.status_reason ? String(req.body.status_reason).trim().slice(0, 500) : null;
                await recordWorkerStatusChange(connection, {
                    workerId: existing.worker_id,
                    oldStatus: existing.status,
                    newStatus: status,
                    effectiveDate: statusEffectiveDate,
                    reason: statusReason,
                    userId: req.user.user_id,
                });
                await connection.execute(
                    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                     VALUES ('workers', ?, 'STATUS_CHANGED', ?, ?, ?)`,
                    [existing.worker_id, req.user.user_id, JSON.stringify({ status: existing.status }),
                        JSON.stringify({ status, effective_date: statusEffectiveDate, reason: statusReason })]
                );

                // §27 / R-14: becoming Inactive does NOT close assignments by
                // itself (status and assignment are separate). Only when the Admin
                // explicitly gives the LAST assigned day are the open assignments
                // ended at that date (inclusive), with the same attendance checks
                // as End Assignment.
                const lastAssignedDay = req.body.end_assignments_last_day;
                if (status === 'Inactive' && lastAssignedDay !== undefined && lastAssignedDay !== null && lastAssignedDay !== '') {
                    if (!isValidDateOnly(lastAssignedDay)) {
                        await connection.rollback();
                        return res.status(400).json({ status: 'error', message: 'end_assignments_last_day must be a valid date (YYYY-MM-DD).' });
                    }
                    const { endAssignment } = require('../routes/assignmentRoutes')._internal;
                    const [openAssignments] = await connection.execute(
                        `SELECT assignment_id FROM workersiteassignments
                         WHERE worker_id = ? AND (unassigned_date IS NULL OR unassigned_date > ?)`,
                        [existing.worker_id, lastAssignedDay]
                    );
                    for (const oa of openAssignments) {
                        try {
                            await endAssignment(connection, {
                                assignmentId: oa.assignment_id, lastDay: lastAssignedDay,
                                reason: `Worker set Inactive from ${statusEffectiveDate}${statusReason ? `: ${statusReason}` : ''}`,
                                userId: req.user.user_id,
                            });
                        } catch (endError) {
                            await connection.rollback();
                            return res.status(endError.statusCode || 400).json({ status: 'error', message: endError.message, ...(endError.extra || {}) });
                        }
                    }
                }
            }

            const personalPhotoPath = req.files && req.files['personal_photo']
                ? req.files['personal_photo'][0].path
                : existing.personal_photo;
            const idPhotoPath = req.files && req.files['id_photo']
                ? req.files['id_photo'][0].path
                : existing.id_photo;
            const birthDateValue = typeof birth_date === 'string' && birth_date.trim() === '' ? null : birth_date;

            await connection.execute(
                `UPDATE workers
                 SET full_name = COALESCE(?, full_name),
                     phone_number = ?,
                     nationality = ?,
                     job_position = ?,
                     hire_date = COALESCE(?, hire_date),
                     notes = ?,
                     status = COALESCE(?, status),
                     mothers_name = ?,
                     birth_date = ?,
                     birth_place = ?,
                     location = ?,
                     personal_photo = ?,
                     id_photo = ?,
                     payment_type = ?,
                     daily_rate = ?,
                     regular_hourly_rate = ?,
                     overtime_hourly_rate = ?
                 WHERE worker_unique_id = ?`,
                [
                    full_name || null,
                    phone_number !== undefined ? phone_number : existing.phone_number,
                    nationality !== undefined ? nationality : existing.nationality,
                    newJobPosition,
                    hire_date || null,
                    notes !== undefined ? notes : existing.notes,
                    status || null,
                    mothers_name !== undefined ? mothers_name : existing.mothers_name,
                    birth_date !== undefined ? birthDateValue : existing.birth_date,
                    birth_place !== undefined ? birth_place : existing.birth_place,
                    location !== undefined ? location : existing.location,
                    personalPhotoPath,
                    idPhotoPath,
                    newPaymentType,
                    newComp.daily_rate,
                    newComp.regular_hourly_rate,
                    newComp.overtime_hourly_rate,
                    workerId
                ]
            );

            await connection.commit();
            return res.status(200).json({ status: 'success', message: 'updated data' });
        } catch (error) {
            await connection.rollback();
            console.error("🚨 UPDATE WORKER ERROR:", error);
            return res.status(500).json({ status: 'error', message: 'حدث خطأ في السيرفر أثناء تحديث العامل' });
        } finally {
            connection.release();
        }
    });
};

// 4. جلب سجل تاريخ الرواتب لعامل معيّن (Admin only)
exports.getCompensationHistory = async (req, res) => {
    try {
        const { id } = req.params; // worker_id (numeric)
        const [rows] = await db.execute(
            `SELECT wch.*, u.full_name AS changed_by_name
             FROM workercompensationhistory wch
             LEFT JOIN users u ON u.user_id = wch.changed_by_user_id
             WHERE wch.worker_id = ?
             ORDER BY wch.effective_from DESC`,
            [id]
        );
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("FETCH COMPENSATION HISTORY ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Failed to load compensation history' });
    }
};

// D1: GET /api/workers/:id/status-history  (worker_id, numeric)
exports.getStatusHistory = async (req, res) => {
    try {
        const workerId = Number(req.params.id);
        if (!Number.isInteger(workerId) || workerId <= 0) {
            return res.status(400).json({ status: 'error', message: 'Invalid worker id.' });
        }
        const [rows] = await db.execute(
            `SELECT wsh.status_history_id, wsh.old_status, wsh.new_status,
                    DATE_FORMAT(wsh.effective_date, '%Y-%m-%d') AS effective_date,
                    wsh.reason, wsh.created_at, u.full_name AS changed_by_name
             FROM worker_status_history wsh
             LEFT JOIN users u ON u.user_id = wsh.changed_by_user_id
             WHERE wsh.worker_id = ?
             ORDER BY wsh.effective_date DESC, wsh.status_history_id DESC`,
            [workerId]
        );
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error('FETCH WORKER STATUS HISTORY ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to load status history' });
    }
};
