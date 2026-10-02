// controllers/staffAttendanceController.js
//
// STAFF attendance — Admin / Staff Supervisor review. Separate from worker
// attendance (table staff_attendance, own rules).
//
// (The old unrouted runBulkAttendance / bulkCheckIn / bulkCheckOut functions
// that wrote into the WORKER table were dead code and have been removed.)
const db = require('../config/db');
const { getAssignedStaffIdsForSupervisor } = require('./staffSupervisorAssignmentController');
const { assertStaffDateEditable } = require('../services/payrollLock');
const { isValidDateOnly } = require('../services/businessDate');

class AppError extends Error {
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

const STAFF_REVIEW_COLUMNS = `sa.staff_attendance_id, sa.staff_id, DATE_FORMAT(sa.record_date, '%Y-%m-%d') AS record_date,
        sa.attendance_status, sa.check_in_time, sa.check_out_time, sa.lunch_start_time, sa.lunch_end_time,
        sa.regular_hours, sa.overtime_hours, sa.lunch_deducted_hours, sa.is_friday_worked, sa.is_paid,
        sa.is_management_paid_absence, sa.status, sa.admin_rejection_notes, sa.source, sa.remarks,
        sa.anomaly_code, sa.anomaly_detail, sa.anomaly_ack_at, sa.anomaly_ack_note,
        sa.paid_decision_by_user_id, sa.paid_decision_at,
        sm.full_name, sm.staff_unique_id, s.site_name`;

// ==================== Admin review ====================

// GET /api/staff-attendance/pending
// Optional: status (Submitted|Rejected|Draft|Approved), date_from, date_to, q, anomaly=1, page, page_size
exports.getPendingStaffAttendance = async (req, res) => {
    try {
        const where = [];
        const params = [];
        if (['Submitted', 'Rejected', 'Draft', 'Approved'].includes(req.query.status)) {
            where.push('sa.status = ?'); params.push(req.query.status);
        } else {
            where.push("sa.status IN ('Submitted', 'Rejected')");
        }
        if (isValidDateOnly(req.query.date_from)) { where.push('sa.record_date >= ?'); params.push(req.query.date_from); }
        if (isValidDateOnly(req.query.date_to)) { where.push('sa.record_date <= ?'); params.push(req.query.date_to); }
        if (req.query.anomaly === '1') where.push('sa.anomaly_code IS NOT NULL');
        const q = String(req.query.q || '').trim();
        if (q) { where.push('(sm.full_name LIKE ? OR sm.staff_unique_id LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

        if (req.user.role === 'StaffSupervisor') {
            const assignedIds = await getAssignedStaffIdsForSupervisor(req.user.user_id);
            if (assignedIds.length === 0) {
                return res.status(200).json({ status: 'success', data: [], summary: { total: 0 } });
            }
            where.push(`sa.staff_id IN (${assignedIds.map(() => '?').join(',')})`);
            params.push(...assignedIds);
        }
        const base = `FROM staff_attendance sa
             JOIN staff_members sm ON sm.staff_id = sa.staff_id
             LEFT JOIN sites s ON s.site_id = sm.site_id
             WHERE ${where.join(' AND ')}`;
        const page = Number(req.query.page);
        const pageSize = Math.min(200, Math.max(10, Number(req.query.page_size) || 50));
        const limitSql = Number.isInteger(page) && page > 0 ? ` LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}` : '';
        const [rows] = await db.execute(`SELECT ${STAFF_REVIEW_COLUMNS} ${base} ORDER BY sa.record_date DESC, sm.full_name${limitSql}`, params);
        const [[summary]] = await db.execute(
            `SELECT COUNT(*) AS total, SUM(sa.status = 'Submitted') AS submitted, SUM(sa.status = 'Rejected') AS rejected,
                    SUM(sa.anomaly_code IS NOT NULL AND sa.anomaly_ack_at IS NULL) AS anomalies_open,
                    COUNT(DISTINCT sa.staff_id) AS staff, COUNT(DISTINCT sa.record_date) AS days ${base}`, params);
        return res.status(200).json({
            status: 'success',
            data: rows,
            summary: {
                total: Number(summary.total || 0), submitted: Number(summary.submitted || 0),
                rejected: Number(summary.rejected || 0), anomalies_open: Number(summary.anomalies_open || 0),
                staff: Number(summary.staff || 0), days: Number(summary.days || 0),
            },
            pagination: limitSql ? { page, page_size: pageSize, total: Number(summary.total || 0) } : null,
        });
    } catch (error) {
        return sendError(res, error, 'An error occurred while fetching pending records.');
    }
};

// POST /api/staff-attendance/review  { staff_attendance_id, status, admin_note, is_paid?, acknowledge_anomaly?, anomaly_note? }
// D-11: Sick is unpaid unless the reviewer explicitly sets is_paid = 1.
// D-09: flagged records need an explicit acknowledgement to be approved.
// D-02: no review inside a finalized/paid staff payroll period.
exports.reviewStaffAttendance = async (req, res) => {
    const { staff_attendance_id, status, admin_note, is_paid } = req.body;
    const adminId = req.user.user_id;

    if (!['Approved', 'Rejected'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'Status must be Approved or Rejected.' });
    }
    if (status === 'Rejected' && (!admin_note || !String(admin_note).trim())) {
        return res.status(400).json({ status: 'error', message: 'Rejection reason is required.' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            'SELECT * FROM staff_attendance WHERE staff_attendance_id = ? FOR UPDATE',
            [staff_attendance_id]
        );
        if (rows.length === 0) throw new AppError('Record not found.', 404);
        const record = rows[0];

        // Scope check: a StaffSupervisor may only review staff explicitly assigned to them.
        if (req.user.role === 'StaffSupervisor') {
            const assignedIds = await getAssignedStaffIdsForSupervisor(req.user.user_id, connection);
            if (!assignedIds.includes(record.staff_id)) {
                throw new AppError('You are not authorized to review this staff member\'s attendance.', 403);
            }
        }

        if (record.status !== 'Submitted') throw new AppError('Cannot review a record that is not in pending status.', 409);
        await assertStaffDateEditable(connection, record.record_date);

        let ackNote = null;
        if (status === 'Approved' && record.anomaly_code && !record.anomaly_ack_at) {
            ackNote = String(req.body.anomaly_note || '').trim();
            if (req.body.acknowledge_anomaly !== true || ackNote.length < 5) {
                throw new AppError(
                    `This record is flagged for review: ${record.anomaly_detail || record.anomaly_code}. Approve only with acknowledge_anomaly = true and a note, or reject / correct it.`,
                    409, { code: 'ANOMALY_ACK_REQUIRED', anomaly_detail: record.anomaly_detail });
            }
        }

        const explicitPaid = (is_paid === 0 || is_paid === 1 || is_paid === true || is_paid === false);
        let resolvedIsPaid;
        if (explicitPaid) resolvedIsPaid = (is_paid === 1 || is_paid === true) ? 1 : 0;
        else resolvedIsPaid = record.attendance_status === 'Sick' ? 0 : Number(record.is_paid);
        const paidChanged = resolvedIsPaid !== Number(record.is_paid);

        await connection.execute(
            `UPDATE staff_attendance
             SET status = ?, admin_rejection_notes = ?, approved_by_user_id = ?, approval_date = NOW(), is_paid = ?,
                 paid_decision_by_user_id = CASE WHEN ? THEN ? ELSE paid_decision_by_user_id END,
                 paid_decision_at = CASE WHEN ? THEN NOW() ELSE paid_decision_at END,
                 anomaly_ack_by_user_id = CASE WHEN ? IS NULL THEN anomaly_ack_by_user_id ELSE ? END,
                 anomaly_ack_at = CASE WHEN ? IS NULL THEN anomaly_ack_at ELSE NOW() END,
                 anomaly_ack_note = CASE WHEN ? IS NULL THEN anomaly_ack_note ELSE ? END
             WHERE staff_attendance_id = ? AND status = 'Submitted'`,
            [status, status === 'Rejected' ? admin_note : null, adminId, resolvedIsPaid,
                explicitPaid || paidChanged ? 1 : 0, adminId, explicitPaid || paidChanged ? 1 : 0,
                ackNote, adminId, ackNote, ackNote, ackNote, staff_attendance_id]
        );

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('staff_attendance', ?, ?, ?, ?, ?)`,
            [staff_attendance_id, status.toUpperCase(), adminId, JSON.stringify(record),
                JSON.stringify({ status, admin_note, is_paid: resolvedIsPaid, is_paid_explicit: explicitPaid, anomaly_ack_note: ackNote })]
        );

        await connection.commit();
        return res.status(200).json({ status: 'success', message: 'Request processed successfully.' });
    } catch (error) {
        await connection.rollback();
        return sendError(res, error, 'An error occurred while reviewing the record.');
    } finally {
        connection.release();
    }
};

// POST /api/staff-attendance/admin/:id/paid  { is_paid: 0|1, reason }
// D-11: explicit, audited "Mark as Paid / Unpaid" for Sick / Vacation /
// Holiday records (Approved or Submitted), outside finalized periods.
// Management-paid ABSENCES keep their own endpoint (staffAbsenceController).
exports.setPaidDecision = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const id = Number(req.params.id);
        const isPaid = req.body?.is_paid === 1 || req.body?.is_paid === true ? 1
            : (req.body?.is_paid === 0 || req.body?.is_paid === false ? 0 : null);
        const reason = String(req.body?.reason || '').trim();
        if (!Number.isInteger(id) || id <= 0) throw new AppError('Invalid id.');
        if (isPaid === null) throw new AppError('is_paid must be 0 or 1.');
        if (reason.length < 3) throw new AppError('A reason is required.');
        await connection.beginTransaction();
        const [[rec]] = await connection.execute('SELECT * FROM staff_attendance WHERE staff_attendance_id = ? FOR UPDATE', [id]);
        if (!rec) throw new AppError('Record not found.', 404);
        if (!['Sick', 'Vacation', 'Holiday'].includes(rec.attendance_status)) {
            throw new AppError('Mark as Paid applies to Sick, Vacation and Holiday records. Use "Management-paid absence" for Absent records.', 409);
        }
        if (!['Submitted', 'Approved'].includes(rec.status)) {
            throw new AppError(`Only Submitted or Approved records can be changed here (this one is ${rec.status}).`, 409);
        }
        await assertStaffDateEditable(connection, rec.record_date);
        await connection.execute(
            `UPDATE staff_attendance SET is_paid = ?, paid_decision_by_user_id = ?, paid_decision_at = NOW()
             WHERE staff_attendance_id = ?`, [isPaid, req.user.user_id, id]);
        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('staff_attendance', ?, ?, ?, ?, ?)`,
            [id, isPaid ? 'MARKED_PAID_LEAVE' : 'MARKED_UNPAID_LEAVE', req.user.user_id,
                JSON.stringify({ is_paid: rec.is_paid }), JSON.stringify({ is_paid: isPaid, reason })]);
        await connection.commit();
        return res.status(200).json({ status: 'success', message: isPaid ? 'Marked as paid.' : 'Marked as unpaid.' });
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        return sendError(res, error, 'Failed to update the paid decision.');
    } finally {
        connection.release();
    }
};

exports.getStaffAttendanceByDate = async (req, res) => {
    const { date } = req.query;
    if (!isValidDateOnly(date)) return res.status(400).json({ status: 'error', message: 'Please provide a valid date.' });
    try {
        let query = `SELECT ${STAFF_REVIEW_COLUMNS}
             FROM staff_attendance sa
             JOIN staff_members sm ON sm.staff_id = sa.staff_id
             LEFT JOIN sites s ON s.site_id = sm.site_id
             WHERE sa.record_date = ?`;
        const params = [date];

        if (req.user.role === 'StaffSupervisor') {
            const assignedIds = await getAssignedStaffIdsForSupervisor(req.user.user_id);
            if (assignedIds.length === 0) {
                return res.status(200).json({ status: 'success', data: [] });
            }
            query += ` AND sa.staff_id IN (${assignedIds.map(() => '?').join(',')})`;
            params.push(...assignedIds);
        }

        query += ' ORDER BY sm.full_name';
        const [rows] = await db.execute(query, params);
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        return sendError(res, error, 'An error occurred while fetching records.');
    }
};
