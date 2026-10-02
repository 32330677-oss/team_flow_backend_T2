// backend/controllers/adminAttendanceController.js
const db = require('../config/db');
const settingsCache = require('../services/settingsCache');
const attendanceService = require('../services/attendanceService');
const { businessToday, isValidDateOnly } = require('../services/businessDate');
const { assertWorkerDateEditable } = require('../services/payrollLock');

// Defaults used when a key was never stored (display only). The overtime rate
// has NO default: it must be configured (D-14).
const DEFAULT_SETTING_VALUES = {
    is_lunch_paid: 'false',
    standard_work_minutes: '600',
    long_shift_review_hours: '16',
    attendance_week_start_day: '6',
    worker_payroll_currency: 'SYP',
    staff_payroll_currency: 'USD',
};
const SETTING_KEYS = ['is_lunch_paid', 'standard_work_minutes', 'overtime_flat_rate_syp', 'long_shift_review_hours',
    'attendance_week_start_day', 'worker_payroll_currency', 'staff_payroll_currency'];
// Keys whose value is baked into stored attendance hours.
const HOURS_KEYS = ['is_lunch_paid', 'standard_work_minutes'];

class OpError extends Error {
    constructor(message, statusCode = 400, extra = null) {
        super(message);
        this.isOperational = true;
        this.statusCode = statusCode;
        this.extra = extra;
    }
}
function sendError(res, error, fallback) {
    if (error && error.isOperational) {
        return res.status(error.statusCode || 400).json({
            status: 'error', ...(error.code ? { code: error.code } : {}), message: error.message, ...(error.extra || {}),
        });
    }
    console.error(fallback, error);
    return res.status(500).json({ status: 'error', message: fallback });
}

// #10: Supervisor reads of worker attendance are limited to the site/shift
// scope they supervise. Same predicate as attendanceController.getRejectedRecords
// and verifySupervisorSite: site_shifts for shift sites, sites.supervisor_id
// only for sites that do not support shifts. Admin is never scoped.
function supervisorScope(req) {
    if (req.user && req.user.role === 'Supervisor') {
        return {
            join: ' LEFT JOIN site_shifts ss ON ss.site_id = a.site_id AND ss.shift_type = a.shift_type',
            where: ` AND ((s.supports_shifts = 0 AND s.supervisor_id = ?)
                       OR (s.supports_shifts = 1 AND ss.supervisor_id = ?))`,
            params: [req.user.user_id, req.user.user_id],
        };
    }
    return { join: '', where: '', params: [] };
}

const REVIEW_COLUMNS = `a.attendance_id, a.worker_id, a.site_id, a.shift_type,
        a.source,
        a.check_in_time, a.check_out_time,
        a.total_working_hours, a.overtime_hours,
        a.management_leave_hours, a.status, a.attendance_status,
        a.remarks, a.admin_rejection_notes,
        a.approved_by_user_id, a.approval_date,
        a.anomaly_code, a.anomaly_detail, a.anomaly_ack_at, a.anomaly_ack_note,
        DATE_FORMAT(a.record_date, '%Y-%m-%d') AS record_date,
        w.full_name, w.worker_unique_id, s.site_name,
        (SELECT COUNT(*) FROM attendanceleaveperiods l WHERE l.attendance_id = a.attendance_id AND l.leave_type = 'Lunch') AS lunch_count`;

