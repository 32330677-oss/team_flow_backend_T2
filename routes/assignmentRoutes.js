// routes/assignmentRoutes.js
//
// Worker site/shift assignments.
//
// Date semantics (services/assignmentDates.js, requirements §5/D-01):
//   assigned_date   = first assigned day (inclusive)
//   unassigned_date = LAST assigned day (inclusive)
//
// Endpoints
//   GET    /api/assignments                     current assignments (open or ending today/later)
//   GET    /api/assignments/worker/:workerId    full history of one worker (Admin)
//   POST   /api/assignments                     create (date-range overlap checked, audited)
//   POST   /api/assignments/:id/end             End Assignment: { last_day, reason }
//   POST   /api/assignments/:id/transfer        Direct Transfer: { transfer_date, target_site_id,
//                                               target_shift_type, reason } — one transaction
//   DELETE /api/assignments/:id                 kept for old clients: same as /end, requires last_day
const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { businessToday, isValidDateOnly, addDays } = require('../services/businessDate');
const { activeOn, currentOrFuture, overlaps } = require('../services/assignmentDates');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

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
        return res.status(error.statusCode || 400).json({ status: 'fail', message: error.message, ...(error.extra || {}) });
    }
    console.error(fallback, error);
    return res.status(500).json({ status: 'error', message: fallback });
}
function normalizeShift(value) {
    return ['Day', 'Night'].includes(value) ? value : 'Day';
}
function requireText(value, name, min = 3) {
    const text = String(value ?? '').trim();
    if (text.length < min) throw new OpError(`${name} is required (at least ${min} characters).`);
    return text.slice(0, 500);
}

// R-13: a target site must exist, be Active, and support the requested shift.
async function validateTargetSite(executor, siteId, shiftType) {
    const [[site]] = await executor.execute(
        'SELECT site_id, site_name, site_status, supports_shifts, contract_id FROM sites WHERE site_id = ? LIMIT 1', [siteId]);
    if (!site) throw new OpError('Site not found.', 404);
    if (site.site_status !== 'Active') throw new OpError(`Site "${site.site_name}" is ${site.site_status}; workers can only be assigned to Active sites.`, 409);
    if (shiftType === 'Night' && Number(site.supports_shifts) !== 1) {
        throw new OpError(`Site "${site.site_name}" does not support shifts; only Day assignments are possible.`, 409);
    }
    return site;
}

// C-16: overlap with ANY assignment of the worker (open or closed) in the date
// range. One worker has one assignment per day (business rule: one active
// assignment), including Day/Night of the same site.
async function findOverlaps(executor, workerId, fromDate, toDate, excludeId = null) {
    const params = [workerId, fromDate, toDate];
    let exclusion = '';
    if (excludeId) { exclusion = ' AND wsa.assignment_id <> ?'; params.push(excludeId); }
    const [rows] = await executor.execute(
        `SELECT wsa.assignment_id, wsa.site_id, s.site_name, wsa.shift_type,
                DATE_FORMAT(wsa.assigned_date, '%Y-%m-%d') AS assigned_date,
                DATE_FORMAT(wsa.unassigned_date, '%Y-%m-%d') AS last_day
         FROM workersiteassignments wsa JOIN sites s ON s.site_id = wsa.site_id
         WHERE wsa.worker_id = ? AND ${overlaps('wsa', '?', '?')}${exclusion}
         FOR UPDATE`,
        params
    );
    return rows;
}

