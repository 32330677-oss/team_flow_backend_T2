const db = require('../config/db');
const biometricDeviceUserService = require('./biometricDeviceUserService');

const NIGHT_START_MINUTES = 17 * 60; // 17:00
const NIGHT_END_MINUTES = 4 * 60;    // 04:00 next day

function createServiceError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function normalizeShift(value) {
    return ['Day', 'Night'].includes(value) ? value : 'Day';
}

function toDateOnly(value) {
    if (!value) return null;

    if (value instanceof Date) {
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, '0');
        const day = String(value.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    return String(value).slice(0, 10);
}

function getMinutesFromDateTime(value) {
    const text = value instanceof Date
        ? `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
        : String(value).slice(11, 16);

    const [hours, minutes] = text.split(':').map(Number);

    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
        return null;
    }

    return hours * 60 + minutes;
}

/**
 * Determines the Worker attendance record_date from the punch time.
 *
 * Day:
 *   record_date = calendar date of punch
 *
 * Night:
 *   17:00 -> 23:59 = same calendar date
 *   00:00 -> 04:00 = previous calendar date
 */
function getWorkerRecordDate(punchedAt, shiftType) {
    const date = toDateOnly(punchedAt);
    const shift = normalizeShift(shiftType);

    if (!date) {
        throw createServiceError('Invalid punch datetime.');
    }

    if (shift !== 'Night') {
        return date;
    }

    const minutes = getMinutesFromDateTime(punchedAt);

    if (minutes === null) {
        throw createServiceError('Invalid punch datetime.');
    }

    // 00:00 - 04:00 belongs to the previous Night shift.
    if (minutes <= NIGHT_END_MINUTES) {
        const d = new Date(`${date}T00:00:00`);

        d.setDate(d.getDate() - 1);

        return toDateOnly(d);
    }

    // 17:00 - 23:59 belongs to this day's Night shift.
    if (minutes >= NIGHT_START_MINUTES) {
        return date;
    }

    // 04:01 - 16:59 is outside the Night shift window.
    return null;
}

/**
 * Find the Worker assignment that was active at the punch date.
 *
 * We intentionally return ambiguity instead of guessing if more than
 * one assignment is valid.
 */
async function resolveWorkerAssignment(
    workerId,
    punchDate,
    executor = db
) {
    const [rows] = await executor.execute(
        `SELECT
            wsa.worker_id,
            wsa.site_id,
            s.site_name,
            wsa.shift_type,
            wsa.assigned_date,
            wsa.unassigned_date
         FROM workersiteassignments wsa
         JOIN workers w
           ON w.worker_id = wsa.worker_id
         JOIN sites s
           ON s.site_id = wsa.site_id
         WHERE wsa.worker_id = ?
           AND wsa.assigned_date <= ?
           AND (
                wsa.unassigned_date IS NULL
                OR wsa.unassigned_date > ?
           )
           AND w.status = 'Active'
         ORDER BY
            wsa.assigned_date DESC,
            wsa.worker_id,
            wsa.site_id,
            wsa.shift_type`,
        [workerId, punchDate, punchDate]
    );

    if (rows.length === 0) {
        return null;
    }

    /*
     * More than one valid assignment means we do not know where
     * the biometric punch belongs.
     */
    if (rows.length > 1) {
        throw createServiceError(
            `Worker ${workerId} has multiple active site/shift assignments on ${punchDate}. Biometric punch cannot be assigned automatically.`,
            409
        );
    }

    return {
        workerId: rows[0].worker_id,
        siteId: rows[0].site_id,
        siteName: rows[0].site_name,
        shiftType: normalizeShift(rows[0].shift_type),
        assignedDate: rows[0].assigned_date,
        unassignedDate: rows[0].unassigned_date,
    };
}

/**
 * Resolve a biometric punch into its attendance context.
 *
 * This does NOT create/update attendance yet.
 */
async function resolvePunchContext(punch, executor = db) {
    if (!punch || !punch.device_employee_id || !punch.punched_at) {
        throw createServiceError('device_employee_id and punched_at are required.');
    }

    const mapping =
        await biometricDeviceUserService.resolveDeviceUser(
            punch.device_employee_id,
            punch.punched_at,
            executor
        );

    if (!mapping) {
        return {
            status: 'unmapped',
            context: null,
        };
    }

    if (mapping.entity_type === 'Staff') {
        const recordDate = toDateOnly(punch.punched_at);

        return {
            status: 'resolved',
            context: {
                entityType: 'Staff',
                staffId: mapping.staff_id,
                recordDate,
            },
        };
    }

    if (mapping.entity_type !== 'Worker') {
        throw createServiceError(
            `Unsupported biometric entity type: ${mapping.entity_type}`,
            409
        );
    }

    const punchCalendarDate = toDateOnly(punch.punched_at);

    const assignment = await resolveWorkerAssignment(
        mapping.worker_id,
        punchCalendarDate,
        executor
    );

    if (!assignment) {
        return {
            status: 'no_assignment',
            context: {
                entityType: 'Worker',
                workerId: mapping.worker_id,
                punchCalendarDate,
            },
        };
    }

    const recordDate = getWorkerRecordDate(
        punch.punched_at,
        assignment.shiftType
    );

    if (!recordDate) {
        return {
            status: 'outside_shift_window',
            context: {
                entityType: 'Worker',
                workerId: mapping.worker_id,
                siteId: assignment.siteId,
                siteName: assignment.siteName,
                shiftType: assignment.shiftType,
                punchCalendarDate,
            },
        };
    }

    /*
     * For Night, the assignment must also be valid for the actual
     * attendance record_date.
     *
     * This protects the 00:00-04:00 case.
     */
    const recordAssignment =
        await resolveWorkerAssignment(
            mapping.worker_id,
            recordDate,
            executor
        );

    if (!recordAssignment) {
        return {
            status: 'no_assignment',
            context: {
                entityType: 'Worker',
                workerId: mapping.worker_id,
                recordDate,
            },
        };
    }

    if (
        recordAssignment.siteId !== assignment.siteId ||
        recordAssignment.shiftType !== assignment.shiftType
    ) {
        throw createServiceError(
            `Worker ${mapping.worker_id} assignment changed across the Night shift boundary. Biometric punch requires manual review.`,
            409
        );
    }

    return {
        status: 'resolved',
        context: {
            entityType: 'Worker',
            workerId: mapping.worker_id,
            siteId: assignment.siteId,
            siteName: assignment.siteName,
            shiftType: assignment.shiftType,
            recordDate,
        },
    };
}

/**
 * Find the Worker attendance record for the exact business key.
 */
async function getWorkerAttendance(
    workerId,
    siteId,
    shiftType,
    recordDate,
    executor = db,
    forUpdate = false
) {
    const lock = forUpdate ? ' FOR UPDATE' : '';

    const [rows] = await executor.execute(
        `SELECT *
         FROM attendance
         WHERE worker_id = ?
           AND site_id = ?
           AND shift_type = ?
           AND record_date = ?
         LIMIT 1${lock}`,
        [
            workerId,
            siteId,
            shiftType,
            recordDate,
        ]
    );

    return rows.length ? rows[0] : null;
}

/**
 * Find Staff attendance for the business key.
 */
async function getStaffAttendance(
    staffId,
    recordDate,
    executor = db,
    forUpdate = false
) {
    const lock = forUpdate ? ' FOR UPDATE' : '';

    const [rows] = await executor.execute(
        `SELECT *
         FROM staff_attendance
         WHERE staff_id = ?
           AND record_date = ?
         LIMIT 1${lock}`,
        [staffId, recordDate]
    );

    return rows.length ? rows[0] : null;
}

/**
 * Apply an IN punch to Worker attendance.
 */
async function applyWorkerIn(
    context,
    punchedAt,
    executor
) {
    const existing = await getWorkerAttendance(
        context.workerId,
        context.siteId,
        context.shiftType,
        context.recordDate,
        executor,
        true
    );

    if (existing) {
        if (
            existing.status === 'Submitted' ||
            existing.status === 'Approved'
        ) {
            return {
                action: 'ignored_locked',
                attendanceId: existing.attendance_id,
            };
        }

        if (existing.status === 'Rejected') {
            return {
                action: 'ignored_rejected',
                attendanceId: existing.attendance_id,
            };
        }

        /*
         * Existing Draft with a check-in:
         * biometric duplicate/re-import should not overwrite it.
         */
        if (existing.check_in_time) {
            return {
                action: 'already_checked_in',
                attendanceId: existing.attendance_id,
            };
        }

        await executor.execute(
            `UPDATE attendance
             SET check_in_time = ?,
                 attendance_status = 'Present',
                 updated_at = CURRENT_TIMESTAMP
             WHERE attendance_id = ?`,
            [punchedAt, existing.attendance_id]
        );

        return {
            action: 'checked_in_existing',
            attendanceId: existing.attendance_id,
        };
    }

    const [result] = await executor.execute(
        `INSERT INTO attendance (
            worker_id,
            site_id,
            record_date,
            check_in_time,
            attendance_status,
            recorded_by_user_id,
            status,
            shift_type
         )
         VALUES (?, ?, ?, ?, 'Present', ?, 'Draft', ?)`,
        [
            context.workerId,
            context.siteId,
            context.recordDate,
            punchedAt,
            1,
            context.shiftType,
        ]
    );

    return {
        action: 'created',
        attendanceId: result.insertId,
    };
}

/**
 * Apply an OUT punch to Worker attendance.
 *
 * We only close an existing Draft record.
 * We do not manufacture an attendance record from an OUT punch.
 */
async function applyWorkerOut(
    context,
    punchedAt,
    executor
) {
    const existing = await getWorkerAttendance(
        context.workerId,
        context.siteId,
        context.shiftType,
        context.recordDate,
        executor,
        true
    );

    if (!existing) {
        return {
            action: 'no_open_attendance',
            attendanceId: null,
        };
    }

    if (
        existing.status === 'Submitted' ||
        existing.status === 'Approved'
    ) {
        return {
            action: 'ignored_locked',
            attendanceId: existing.attendance_id,
        };
    }

    if (existing.status === 'Rejected') {
        return {
            action: 'ignored_rejected',
            attendanceId: existing.attendance_id,
        };
    }

    if (!existing.check_in_time) {
        return {
            action: 'no_check_in',
            attendanceId: existing.attendance_id,
        };
    }

    if (existing.check_out_time) {
        return {
            action: 'already_checked_out',
            attendanceId: existing.attendance_id,
        };
    }

    const checkIn = new Date(existing.check_in_time);
    const checkOut = new Date(punchedAt);

    if (
        Number.isNaN(checkIn.getTime()) ||
        Number.isNaN(checkOut.getTime()) ||
        checkOut <= checkIn
    ) {
        return {
            action: 'invalid_checkout_time',
            attendanceId: existing.attendance_id,
        };
    }

    await executor.execute(
        `UPDATE attendance
         SET check_out_time = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE attendance_id = ?`,
        [punchedAt, existing.attendance_id]
    );

    return {
        action: 'checked_out',
        attendanceId: existing.attendance_id,
    };
}

/**
 * Main entry point for one raw biometric punch.
 *
 * IMPORTANT:
 * - Does not modify attendance_punches.
 * - Does not perform payroll.
 * - Does not call HTTP controllers.
 */
async function processPunch(punch, recordedByUserId) {
    if (!Number.isInteger(Number(recordedByUserId)) || Number(recordedByUserId) <= 0) {
    throw createServiceError(
        'A valid recordedByUserId is required for biometric attendance.'
    );
}
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const resolved = await resolvePunchContext(
            punch,
            connection
        );

        if (resolved.status !== 'resolved') {
            await connection.commit();

            return {
                processed: false,
                status: resolved.status,
                context: resolved.context,
            };
        }

        const context = resolved.context;
        context.recordedByUserId = Number(recordedByUserId);

        let result;

if (context.entityType === 'Worker') {
    if (punch.punch_type === 'IN') {
        result = await applyWorkerIn(
            context,
            punch.punched_at,
            connection
        );
    } else if (punch.punch_type === 'OUT') {
        result = await applyWorkerOut(
            context,
            punch.punched_at,
            connection
        );
    } else {
        throw createServiceError(
            `Unsupported punch type: ${punch.punch_type}`
        );
    }
} else if (context.entityType === 'Staff') {
    if (punch.punch_type === 'IN') {
        result = await applyStaffIn(
            context,
            punch.punched_at,
            context.recordedByUserId,
            connection
        );
    } else if (punch.punch_type === 'OUT') {
        result = await applyStaffOut(
            context,
            punch.punched_at,
            connection
        );
    } else {
        throw createServiceError(
            `Unsupported punch type: ${punch.punch_type}`
        );
    }
} else {
    throw createServiceError(
        `Unsupported biometric entity type: ${context.entityType}`,
        409
    );
}

        await connection.commit();

        return {
            processed: true,
            status: 'processed',
            context,
            result,
        };
    } catch (error) {
        try {
            await connection.rollback();
        } catch (_) {}

        throw error;
    } finally {
        connection.release();
    }
}
/**
 * Apply biometric IN punch to Staff attendance.
 *
 * Staff attendance is unique by:
 *   staff_id + record_date
 *
 * Staff has no site/shift dimension in staff_attendance.
 */
async function applyStaffIn(
    context,
    punchedAt,
    recordedByUserId,
    executor
) {
    const existing = await getStaffAttendance(
        context.staffId,
        context.recordDate,
        executor,
        true
    );

    if (existing) {
        /*
         * Submitted and Approved are locked.
         * Biometric processing must never overwrite them.
         */
        if (
            existing.status === 'Submitted' ||
            existing.status === 'Approved'
        ) {
            return {
                action: 'ignored_locked',
                staffAttendanceId: existing.staff_attendance_id,
            };
        }

        /*
         * A rejected record must be handled through the normal
         * Staff resubmission flow, not silently changed by biometric.
         */
        if (existing.status === 'Rejected') {
            return {
                action: 'ignored_rejected',
                staffAttendanceId: existing.staff_attendance_id,
            };
        }

        /*
         * Existing Draft with check-in:
         * Treat another IN punch as duplicate/repeated punch.
         */
        if (existing.check_in_time) {
            return {
                action: 'already_checked_in',
                staffAttendanceId: existing.staff_attendance_id,
            };
        }

        /*
         * Existing Draft without check-in:
         * Fill the check-in time.
         */
        await executor.execute(
            `UPDATE staff_attendance
             SET check_in_time = ?,
                 attendance_status = 'Present',
                 recorded_by_user_id = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE staff_attendance_id = ?`,
            [
                punchedAt,
                recordedByUserId,
                existing.staff_attendance_id,
            ]
        );

        return {
            action: 'checked_in_existing',
            staffAttendanceId: existing.staff_attendance_id,
        };
    }

    /*
     * No attendance exists for this Staff/date.
     *
     * Create a normal Draft Present record.
     *
     * We intentionally do NOT calculate hours here.
     * Existing Staff attendance/payroll logic remains responsible
     * for working hours, lunch, overtime, Friday rules, etc.
     */
    const [result] = await executor.execute(
        `INSERT INTO staff_attendance (
            staff_id,
            record_date,
            check_in_time,
            attendance_status,
            is_friday_worked,
            is_paid,
            is_management_paid_absence,
            recorded_by_user_id,
            status
         )
         VALUES (
            ?, ?, ?, 'Present', 0, 1, 0, ?, 'Draft'
         )`,
        [
            context.staffId,
            context.recordDate,
            punchedAt,
            recordedByUserId,
        ]
    );

    return {
        action: 'created',
        staffAttendanceId: result.insertId,
    };
}


/**
 * Apply biometric OUT punch to Staff attendance.
 *
 * An OUT punch never creates a new Staff attendance record.
 */
async function applyStaffOut(
    context,
    punchedAt,
    executor
) {
    const existing = await getStaffAttendance(
        context.staffId,
        context.recordDate,
        executor,
        true
    );

    if (!existing) {
        return {
            action: 'no_open_attendance',
            staffAttendanceId: null,
        };
    }

    /*
     * Submitted and Approved are locked.
     */
    if (
        existing.status === 'Submitted' ||
        existing.status === 'Approved'
    ) {
        return {
            action: 'ignored_locked',
            staffAttendanceId: existing.staff_attendance_id,
        };
    }

    /*
     * Rejected records must go through the existing Staff
     * resubmission flow.
     */
    if (existing.status === 'Rejected') {
        return {
            action: 'ignored_rejected',
            staffAttendanceId: existing.staff_attendance_id,
        };
    }

    /*
     * Cannot checkout if there is no check-in.
     */
    if (!existing.check_in_time) {
        return {
            action: 'no_check_in',
            staffAttendanceId: existing.staff_attendance_id,
        };
    }

    /*
     * Duplicate OUT.
     */
    if (existing.check_out_time) {
        return {
            action: 'already_checked_out',
            staffAttendanceId: existing.staff_attendance_id,
        };
    }

    /*
     * Validate chronological order.
     */
    const checkIn = new Date(existing.check_in_time);
    const checkOut = new Date(punchedAt);

    if (
        Number.isNaN(checkIn.getTime()) ||
        Number.isNaN(checkOut.getTime()) ||
        checkOut <= checkIn
    ) {
        return {
            action: 'invalid_checkout_time',
            staffAttendanceId: existing.staff_attendance_id,
        };
    }

    /*
     * Only save the checkout here.
     *
     * We intentionally do NOT calculate:
     * - regular_hours
     * - overtime_hours
     * - lunch_deducted_hours
     * - Friday calculations
     *
     * Those belong to the existing Staff attendance/payroll logic.
     */
    await executor.execute(
        `UPDATE staff_attendance
         SET check_out_time = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE staff_attendance_id = ?`,
        [
            punchedAt,
            existing.staff_attendance_id,
        ]
    );

    return {
        action: 'checked_out',
        staffAttendanceId: existing.staff_attendance_id,
    };
}
module.exports = {
    getWorkerRecordDate,
    resolveWorkerAssignment,
    resolvePunchContext,
    getWorkerAttendance,
    getStaffAttendance,
    processPunch,
};