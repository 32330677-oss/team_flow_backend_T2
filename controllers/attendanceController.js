const db = require('../config/db');
const attendanceService = require('../services/attendanceService');
const settingsCache = require('../services/settingsCache');
const { activeOn } = require('../services/assignmentDates');
const { assertWorkerDateEditable, findLockedWorkerBatch } = require('../services/payrollLock');
const { getWorkerStatusOnDate, getActiveWorkerIdsOnDate } = require('../services/workerStatusService');
const weekGate = require('../services/weekGate');
const { addDays } = require('../services/businessDate');
class AppError extends Error {
    constructor(message, statusCode = 400, extra = null) {
        super(message);
        this.isOperational = true;
        this.statusCode = statusCode;
        this.extra = extra;
    }
}

// Uniform JSON error reply for operational errors (incl. payroll lock 409 and
// previous-week gate 409, which carry a machine-readable code).
function sendOpError(res, error, fallbackMessage) {
    if (error && error.isOperational) {
        return res.status(error.statusCode || 400).json({
            status: 'error',
            ...(error.code ? { code: error.code } : {}),
            message: error.message,
            ...(error.extra || {}),
        });
    }
    return res.status(500).json({ status: 'error', message: fallbackMessage });
}

// Business "now" as a wall-clock string (Asia/Beirut by default), used to
// refuse check-out / break times in the future (R-06).
function businessNowWall() {
    const timeZone = process.env.APP_TIME_ZONE || 'Asia/Beirut';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
    const v = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${v.year}-${v.month}-${v.day} ${v.hour}:${v.minute}:${v.second}`;
}

// A clock time may not be later than "now" (small tolerance for device clocks).
function assertNotFutureTime(wall, label) {
    const nowPlus = addMinutesWall(businessNowWall(), 5);
    if (wall && wall > nowPlus) {
        throw new AppError(`${label} cannot be in the future (${wall}).`);
    }
}
function addMinutesWall(wall, minutes) {
    const [d, t] = wall.split(' ');
    const [y, mo, da] = d.split('-').map(Number);
    const [h, mi, se] = t.split(':').map(Number);
    const x = new Date(Date.UTC(y, mo - 1, da, h, mi + minutes, se));
    const pad = (n) => String(n).padStart(2, '0');
    return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}:${pad(x.getUTCSeconds())}`;
}

// §9: an attendance DATE may never be in the future. (A Night Shift OUT on the
// next calendar day is still allowed: only record_date is checked here.)
function assertNotFutureDate(recordDate) {
    if (String(recordDate).slice(0, 10) > businessTodayDateOnly()) {
        throw new AppError('Attendance cannot be recorded for a future date. A night shift is recorded on the date it started.');
    }
}

function isValidDateOnly(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const [year, month, day] = String(value).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;
}

function requireRecordDate(value) {
    if (!isValidDateOnly(value)) throw new AppError('A valid record_date (YYYY-MM-DD) is required.');
    return String(value);
}

function businessTodayDateOnly() {
    const timeZone = process.env.APP_TIME_ZONE || 'Asia/Beirut';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
}