// GET /api/admin/attendance/pending
// Optional filters (server-side, D-12 / §31):
//   status=Submitted|Rejected|Draft|Approved|open (default: Submitted+Rejected)
//   date_from, date_to, site_id, shift_type, q (name / worker id), anomaly=1,
//   page, page_size (pagination only when page is given; otherwise all rows,
//   which keeps older clients working).
exports.getPendingRecords = async (req, res) => {
    try {
        const scope = supervisorScope(req);
        const where = [];
        const params = [];
        const statusFilter = String(req.query.status || '');
        if (['Submitted', 'Rejected', 'Draft', 'Approved'].includes(statusFilter)) {
            where.push('a.status = ?'); params.push(statusFilter);
        } else {
            where.push("a.status IN ('Submitted', 'Rejected')");
        }
        if (isValidDateOnly(req.query.date_from)) { where.push('a.record_date >= ?'); params.push(req.query.date_from); }
        if (isValidDateOnly(req.query.date_to)) { where.push('a.record_date <= ?'); params.push(req.query.date_to); }
        if (Number(req.query.site_id) > 0) { where.push('a.site_id = ?'); params.push(Number(req.query.site_id)); }
        if (['Day', 'Night'].includes(req.query.shift_type)) { where.push('a.shift_type = ?'); params.push(req.query.shift_type); }
        if (req.query.anomaly === '1') where.push('a.anomaly_code IS NOT NULL');
        const q = String(req.query.q || '').trim();
        if (q) { where.push('(w.full_name LIKE ? OR w.worker_unique_id LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

        const base = `FROM attendance a
             JOIN workers w ON a.worker_id = w.worker_id
             JOIN sites s ON a.site_id = s.site_id${scope.join}
             WHERE ${where.join(' AND ')}${scope.where}`;
        const allParams = [...params, ...scope.params];

        const page = Number(req.query.page);
        const pageSize = Math.min(200, Math.max(10, Number(req.query.page_size) || 50));
        let limitSql = '';
        if (Number.isInteger(page) && page > 0) limitSql = ` LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;

        const [rows] = await db.execute(
            `SELECT ${REVIEW_COLUMNS} ${base} ORDER BY a.record_date DESC, s.site_name, a.shift_type, w.full_name${limitSql}`,
            allParams
        );
        const [[summary]] = await db.execute(
            `SELECT COUNT(*) AS total,
                    SUM(a.status = 'Submitted') AS submitted,
                    SUM(a.status = 'Rejected') AS rejected,
                    SUM(a.anomaly_code IS NOT NULL AND a.anomaly_ack_at IS NULL) AS anomalies_open,
                    COUNT(DISTINCT a.worker_id) AS workers,
                    COUNT(DISTINCT a.record_date) AS days
             ${base}`,
            allParams
        );
        res.status(200).json({
            status: 'success',
            data: rows,
            summary: {
                total: Number(summary.total || 0),
                submitted: Number(summary.submitted || 0),
                rejected: Number(summary.rejected || 0),
                anomalies_open: Number(summary.anomalies_open || 0),
                workers: Number(summary.workers || 0),
                days: Number(summary.days || 0),
            },
            pagination: limitSql ? { page, page_size: pageSize, total: Number(summary.total || 0) } : null,
        });
    } catch (error) {
        sendError(res, error, 'Failed to load attendance records.');
    }
};

// 2. Review record (Approve or Reject) with strict pre-validation & audit logging
//    D-09: a record flagged with an anomaly can only be APPROVED with an
//    explicit acknowledgement note (or after an Admin correction cleared it).
exports.reviewRecord = async (req, res) => {
    const { attendance_id, status, admin_note } = req.body;
    const adminId = req.user?.user_id;
    if (!['Approved', 'Rejected'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'Status must be Approved or Rejected.' });
    }
    if (status === 'Rejected' && (!admin_note || !String(admin_note).trim())) {
        return res.status(400).json({ status: 'error', message: 'A rejection reason is required.' });
    }
    if (!adminId) {
        return res.status(401).json({ status: 'error', message: 'Admin identification not found' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // #9: lock the row so two concurrent reviews cannot both succeed.
        const [oldRows] = await connection.execute(
            'SELECT * FROM attendance WHERE attendance_id = ? FOR UPDATE',
            [attendance_id]
        );
        if (oldRows.length === 0) throw new OpError('Record does not exist', 404);
        const oldRecord = oldRows[0];

        if (oldRecord.status === 'Rejected') {
            throw new OpError('Rejected records must be resubmitted by the supervisor first.', 409);
        }
        if (oldRecord.status !== 'Submitted') {
            throw new OpError('Record cannot be reviewed as it is not in pending status.', 409);
        }
        await assertWorkerDateEditable(connection, oldRecord.site_id, oldRecord.record_date);   // D-02

        let ackNote = null;
        if (status === 'Approved' && oldRecord.anomaly_code && !oldRecord.anomaly_ack_at) {
            ackNote = String(req.body.anomaly_note || '').trim();
            if (req.body.acknowledge_anomaly !== true || ackNote.length < 5) {
                throw new OpError(
                    `This record is flagged for review: ${oldRecord.anomaly_detail || oldRecord.anomaly_code}. ` +
                    'Approve only after checking it, with acknowledge_anomaly = true and a note (min. 5 characters), ' +
                    'or reject it / correct it first.', 409, { code: 'ANOMALY_ACK_REQUIRED', anomaly_detail: oldRecord.anomaly_detail });
            }
        }

        // B6: biometric worker records can be rejected like manual ones.
        const [reviewed] = await connection.execute(
            `UPDATE attendance
             SET status = ?, admin_rejection_notes = ?, approved_by_user_id = ?, approval_date = NOW(),
                 anomaly_ack_by_user_id = CASE WHEN ? IS NULL THEN anomaly_ack_by_user_id ELSE ? END,
                 anomaly_ack_at = CASE WHEN ? IS NULL THEN anomaly_ack_at ELSE NOW() END,
                 anomaly_ack_note = CASE WHEN ? IS NULL THEN anomaly_ack_note ELSE ? END
             WHERE attendance_id = ? AND status = 'Submitted'`,
            [status, (status === 'Rejected' ? admin_note : null), adminId,
                ackNote, adminId, ackNote, ackNote, ackNote, attendance_id]
        );
        if (reviewed.affectedRows !== 1) {
            throw new OpError('Record cannot be reviewed as it is not in pending status.', 409);
        }

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES (?, ?, ?, ?, ?, ?)`,
            ['attendance', attendance_id, status.toUpperCase(), adminId,
                JSON.stringify(oldRecord), JSON.stringify({ status, admin_note, anomaly_ack_note: ackNote })]
        );

        await connection.commit();
        res.status(200).json({ status: 'success', message: 'Operation completed successfully' });
    } catch (error) {
        await connection.rollback();
        if (error.isOperational) {
            return res.status(error.statusCode || 400).json({
                status: 'error', ...(error.code ? { code: error.code } : {}), message: error.message, ...(error.extra || {}),
            });
        }
        console.error('Review Transaction Error:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error while reviewing the record.' });
    } finally {
        connection.release();
    }
};

