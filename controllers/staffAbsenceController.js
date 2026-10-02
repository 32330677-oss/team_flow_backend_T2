// controllers/staffAbsenceController.js
//
// Pre-payroll workflow: lets the Admin review Absent staff_attendance
// records for a period and explicitly grant "management-paid leave" for
// specific absence days (e.g. the staff member was out but management
// decided to pay that day anyway). This is intentionally kept separate
// from the generic `is_paid` flag (which defaults to 1 and covers paid
// leave types like Sick/Vacation/Holiday) — Absent days must stay unpaid
// unless an Admin explicitly flags them here, which is why a dedicated
// `is_management_paid_absence` column (default 0) is used instead of
// reusing `is_paid`.
//
// Wire into routes/staffAttendanceRoutes.js:
//   const staffAbsenceController = require('../controllers/staffAbsenceController');
//   router.get('/admin/absences', restrictTo('Admin'), staffAbsenceController.getAbsenceSummary);
//   router.post('/admin/absences/mark-paid', restrictTo('Admin'), staffAbsenceController.markAbsencesPaid);
//   router.post('/admin/absences/unmark-paid', restrictTo('Admin'), staffAbsenceController.unmarkAbsencePaid);

const db = require('../config/db');
const { findLockedStaffBatch } = require('../services/payrollLock');
const { getActiveSpansOverlapping } = require('../services/staffEmploymentService');