const SUPERVISOR_ALLOWED_LEAVE_TYPES = ['Rest', 'Lunch'];
function formatToMySqlDateTime(value) {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(String(value));
    if (!match) return null;

    const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00'] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);

    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;

    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (Number.isNaN(date.getTime())) return null;
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day || date.getUTCHours() !== hour ||
        date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;

    const pad = (n) => String(n).padStart(2, '0');
    return `${yearText}-${monthText}-${dayText} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

function normalizeShift(value) {
    return ['Day', 'Night'].includes(value) ? value : 'Day';
}

// ------------------------------------------------------------
// استبدل getAttendanceId
// ------------------------------------------------------------
async function getAttendanceId(worker_id, site_id, shift_type, recordDate, executor = db, forUpdate = false) {
    const lock = forUpdate ? ' FOR UPDATE' : '';
    const [rows] = await executor.execute(
        `SELECT attendance_id FROM attendance
         WHERE worker_id = ? AND site_id = ? AND shift_type = ?
           AND record_date BETWEEN DATE_SUB(?, INTERVAL 1 DAY) AND ?
           AND check_in_time IS NOT NULL AND check_out_time IS NULL
           AND status = 'Draft'
         ORDER BY check_in_time DESC, attendance_id DESC LIMIT 1${lock}`,
        [worker_id, site_id, shift_type, recordDate, recordDate]
    );
    return rows.length > 0 ? rows[0].attendance_id : null;
}

async function verifySupervisorSite(userId, siteId, shiftType = 'Day') {
    const [rows] = await db.execute(
        `SELECT 1 FROM site_shifts WHERE site_id = ? AND shift_type = ? AND supervisor_id = ?
         UNION
         SELECT 1 FROM sites WHERE site_id = ? AND supervisor_id = ? AND supports_shifts = 0
         LIMIT 1`,
        [siteId, shiftType, userId, siteId, userId]
    );
    return rows.length > 0;
}

// C-12: assignment on the record date (inclusive last day) AND the worker's
// HISTORICAL status on that date (worker_status_history), never today's status.
async function verifyWorkerAssignedToSite(workerId, siteId, shiftType, recordDate = null, executor = db) {
    const effectiveDate = String(recordDate || businessTodayDateOnly()).slice(0, 10);
    const [rows] = await executor.execute(
        `SELECT 1
         FROM workersiteassignments wsa
         WHERE wsa.worker_id = ?
           AND wsa.site_id = ?
           AND wsa.shift_type = ?
           AND ${activeOn('wsa')}
         LIMIT 1`,
        [workerId, siteId, shiftType, effectiveDate, effectiveDate]
    );
    if (rows.length === 0) return false;
    const status = await getWorkerStatusOnDate(workerId, effectiveDate, executor);
    return status.status === 'Active';
}
async function verifySiteAction(req, siteId, shiftType = 'Day') {
    if (req.user.role === 'Admin') return true;
    return verifySupervisorSite(req.user.user_id, siteId, shiftType);
}

exports.getSiteWorkers = async (req, res) => {
    try {
        const { siteId } = req.params;
        const recordDate = requireRecordDate(req.query.record_date);
        const shiftType = normalizeShift(req.query.shift_type);
        const supervisor_id = req.user.user_id;

        if (req.user.role !== 'Admin') {
            const isAuthorized = await verifySupervisorSite(supervisor_id, siteId, shiftType);
            if (!isAuthorized) {
                return res.status(403).json({ status: 'error', message: 'You are not authorized to access this site\'s data.' });
            }
        }

        // D-07: operational projection only (no rates, no personal/identity data).
        // C-12: assignment on the date (inclusive last day); the historical
        // status filter is applied below in JS (worker_status_history).
        const query = `
            SELECT DISTINCT w.worker_id, w.worker_unique_id, w.full_name, w.job_position,
                   wsa.assignment_id, wsa.shift_type AS assignment_shift_type,
                   DATE_FORMAT(wsa.assigned_date, '%Y-%m-%d') AS assigned_date,
                   DATE_FORMAT(wsa.unassigned_date, '%Y-%m-%d') AS assignment_last_day,
                   a.attendance_id,
                   DATE_FORMAT(a.record_date, '%Y-%m-%d') AS attendance_record_date,
                   a.status AS workflow_status,
                   a.attendance_status,
                   a.check_in_time,
                   a.check_out_time,
                   a.total_working_hours,
                   a.overtime_hours,
                   a.management_leave_hours,
                   a.source AS attendance_source,
                   a.anomaly_code,
                   a.anomaly_detail,
                   a.admin_rejection_notes,
                   a.remarks AS attendance_remarks,
                   (SELECT leave_id
                    FROM attendanceleaveperiods alp
                    WHERE alp.attendance_id = a.attendance_id
                      AND alp.leave_end_time IS NULL
                    ORDER BY alp.leave_id DESC
                    LIMIT 1) AS current_leave_id,
                   (SELECT leave_type
                    FROM attendanceleaveperiods alp
                    WHERE alp.attendance_id = a.attendance_id
                      AND alp.leave_end_time IS NULL
                    ORDER BY alp.leave_id DESC
                    LIMIT 1) AS current_leave_type,
                   (SELECT COUNT(*) FROM attendanceleaveperiods alp
                    WHERE alp.attendance_id = a.attendance_id AND alp.leave_type = 'Lunch') AS lunch_count
            FROM workers w
            JOIN workersiteassignments wsa ON w.worker_id = wsa.worker_id AND wsa.shift_type = ?
            LEFT JOIN attendance a ON a.attendance_id = (
                SELECT a2.attendance_id
                FROM attendance a2
                WHERE a2.worker_id = w.worker_id
                  AND a2.site_id = ?
                  AND a2.shift_type = ?
                  AND (a2.record_date = ?
                       OR (a2.status = 'Draft' AND a2.check_in_time IS NOT NULL AND a2.check_out_time IS NULL
                           AND a2.record_date = DATE_SUB(?, INTERVAL 1 DAY)))
                ORDER BY (a2.record_date = ?) DESC, a2.attendance_id DESC
                LIMIT 1
            )
            WHERE wsa.site_id = ?
            AND ${activeOn('wsa')}
            ORDER BY w.full_name
        `;

        const [rows] = await db.execute(query, [
            shiftType, siteId, shiftType, recordDate, recordDate, recordDate,
            siteId, recordDate, recordDate,
        ]);
        // Worker active on that date, OR already has a record to show/correct.
        const activeIds = await getActiveWorkerIdsOnDate(rows.map((r) => r.worker_id), recordDate);
        const workers = rows
            .filter((r) => activeIds.has(r.worker_id) || r.attendance_id)
            .map((r) => ({ ...r, active_on_date: activeIds.has(r.worker_id) }));

        // Day context for the UI (banners / disabled actions with an explanation).
        const today = businessTodayDateOnly();
        const lockedBatch = await findLockedWorkerBatch(db, { siteId, date: recordDate });
        const gate = await weekGate.previousWeekWorkerDrafts(db, { siteId, shiftType, recordDate });
        const week = await weekGate.weekBounds(recordDate);
        res.status(200).json({
            status: 'success',
            data: workers,
            shift_type: shiftType,
            day: {
                record_date: recordDate,
                business_today: today,
                is_future: recordDate > today,
                week_start: week.weekStart,
                week_end: week.weekEnd,
                previous_week_drafts: gate.days,
                previous_week: { start: gate.prevStart, end: gate.prevEnd },
                payroll_locked: Boolean(lockedBatch),
                payroll_lock_batch_id: lockedBatch ? lockedBatch.payroll_batch_id : null,
            },
        });
    } catch (error) {
        console.error("SQL ERROR:", error);
        if (error.isOperational) return sendOpError(res, error);
        res.status(500).json({ status: 'error', message: 'An error occurred while fetching worker data, please try again.' });
    }
};
// ------------------------------------------------------------
// استبدل checkIn بالكامل
// ------------------------------------------------------------
exports.checkIn = async (req, res) => {
    const { worker_id, site_id, check_in_time } = req.body;
    const shift_type = normalizeShift(req.body.shift_type);
    const recorded_by_user_id = req.user.user_id;

    if (!worker_id || !site_id) {
        return res.status(400).json({ status: 'error', message: 'Worker and site are required.' });
    }
    if (!check_in_time) {
        return res.status(400).json({ status: 'error', message: 'Check-in time is required.' });
    }

    const formattedCheckIn = formatToMySqlDateTime(check_in_time);
    if (!formattedCheckIn) {
        return res.status(400).json({ status: 'error', message: 'Invalid check-in time format.' });
    }

    const recordDate = formattedCheckIn.slice(0, 10);
    if (recordDate > businessTodayDateOnly()) {
        return res.status(400).json({ status: 'error', message: 'Check-in date cannot be in the future.' });
    }

    if (!(await verifySiteAction(req, site_id, shift_type))) {
        return res.status(403).json({ status: 'error', message: 'You are not authorized to record attendance at this site.' });
    }
    if (!(await verifyWorkerAssignedToSite(worker_id, site_id, shift_type, recordDate))) {
        return res.status(400).json({ status: 'error', message: 'Worker is not active or is not assigned to this site/shift.' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        await assertWorkerDateEditable(connection, site_id, recordDate);   // D-02

        const openShiftId = await getAttendanceId(worker_id, site_id, shift_type, recordDate, connection, true);
        if (openShiftId) {
            await connection.rollback();
            return res.status(409).json({
                status: 'error',
                message: 'There is a previous open shift that hasn\'t been closed yet. Close it first before logging in again.'
            });
        }

        const [existingToday] = await connection.execute(
            `SELECT attendance_id, attendance_status, check_in_time, check_out_time, status
             FROM attendance
             WHERE worker_id = ? AND site_id = ? AND shift_type = ? AND record_date = ?
             ORDER BY attendance_id DESC
             LIMIT 1 FOR UPDATE`,
            [worker_id, site_id, shift_type, recordDate]
        );

        if (existingToday.length > 0) {
            const existing = existingToday[0];

            if (existing.status === 'Rejected') {
                await connection.rollback();
                return res.status(409).json({
                    status: 'error',
                    message: 'This attendance record was rejected. Open Rejected Records and resubmit it.'
                });
            }
            if (existing.status !== 'Draft') {
                await connection.rollback();
                return res.status(409).json({ status: 'error', message: 'Worker already has a finalized attendance record for today.' });
            }
            if (['Absent', 'Sick', 'Vacation', 'Holiday'].includes(existing.attendance_status) && !existing.check_in_time && !existing.check_out_time) {
                const [revived] = await connection.execute(
                    `UPDATE attendance
                     SET check_in_time = ?,
                         attendance_status = 'Present',
                         management_leave_hours = 0,
                         total_working_hours = NULL,
                         overtime_hours = 0,
                         remarks = NULL
                     WHERE attendance_id = ? AND status = 'Draft'
                       AND check_in_time IS NULL AND check_out_time IS NULL`,
                    [formattedCheckIn, existing.attendance_id]
                );
                if (revived.affectedRows !== 1) throw new AppError('Attendance was changed by another request.');

                await connection.execute(
                    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                     VALUES ('attendance', ?, 'CHECK_IN', ?, ?, ?)`,
                    [existing.attendance_id, recorded_by_user_id, JSON.stringify({ attendance_status: existing.attendance_status }), JSON.stringify({ check_in_time: formattedCheckIn, attendance_status: 'Present', shift_type })]
                );
                await connection.commit();
                return res.status(200).json({
                    status: 'success',
                    message: 'Check-in recorded successfully',
                    data: { attendance_id: existing.attendance_id, check_in_time: formattedCheckIn, attendance_status: 'Present', shift_type }
                });
            }
            await connection.rollback();
            return res.status(409).json({ status: 'error', message: 'Worker already has an attendance record for today.' });
        }

        const [result] = await connection.execute(
            `INSERT INTO attendance (worker_id, site_id, shift_type, record_date, check_in_time, attendance_status, status, recorded_by_user_id)
             VALUES (?, ?, ?, ?, ?, 'Present', 'Draft', ?)`,
            [worker_id, site_id, shift_type, recordDate, formattedCheckIn, recorded_by_user_id]
        );

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('attendance', ?, 'CHECK_IN', ?, NULL, ?)`,
            [result.insertId, recorded_by_user_id, JSON.stringify({ check_in_time: formattedCheckIn, shift_type })]
        );

        await connection.commit();
        return res.status(201).json({
            status: 'success',
            message: 'Check-in recorded successfully',
            data: { attendance_id: result.insertId, check_in_time: formattedCheckIn, attendance_status: 'Present', shift_type }
        });
    } catch (error) {
        await connection.rollback();
        console.error("CHECK-IN ERROR:", error);
        if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
            return res.status(409).json({ status: 'error', message: 'Worker already has an attendance record for this date/shift.' });
        }
        return sendOpError(res, error, 'An error occurred while recording check-in, please try again.');
    } finally {
        connection.release();
    }
};

function normalizeWorkerIds(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 500) return null;
    const ids = [...new Set(value.map(Number))];
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return null;
    return ids;
}

async function verifyBulkWorkers(workerIds, siteId, shiftType, recordDate, executor) {
    const assigned = [];
    for (const workerId of workerIds) {
        const [rows] = await executor.execute(
            `SELECT 1
             FROM workersiteassignments wsa
             WHERE wsa.worker_id = ?
               AND wsa.site_id = ?
               AND wsa.shift_type = ?
               AND ${activeOn('wsa')}
             LIMIT 1`,
            [workerId, siteId, shiftType, recordDate, recordDate]
        );
        if (rows.length > 0) assigned.push(workerId);
    }
    // C-12: historical status on the record date.
    const active = await getActiveWorkerIdsOnDate(assigned, recordDate, executor);
    return new Set(assigned.filter((id) => active.has(id)));
}

async function runBulkAttendance(req, res, mode) {
    const { site_id, record_date, worker_ids } = req.body;
    const shift_type = normalizeShift(req.body.shift_type);
    const workerIds = normalizeWorkerIds(worker_ids);
    const timeField = mode === 'checkin' ? 'check_in_time' : 'check_out_time';
    const rawTime = req.body[timeField];

    if (!site_id || !isValidDateOnly(record_date) || !workerIds || !rawTime) {
        return res.status(400).json({
            status: 'error',
            message: `site_id, record_date, worker_ids, and ${timeField} are required.`
        });
    }

    const formattedTime = formatToMySqlDateTime(rawTime);
    if (!formattedTime) return res.status(400).json({ status: 'error', message: `Invalid ${timeField} format.` });
    if (mode === 'checkin' && formattedTime.slice(0, 10) > businessTodayDateOnly()) {
        return res.status(400).json({ status: 'error', message: 'Check-in date cannot be in the future.' });
    }
    if (mode === 'checkin' && formattedTime.slice(0, 10) !== String(record_date)) {
        return res.status(400).json({ status: 'error', message: `Check-in date (${formattedTime.slice(0, 10)}) must match the attendance date (${record_date}).` });
    }
    try {
        assertNotFutureDate(record_date);
        if (mode === 'checkout') assertNotFutureTime(formattedTime, 'Check-out time');
    } catch (e) {
        return sendOpError(res, e);
    }
    if (!(await verifySiteAction(req, site_id, shift_type))) {
        return res.status(403).json({ status: 'error', message: 'You are not authorized to manage this site.' });
    }

    const connection = await db.getConnection();
    let failedWorker = null;

    try {
        await connection.beginTransaction();
        await assertWorkerDateEditable(connection, site_id, record_date);   // D-02
        const validWorkers = await verifyBulkWorkers(workerIds, site_id, shift_type, record_date, connection);

        for (const workerId of workerIds) {
            if (!validWorkers.has(workerId)) {
                failedWorker = { worker_id: workerId, message: 'Worker is not active or is not assigned to this site/shift.' };
                throw new AppError(`Bulk ${mode} aborted: worker ${workerId} is not active or not assigned to this site/shift. No changes were saved.`);
            }

            if (mode === 'checkin') {
                const openShiftId = await getAttendanceId(workerId, site_id, shift_type, record_date, connection, true);
                if (openShiftId) {
                    failedWorker = { worker_id: workerId, message: 'Worker has a previous open shift that must be closed first.' };
                    throw new AppError(`Bulk check-in aborted: worker ${workerId} has an unclosed previous shift. No changes were saved.`);
                }

                const [rows] = await connection.execute(
                    `SELECT attendance_id, attendance_status, check_in_time, check_out_time, status
                     FROM attendance
                     WHERE worker_id = ? AND site_id = ? AND shift_type = ? AND record_date = ?
                     ORDER BY attendance_id DESC LIMIT 1 FOR UPDATE`,
                    [workerId, site_id, shift_type, record_date]
                );

                if (rows.length > 0) {
                    const existing = rows[0];
                    if (existing.status !== 'Draft') {
                        failedWorker = { worker_id: workerId, message: 'Attendance is already finalized.' };
                        throw new AppError(`Bulk check-in aborted: worker ${workerId}'s attendance is already finalized. No changes were saved.`);
                    }
                    if (existing.check_in_time || existing.check_out_time) {
                        failedWorker = { worker_id: workerId, message: 'Worker is already checked in or checked out.' };
                        throw new AppError(`Bulk check-in aborted: worker ${workerId} is already checked in or checked out. No changes were saved.`);
                    }
                    const reason = ['Absent', 'Sick', 'Vacation', 'Holiday'].includes(existing.attendance_status)
                        ? `Worker is marked as ${existing.attendance_status}. Use the individual check-in action on this worker to change it.`
                        : 'Worker already has an attendance record.';
                    failedWorker = { worker_id: workerId, message: reason };
                    throw new AppError(`Bulk check-in aborted: ${reason} (worker ${workerId}). No changes were saved.`);
                } else {
                    const [inserted] = await connection.execute(
                        `INSERT INTO attendance (worker_id, site_id, shift_type, record_date, check_in_time, attendance_status, status, recorded_by_user_id)
                         VALUES (?, ?, ?, ?, ?, 'Present', 'Draft', ?)`,
                        [workerId, site_id, shift_type, record_date, formattedTime, req.user.user_id]
                    );
                    await connection.execute(
                        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                         VALUES ('attendance', ?, 'CHECK_IN', ?, NULL, ?)`,
                        [inserted.insertId, req.user.user_id, JSON.stringify({ check_in_time: formattedTime, source: 'bulk', shift_type })]
                    );
                }
            } else {
                const attendanceId = await getAttendanceId(workerId, site_id, shift_type, record_date, connection, true);
                if (!attendanceId) {
                    failedWorker = { worker_id: workerId, message: 'No open check-in found for this worker.' };
                    throw new AppError(`Bulk check-out aborted: no open check-in found for worker ${workerId}. No changes were saved.`);
                }
                const [[attendance]] = await connection.execute(
                    `SELECT check_in_time, check_out_time FROM attendance WHERE attendance_id = ? FOR UPDATE`,
                    [attendanceId]
                );
                if (!attendance || attendance.check_out_time) {
                    failedWorker = { worker_id: workerId, message: 'Worker is already checked out.' };
                    throw new AppError(`Bulk check-out aborted: worker ${workerId} is already checked out. No changes were saved.`);
                }
                const [[openLeave]] = await connection.execute(
                    `SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NULL LIMIT 1 FOR UPDATE`,
                    [attendanceId]
                );
                if (openLeave) {
                    failedWorker = { worker_id: workerId, message: 'Worker has an open break.' };
                    throw new AppError(`Bulk check-out aborted: worker ${workerId} has an open break. No changes were saved.`);
                }
                const [updated] = await connection.execute(
                    `UPDATE attendance SET check_out_time = ?, attendance_status = 'Present'
                     WHERE attendance_id = ? AND status = 'Draft' AND check_out_time IS NULL`,
                    [formattedTime, attendanceId]
                );
                if (updated.affectedRows !== 1) {
                    failedWorker = { worker_id: workerId, message: 'Attendance changed by another request.' };
                    throw new AppError(`Bulk check-out aborted: attendance for worker ${workerId} changed by another request. No changes were saved.`);
                }
                await attendanceService.calculateWorkingHours(attendanceId, connection);
                await connection.execute(
                    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                     VALUES ('attendance', ?, 'CHECK_OUT', ?, ?, ?)`,
                    [attendanceId, req.user.user_id, JSON.stringify({ check_out_time: null }), JSON.stringify({ check_out_time: formattedTime, source: 'bulk', shift_type })]
                );
            }
        }

        await connection.commit();
        return res.status(200).json({ status: 'success', successful: workerIds, failed: [] });
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        console.error(`BULK ${mode.toUpperCase()} ERROR (transaction rolled back, nothing saved):`, error);

        if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
            return res.status(409).json({
                status: 'error',
                message: 'Attendance already exists for this date/shift. No changes were saved.',
                failed_worker: failedWorker
            });
        }

        if (error.isOperational) {
            return res.status(error.statusCode || 400).json({
                status: 'error', ...(error.code ? { code: error.code } : {}),
                message: error.message, failed_worker: failedWorker, ...(error.extra || {}),
            });
        }
        return res.status(500).json({
            status: 'error',
            message: `Bulk ${mode} failed due to a server error. No changes were saved.`,
            failed_worker: failedWorker
        });
    } finally {
        connection.release();
    }
}

