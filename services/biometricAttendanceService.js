const db = require('../config/db');
const biometricDeviceUserService = require('./biometricDeviceUserService');
const attendanceService = require('./attendanceService');
const { calculateStaffShiftHours } = require('./staffAttendanceService');
const { getActiveSpansOverlapping } = require('./staffEmploymentService');

// Business rules (override through .env)
const MAX_SHIFT_HOURS = Math.min(23, Math.max(1, Number(process.env.BIOMETRIC_MAX_SHIFT_HOURS) || 16));
const MAX_PUNCH_AGE_DAYS = Math.max(1, Number(process.env.BIOMETRIC_MAX_PUNCH_AGE_DAYS) || 30);

const TABLES = {
  Worker: { table: 'attendance', pk: 'attendance_id', owner: 'worker_id' },
  Staff: { table: 'staff_attendance', pk: 'staff_attendance_id', owner: 'staff_id' },
};

function createServiceError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeShift(value) {
  return ['Day', 'Night'].includes(value) ? value : 'Day';
}

// ---------- wall-clock helpers (no timezone conversion, same as the rest of the codebase) ----------
const pad = (n) => String(n).padStart(2, '0');

function toWall(value) {
  return String(value).replace('T', ' ').slice(0, 19);
}

function wallToMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw createServiceError('Invalid punch datetime.');
  return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function msToWall(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const shiftWall = (s, hours) => msToWall(wallToMs(s) + hours * 3600000);
const addDays = (dateStr, n) => msToWall(wallToMs(`${dateStr} 00:00:00`) + n * 86400000).slice(0, 10);

function businessToday() {
  const timeZone = process.env.APP_TIME_ZONE || 'Asia/Beirut';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${v.year}-${v.month}-${v.day}`;
}

// Rule 10: no future punches, none older than MAX_PUNCH_AGE_DAYS.
function checkPunchWindow(punchDate) {
  const today = businessToday();
  if (punchDate > today) return 'future_punch';
  if (punchDate < addDays(today, -MAX_PUNCH_AGE_DAYS)) return 'punch_too_old';
  return null;
}

function gate(rec) {
  if (rec.status === 'Submitted' || rec.status === 'Approved') return 'ignored_locked';
  if (rec.status === 'Rejected') return 'ignored_rejected';
  return null;
}

// ---------- Worker assignment (same rule as manual verifyWorkerAssignedToSite) ----------
async function resolveWorkerAssignment(workerId, punchDate, executor = db) {
  const [rows] = await executor.execute(
    `SELECT wsa.worker_id, wsa.site_id, wsa.shift_type
     FROM workersiteassignments wsa
     JOIN workers w ON w.worker_id = wsa.worker_id
     WHERE wsa.worker_id = ?
       AND wsa.assigned_date <= ?
       AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date > ?)
       AND w.status = 'Active'
     ORDER BY wsa.assigned_date DESC`,
    [workerId, punchDate, punchDate]
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw createServiceError(
      `Worker ${workerId} has multiple active site/shift assignments on ${punchDate}. Punch requires manual review.`,
      409
    );
  }
  return { siteId: rows[0].site_id, shiftType: normalizeShift(rows[0].shift_type) };
}

// scope = { siteId, shiftType } (Worker only). When given, only that site/shift is searched.
// When absent (overnight OUT, or a worker with no assignment on the punch date), the candidate
// records themselves decide the site/shift; ambiguity is never guessed.
async function findSession(kind, ownerId, punchWall, direction, executor, scope = null) {
  const t = TABLES[kind];
  const lower = shiftWall(punchWall, -MAX_SHIFT_HOURS);
  const upper = direction === 'OUT' ? punchWall : shiftWall(punchWall, MAX_SHIFT_HOURS);

  const params = [ownerId, lower, upper];
  let scopeSql = '';
  if (kind === 'Worker' && scope) {
    scopeSql = ' AND site_id = ? AND shift_type = ?';
    params.push(scope.siteId, scope.shiftType);
  }

  const [rows] = await executor.execute(
    `SELECT * FROM ${t.table}
     WHERE ${t.owner} = ? AND check_in_time IS NOT NULL
       AND check_in_time BETWEEN ? AND ?${scopeSql}
     ORDER BY ABS(TIMESTAMPDIFF(SECOND, check_in_time, ?)) ASC, check_in_time DESC
     FOR UPDATE`,
    [...params, punchWall]
  );

  if (kind !== 'Worker' || scope || rows.length <= 1) return rows[0] || null;

  // Unscoped Worker lookup: candidates from different site/shift are never merged.
  const keys = new Set(rows.map((r) => `${r.site_id}|${r.shift_type}`));
  if (keys.size === 1) return rows[0];

  const a = await resolveWorkerAssignment(ownerId, punchWall.slice(0, 10), executor);
  const match = a ? rows.find((r) => r.site_id === a.siteId && r.shift_type === a.shiftType) : null;
  if (match) return match;

  throw createServiceError(
    `Worker ${ownerId} punch matches sessions from more than one site/shift. Requires manual review.`,
    409
  );
}

// ---------- Hours ----------
async function staffHours(rec, inWall, outWall, executor) {
  const [[sm]] = await executor.execute(
    'SELECT standard_daily_hours FROM staff_members WHERE staff_id = ?',
    [rec.staff_id]
  );
  const profileHours = Number(sm?.standard_daily_hours) > 0 ? Number(sm.standard_daily_hours) : 8;
  const snapshotMinutes = Number(rec.standard_minutes_snapshot) > 0
    ? Number(rec.standard_minutes_snapshot)
    : Math.round(profileHours * 60);

  const shift = calculateStaffShiftHours({
    checkInRaw: inWall,
    checkOutRaw: outWall,
    lunchStartRaw: rec.lunch_start_time,
    lunchEndRaw: rec.lunch_end_time,
    recordDate: inWall.slice(0, 10),
    standardDailyHours: snapshotMinutes / 60,
  });
  return { shift, snapshotMinutes };
}

async function writeStaffHours(rec, inWall, outWall, executor) {
  const { shift, snapshotMinutes } = await staffHours(rec, inWall, outWall, executor);
  await executor.execute(
    `UPDATE staff_attendance
     SET regular_hours = ?, overtime_hours = ?, lunch_deducted_hours = ?,
         standard_minutes_snapshot = COALESCE(standard_minutes_snapshot, ?),
         updated_at = CURRENT_TIMESTAMP
     WHERE staff_attendance_id = ?`,
    [shift.regularHours.toFixed(2), shift.overtimeHours.toFixed(2), shift.lunchHours.toFixed(2),
      snapshotMinutes, rec.staff_attendance_id]
  );
}

async function applyInToSession(kind, rec, punchWall, executor) {
  const t = TABLES[kind];
  const id = rec[t.pk];

  // Biometric never touches a Manual record.
  if (rec.source !== 'Biometric') return { action: 'ignored_manual', id };

  const blocked = gate(rec);
  if (blocked) return { action: blocked, id };

  const curIn = toWall(rec.check_in_time);
  if (punchWall >= curIn) return { action: 'already_checked_in', id };   // removed: || rec.source !== 'Biometric'

  const newDate = punchWall.slice(0, 10);
  const oldDate = String(rec.record_date).slice(0, 10);

  if (newDate !== oldDate) {
    const [conflict] = kind === 'Worker'
      ? await executor.execute(
          `SELECT 1 FROM attendance
           WHERE worker_id = ? AND site_id = ? AND shift_type = ? AND record_date = ? AND attendance_id <> ? LIMIT 1`,
          [rec.worker_id, rec.site_id, rec.shift_type, newDate, id])
      : await executor.execute(
          `SELECT 1 FROM staff_attendance
           WHERE staff_id = ? AND record_date = ? AND staff_attendance_id <> ? LIMIT 1`,
          [rec.staff_id, newDate, id]);
    if (conflict.length) return { action: 'conflict_review', id };
  }

  await executor.execute(
    `UPDATE ${t.table} SET check_in_time = ?, record_date = ?, updated_at = CURRENT_TIMESTAMP WHERE ${t.pk} = ?`,
    [punchWall, newDate, id]
  );

  if (rec.check_out_time) {
    if (kind === 'Worker') await attendanceService.calculateWorkingHours(id, executor);
    else await writeStaffHours(rec, punchWall, toWall(rec.check_out_time), executor);
  }
  return { action: 'checked_in_updated_earlier', id };
}

async function applyOutToSession(kind, rec, punchWall, executor) {
  const t = TABLES[kind];
  const id = rec[t.pk];

  // Manual IN with no OUT must NOT be completed by a biometric OUT.
  if (rec.source !== 'Biometric') return { action: 'ignored_manual', id };

  const blocked = gate(rec);
  if (blocked) return { action: blocked, id };

  const inWall = toWall(rec.check_in_time);
  if (punchWall <= inWall) return { action: 'invalid_checkout_time', id };

  if (rec.check_out_time) {
    const curOut = toWall(rec.check_out_time);
    if (punchWall <= curOut) return { action: 'already_checked_out', id };   // removed: || rec.source !== 'Biometric'
  }

  if (kind === 'Worker') {
    // Same rule as manual checkOut: no open break.
    const [[openLeave]] = await executor.execute(
      `SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NULL LIMIT 1`,
      [id]
    );
    if (openLeave) return { action: 'open_break', id };

    await executor.execute(
      `UPDATE attendance SET check_out_time = ?, attendance_status = 'Present', updated_at = CURRENT_TIMESTAMP
       WHERE attendance_id = ?`,
      [punchWall, id]
    );
    await attendanceService.calculateWorkingHours(id, executor);
  } else {
    await executor.execute(
      `UPDATE staff_attendance SET check_out_time = ?, updated_at = CURRENT_TIMESTAMP WHERE staff_attendance_id = ?`,
      [punchWall, id]
    );
    await writeStaffHours(rec, inWall, punchWall, executor);
  }

  return { action: rec.check_out_time ? 'checked_out_updated_later' : 'checked_out', id };
}

// ---------- Worker IN (create) ----------
async function workerIn(workerId, punchWall, userId, executor) {
  const punchDate = punchWall.slice(0, 10);
  const assignment = await resolveWorkerAssignment(workerId, punchDate, executor);

  // Day and Night (or two sites) can never merge:
  // session search is scoped to the assigned site/shift.
  const session = await findSession(
    'Worker',
    workerId,
    punchWall,
    'IN',
    executor,
    assignment
  );

  if (session) {
    return applyInToSession('Worker', session, punchWall, executor);
  }

  if (!assignment) return { unresolved: 'no_assignment' };
  const [rows] = await executor.execute(
    `SELECT * FROM attendance
     WHERE worker_id = ? AND site_id = ? AND shift_type = ? AND record_date = ? LIMIT 1 FOR UPDATE`,
    [workerId, assignment.siteId, assignment.shiftType, punchDate]
  );

  if (rows.length) {
    const ex = rows[0];
    const blocked = gate(ex);
    if (blocked) return { action: blocked, id: ex.attendance_id };
    if (ex.source !== 'Biometric') return { action: 'ignored_manual', id: ex.attendance_id };
    if (ex.status === 'Draft' && !ex.check_in_time) {
      // Same reset the manual check-in does when reviving an Absent/Sick Draft.
      await executor.execute(
        `UPDATE attendance
         SET check_in_time = ?, attendance_status = 'Present', management_leave_hours = 0,
             total_working_hours = NULL, overtime_hours = 0, remarks = NULL,
             source = 'Biometric', updated_at = CURRENT_TIMESTAMP
         WHERE attendance_id = ? AND status = 'Draft'`,
        [punchWall, ex.attendance_id]
      );
      return { action: 'checked_in_existing', id: ex.attendance_id };
    }
    return { action: 'conflict_review', id: ex.attendance_id };
  }

  const [ins] = await executor.execute(
    `INSERT INTO attendance
       (worker_id, site_id, shift_type, record_date, check_in_time, attendance_status,
        status, recorded_by_user_id, source)
     VALUES (?, ?, ?, ?, ?, 'Present', 'Draft', ?, 'Biometric')`,
    [workerId, assignment.siteId, assignment.shiftType, punchDate, punchWall, userId]
  );
  return { action: 'created', id: ins.insertId };
}

// ---------- Staff IN (create) ----------
async function staffIn(staffId, punchWall, userId, executor) {
  const session = await findSession('Staff', staffId, punchWall, 'IN', executor);
  if (session) return applyInToSession('Staff', session, punchWall, executor);

  const punchDate = punchWall.slice(0, 10);

  const [[sm]] = await executor.execute(
    'SELECT status, standard_daily_hours FROM staff_members WHERE staff_id = ? FOR UPDATE',
    [staffId]
  );
  if (!sm || sm.status !== 'Active') return { unresolved: 'staff_inactive' };

  const spans = await getActiveSpansOverlapping(staffId, punchDate, punchDate, executor);
  if (spans.length === 0) return { unresolved: 'not_employed_on_date' };

  // A staff record nobody can see/submit is useless: require a current supervisor.
   const [sup] = await executor.execute(
    `SELECT 1 FROM staff_supervisor_assignments
     WHERE staff_id = ? AND assigned_date <= ?
       AND (unassigned_date IS NULL OR unassigned_date > ?) LIMIT 1`,
    [staffId, punchDate, punchDate]
  );
  if (!sup.length) return { unresolved: 'no_supervisor_assignment' };

  const [rows] = await executor.execute(
    `SELECT * FROM staff_attendance WHERE staff_id = ? AND record_date = ? LIMIT 1 FOR UPDATE`,
    [staffId, punchDate]
  );
  if (rows.length) {
    const ex = rows[0];
    const blocked = gate(ex);
    if (blocked) return { action: blocked, id: ex.staff_attendance_id };
    if (ex.source !== 'Biometric') return { action: 'ignored_manual', id: ex.staff_attendance_id };   // NEW
    if (ex.status === 'Draft' && !ex.check_in_time) {
      await executor.execute(
        `UPDATE staff_attendance
         SET check_in_time = ?, attendance_status = 'Present', source = 'Biometric',
             recorded_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE staff_attendance_id = ?`,
        [punchWall, userId, ex.staff_attendance_id]
      );
      return { action: 'checked_in_existing', id: ex.staff_attendance_id };
    }
    return { action: 'conflict_review', id: ex.staff_attendance_id };
  }

  const hours = Number(sm.standard_daily_hours) > 0 ? Number(sm.standard_daily_hours) : 8;

  // Friday: created with is_friday_worked = 0. The supervisor must confirm it
  // (submit is blocked until confirmed, see staffAttendanceSupervisorController).
  const [ins] = await executor.execute(
    `INSERT INTO staff_attendance
       (staff_id, record_date, check_in_time, attendance_status, is_friday_worked, is_paid,
        is_management_paid_absence, standard_minutes_snapshot, recorded_by_user_id, status, source)
     VALUES (?, ?, ?, 'Present', 0, 1, 0, ?, ?, 'Draft', 'Biometric')`,
    [staffId, punchDate, punchWall, Math.round(hours * 60), userId]
  );
  return { action: 'created', id: ins.insertId };
}

// ---------- Entry point ----------
async function processPunch(punch, recordedByUserId) {
  const userId = Number(recordedByUserId);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw createServiceError('A valid recordedByUserId is required for biometric attendance.');
  }
  if (!punch || !punch.device_employee_id || !punch.punched_at) {
    throw createServiceError('device_employee_id and punched_at are required.');
  }

  const punchWall = toWall(punch.punched_at);
  const windowIssue = checkPunchWindow(punchWall.slice(0, 10));
  if (windowIssue) return { processed: false, status: windowIssue };

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const mapping = await biometricDeviceUserService.resolveDeviceUser(
      punch.device_employee_id, punchWall, connection
    );
    if (!mapping) {
      await connection.commit();
      return { processed: false, status: 'unmapped' };
    }

    const kind = mapping.entity_type;
    if (kind !== 'Worker' && kind !== 'Staff') {
      throw createServiceError(`Unsupported biometric entity type: ${kind}`, 409);
    }
    const ownerId = kind === 'Worker' ? mapping.worker_id : mapping.staff_id;

    let result;
    if (punch.punch_type === 'IN') {
      result = kind === 'Worker'
        ? await workerIn(ownerId, punchWall, userId, connection)
        : await staffIn(ownerId, punchWall, userId, connection);
    } else if (punch.punch_type === 'OUT') {
      const rec = await findSession(kind, ownerId, punchWall, 'OUT', connection);
      result = rec
        ? await applyOutToSession(kind, rec, punchWall, connection)
        : { action: 'no_open_attendance', id: null };
    } else {
      throw createServiceError(`Unsupported punch type: ${punch.punch_type}`);
    }

    await connection.commit();

    if (result.unresolved) return { processed: false, status: result.unresolved };
    return { processed: true, status: 'processed', result };
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { processPunch, resolveWorkerAssignment, findSession };