function isValidDateOnly(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function normalizeIds(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

// GET /api/staff-attendance/admin/absences?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
// Returns, per staff member, every Approved Absent day in the period so
// the Admin can decide which ones (if any) to pay as management leave
// before generating payroll.
exports.getAbsenceSummary = async (req, res) => {
    const { start_date, end_date } = req.query;
    if (!isValidDateOnly(start_date) || !isValidDateOnly(end_date)) {
        return res.status(400).json({ status: 'error', message: 'A valid start_date and end_date (YYYY-MM-DD) are required.' });
    }
    if (end_date < start_date) {
        return res.status(400).json({ status: 'error', message: 'end_date must be after or equal to start_date.' });
    }

    try {
        const [rows] = await db.execute(
            `SELECT sa.staff_attendance_id, sa.record_date, sa.is_management_paid_absence,
                    sa.management_paid_reason, sa.management_paid_at,
                    u.full_name AS management_paid_by_name,
                    sm.staff_id, sm.staff_unique_id, sm.full_name, sm.position
             FROM staff_attendance sa
             JOIN staff_members sm ON sm.staff_id = sa.staff_id
             LEFT JOIN users u ON u.user_id = sa.management_paid_by_user_id
             WHERE sa.attendance_status = 'Absent'
               AND sa.status = 'Approved'
               AND sa.record_date BETWEEN ? AND ?
             ORDER BY sm.full_name, sa.record_date`,
            [start_date, end_date]
        );

        const byStaff = new Map();
        for (const row of rows) {
            const employedSpans = await getActiveSpansOverlapping(
                row.staff_id,
                start_date,
                end_date
            );
            const recordDate = String(row.record_date).slice(0, 10);
            const employedOnRecordDate = employedSpans.some((span) =>
                recordDate >= span.start && (!span.end || recordDate <= span.end)
            );
            if (!employedOnRecordDate) continue;

            if (!byStaff.has(row.staff_id)) {
                byStaff.set(row.staff_id, {
                    staff_id: row.staff_id,
                    staff_unique_id: row.staff_unique_id,
                    full_name: row.full_name,
                    position: row.position,
                    total_absences: 0,
                    paid_count: 0,
                    unpaid_count: 0,
                    absences: [],
                });
            }
            const entry = byStaff.get(row.staff_id);
            const isPaid = Number(row.is_management_paid_absence) === 1;
            entry.total_absences += 1;
            if (isPaid) entry.paid_count += 1; else entry.unpaid_count += 1;
            entry.absences.push({
                staff_attendance_id: row.staff_attendance_id,
                record_date: row.record_date,
                is_management_paid_absence: isPaid,
                management_paid_reason: row.management_paid_reason,
                management_paid_at: row.management_paid_at,
                management_paid_by_name: row.management_paid_by_name,
            });
        }

        return res.status(200).json({ status: 'success', data: [...byStaff.values()] });
    } catch (error) {
        console.error('GET ABSENCE SUMMARY ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to load absence summary.' });
    }
};

// POST /api/staff-attendance/admin/absences/mark-paid
// body: { staff_attendance_ids: number[], reason: string }
// Grants management-paid leave for the given Absent days. Only Approved
// Absent records are eligible, since only Approved records feed payroll.
exports.markAbsencesPaid = async (req, res) => {
    const ids = normalizeIds(req.body?.staff_attendance_ids);
    const reason = String(req.body?.reason || '').trim();
    const adminId = req.user.user_id;

    if (ids.length === 0) {
        return res.status(400).json({ status: 'error', message: 'At least one attendance record must be selected.' });
    }
    if (!reason) {
        return res.status(400).json({ status: 'error', message: 'A reason is required to grant management-paid leave.' });
    }

    const connection = await db.getConnection();
    const updated = [];
    const skipped = [];
    try {
        await connection.beginTransaction();

        for (const id of ids) {
            const [rows] = await connection.execute(
                `SELECT staff_attendance_id, staff_id, attendance_status, status, is_management_paid_absence
                 FROM staff_attendance WHERE staff_attendance_id = ? FOR UPDATE`,
                [id]
            );
            if (rows.length === 0) {
                skipped.push({ staff_attendance_id: id, reason: 'Record not found.' });
                continue;
            }
            const record = rows[0];
            if (record.attendance_status !== 'Absent' || record.status !== 'Approved') {
                skipped.push({ staff_attendance_id: id, reason: 'Only approved Absent records can be granted management-paid leave.' });
                continue;
            }
            if (Number(record.is_management_paid_absence) === 1) {
                skipped.push({ staff_attendance_id: id, reason: 'Already marked as management-paid.' });
                continue;
            }
            const [[dateRow]] = await connection.execute('SELECT record_date FROM staff_attendance WHERE staff_attendance_id = ?', [id]);
            if (await findLockedStaffBatch(connection, { date: String(dateRow.record_date).slice(0, 10) })) {
                skipped.push({ staff_attendance_id: id, reason: 'The date is inside a finalized/paid staff payroll period (use Correct attendance).' });
                continue;
            }

            await connection.execute(
                `UPDATE staff_attendance
                 SET is_management_paid_absence = 1, management_paid_reason = ?,
                     management_paid_by_user_id = ?, management_paid_at = NOW()
                 WHERE staff_attendance_id = ?`,
                [reason, adminId, id]
            );

            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('staff_attendance', ?, 'MANAGEMENT_LEAVE_GRANTED', ?, ?, ?)`,
                [id, adminId, JSON.stringify({ is_management_paid_absence: false }), JSON.stringify({ is_management_paid_absence: true, reason })]
            );

            updated.push(id);
        }

        await connection.commit();
        return res.status(200).json({
            status: 'success',
            message: `${updated.length} absence day(s) marked as management-paid.`,
            data: { updated, skipped },
        });
    } catch (error) {
        await connection.rollback();
        console.error('MARK ABSENCES PAID ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to update absence records.' });
    } finally {
        connection.release();
    }
};

// POST /api/staff-attendance/admin/absences/unmark-paid
// body: { staff_attendance_ids: number[] }
// Reverts a previously granted management-paid absence back to unpaid.
exports.unmarkAbsencePaid = async (req, res) => {
    const ids = normalizeIds(req.body?.staff_attendance_ids);
    const adminId = req.user.user_id;

    if (ids.length === 0) {
        return res.status(400).json({ status: 'error', message: 'At least one attendance record must be selected.' });
    }

    const connection = await db.getConnection();
    const updated = [];
    const skipped = [];
    try {
        await connection.beginTransaction();

        for (const id of ids) {
            const [rows] = await connection.execute(
                `SELECT staff_attendance_id, attendance_status, status, is_management_paid_absence
                 FROM staff_attendance WHERE staff_attendance_id = ? FOR UPDATE`,
                [id]
            );
            if (rows.length === 0) {
                skipped.push({ staff_attendance_id: id, reason: 'Record not found.' });
                continue;
            }
            const record = rows[0];
            if (Number(record.is_management_paid_absence) !== 1) {
                skipped.push({ staff_attendance_id: id, reason: 'Record is not currently management-paid.' });
                continue;
            }
            const [[dateRow2]] = await connection.execute('SELECT record_date FROM staff_attendance WHERE staff_attendance_id = ?', [id]);
            if (await findLockedStaffBatch(connection, { date: String(dateRow2.record_date).slice(0, 10) })) {
                skipped.push({ staff_attendance_id: id, reason: 'The date is inside a finalized/paid staff payroll period (use Correct attendance).' });
                continue;
            }

            await connection.execute(
                `UPDATE staff_attendance
                 SET is_management_paid_absence = 0, management_paid_reason = NULL,
                     management_paid_by_user_id = NULL, management_paid_at = NULL
                 WHERE staff_attendance_id = ?`,
                [id]
            );

            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('staff_attendance', ?, 'MANAGEMENT_LEAVE_REVOKED', ?, ?, ?)`,
                [id, adminId, JSON.stringify({ is_management_paid_absence: true }), JSON.stringify({ is_management_paid_absence: false })]
            );

            updated.push(id);
        }

        await connection.commit();
        return res.status(200).json({
            status: 'success',
            message: `${updated.length} absence day(s) reverted to unpaid.`,
            data: { updated, skipped },
        });
    } catch (error) {
        await connection.rollback();
        console.error('UNMARK ABSENCE PAID ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to update absence records.' });
    } finally {
        connection.release();
    }
};