exports.bulkCheckIn = (req, res) => runBulkAttendance(req, res, 'checkin');
exports.bulkCheckOut = (req, res) => runBulkAttendance(req, res, 'checkout');
// ==================== Bulk Absent / Sick / Vacation / Holiday ====================
async function runBulkSetStatus(req, res) {
    const { site_id, record_date, worker_ids, attendance_status, remarks } = req.body;
    const shift_type = normalizeShift(req.body.shift_type);
    const workerIds = normalizeWorkerIds(worker_ids);
    const allowedStatuses = ['Absent', 'Sick', 'Vacation', 'Holiday'];
    const normalizedStatus = attendance_status === 'Annual' ? 'Vacation' : attendance_status;
    const recordedByUserId = req.user.user_id;

    if (!site_id || !isValidDateOnly(record_date) || !workerIds || !normalizedStatus) {
        return res.status(400).json({
            status: 'error',
            message: 'site_id, record_date, worker_ids, and attendance_status are required.'
        });
    }
    if (!allowedStatuses.includes(normalizedStatus)) {
        return res.status(400).json({ status: 'error', message: 'Invalid attendance status.' });
    }
    try { assertNotFutureDate(record_date); } catch (e) { return sendOpError(res, e); }   // §9
    if (!(await verifySiteAction(req, site_id, shift_type))) {
        return res.status(403).json({ status: 'error', message: 'You are not authorized to manage this site.' });
    }

    const connection = await db.getConnection();
    let failedWorker = null;

    try {
        await connection.beginTransaction();
        await assertWorkerDateEditable(connection, site_id, record_date);   // D-02
        const validWorkers = await verifyBulkWorkers(workerIds, site_id, shift_type, record_date, connection);

        for (const workerId of workerIds) {
            if (!validWorkers.has(workerId)) {
                failedWorker = { worker_id: workerId, message: 'Worker is not active or is not assigned to this site/shift.' };
                throw new AppError(`Bulk status update aborted: worker ${workerId} is not active or not assigned to this site/shift. No changes were saved.`);
            }

            const [rows] = await connection.execute(
                `SELECT attendance_id, status, attendance_status, check_in_time, check_out_time
                 FROM attendance
                 WHERE worker_id = ? AND site_id = ? AND shift_type = ? AND record_date = ?
                 ORDER BY attendance_id DESC LIMIT 1 FOR UPDATE`,
                [workerId, site_id, shift_type, record_date]
            );

            const message = remarks || `${normalizedStatus} - recorded by supervisor (bulk)`;

            if (rows.length > 0) {
                const existing = rows[0];

                if (existing.status !== 'Draft') {
                    failedWorker = { worker_id: workerId, message: 'Attendance cannot be changed after it has been submitted.' };
                    throw new AppError(`Bulk status update aborted: worker ${workerId}'s attendance is already submitted/finalized. No changes were saved.`);
                }
                if (existing.check_in_time || existing.check_out_time) {
                    failedWorker = { worker_id: workerId, message: 'Cannot change attendance status after clock activity exists.' };
                    throw new AppError(`Bulk status update aborted: worker ${workerId} already has clock activity (check-in/out). No changes were saved.`);
                }

                const [updated] = await connection.execute(
                    `UPDATE attendance
                     SET attendance_status = ?, remarks = ?, recorded_by_user_id = ?
                     WHERE attendance_id = ? AND status = 'Draft'
                       AND check_in_time IS NULL AND check_out_time IS NULL`,
                    [normalizedStatus, message, recordedByUserId, existing.attendance_id]
                );
                if (updated.affectedRows !== 1) {
                    failedWorker = { worker_id: workerId, message: 'Attendance changed by another request.' };
                    throw new AppError(`Bulk status update aborted: attendance for worker ${workerId} changed by another request. No changes were saved.`);
                }

                await connection.execute(
                    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                     VALUES ('attendance', ?, 'STATUS_UPDATED', ?, ?, ?)`,
                    [
                        existing.attendance_id, recordedByUserId,
                        JSON.stringify({ attendance_status: existing.attendance_status, remarks: null }),
                        JSON.stringify({ attendance_status: normalizedStatus, remarks: message, source: 'bulk', shift_type })
                    ]
                );
            } else {
                const [inserted] = await connection.execute(
                    `INSERT INTO attendance
                        (worker_id, site_id, shift_type, record_date, attendance_status, status, recorded_by_user_id, remarks)
                     VALUES (?, ?, ?, ?, ?, 'Draft', ?, ?)`,
                    [workerId, site_id, shift_type, record_date, normalizedStatus, recordedByUserId, message]
                );
                await connection.execute(
                    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                     VALUES ('attendance', ?, 'STATUS_CREATED', ?, NULL, ?)`,
                    [inserted.insertId, recordedByUserId, JSON.stringify({ attendance_status: normalizedStatus, remarks: message, source: 'bulk', shift_type })]
                );
            }
        }

        await connection.commit();
        return res.status(200).json({ status: 'success', successful: workerIds, failed: [] });
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        console.error('BULK SET STATUS ERROR (transaction rolled back, nothing saved):', error);

        if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
            return res.status(409).json({
                status: 'error',
                message: 'Attendance already exists for this date/shift. No changes were saved.',
                failed_worker: failedWorker
            });
        }

        if (error.isOperational) {
            return res.status(error.statusCode || 400).json({
                status: 'error', ...(error.code ? { code: error.code } : {}),
                message: error.message, failed_worker: failedWorker, ...(error.extra || {}),
            });
        }
        return res.status(500).json({
            status: 'error',
            message: 'Bulk status update failed due to a server error. No changes were saved.',
            failed_worker: failedWorker
        });
    } finally {
        connection.release();
    }
}