// 3. Get records by specific date
exports.getRecordsByDate = async (req, res) => {
    const { date } = req.query;
    if (!isValidDateOnly(date)) return res.status(400).json({ status: 'error', message: 'A valid date (YYYY-MM-DD) is required.' });
    try {
        const scope = supervisorScope(req);
        const [rows] = await db.execute(
            `SELECT ${REVIEW_COLUMNS}
             FROM attendance a
             JOIN workers w ON a.worker_id = w.worker_id
             JOIN sites s ON a.site_id = s.site_id${scope.join}
             WHERE a.record_date = ? AND (a.status IN ('Submitted', 'Rejected'))${scope.where}`,
            [date, ...scope.params]
        );
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        sendError(res, error, 'Failed to load attendance records.');
    }
};

// 4. Get settings (current values + dated history)
exports.getBreakSettings = async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [SETTING_KEYS]);
        const data = { ...DEFAULT_SETTING_VALUES, overtime_flat_rate_syp: null };
        rows.forEach((r) => { data[r.setting_key] = r.setting_value; });
        let history = [];
        try {
            const [h] = await db.query(
                `SELECT h.setting_key, h.setting_value, DATE_FORMAT(h.effective_from, '%Y-%m-%d') AS effective_from,
                        DATE_FORMAT(h.effective_to, '%Y-%m-%d') AS effective_to, h.reason, h.created_at, u.full_name AS changed_by
                 FROM system_settings_history h LEFT JOIN users u ON u.user_id = h.changed_by_user_id
                 WHERE h.setting_key IN (?) ORDER BY h.setting_key, h.effective_from DESC`, [SETTING_KEYS]);
            history = h;
        } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
        res.status(200).json({ status: 'success', data, history, business_today: businessToday() });
    } catch (error) {
        sendError(res, error, 'Failed to load settings.');
    }
};