async function audit(executor, recordId, action, userId, oldValues, newValues) {
    await executor.execute(
        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
         VALUES ('workersiteassignments', ?, ?, ?, ?, ?)`,
        [recordId, action, userId, oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null]
    );
}

// 1. Current assignments. Supervisors only see assignments of the sites/shifts
//    they supervise (D-07, least privilege).
router.get('/', authMiddleware, restrictTo('Admin', 'Supervisor'), async (req, res) => {
    const today = businessToday();
    const params = [today];
    let scope = '';
    if (req.user.role === 'Supervisor') {
        scope = ` AND ((s.supports_shifts = 0 AND s.supervisor_id = ?)
                   OR (s.supports_shifts = 1 AND EXISTS (SELECT 1 FROM site_shifts ss
                        WHERE ss.site_id = wsa.site_id AND ss.shift_type = wsa.shift_type AND ss.supervisor_id = ?)))`;
        params.push(req.user.user_id, req.user.user_id);
    }
    try {
        const [results] = await db.execute(
            `SELECT wsa.assignment_id, wsa.worker_id, w.full_name AS worker_name, w.worker_unique_id,
                    wsa.site_id, wsa.shift_type, s.site_name AS project_name, s.site_name, s.supports_shifts,
                    DATE_FORMAT(wsa.assigned_date, '%Y-%m-%d') AS start_date,
                    DATE_FORMAT(wsa.unassigned_date, '%Y-%m-%d') AS last_day
             FROM workersiteassignments wsa
             JOIN workers w ON wsa.worker_id = w.worker_id
             JOIN sites s ON wsa.site_id = s.site_id
             WHERE ${currentOrFuture('wsa', '?')}${scope}
             ORDER BY s.site_name, wsa.shift_type, w.full_name`,
            params
        );
        res.status(200).json({ status: 'success', data: results, business_today: today });
    } catch (err) {
        sendError(res, err, 'Failed to load assignments.');
    }
});

// 1b. Assignment history of a worker (historical vs current distinction in the UI).
router.get('/worker/:workerId', authMiddleware, restrictTo('Admin'), async (req, res) => {
    try {
        const workerId = Number(req.params.workerId);
        if (!Number.isInteger(workerId) || workerId <= 0) throw new OpError('Invalid worker id.');
        const [rows] = await db.execute(
            `SELECT wsa.assignment_id, wsa.site_id, s.site_name, wsa.shift_type,
                    DATE_FORMAT(wsa.assigned_date, '%Y-%m-%d') AS assigned_date,
                    DATE_FORMAT(wsa.unassigned_date, '%Y-%m-%d') AS last_day,
                    wsa.end_reason, wsa.ended_at, eu.full_name AS ended_by, au.full_name AS assigned_by,
                    (wsa.unassigned_date IS NOT NULL AND wsa.unassigned_date < wsa.assigned_date) AS cancelled
             FROM workersiteassignments wsa
             JOIN sites s ON s.site_id = wsa.site_id
             LEFT JOIN users eu ON eu.user_id = wsa.ended_by_user_id
             LEFT JOIN users au ON au.user_id = wsa.assigned_by_user_id
             WHERE wsa.worker_id = ?
             ORDER BY wsa.assigned_date DESC, wsa.assignment_id DESC`,
            [workerId]
        );
        const [transfers] = await db.execute(
            `SELECT t.request_id, t.transfer_type, t.status, DATE_FORMAT(t.effective_date, '%Y-%m-%d') AS effective_date,
                    cs.site_name AS from_site, t.current_shift_type AS from_shift,
                    ts.site_name AS to_site, t.target_shift_type AS to_shift,
                    t.request_reason, t.admin_notes, u.full_name AS requested_by, ru.full_name AS reviewed_by, t.reviewed_at
             FROM worker_transfer_requests t
             JOIN sites cs ON cs.site_id = t.current_site_id
             JOIN sites ts ON ts.site_id = t.target_site_id
             JOIN users u ON u.user_id = t.requested_by_user_id
             LEFT JOIN users ru ON ru.user_id = t.reviewed_by_user_id
             WHERE t.worker_id = ? ORDER BY t.created_at DESC`,
            [workerId]
        );
        res.status(200).json({ status: 'success', data: rows, transfers, business_today: businessToday() });
    } catch (err) {
        sendError(res, err, 'Failed to load the assignment history.');
    }
});

// Shared End Assignment logic (selected date = LAST assigned day).
async function endAssignment(connection, { assignmentId, lastDay, reason, userId }) {
    const [[a]] = await connection.execute(
        `SELECT assignment_id, worker_id, site_id, shift_type,
                DATE_FORMAT(assigned_date, '%Y-%m-%d') AS assigned_date,
                DATE_FORMAT(unassigned_date, '%Y-%m-%d') AS unassigned_date
         FROM workersiteassignments WHERE assignment_id = ? FOR UPDATE`, [assignmentId]);
    if (!a) throw new OpError('Assignment not found.', 404);
    if (a.unassigned_date !== null && a.unassigned_date < businessToday()) {
        throw new OpError(`This assignment already ended on ${a.unassigned_date}.`, 409);
    }
    if (lastDay < addDays(a.assigned_date, -1)) {
        throw new OpError(`The last day cannot be before the assignment start (${a.assigned_date}).`);
    }
    if (a.unassigned_date !== null && lastDay > a.unassigned_date) {
        throw new OpError(`The assignment already ends on ${a.unassigned_date}; it cannot be extended here.`, 409);
    }
    // Attendance AFTER the last day at this site/shift would become orphaned
    // (it blocks payroll). Refuse and list it.
    const [conflicts] = await connection.execute(
        `SELECT attendance_id, DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date, status, source
         FROM attendance WHERE worker_id = ? AND site_id = ? AND shift_type = ? AND record_date > ?
         ORDER BY record_date`,
        [a.worker_id, a.site_id, a.shift_type, lastDay]
    );
    if (conflicts.length > 0) {
        throw new OpError(
            `The worker has ${conflicts.length} attendance record(s) at this site/shift after ${lastDay} ` +
            `(${conflicts.slice(0, 5).map((c) => c.record_date).join(', ')}). Choose a later last day or correct those records first.`,
            409, { conflicts });
    }
    await connection.execute(
        `UPDATE workersiteassignments
         SET unassigned_date = ?, ended_by_user_id = ?, ended_at = NOW(), end_reason = ?, updated_at = NOW()
         WHERE assignment_id = ?`,
        [lastDay, userId, reason, assignmentId]
    );
    await audit(connection, assignmentId, 'ASSIGNMENT_ENDED', userId,
        { unassigned_date: a.unassigned_date, site_id: a.site_id, shift_type: a.shift_type },
        { last_day: lastDay, first_day_outside: addDays(lastDay, 1), reason });
    return a;
}

// 2. End Assignment — the selected date is the LAST day the worker is assigned.
async function handleEnd(req, res) {
    const connection = await db.getConnection();
    try {
        const assignmentId = Number(req.params.assignment_id);
        const lastDay = req.body?.last_day;
        if (!isValidDateOnly(lastDay)) throw new OpError('last_day (YYYY-MM-DD) is required: the LAST day the worker is assigned to this site.');
        const reason = requireText(req.body?.reason, 'reason');
        await connection.beginTransaction();
        await endAssignment(connection, { assignmentId, lastDay, reason, userId: req.user.user_id });
        await connection.commit();
        res.status(200).json({
            status: 'success',
            message: `Assignment ended. ${lastDay} is the last assigned day; the worker is outside this assignment from ${addDays(lastDay, 1)}.`,
        });
    } catch (err) {
        try { await connection.rollback(); } catch (_) {}
        sendError(res, err, 'An error occurred while ending the assignment.');
    } finally {
        connection.release();
    }
}
router.post('/:assignment_id/end', authMiddleware, restrictTo('Admin'), handleEnd);
router.delete('/:assignment_id', authMiddleware, restrictTo('Admin'), handleEnd);

// 3. Create assignment (date-range overlap check, site validation, audit).
router.post('/', authMiddleware, restrictTo('Admin'), async (req, res) => {
    const { worker_id, site_id } = req.body;
    const shift_type = normalizeShift(req.body.shift_type);
    const connection = await db.getConnection();
    try {
        if (!worker_id || !site_id) throw new OpError('Required fields are missing');
        const assignedDate = req.body.assigned_date ? String(req.body.assigned_date).trim() : businessToday();
        if (!isValidDateOnly(assignedDate)) throw new OpError('Invalid assigned_date format (YYYY-MM-DD).');
        if (assignedDate > businessToday()) throw new OpError('assigned_date cannot be a future date.');

        await connection.beginTransaction();
        const [[worker]] = await connection.execute(
            `SELECT worker_id, status, DATE_FORMAT(hire_date, '%Y-%m-%d') AS hire_date FROM workers WHERE worker_id = ? FOR UPDATE`, [worker_id]);
        if (!worker) throw new OpError('Worker not found.', 404);
        if (worker.hire_date && assignedDate < worker.hire_date) {
            throw new OpError(`Assignment date (${assignedDate}) cannot be earlier than the worker's hire date (${worker.hire_date}).`);
        }
        const site = await validateTargetSite(connection, site_id, shift_type);
        const overlapping = await findOverlaps(connection, worker_id, assignedDate, null);
        if (overlapping.length > 0) {
            const o = overlapping[0];
            throw new OpError(
                `This worker is already assigned to "${o.site_name}" (${o.shift_type}) from ${o.assigned_date}` +
                `${o.last_day ? ` to ${o.last_day}` : ' (open)'}, which overlaps ${assignedDate}. End that assignment first, or use Transfer.`,
                400, { conflicts: overlapping, current_site_id: o.site_id, current_shift_type: o.shift_type, current_site_name: o.site_name });
        }
        const [result] = await connection.execute(
            `INSERT INTO workersiteassignments
             (worker_id, site_id, contract_id, assigned_by_user_id, assigned_date, shift_type, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [worker_id, site_id, site.contract_id, req.user.user_id, assignedDate, shift_type]
        );
        await audit(connection, result.insertId, 'ASSIGNMENT_CREATED', req.user.user_id, null,
            { worker_id, site_id, shift_type, assigned_date: assignedDate });
        await connection.commit();
        res.status(201).json({ status: 'success', data: { assignment_id: result.insertId, shift_type } });
    } catch (err) {
        try { await connection.rollback(); } catch (_) {}
        sendError(res, err, 'An error occurred on the server while saving the assignment.');
    } finally {
        connection.release();
    }
});

// 4. Direct Transfer (D-01): transfer_date = FIRST day at the new site; the old
//    assignment ends the previous day. Validate -> close old -> open new ->
//    record the transfer + audit, all in ONE transaction. No approval workflow.
router.post('/:assignment_id/transfer', authMiddleware, restrictTo('Admin'), async (req, res) => {
    const connection = await db.getConnection();
    try {
        const assignmentId = Number(req.params.assignment_id);
        const transferDate = req.body?.transfer_date;
        const targetSiteId = Number(req.body?.target_site_id);
        const targetShift = normalizeShift(req.body?.target_shift_type);
        if (!isValidDateOnly(transferDate)) throw new OpError('transfer_date (YYYY-MM-DD) is required: the FIRST day at the new site.');
        if (!Number.isInteger(targetSiteId) || targetSiteId <= 0) throw new OpError('target_site_id is required.');
        const reason = requireText(req.body?.reason, 'reason');
        const userId = req.user.user_id;

        await connection.beginTransaction();
        const [[a]] = await connection.execute(
            `SELECT assignment_id, worker_id, site_id, shift_type, DATE_FORMAT(assigned_date, '%Y-%m-%d') AS assigned_date
             FROM workersiteassignments WHERE assignment_id = ? FOR UPDATE`, [assignmentId]);
        if (!a) throw new OpError('Assignment not found.', 404);
        if (a.site_id === targetSiteId && a.shift_type === targetShift) {
            throw new OpError('The target site/shift is the same as the current one.');
        }
        if (transferDate <= a.assigned_date) {
            throw new OpError(`transfer_date must be after the current assignment start (${a.assigned_date}).`, 409);
        }
        const site = await validateTargetSite(connection, targetSiteId, targetShift);
        const lastDay = addDays(transferDate, -1);
        await endAssignment(connection, { assignmentId, lastDay, reason: `Direct transfer: ${reason}`, userId });

        const overlapping = await findOverlaps(connection, a.worker_id, transferDate, null, assignmentId);
        if (overlapping.length > 0) {
            throw new OpError('The worker already has an assignment that overlaps the transfer date.', 409, { conflicts: overlapping });
        }
        const [ins] = await connection.execute(
            `INSERT INTO workersiteassignments
             (worker_id, site_id, contract_id, assigned_by_user_id, assigned_date, shift_type, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [a.worker_id, targetSiteId, site.contract_id, userId, transferDate, targetShift]
        );
        const [tr] = await connection.execute(
            `INSERT INTO worker_transfer_requests
               (worker_id, current_site_id, current_shift_type, target_site_id, target_shift_type,
                requested_by_user_id, status, request_reason, effective_date, transfer_type,
                reviewed_by_user_id, reviewed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'Approved', ?, ?, 'Direct', ?, NOW(), NOW(), NOW())`,
            [a.worker_id, a.site_id, a.shift_type, targetSiteId, targetShift, userId, reason, transferDate, userId]
        );
        await audit(connection, ins.insertId, 'DIRECT_TRANSFER', userId,
            { assignment_id: assignmentId, site_id: a.site_id, shift_type: a.shift_type, last_day: lastDay },
            { assignment_id: ins.insertId, site_id: targetSiteId, shift_type: targetShift, first_day: transferDate, reason, transfer_record_id: tr.insertId });
        await connection.commit();
        res.status(200).json({
            status: 'success',
            message: `Worker transferred. Last day at the old site: ${lastDay}. First day at "${site.site_name}" (${targetShift}): ${transferDate}.`,
            data: { old_assignment_id: assignmentId, new_assignment_id: ins.insertId, transfer_record_id: tr.insertId },
        });
    } catch (err) {
        try { await connection.rollback(); } catch (_) {}
        sendError(res, err, 'An error occurred while transferring the worker.');
    } finally {
        connection.release();
    }
});

module.exports = router;
module.exports._internal = { findOverlaps, validateTargetSite, endAssignment, activeOn };