exports.bulkSetAttendanceStatus = (req, res) => runBulkSetStatus(req, res);
exports.setAttendanceStatus = async (req, res) => {
    const { worker_id, site_id, attendance_status, remarks, record_date } = req.body;
    const shift_type = normalizeShift(req.body.shift_type);
    const normalizedStatus = attendance_status === 'Annual' ? 'Vacation' : attendance_status;
    const allowedStatuses = ['Absent', 'Sick', 'Vacation', 'Holiday'];
    const recordedByUserId = req.user.user_id;

    if (!worker_id || !site_id || !attendance_status || !isValidDateOnly(record_date)) {
        return res.status(400).json({ status: 'error', message: 'Worker, site, and attendance status are required.' });
    }
    if (!allowedStatuses.includes(normalizedStatus)) {
        return res.status(400).json({ status: 'error', message: 'Invalid attendance status.' });
    }
    try { assertNotFutureDate(record_date); } catch (e) { return sendOpError(res, e); }   // §9

    if (!(await verifySiteAction(req, site_id, shift_type))) {
        return res.status(403).json({ status: 'error', message: 'You are not authorized to update this site.' });
    }
    if (!(await verifyWorkerAssignedToSite(worker_id, site_id, shift_type, record_date))) {
        return res.status(400).json({ status: 'error', message: 'Worker is not active or is not assigned to this site/shift.' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        await assertWorkerDateEditable(connection, site_id, record_date);   // D-02
        const [existingRows] = await connection.execute(
            `SELECT attendance_id, status, attendance_status, check_in_time, check_out_time
             FROM attendance
             WHERE worker_id = ? AND site_id = ? AND shift_type = ? AND record_date = ?
             ORDER BY attendance_id DESC LIMIT 1 FOR UPDATE`,
            [worker_id, site_id, shift_type, record_date]
        );
        const message = remarks || `${normalizedStatus} - recorded by supervisor`;

        if (existingRows.length > 0) {
            const existing = existingRows[0];
            if (existing.status !== 'Draft') throw new AppError('Attendance cannot be changed after it has been submitted.');
            if (existing.check_in_time || existing.check_out_time) throw new AppError('Cannot change attendance status after clock activity exists.');

            const [updated] = await connection.execute(
                `UPDATE attendance
                 SET attendance_status = ?, remarks = ?, recorded_by_user_id = ?
                 WHERE attendance_id = ? AND status = 'Draft'
                   AND check_in_time IS NULL AND check_out_time IS NULL`,
                [normalizedStatus, message, recordedByUserId, existing.attendance_id]
            );
            if (updated.affectedRows !== 1) throw new AppError('Attendance was changed by another request.');

            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('attendance', ?, 'STATUS_UPDATED', ?, ?, ?)`,
                [existing.attendance_id, recordedByUserId,
                 JSON.stringify({ attendance_status: existing.attendance_status, remarks: null }),
                 JSON.stringify({ attendance_status: normalizedStatus, remarks: message, shift_type })]
            );
            await connection.commit();
            return res.status(200).json({ status: 'success', message: 'Attendance status updated successfully.' });
        }

        const [inserted] = await connection.execute(
            `INSERT INTO attendance
                (worker_id, site_id, shift_type, record_date, attendance_status, status, recorded_by_user_id, remarks)
             VALUES (?, ?, ?, ?, ?, 'Draft', ?, ?)`,
            [worker_id, site_id, shift_type, record_date, normalizedStatus, recordedByUserId, message]
        );
        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('attendance', ?, 'STATUS_CREATED', ?, NULL, ?)`,
            [inserted.insertId, recordedByUserId, JSON.stringify({ attendance_status: normalizedStatus, remarks: message, shift_type })]
        );
        await connection.commit();
        return res.status(201).json({ status: 'success', message: 'Attendance status recorded successfully.' });
    } catch (error) {
        await connection.rollback();
        console.error('SET ATTENDANCE STATUS ERROR:', error);
        if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
            return res.status(409).json({ status: 'error', message: 'Worker already has an attendance record for this date/shift.' });
        }
        return sendOpError(res, error, 'An error occurred while saving attendance status.');
    } finally {
        connection.release();
    }
};

exports.editAttendanceTimes = async (req, res) => {
    const { attendance_id } = req.params;
    const { check_in_time, check_out_time } = req.body;
    const userId = req.user.user_id;

    if (!check_in_time && !check_out_time) {
        return res.status(400).json({ status: 'error', message: 'Provide at least a new check-in or check-out time.' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            'SELECT * FROM attendance WHERE attendance_id = ? FOR UPDATE',
            [attendance_id]
        );
        if (rows.length === 0) throw new AppError('Attendance record not found.');
        const record = rows[0];

        if (record.status !== 'Draft') {
            throw new AppError('Only records still in Draft status can be edited here.');
        }
        await assertWorkerDateEditable(connection, record.site_id, record.record_date);   // D-02
        // ✅ FIX: مرّر shift_type الفعلي للسجل، وليس الافتراضي
        if (!(await verifySiteAction(req, record.site_id, record.shift_type))) {
            throw new AppError('You are not authorized to edit attendance for this site.');
        }

        const newCheckIn = check_in_time ? formatToMySqlDateTime(check_in_time) : record.check_in_time;
        const newCheckOut = check_out_time ? formatToMySqlDateTime(check_out_time) : record.check_out_time;

        if (check_in_time && !newCheckIn) throw new AppError('Invalid check-in time format.');
        if (check_out_time && !newCheckOut) throw new AppError('Invalid check-out time format.');
        if (check_out_time) assertNotFutureTime(newCheckOut, 'Check-out time');
        if (check_in_time) assertNotFutureTime(newCheckIn, 'Check-in time');

        const recordDateStr = String(record.record_date).slice(0, 10);
        if (newCheckIn && newCheckIn.slice(0, 10) !== recordDateStr) {
            throw new AppError(`Check-in date (${newCheckIn.slice(0, 10)}) must match the attendance record's date (${recordDateStr}).`);
        }

        if (newCheckIn && newCheckOut) {
            const start = parseAttendanceDate(newCheckIn);
            const end = parseAttendanceDate(newCheckOut);
            if (!start || !end || end <= start) {
                throw new AppError('Check-out time must be after check-in time.');
            }

            const [leaves] = await connection.execute(
                `SELECT leave_start_time, leave_end_time FROM attendanceleaveperiods WHERE attendance_id = ?`,
                [attendance_id]
            );
            for (const leave of leaves) {
                const leaveStart = parseAttendanceDate(leave.leave_start_time);
                const leaveEnd = leave.leave_end_time ? parseAttendanceDate(leave.leave_end_time) : null;
                if (leaveStart && leaveStart < start) {
                    throw new AppError('Cannot set check-in after an existing break/lunch start. Adjust the break first.');
                }
                if (leaveEnd && leaveEnd > end) {
                    throw new AppError('Cannot set check-out before an existing break/lunch end. Adjust the break first.');
                }
            }
        }

        const [updated] = await connection.execute(
            `UPDATE attendance SET check_in_time = ?, check_out_time = ? WHERE attendance_id = ? AND status = 'Draft'`,
            [newCheckIn, newCheckOut, attendance_id]
        );
        if (updated.affectedRows !== 1) throw new AppError('Attendance was changed by another request.');

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('attendance', ?, 'TIMES_CORRECTED', ?, ?, ?)`,
            [
                attendance_id, userId,
                JSON.stringify({ check_in_time: record.check_in_time, check_out_time: record.check_out_time }),
                JSON.stringify({ check_in_time: newCheckIn, check_out_time: newCheckOut })
            ]
        );

        if (newCheckIn && newCheckOut) {
            await attendanceService.calculateWorkingHours(attendance_id, connection);
        }

        await connection.commit();
        return res.status(200).json({ status: 'success', message: 'Attendance times updated successfully.' });
    } catch (error) {
        await connection.rollback();
        console.error('EDIT ATTENDANCE TIMES ERROR:', error);
        return sendOpError(res, error, 'An error occurred while editing attendance times.');
    } finally {
        connection.release();
    }
};

exports.checkOut = async (req, res) => {
    const { worker_id, site_id, check_out_time, record_date } = req.body;
    const shift_type = normalizeShift(req.body.shift_type);
    const userId = req.user.user_id;
    if (!worker_id || !site_id || !isValidDateOnly(record_date)) return res.status(400).json({ status: 'error', message: 'Worker, site, and valid record_date are required.' });
    if (!check_out_time) return res.status(400).json({ status: 'error', message: 'Check-out time is required.' });

    const formattedCheckOut = formatToMySqlDateTime(check_out_time);
    if (!formattedCheckOut) return res.status(400).json({ status: 'error', message: 'Invalid check-out time format.' });
    try { assertNotFutureTime(formattedCheckOut, 'Check-out time'); } catch (e) { return sendOpError(res, e); }   // R-06
    if (!(await verifySiteAction(req, site_id, shift_type))) return res.status(403).json({ status: 'error', message: 'You are not authorized to perform this action at the specified site.' });
    if (!(await verifyWorkerAssignedToSite(worker_id, site_id, shift_type, record_date))) return res.status(400).json({ status: 'error', message: 'Worker is not active or is not assigned to this site/shift.' });

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const attId = await getAttendanceId(worker_id, site_id, shift_type, record_date, connection, true);
        if (!attId) throw new AppError('Attendance record not found.');

        const [[row]] = await connection.execute(
            'SELECT check_in_time, check_out_time, record_date FROM attendance WHERE attendance_id = ? FOR UPDATE', [attId]
        );
        await assertWorkerDateEditable(connection, site_id, row.record_date);   // D-02
        const checkInDate = parseAttendanceDate(row?.check_in_time);
        const checkOutDate = parseAttendanceDate(formattedCheckOut);
        if (!checkInDate || !checkOutDate || checkOutDate <= checkInDate) throw new AppError('Check-out time must be after check-in time.');

        const [openLeaves] = await connection.execute(
            'SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NULL LIMIT 1 FOR UPDATE', [attId]
        );
        if (openLeaves.length > 0) throw new AppError('End the active break before checking out.');

        const [updated] = await connection.execute(
            `UPDATE attendance SET check_out_time = ?
             WHERE attendance_id = ? AND status = 'Draft' AND check_out_time IS NULL`,
            [formattedCheckOut, attId]
        );
        if (updated.affectedRows !== 1) throw new AppError('Attendance was changed by another request.');

        const calc = await attendanceService.calculateWorkingHours(attId, connection);
        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('attendance', ?, 'CHECK_OUT', ?, ?, ?)`,
            [attId, userId, JSON.stringify({ check_in_time: row.check_in_time, check_out_time: null }), JSON.stringify({ check_out_time: formattedCheckOut, shift_type })]
        );
        await connection.commit();
        return res.status(200).json({
            status: 'success',
            message: calc && calc.anomaly
                ? `Check-out recorded. Flagged for review: ${calc.anomaly.detail}`
                : 'Check-out recorded successfully.',
            data: { attendance_id: attId, check_out_time: formattedCheckOut, anomaly: calc ? calc.anomaly : null },
        });
    } catch (error) {
        await connection.rollback();
        console.error('CHECK-OUT ERROR:', error);
        return sendOpError(res, error, 'An error occurred during check-out, please try again.');
    } finally {
        connection.release();
    }
};

function normalizeTimeForDate(value, date) {
    if (!value) return null;
    const text = String(value);
    if (/^\d{2}:\d{2}(:\d{2})?$/.test(text)) {
        return `${date} ${text.length === 5 ? text + ':00' : text}`;
    }
    return formatToMySqlDateTime(text);
}

function formatUtcDateAsMySql(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

// Convert a time-only input to the occurrence inside the actual shift window.
// This makes 23:00 -> 01:00 and breaks such as 00:30 unambiguous.
function normalizeTimeForShift(value, shiftStart, shiftEnd) {
    if (!value || !shiftStart || !shiftEnd) return null;
    const text = String(value);
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(text)) return formatToMySqlDateTime(text);
    const parts = text.split(':').map(Number);
    const candidate = new Date(shiftStart.getTime());
    candidate.setUTCHours(parts[0], parts[1], parts[2] || 0, 0);
    while (candidate < shiftStart) candidate.setUTCDate(candidate.getUTCDate() + 1);
    if (candidate > shiftEnd) {
        const previousDay = new Date(candidate.getTime());
        previousDay.setUTCDate(previousDay.getUTCDate() - 1);
        if (previousDay >= shiftStart && previousDay <= shiftEnd) return formatUtcDateAsMySql(previousDay);
    }
    return candidate <= shiftEnd ? formatUtcDateAsMySql(candidate) : null;
}

function parseAttendanceDate(value) {
    const formatted = formatToMySqlDateTime(value);
    if (!formatted) return null;
    const [datePart, timePart] = formatted.split(' ');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, second] = timePart.split(':').map(Number);
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

async function hasOverlappingLeave(executor, attendanceId, start, end, excludeLeaveId = null) {
    const params = [attendanceId, end, start];
    let exclusion = '';
    if (excludeLeaveId !== null) {
        exclusion = ' AND leave_id <> ?';
        params.push(excludeLeaveId);
    }
    const [rows] = await executor.execute(
        `SELECT leave_id
         FROM attendanceleaveperiods
         WHERE attendance_id = ?
           AND leave_start_time < ?
           AND COALESCE(leave_end_time, '9999-12-31 23:59:59') > ?${exclusion}
         LIMIT 1
         FOR UPDATE`,
        params
    );
    return rows.length > 0;
}

exports.saveLunchBulk = async (req, res) => {
    const { siteId, date, default_start_time, default_end_time, overrides = {}, excluded_worker_ids = [] } = req.body;
    const shiftType = normalizeShift(req.body.shift_type);
    const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : null;
    const safeOverrides = overrides && typeof overrides === 'object' ? overrides : {};
    const hasOverrides = Object.keys(safeOverrides).length > 0;
    const excludedSet = new Set(
        Array.isArray(excluded_worker_ids)
            ? excluded_worker_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
            : []
    );

    if (!siteId || !selectedDate) {
        return res.status(400).json({ status: 'error', message: 'siteId and date are required.' });
    }
    if (!hasOverrides && (!default_start_time || !default_end_time)) {
        return res.status(400).json({ status: 'error', message: 'Provide a default lunch time or worker-specific times.' });
    }

    try {
        if (!(await verifySiteAction(req, siteId, shiftType))) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to manage this site.' });
        }

        const defaultStart = default_start_time ? normalizeTimeForDate(default_start_time, selectedDate) : null;
        const defaultEnd = default_end_time ? normalizeTimeForDate(default_end_time, selectedDate) : null;
        if ((default_start_time && !defaultStart) || (default_end_time && !defaultEnd)) {
            return res.status(400).json({ status: 'error', message: 'Invalid default lunch time format.' });
        }

        await assertWorkerDateEditable(db, siteId, selectedDate);   // D-02
        const [recordsAll] = await db.execute(
            `SELECT a.attendance_id, a.worker_id, a.check_in_time, a.check_out_time,
                    DATE_FORMAT(a.record_date, '%Y-%m-%d') AS record_date
             FROM attendance a
             JOIN workersiteassignments wsa
               ON wsa.worker_id = a.worker_id
              AND wsa.site_id = a.site_id
              AND wsa.shift_type = a.shift_type
              AND ${activeOn('wsa', 'a.record_date')}
             WHERE a.site_id = ? AND a.shift_type = ? AND (a.record_date = ? OR
                    (a.record_date = DATE_SUB(?, INTERVAL 1 DAY)
                     AND DATE(a.check_out_time) > a.record_date))
               AND a.status = 'Draft'
               AND a.check_in_time IS NOT NULL
               AND a.check_out_time IS NOT NULL`,
            [siteId, shiftType, selectedDate, selectedDate]
        );
        // C-12: historical status on each record's own date.
        const records = [];
        for (const r of recordsAll) {
            const active = await getActiveWorkerIdsOnDate([r.worker_id], r.record_date);
            if (active.has(r.worker_id)) records.push(r);
        }
        if (records.length === 0) {
            return res.status(400).json({ status: 'error', message: 'No completed attendance records found for this date.' });
        }

        const recordsToUpdate = records.filter((record) => {
            const override = safeOverrides[String(record.worker_id)] || safeOverrides[record.worker_id] || {};
            const hasOwnTime = Boolean(override.start_time && override.end_time);
            if (excludedSet.has(Number(record.worker_id)) && !hasOwnTime) return false;
            return Boolean((override.start_time || default_start_time) && (override.end_time || default_end_time));
        });
        if (recordsToUpdate.length === 0) {
            return res.status(400).json({ status: 'error', message: 'No workers selected to receive a lunch time.' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            for (const record of recordsToUpdate) {
                const override = safeOverrides[String(record.worker_id)] || safeOverrides[record.worker_id] || {};
                const rawStart = override.start_time || default_start_time;
                const rawEnd = override.end_time || default_end_time;
                if (!rawStart || !rawEnd) continue;
                const checkInDate = parseAttendanceDate(record.check_in_time);
                const checkOutDate = parseAttendanceDate(record.check_out_time);
                const start = normalizeTimeForShift(rawStart, checkInDate, checkOutDate);
                const end = normalizeTimeForShift(rawEnd, checkInDate, checkOutDate);
                const lunchStartDate = parseAttendanceDate(start);
                const lunchEndDate = parseAttendanceDate(end);
                if (!checkInDate || !checkOutDate || !start || !end || !lunchStartDate || !lunchEndDate) {
                    throw new AppError(`Invalid time for worker ${record.worker_id}`);
                }
                if (lunchEndDate <= lunchStartDate) throw new AppError(`Lunch end must be after lunch start for worker ${record.worker_id}`);
                if (lunchStartDate < checkInDate || lunchEndDate > checkOutDate) {
                    throw new AppError(`Lunch must be between check-in and check-out for worker ${record.worker_id}`);
                }

                const [existing] = await connection.execute(
                    `SELECT leave_id FROM attendanceleaveperiods
                     WHERE attendance_id = ? AND leave_type = 'Lunch'
                     ORDER BY leave_id DESC LIMIT 1`,
                    [record.attendance_id]
                );
                const currentLunchId = existing.length > 0 ? existing[0].leave_id : null;
                if (await hasOverlappingLeave(connection, record.attendance_id, start, end, currentLunchId)) {
                    throw new AppError(`Lunch period overlaps another break for worker ${record.worker_id}.`);
                }
                if (existing.length > 0) {
                    const [lunchUpdated] = await connection.execute(
                        `UPDATE attendanceleaveperiods
                         SET leave_start_time = ?, leave_end_time = ?
                         WHERE leave_id = ?`,
                        [start, end, existing[0].leave_id]
                    );
                    if (lunchUpdated.affectedRows !== 1) throw new AppError('Lunch record was changed by another request.');
                    await connection.execute(
                        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                         VALUES ('attendanceleaveperiods', ?, 'LUNCH_BULK_UPDATE', ?, ?, ?)`,
                        [existing[0].leave_id, req.user.user_id, JSON.stringify({ attendance_id: record.attendance_id }), JSON.stringify({ leave_start_time: start, leave_end_time: end })]
                    );
                } else {
                    const [result] = await connection.execute(
                        `INSERT INTO attendanceleaveperiods
                         (attendance_id, leave_start_time, leave_end_time, leave_type)
                         VALUES (?, ?, ?, 'Lunch')`,
                        [record.attendance_id, start, end]
                    );
                    await connection.execute(
                        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                         VALUES ('attendanceleaveperiods', ?, 'LUNCH_BULK_CREATE', ?, NULL, ?)`,
                        [result.insertId, req.user.user_id, JSON.stringify({ attendance_id: record.attendance_id, leave_start_time: start, leave_end_time: end, leave_type: 'Lunch' })]
                    );
                }
                await attendanceService.calculateWorkingHours(record.attendance_id, connection);
            }
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

        return res.status(200).json({ status: 'success', message: 'Lunch times saved successfully.', updated_records: recordsToUpdate.length });
    } catch (error) {
        console.error('SAVE BULK LUNCH ERROR:', error);
        return sendOpError(res, error, 'An error occurred while saving lunch times.');
    }
};


exports.submitDay = async (req, res) => {
    const {
        siteId,
        record_date,
        lunch_decisions = [],
        confirmed_lunch_skips = []
    } = req.body;
    const shiftType = normalizeShift(req.body.shift_type);

    if (!siteId || !isValidDateOnly(record_date)) {
        return res.status(400).json({
            status: 'error',
            message: 'Site and valid record_date are required.'
        });
    }

    const decisions = new Map();

    if (Array.isArray(confirmed_lunch_skips)) {
        for (const item of confirmed_lunch_skips) {
            const attendanceId = Number(item?.attendance_id);
            const reason = String(item?.reason || '').trim();
            if (Number.isInteger(attendanceId) && attendanceId > 0 && reason) {
                decisions.set(attendanceId, { worked_through_lunch: true, reason });
            }
        }
    }
    if (Array.isArray(lunch_decisions)) {
        for (const item of lunch_decisions) {
            const attendanceId = Number(item?.attendance_id);
            if (!Number.isInteger(attendanceId) || attendanceId <= 0) continue;
            const workedThroughLunch = item?.worked_through_lunch === true;
            const reason = String(item?.reason || '').trim();
            decisions.set(attendanceId, { worked_through_lunch: workedThroughLunch, reason });
        }
    }

    const connection = await db.getConnection();
    let transactionStarted = false;

    try {
        if (!(await verifySiteAction(req, siteId, shiftType))) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to submit this site.' });
        }
        assertNotFutureDate(record_date);   // §9: a future day can never be submitted

        await connection.beginTransaction();
        transactionStarted = true;

        // D-02: a finalized payroll period cannot receive new submissions.
        await assertWorkerDateEditable(connection, siteId, record_date);
        // §10: actual Draft records in the previous week block this submission.
        const gate = await weekGate.previousWeekWorkerDrafts(connection, { siteId, shiftType, recordDate: record_date });
        if (gate.days.length > 0) throw weekGate.gateError(gate);

          const [openShifts] = await connection.execute(
            `SELECT a.attendance_id, w.full_name
             FROM attendance a
             JOIN workers w ON w.worker_id = a.worker_id
             WHERE a.site_id = ? AND a.shift_type = ?
               AND (a.record_date = ? OR a.record_date = DATE_SUB(?, INTERVAL 1 DAY))
               AND a.status = 'Draft'
               AND a.attendance_status = 'Present'
               AND (a.check_in_time IS NULL OR a.check_out_time IS NULL)`,
            [siteId, shiftType, record_date, record_date]
        );
        if (openShifts.length > 0) {
            await connection.rollback();
            transactionStarted = false;
            return res.status(400).json({
                status: 'error',
                message: 'Some workers are still checked in and have not checked out yet.',
                open_workers: openShifts.map(row => ({ attendance_id: row.attendance_id, full_name: row.full_name }))
            });
        }

        // 2) Open leaves
        const [openLeaves] = await connection.execute(
            `SELECT alp.leave_id, w.full_name
             FROM attendanceleaveperiods alp
             JOIN attendance a ON a.attendance_id = alp.attendance_id
             JOIN workers w ON w.worker_id = a.worker_id
             WHERE a.site_id = ? AND a.shift_type = ?
               AND (a.record_date = ? OR a.record_date = DATE_SUB(?, INTERVAL 1 DAY))
               AND a.status = 'Draft'
               AND alp.leave_end_time IS NULL`,
            [siteId, shiftType, record_date, record_date]
        );
        if (openLeaves.length > 0) {
            await connection.rollback();
            transactionStarted = false;
            return res.status(400).json({
                status: 'error',
                message: 'Some workers still have an active break that has not ended.',
                open_workers: openLeaves.map(row => ({ leave_id: row.leave_id, full_name: row.full_name }))
            });
        }

        // 3) Missing attendance for shift-scoped assignments
        //    (C-12: only workers whose HISTORICAL status on the date is Active)
        const [missingCandidates] = await connection.execute(
            `SELECT DISTINCT w.worker_id, w.full_name
             FROM workersiteassignments wsa
             JOIN workers w ON w.worker_id = wsa.worker_id
             WHERE wsa.site_id = ? AND wsa.shift_type = ?
               AND ${activeOn('wsa')}
               AND NOT EXISTS (
                   SELECT 1 FROM attendance a
                   WHERE a.worker_id = w.worker_id AND a.site_id = wsa.site_id AND a.shift_type = wsa.shift_type
                     AND (
                          a.record_date = ?
                          OR (a.record_date = DATE_SUB(?, INTERVAL 1 DAY)
                              AND a.check_out_time IS NOT NULL
                              AND DATE(a.check_out_time) > a.record_date)
                     )
               )
             ORDER BY w.full_name, w.worker_id`,
            [siteId, shiftType, record_date, record_date, record_date, record_date]
        );
        const activeOnDay = await getActiveWorkerIdsOnDate(missingCandidates.map((r) => r.worker_id), record_date, connection);
        const missingAttendance = missingCandidates.filter((r) => activeOnDay.has(r.worker_id));
        if (missingAttendance.length > 0) {
            await connection.rollback();
            transactionStarted = false;
            return res.status(400).json({
                status: 'error',
                code: 'MISSING_ATTENDANCE_RECORDS',
                message: 'Every assigned worker must have an attendance status before submitting the day.',
                missing_workers: missingAttendance.map(row => ({ worker_id: row.worker_id, full_name: row.full_name }))
            });
        }

        // 4) Missing lunch — shift-scoped
        const [missingLunch] = await connection.execute(
            `SELECT a.attendance_id, a.worker_id, a.check_in_time, a.check_out_time, w.full_name
             FROM attendance a
             JOIN workers w ON w.worker_id = a.worker_id
             LEFT JOIN attendanceleaveperiods alp
               ON alp.attendance_id = a.attendance_id AND alp.leave_type = 'Lunch'
             LEFT JOIN (
                 SELECT MIN(alp2.leave_start_time) AS site_lunch_start,
                        MAX(alp2.leave_end_time) AS site_lunch_end
                 FROM attendanceleaveperiods alp2
                 JOIN attendance a2 ON a2.attendance_id = alp2.attendance_id
                 WHERE a2.site_id = ? AND a2.shift_type = ?
                   AND alp2.leave_type = 'Lunch' AND alp2.leave_end_time IS NOT NULL
                   AND (a2.record_date = ? OR (a2.record_date = DATE_SUB(?, INTERVAL 1 DAY)
                        AND a2.check_out_time IS NOT NULL AND DATE(a2.check_out_time) > a2.record_date))
             ) site_lunch ON 1 = 1
             WHERE a.site_id = ? AND a.shift_type = ? AND a.status = 'Draft'
               AND (a.record_date = ? OR (a.record_date = DATE_SUB(?, INTERVAL 1 DAY)
                    AND a.check_out_time IS NOT NULL AND DATE(a.check_out_time) > a.record_date))
               AND a.check_in_time IS NOT NULL AND a.check_out_time IS NOT NULL
               AND alp.leave_id IS NULL
               AND (
                    site_lunch.site_lunch_start IS NULL
                    OR (a.check_in_time < site_lunch.site_lunch_end AND a.check_out_time > site_lunch.site_lunch_start)
               )`,
            [siteId, shiftType, record_date, record_date, siteId, shiftType, record_date, record_date]
        );

        let siteLunchStart = null;
        let siteLunchEnd = null;
        if (missingLunch.length > 0) {
            const [[siteLunch]] = await connection.execute(
                `SELECT MIN(alp.leave_start_time) AS lunch_start, MAX(alp.leave_end_time) AS lunch_end
                 FROM attendanceleaveperiods alp
                 JOIN attendance a ON a.attendance_id = alp.attendance_id
                 WHERE a.site_id = ? AND a.shift_type = ? AND alp.leave_type = 'Lunch'
                   AND alp.leave_end_time IS NOT NULL
                   AND (a.record_date = ? OR (a.record_date = DATE_SUB(?, INTERVAL 1 DAY)
                        AND a.check_out_time IS NOT NULL AND DATE(a.check_out_time) > a.record_date))`,
                [siteId, shiftType, record_date, record_date]
            );
            siteLunchStart = siteLunch?.lunch_start || null;
            siteLunchEnd = siteLunch?.lunch_end || null;
        }

        if (missingLunch.length > 0) {
            const stillUnconfirmed = missingLunch.filter(row => !decisions.has(Number(row.attendance_id)));
            if (stillUnconfirmed.length > 0) {
                await connection.rollback();
                transactionStarted = false;
                return res.status(200).json({
                    status: 'warning',
                    requires_confirmation: true,
                    message: 'The following workers have no recorded lunch. Please confirm whether each worker worked during lunch.',
                    lunch_period: { start: siteLunchStart, end: siteLunchEnd },
                    missing_workers: stillUnconfirmed.map(row => ({
                        attendance_id: row.attendance_id, worker_id: row.worker_id, full_name: row.full_name
                    }))
                });
            }
        }

        // 5) Apply lunch decisions (لا تغيير على المنطق الداخلي، فقط استُخدم shiftType بجلب البيانات أعلاه)
        for (const row of missingLunch) {
            const attendanceId = Number(row.attendance_id);
            const decision = decisions.get(attendanceId);
            if (!decision) throw new AppError(`Missing lunch decision for worker ${row.full_name}.`);

            if (decision.worked_through_lunch === true) {
                const reason = decision.reason;
                if (!reason) throw new AppError(`A reason is required when ${row.full_name} worked through lunch.`);
                await connection.execute(
                    `UPDATE attendance SET remarks = CONCAT(COALESCE(remarks, ''), CASE WHEN remarks IS NULL OR remarks = '' THEN '' ELSE ' | ' END, ?) WHERE attendance_id = ?`,
                    [`Worked through lunch: ${reason}`, attendanceId]
                );
                await connection.execute(
                    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                     VALUES ('attendance', ?, 'LUNCH_SKIPPED_CONFIRMED', ?, NULL, ?)`,
                    [attendanceId, req.user.user_id, JSON.stringify({ worked_through_lunch: true, reason })]
                );
                continue;
            }

            if (!siteLunchStart || !siteLunchEnd) {
                throw new AppError(`No site lunch period is configured. Record the site's lunch time before submitting the day for worker ${row.full_name}.`);
            }
            const checkInDate = parseAttendanceDate(row.check_in_time);
            const checkOutDate = parseAttendanceDate(row.check_out_time);
            if (!checkInDate || !checkOutDate) throw new AppError(`Invalid attendance times for worker ${row.full_name}.`);

            const lunchStart = normalizeTimeForShift(siteLunchStart, checkInDate, checkOutDate);
            const lunchEnd = normalizeTimeForShift(siteLunchEnd, checkInDate, checkOutDate);
            const lunchStartDate = parseAttendanceDate(lunchStart);
            const lunchEndDate = parseAttendanceDate(lunchEnd);
            if (!lunchStart || !lunchEnd || !lunchStartDate || !lunchEndDate) {
                throw new AppError(`The site lunch period is not valid for worker ${row.full_name}'s shift.`);
            }
            if (lunchEndDate <= lunchStartDate) throw new AppError(`Lunch end must be after lunch start for worker ${row.full_name}.`);

            if (lunchStartDate < checkOutDate && lunchEndDate > checkInDate) {
                if (lunchStartDate < checkInDate || lunchEndDate > checkOutDate) {
                    throw new AppError(`Lunch period is not completely inside worker ${row.full_name}'s shift.`);
                }
                const [existingLunch] = await connection.execute(
                    `SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_type = 'Lunch' ORDER BY leave_id DESC LIMIT 1`,
                    [attendanceId]
                );
                if (existingLunch.length === 0) {
                    const [insertedLunch] = await connection.execute(
                        `INSERT INTO attendanceleaveperiods (attendance_id, leave_start_time, leave_end_time, leave_type) VALUES (?, ?, ?, 'Lunch')`,
                        [attendanceId, lunchStart, lunchEnd]
                    );
                    await connection.execute(
                        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                         VALUES ('attendanceleaveperiods', ?, 'LUNCH_AUTO_CREATE_ON_SUBMIT', ?, NULL, ?)`,
                        [insertedLunch.insertId, req.user.user_id, JSON.stringify({
                            attendance_id: attendanceId, leave_start_time: lunchStart, leave_end_time: lunchEnd,
                            leave_type: 'Lunch', reason: 'Worker confirmed they did not work during lunch.'
                        })]
                    );
                }
            }
            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('attendance', ?, 'LUNCH_NOT_WORKED_CONFIRMED', ?, NULL, ?)`,
                [attendanceId, req.user.user_id, JSON.stringify({ worked_through_lunch: false, lunch_start: lunchStart, lunch_end: lunchEnd })]
            );
        }

        // 6) (Former auto-absent step removed: it was unreachable because step 3
        //    refuses the submission while any assigned, active worker has no
        //    record. Every worker therefore needs an explicit status.)

        // 7) Recalculate completed shifts, shift-scoped
        const [completedShifts] = await connection.execute(
            `SELECT attendance_id FROM attendance
             WHERE site_id = ? AND shift_type = ?
               AND (record_date = ? OR (record_date = DATE_SUB(?, INTERVAL 1 DAY)
                    AND check_out_time IS NOT NULL AND DATE(check_out_time) > record_date))
               AND status = 'Draft' AND check_in_time IS NOT NULL AND check_out_time IS NOT NULL`,
            [siteId, shiftType, record_date, record_date]
        );
        for (const shift of completedShifts) {
            await attendanceService.calculateWorkingHours(shift.attendance_id, connection);
        }

        // 8) Submit, shift-scoped
        const [submitted] = await connection.execute(
            `UPDATE attendance
             SET status = 'Submitted'
             WHERE site_id = ? AND shift_type = ?
               AND (record_date = ? OR (record_date = DATE_SUB(?, INTERVAL 1 DAY)
                    AND check_out_time IS NOT NULL AND DATE(check_out_time) > record_date))
                              AND status = 'Draft'
               AND (attendance_status <> 'Present'
                    OR (check_in_time IS NOT NULL AND check_out_time IS NOT NULL))`,
            [siteId, shiftType, record_date, record_date]
        );

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('attendance', 0, 'DAY_SUBMITTED', ?, NULL, ?)`,
            [req.user.user_id, JSON.stringify({ site_id: siteId, shift_type: shiftType, record_date, affected_rows: submitted.affectedRows })]
        );

        await connection.commit();
        return res.status(200).json({
            status: 'success',
            message: 'Day submitted successfully for review.',
            submitted_records: submitted.affectedRows
        });
    } catch (error) {
        if (transactionStarted) {
            try { await connection.rollback(); } catch (rollbackError) { console.error('ROLLBACK ERROR:', rollbackError); }
        }
        console.error('SUBMIT DAY ERROR:', error);
        return sendOpError(res, error, 'An error occurred while submitting the day, please try again.');
    } finally {
        connection.release();
    }
};

exports.getRejectedRecords = async (req, res) => {
    try {
        const supervisor_id = req.user.user_id;
        const isAdmin = req.user.role === 'Admin';
        // ✅ FIX: الفلترة القديمة (s.supervisor_id = ?) ما بتشتغل صح بعد
        // ما صار T2 site واحد له مشرفين. نستخدم site_shifts + fallback
        // للمواقع غير الشيفتية (زي Bridges).
        const query = `
            SELECT a.*, w.full_name, s.site_name
            FROM attendance a
            JOIN workers w ON a.worker_id = w.worker_id
            JOIN sites s ON a.site_id = s.site_id
            LEFT JOIN site_shifts ss ON ss.site_id = a.site_id AND ss.shift_type = a.shift_type
            WHERE a.status = 'Rejected'
              ${isAdmin ? '' : `AND (
                    (s.supports_shifts = 0 AND s.supervisor_id = ?)
                    OR (s.supports_shifts = 1 AND ss.supervisor_id = ?)
                  )`}
            ORDER BY s.site_name, a.record_date DESC, w.full_name`;
        const [rows] = await db.execute(query, isAdmin ? [] : [supervisor_id, supervisor_id]);
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("GET REJECTED ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred while fetching rejected records, please try again.' });
    }
};

exports.startLeave = async (req, res) => {
    try {
        const { worker_id, site_id, leave_type, leave_start_time, record_date } = req.body;
        const shift_type = normalizeShift(req.body.shift_type);
        const recorded_by_user_id = req.user.user_id;

        if (!worker_id || !site_id) {
            return res.status(400).json({ status: 'error', message: 'Worker and site are required.' });
        }
        if (!SUPERVISOR_ALLOWED_LEAVE_TYPES.includes(leave_type)) {
            return res.status(400).json({
                status: 'error',
                message: `Invalid leave type. Allowed values are: ${SUPERVISOR_ALLOWED_LEAVE_TYPES.join(', ')}.`
            });
        }
        if (!leave_start_time) {
            return res.status(400).json({ status: 'error', message: 'Break start time is required.' });
        }
        const formattedStart = formatToMySqlDateTime(leave_start_time);
        if (!formattedStart) {
            return res.status(400).json({ status: 'error', message: 'Invalid break start time format.' });
        }
        if (!(await verifySiteAction(req, site_id, shift_type))) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to manage leave at this site.' });
        }
        if (!(await verifyWorkerAssignedToSite(worker_id, site_id, shift_type, record_date))) {
            return res.status(400).json({ status: 'error', message: 'Worker is not active or is not assigned to this site/shift.' });
        }

        const att_id = await getAttendanceId(worker_id, site_id, shift_type, record_date);
        if (!att_id) return res.status(404).json({ status: 'error', message: 'No active attendance record found!' });
        assertNotFutureTime(formattedStart, 'Break start time');
        await assertWorkerDateEditable(db, site_id, record_date);   // D-02

        const [attendanceRows] = await db.execute(
            'SELECT check_in_time, check_out_time FROM attendance WHERE attendance_id = ? LIMIT 1',
            [att_id]
        );
        const checkInDate = parseAttendanceDate(attendanceRows[0]?.check_in_time);
        const checkOutDate = attendanceRows[0]?.check_out_time ? parseAttendanceDate(attendanceRows[0].check_out_time) : null;
        const leaveStartDate = parseAttendanceDate(formattedStart);
        if (!checkInDate || !leaveStartDate || leaveStartDate < checkInDate || (checkOutDate && leaveStartDate > checkOutDate)) {
            return res.status(400).json({ status: 'error', message: 'Break start time must be within the attendance shift.' });
        }

        const [existingOpenLeave] = await db.execute(
            'SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NULL LIMIT 1',
            [att_id]
        );
        if (existingOpenLeave.length > 0) {
            return res.status(409).json({ status: 'error', message: 'Worker already has an active break.' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            await connection.execute('SELECT attendance_id FROM attendance WHERE attendance_id = ? FOR UPDATE', [att_id]);
            const shiftEndForLeave = checkOutDate ? formatUtcDateAsMySql(checkOutDate) : '9999-12-31 23:59:59';
            if (await hasOverlappingLeave(connection, att_id, formattedStart, shiftEndForLeave, null)) {
                throw new AppError('Break overlaps an existing break.');
            }
            const [result] = await connection.execute(
                'INSERT INTO attendanceleaveperiods (attendance_id, leave_start_time, leave_type) VALUES (?, ?, ?)',
                [att_id, formattedStart, leave_type]
            );
            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('attendanceleaveperiods', ?, 'LEAVE_START', ?, NULL, ?)`,
                [result.insertId, recorded_by_user_id, JSON.stringify({ leave_type, leave_start_time: formattedStart })]
            );
            await connection.commit();
            res.status(200).json({ status: 'success', message: 'Leave/break started successfully' });
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error("START LEAVE ERROR:", error);
        sendOpError(res, error, 'An error occurred while starting the break, please try again.');
    }
};

exports.endLeave = async (req, res) => {
    try {
        const { worker_id, site_id, leave_end_time, record_date } = req.body;
        const shift_type = normalizeShift(req.body.shift_type);
        const recorded_by_user_id = req.user.user_id;

        if (!leave_end_time) {
            return res.status(400).json({ status: 'error', message: 'Break end time is required.' });
        }
        const formattedEnd = formatToMySqlDateTime(leave_end_time);
        if (!formattedEnd) {
            return res.status(400).json({ status: 'error', message: 'Invalid break end time format.' });
        }
        if (!worker_id || !site_id || !isValidDateOnly(record_date)) {
            return res.status(400).json({ status: 'error', message: 'Worker, site, and valid record_date are required.' });
        }
        if (!(await verifySiteAction(req, site_id, shift_type))) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to manage leave at this site.' });
        }
        if (!(await verifyWorkerAssignedToSite(worker_id, site_id, shift_type, record_date))) {
            return res.status(400).json({ status: 'error', message: 'Worker is not active or is not assigned to this site/shift.' });
        }

        const att_id = await getAttendanceId(worker_id, site_id, shift_type, record_date);
        if (!att_id) return res.status(404).json({ status: 'error', message: 'Attendance record not found!' });
        assertNotFutureTime(formattedEnd, 'Break end time');
        await assertWorkerDateEditable(db, site_id, record_date);   // D-02

        const [openLeaves] = await db.execute(
            `SELECT leave_id, leave_start_time FROM attendanceleaveperiods
             WHERE attendance_id = ? AND leave_end_time IS NULL ORDER BY leave_id DESC LIMIT 1`,
            [att_id]
        );
        if (openLeaves.length === 0) {
            return res.status(404).json({ status: 'error', message: 'No active break found!' });
        }

        const leave_id = openLeaves[0].leave_id;
        const existingStart = openLeaves[0].leave_start_time;
        const [attendanceRows] = await db.execute(
            'SELECT check_out_time FROM attendance WHERE attendance_id = ? LIMIT 1',
            [att_id]
        );
        const startDate = parseAttendanceDate(existingStart);
        const endDate = parseAttendanceDate(formattedEnd);
        const checkOutDate = parseAttendanceDate(attendanceRows[0]?.check_out_time);
        if (!startDate || !endDate || endDate <= startDate || (checkOutDate && endDate > checkOutDate)) {
            return res.status(400).json({ status: 'error', message: 'Break end time must be after break start and within the shift.' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            await connection.execute('SELECT leave_id FROM attendanceleaveperiods WHERE leave_id = ? FOR UPDATE', [leave_id]);
            const [ended] = await connection.execute(
                `UPDATE attendanceleaveperiods
                 SET leave_end_time = ?
                 WHERE leave_id = ? AND leave_end_time IS NULL`,
                [formattedEnd, leave_id]
            );
            if (ended.affectedRows !== 1) throw new AppError('Break was changed by another request.');
            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('attendanceleaveperiods', ?, 'LEAVE_END', ?, ?, ?)`,
                [leave_id, recorded_by_user_id, JSON.stringify({ leave_start_time: existingStart }), JSON.stringify({ leave_end_time: formattedEnd })]
            );
            await connection.commit();
            res.status(200).json({ status: 'success', message: 'Break ended successfully' });
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error("END LEAVE ERROR:", error);
        sendOpError(res, error, 'An error occurred while ending the break, please try again.');
    }
};

// =====================================================================
// Add this require at the top of controllers/attendanceController.js
// (it is not currently imported there):
//
//   const settingsCache = require('../services/settingsCache');
//
// Then REPLACE the existing `exports.setManagementLeaveHours` function
// with the version below. Nothing else in the file needs to change —
// attendanceService.calculateWorkingHours() is still used unchanged for
// the "complete shift" case.
// =====================================================================

exports.setManagementLeaveHours = async (req, res) => {
    const { attendance_id } = req.params;
    const { hours, reason } = req.body;
    const adminId = req.user.user_id;

    const numericHours = Number(hours);
    if (hours === undefined || !Number.isFinite(numericHours) || numericHours < 0 || numericHours > 24) {
        return res.status(400).json({ status: 'error', message: 'Hours must be a finite number between 0 and 24.' });
    }
    if (req.user.role !== 'Admin') {
        return res.status(403).json({ status: 'error', message: 'Only an Admin can grant management leave hours.' });
    }

    const trimmedReason = String(reason || '').trim();

    const connection = await db.getConnection();
    let oldRecord;
    let responseMessage = 'Management leave hours recorded successfully';
    let responseWarning = null;

    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute('SELECT * FROM attendance WHERE attendance_id = ? FOR UPDATE', [attendance_id]);
        if (rows.length === 0) throw new AppError('Record not found');
        oldRecord = rows[0];
        // C-06: approved records are locked; use the Admin correction workflow.
        if (!['Draft', 'Submitted', 'Rejected'].includes(oldRecord.status)) {
            throw new AppError(`Management leave can only be set on Draft, Submitted or Rejected records (this record is ${oldRecord.status}). Use "Correct attendance" for approved records.`, 409);
        }
        await assertWorkerDateEditable(connection, oldRecord.site_id, oldRecord.record_date);   // D-02

        const hasCheckIn = Boolean(oldRecord.check_in_time);
        const hasCheckOut = Boolean(oldRecord.check_out_time);

        // Case C: no shift at all (Absent / Sick / Vacation / Holiday).
        // Admin is granting hours with nothing to attach them to, so a
        // reason is mandatory and we must set total_working_hours directly
        // — calculateWorkingHours() cannot run without check-in/check-out.
        if (!hasCheckIn) {
            if (!trimmedReason) {
                throw new AppError('A reason is required when granting management leave hours to a worker with no check-in (Absent/Sick/Vacation/Holiday).');
            }

            let standardMinutes;
            if (oldRecord.standard_minutes_snapshot !== null && oldRecord.standard_minutes_snapshot !== undefined) {
                standardMinutes = Number(oldRecord.standard_minutes_snapshot);
            } else {
                // D3: value in effect on the record's own date.
                const configured = Number(await settingsCache.getSettingForDate(
                    'standard_work_minutes', String(oldRecord.record_date).slice(0, 10), '600'));
                standardMinutes = Number.isFinite(configured) && configured > 0 ? configured : 600;
            }

            const standardHours = standardMinutes / 60;
            const regularHours = Math.min(numericHours, standardHours);
            const overtimeHours = Math.max(0, numericHours - standardHours);

            const [updated] = await connection.execute(
                `UPDATE attendance
                 SET management_leave_hours = ?,
                     total_working_hours = ?,
                     overtime_hours = ?,
                     standard_minutes_snapshot = COALESCE(standard_minutes_snapshot, ?)
                 WHERE attendance_id = ?`,
                [numericHours, regularHours.toFixed(2), overtimeHours.toFixed(2), standardMinutes, attendance_id]
            );
            if (updated.affectedRows !== 1) throw new AppError('Attendance was changed by another request.');

            responseMessage = `Management leave recorded (${numericHours}h) and counted directly as working hours since the worker has no check-in.`;
        } else if (hasCheckIn && !hasCheckOut) {
            // Case B: shift still open. Do NOT touch total_working_hours —
            // leave the existing "wait for checkout" behavior untouched.
            const [updated] = await connection.execute(
                'UPDATE attendance SET management_leave_hours = ? WHERE attendance_id = ?',
                [numericHours, attendance_id]
            );
            if (updated.affectedRows !== 1) throw new AppError('Attendance was changed by another request.');

            responseWarning = 'Worker has not checked out yet. These hours are saved but will not be reflected in working hours until checkout is completed.';
        } else {
            // Case A: complete shift (check-in + check-out). Existing behavior.
            const [updated] = await connection.execute(
                'UPDATE attendance SET management_leave_hours = ? WHERE attendance_id = ?',
                [numericHours, attendance_id]
            );
            if (updated.affectedRows !== 1) throw new AppError('Attendance was changed by another request.');

            await attendanceService.calculateWorkingHours(attendance_id, connection);
        }

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('attendance', ?, 'MANAGEMENT_LEAVE', ?, ?, ?)`,
            [attendance_id, adminId, JSON.stringify(oldRecord), JSON.stringify({ management_leave_hours: numericHours, reason: trimmedReason || null })]
        );

        await connection.commit();
    } catch (error) {
        await connection.rollback();
        console.error("MANAGEMENT LEAVE ERROR:", error);
        return sendOpError(res, error, 'An error occurred while recording management leave hours.');
    } finally {
        connection.release();
    }

    res.status(200).json({ status: 'success', message: responseMessage, warning: responseWarning });
};

// C-13: a rejected record is resubmitted with the status chosen by the
// supervisor (Present needs check-in/out; Absent/Sick/Vacation/Holiday need no
// times). Management leave hours granted by an Admin are KEPT. An Admin may
// resubmit too (e.g. a site with no active supervisor); the site/shift scope
// check still applies to Supervisors.
exports.resubmitAttendance = async (req, res) => {
    const { attendance_id } = req.params;
    const { check_in_time, check_out_time, remarks } = req.body;
    const userId = req.user.user_id;
    const isAdmin = req.user.role === 'Admin';
    const requestedStatus = req.body.attendance_status === 'Annual' ? 'Vacation' : req.body.attendance_status;
    const ALLOWED = ['Present', 'Absent', 'Sick', 'Vacation', 'Holiday'];

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        // #4: biometric records are recorded by the Admin who ran processing, so the
        // ownership check cannot apply to them. The site/shift scope check below
        // (verifySiteAction) still restricts who may resubmit.
        const [records] = await connection.execute(
            `SELECT * FROM attendance
             WHERE attendance_id = ? AND status = 'Rejected'
               AND (? = 1 OR recorded_by_user_id = ? OR source = 'Biometric'
                    OR EXISTS (SELECT 1 FROM site_shifts ss WHERE ss.site_id = attendance.site_id
                               AND ss.shift_type = attendance.shift_type AND ss.supervisor_id = ?)
                    OR EXISTS (SELECT 1 FROM sites s WHERE s.site_id = attendance.site_id
                               AND s.supports_shifts = 0 AND s.supervisor_id = ?))
             FOR UPDATE`,
            [attendance_id, isAdmin ? 1 : 0, userId, userId, userId]
        );

        if (records.length === 0) throw new AppError('Record not found or you are not allowed to edit it');

        const oldRecord = records[0];
        if (!(await verifySiteAction(req, oldRecord.site_id, oldRecord.shift_type))) {
            throw new AppError('You are not authorized to resubmit attendance for this site.', 403);
        }
        await assertWorkerDateEditable(connection, oldRecord.site_id, oldRecord.record_date);   // D-02
        if (!(await verifyWorkerAssignedToSite(oldRecord.worker_id, oldRecord.site_id, oldRecord.shift_type, oldRecord.record_date, connection))) {
            throw new AppError('Worker was not active or not assigned to this site/shift on this date.');
        }
        const [openLeaves] = await connection.execute(
            'SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NULL LIMIT 1 FOR UPDATE',
            [attendance_id]
        );
        if (openLeaves.length > 0) throw new AppError('End the active break before resubmitting attendance.');

        const newStatus = requestedStatus || oldRecord.attendance_status || 'Present';
        if (!ALLOWED.includes(newStatus)) throw new AppError('Invalid attendance status.');
        const recordDateStr = String(oldRecord.record_date).slice(0, 10);

        let formattedCheckIn = null;
        let formattedCheckOut = null;
        if (newStatus === 'Present') {
            formattedCheckIn = formatToMySqlDateTime(check_in_time || oldRecord.check_in_time);
            formattedCheckOut = formatToMySqlDateTime(check_out_time || oldRecord.check_out_time);
            if (!formattedCheckIn || !formattedCheckOut) {
                throw new AppError('Both check-in and check-out times are required for Present.');
            }
            if (formattedCheckIn.slice(0, 10) !== recordDateStr) {
                throw new AppError(`Check-in date (${formattedCheckIn.slice(0, 10)}) must match the attendance record's date (${recordDateStr}).`);
            }
            const checkInDate = parseAttendanceDate(formattedCheckIn);
            const checkOutDate = parseAttendanceDate(formattedCheckOut);
            if (!checkInDate || !checkOutDate || checkOutDate <= checkInDate) {
                throw new AppError('Check-out time must be after check-in time');
            }
            assertNotFutureTime(formattedCheckOut, 'Check-out time');
        } else {
            // A non-Present status has no clock times; existing breaks of the
            // old Present version are kept in the audit row and removed from the
            // live record only through the audit-preserving UPDATE below.
            const [[breaks]] = await connection.execute(
                'SELECT COUNT(*) AS cnt FROM attendanceleaveperiods WHERE attendance_id = ?', [attendance_id]);
            if (Number(breaks.cnt) > 0) {
                throw new AppError('This record has recorded breaks. It can only be resubmitted as Present (or corrected by an Admin).');
            }
        }

        // Non-Present: hours come only from Admin-granted management leave
        // (same rule as setManagementLeaveHours case C); otherwise none.
        let nonPresentRegular = null;
        let nonPresentOvertime = 0;
        const mgmtHours = Number(oldRecord.management_leave_hours || 0);
        if (newStatus !== 'Present' && mgmtHours > 0) {
            let standardMinutes = Number(oldRecord.standard_minutes_snapshot);
            if (!(standardMinutes > 0)) {
                standardMinutes = Number(await settingsCache.getSettingForDate('standard_work_minutes', recordDateStr, '600')) || 600;
            }
            nonPresentRegular = Math.min(mgmtHours, standardMinutes / 60).toFixed(2);
            nonPresentOvertime = Math.max(0, mgmtHours - standardMinutes / 60).toFixed(2);
        }

        const [resubmitted] = await connection.execute(
            `UPDATE attendance
             SET check_in_time = ?,
                 check_out_time = ?,
                 attendance_status = ?,
                 remarks = ?,
                 status = 'Submitted',
                 total_working_hours = CASE WHEN ? = 'Present' THEN total_working_hours ELSE ? END,
                 overtime_hours = CASE WHEN ? = 'Present' THEN overtime_hours ELSE ? END,
                 anomaly_code = CASE WHEN ? = 'Present' THEN anomaly_code ELSE NULL END,
                 anomaly_detail = CASE WHEN ? = 'Present' THEN anomaly_detail ELSE NULL END,
                 updated_at = NOW()
             WHERE attendance_id = ?
               AND status = 'Rejected'`,
            [formattedCheckIn, formattedCheckOut, newStatus, remarks ?? oldRecord.remarks ?? null,
             newStatus, nonPresentRegular, newStatus, nonPresentOvertime, newStatus, newStatus, attendance_id]
        );

        if (resubmitted.affectedRows !== 1) throw new AppError('Attendance was changed by another request.');

        let calc = null;
        if (newStatus === 'Present') {
            calc = await attendanceService.calculateWorkingHours(attendance_id, connection);
        }

        await connection.execute(
            `INSERT INTO auditlogs
                (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                'attendance',
                attendance_id,
                'RESUBMIT',
                userId,
                JSON.stringify(oldRecord),
                JSON.stringify({
                    check_in_time: formattedCheckIn,
                    check_out_time: formattedCheckOut,
                    attendance_status: newStatus,
                    remarks: remarks ?? oldRecord.remarks ?? null,
                    status: 'Submitted',
                    management_leave_hours: Number(oldRecord.management_leave_hours || 0),
                    shift_type: oldRecord.shift_type,
                    resubmitted_by_role: req.user.role,
                })
            ]
        );

        await connection.commit();
        res.status(200).json({
            status: 'success',
            message: calc && calc.anomaly ? `Resubmitted. Flagged for review: ${calc.anomaly.detail}` : 'Resubmitted successfully',
        });
    } catch (error) {
        await connection.rollback();
        console.error("RESUBMIT ERROR:", error);
        sendOpError(res, error, 'An error occurred while resubmitting, please try again.');
    } finally {
        connection.release();
    }
};

// Shared, unchanged helpers (used by the D2 admin "Submit for review" path so
// it applies exactly the same lunch rules as submitDay).
exports._shared = { normalizeTimeForShift, parseAttendanceDate, formatToMySqlDateTime };