// 5. Update settings with an effective date (D-08).
//    * No global "no pending attendance" lock any more.
//    * effective_from (default: business today) may be in the past, but never
//      inside a Finalized/Paid payroll period (that history cannot change;
//      use the correction workflow) and never before the last dated change.
//    * Settings baked into stored hours (lunch paid, standard minutes) are
//      refused while Submitted/Approved worker records exist on/after
//      effective_from (their stored hours would silently disagree). Draft
//      records on/after effective_from are recalculated explicitly, each with an
//      audit row, and listed in the response.
exports.updateBreakSettings = async (req, res) => {
    const body = req.body || {};
    const adminId = req.user.user_id;
    const effectiveFrom = body.effective_from || businessToday();
    const reason = String(body.reason || '').trim() || null;
    const updates = {};

    try {
        if (!isValidDateOnly(effectiveFrom)) throw new OpError('effective_from must be a valid date (YYYY-MM-DD).');
        if (effectiveFrom > businessToday()) {
            // Future-dated values are allowed; nothing else needed.
        }
        if (body.is_lunch_paid !== undefined) {
            if (!['true', 'false', true, false].includes(body.is_lunch_paid)) throw new OpError('is_lunch_paid must be true or false.');
            updates.is_lunch_paid = String(body.is_lunch_paid);
        }
        if (body.standard_work_minutes !== undefined) {
            const v = Number(body.standard_work_minutes);
            if (!Number.isFinite(v) || v <= 0 || v > 1440) throw new OpError('standard_work_minutes must be between 1 and 1440.');
            updates.standard_work_minutes = String(v);
        }
        if (body.overtime_flat_rate_syp !== undefined) {
            const v = Number(body.overtime_flat_rate_syp);
            if (!Number.isFinite(v) || v <= 0) throw new OpError('overtime_flat_rate_syp must be a positive number.');
            updates.overtime_flat_rate_syp = String(v);
        }
        if (body.long_shift_review_hours !== undefined) {
            const v = Number(body.long_shift_review_hours);
            if (!Number.isFinite(v) || v < 4 || v > 48) throw new OpError('long_shift_review_hours must be between 4 and 48.');
            updates.long_shift_review_hours = String(v);
        }
        if (body.attendance_week_start_day !== undefined) {
            const v = Number(body.attendance_week_start_day);
            if (!Number.isInteger(v) || v < 0 || v > 6) throw new OpError('attendance_week_start_day must be 0 (Sunday) to 6 (Saturday).');
            updates.attendance_week_start_day = String(v);
        }
        for (const key of ['worker_payroll_currency', 'staff_payroll_currency']) {
            if (body[key] !== undefined) {
                const v = String(body[key]).trim().toUpperCase();
                if (!/^[A-Z]{3}$/.test(v)) throw new OpError(`${key} must be a 3-letter ISO currency code.`);
                updates[key] = v;
            }
        }
        if (Object.keys(updates).length === 0) throw new OpError('No setting to update.');
        if (effectiveFrom < businessToday() && !reason) {
            throw new OpError('A reason is required for a back-dated effective date.');
        }
    } catch (error) {
        return sendError(res, error, 'Invalid settings.');
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Never inside finalized/paid payroll history (workers; staff too for currency).
        const [[finalized]] = await connection.execute(
            `SELECT payroll_batch_id, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date FROM payrollbatches
             WHERE is_finalized = 1 AND status IN ('Generated','Paid') AND end_date >= ?
             ORDER BY end_date DESC LIMIT 1`, [effectiveFrom]);
        if (finalized) {
            throw new OpError(
                `effective_from ${effectiveFrom} falls inside finalized worker payroll batch #${finalized.payroll_batch_id} ` +
                `(ends ${finalized.end_date}). Finalized payroll cannot change; choose a date after ${finalized.end_date} ` +
                'or record the difference with the correction workflow.', 409);
        }

        const touchesHours = HOURS_KEYS.some((k) => updates[k] !== undefined);
        if (touchesHours) {
            const [blocking] = await connection.execute(
                `SELECT status, COUNT(*) AS cnt, DATE_FORMAT(MIN(record_date), '%Y-%m-%d') AS first_date
                 FROM attendance WHERE status IN ('Submitted', 'Approved') AND record_date >= ?
                 GROUP BY status`, [effectiveFrom]);
            if (blocking.length > 0) {
                throw new OpError(
                    `Submitted/Approved worker attendance exists on or after ${effectiveFrom} ` +
                    `(${blocking.map((b) => `${b.cnt} ${b.status} from ${b.first_date}`).join(', ')}). ` +
                    'Their stored hours were calculated with the current value. Choose an effective date after those records, ' +
                    'or reject them back for recalculation first.', 409, { code: 'SETTINGS_AFFECT_REVIEWED_RECORDS', blocking });
            }
        }

        if (updates.overtime_flat_rate_syp !== undefined) {
            // Informational: a Generated (not finalized) batch covering the date
            // keeps its snapshot until it is regenerated.
        }

        for (const [key, value] of Object.entries(updates)) {
            const [[currentRow]] = await connection.execute(
                'SELECT setting_value FROM system_settings WHERE setting_key = ? FOR UPDATE', [key]);
            const oldValue = currentRow ? currentRow.setting_value : (DEFAULT_SETTING_VALUES[key] ?? null);
            // The "current" value only changes when the new value is already in effect.
            if (effectiveFrom <= businessToday()) {
                await connection.execute(
                    `INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
                    [key, String(value)]
                );
            } else if (!currentRow && oldValue !== null) {
                await connection.execute('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [key, String(oldValue)]);
            }
            await settingsCache.recordSettingChange(connection, {
                key, oldValue, newValue: value, effectiveFrom, reason, userId: adminId,
            });
            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('system_settings', 0, 'UPDATE_SETTING', ?, ?, ?)`,
                [adminId, JSON.stringify({ [key]: oldValue }), JSON.stringify({ [key]: value, effective_from: effectiveFrom, reason })]
            );
        }

        await connection.commit();
        await settingsCache.refresh();

        // Explicit recalculation of Draft records on/after the date (new transaction).
        const recalculated = [];
        if (touchesHours) {
            const [drafts] = await db.execute(
                `SELECT attendance_id, total_working_hours, overtime_hours, standard_minutes_snapshot
                 FROM attendance WHERE status = 'Draft' AND record_date >= ?
                   AND check_in_time IS NOT NULL AND check_out_time IS NOT NULL`, [effectiveFrom]);
            for (const d of drafts) {
                const c = await db.getConnection();
                try {
                    await c.beginTransaction();
                    if (updates.standard_work_minutes !== undefined) {
                        await c.execute('UPDATE attendance SET standard_minutes_snapshot = NULL WHERE attendance_id = ? AND status = \'Draft\'', [d.attendance_id]);
                    }
                    const calc = await attendanceService.calculateWorkingHours(d.attendance_id, c);
                    await c.execute(
                        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                         VALUES ('attendance', ?, 'SETTINGS_RECALCULATED', ?, ?, ?)`,
                        [d.attendance_id, adminId,
                            JSON.stringify({ total_working_hours: d.total_working_hours, overtime_hours: d.overtime_hours, standard_minutes_snapshot: d.standard_minutes_snapshot }),
                            JSON.stringify({ total_working_hours: calc.regularHours, overtime_hours: calc.overtimeHours, effective_from: effectiveFrom, settings: updates })]
                    );
                    await c.commit();
                    recalculated.push(d.attendance_id);
                } catch (e) {
                    try { await c.rollback(); } catch (_) {}
                    console.error('SETTINGS RECALC ERROR', d.attendance_id, e.message);
                } finally {
                    c.release();
                }
            }
        }

        res.status(200).json({
            status: 'success',
            message: `Settings saved, effective from ${effectiveFrom}.` +
                (recalculated.length ? ` ${recalculated.length} Draft record(s) on/after that date were recalculated (audited).` : ''),
            effective_from: effectiveFrom,
            recalculated_draft_ids: recalculated,
        });
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        sendError(res, error, 'Internal server error while updating settings.');
    } finally {
        connection.release();
    }
};
