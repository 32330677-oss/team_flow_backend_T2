// services/biometricAttendanceService.js
//
// Turns ONE raw biometric punch into (at most) one attendance change.
// Worker attendance (table `attendance`) and Staff attendance (table
// `staff_attendance`) are handled by separate functions; only small,
// table-agnostic helpers are shared.
//
// Phase 2 rules (see PHASE_2_MODIFIED_FILES_REPORT.md):
//   * No time thresholds decide what a punch "means" (D4). There is no
//     duplicate-IN debounce and no shift-duration window.
//   * An IN never moves record_date (A1). An IN creates a session for its own
//     date only, or goes to NeedsReview.
//   * A second IN while the person's latest session is still open (same day
//     or across midnight) is AMBIGUOUS -> NeedsReview (D4). The admin decides
//     (Use as Checkout / Mark as Duplicate / Keep as New IN / Dismiss).
//   * An OUT closes ONLY the person's latest session, when that session is
//     open and started on the OUT's date or the day before (B2). Anything
//     else -> NeedsReview.
//   * Biometric never modifies a Manual record (source guard). On Biometric
//     records it only (a) creates the record, or (b) fills an EMPTY check-out.
//     It never replaces a value; any replacement is a human decision (A2).
//   * Historical checks use the punch date: device mapping (date-ranged),
//     worker_status_history (D1/C1), staff employment spans (C1), assignment
//     (date-ranged), site status (C3).
//
// The caller owns the transaction (see biometricPunchProcessor): the
// attendance change and the queue status are committed together (#1).

const db = require('../config/db');
const biometricDeviceUserService = require('./biometricDeviceUserService');
const attendanceService = require('./attendanceService');
const { calculateStaffShiftHours } = require('./staffAttendanceService');
const { isEmployedOnDate } = require('./staffEmploymentService');
const { getWorkerStatusOnDate } = require('./workerStatusService');
const { getStaffCompensationForDate } = require('./staffCompensationService');
const { businessToday, addDays } = require('./businessDate');
const { activeOn } = require('./assignmentDates');
const { getSiteStatusOnDate } = require('./siteStatusService');
const { findLockedWorkerBatch, findLockedStaffBatch } = require('./payrollLock');
const anomalyService = require('./anomalyService');

// Technical import window (not a shift rule, not a payroll rule).
// §19: measured from punched_at to the date the punch was RECEIVED (imported),
// so a delay in processing never turns a valid punch into an Invalid one.
// An Admin can restore an Invalid punch with a reason (D-04, window_override).
const MAX_PUNCH_AGE_DAYS = Math.max(1, Number(process.env.BIOMETRIC_MAX_PUNCH_AGE_DAYS) || 30);

const TABLES = {
  Worker: { table: 'attendance', pk: 'attendance_id', owner: 'worker_id' },
  Staff: { table: 'staff_attendance', pk: 'staff_attendance_id', owner: 'staff_id' },
};

// Human-readable explanation for every result code (stored in processing_error
// for NeedsReview/Invalid items so the Daily Review can show it as-is).
const MESSAGES = {
  future_punch: 'The punch time is in the future (check the device clock). Retry once that time has passed.',
  punch_too_old: `The punch was imported more than ${MAX_PUNCH_AGE_DAYS} days after it happened. An Admin can restore it for processing with a reason.`,
  long_duration: 'Closing the open session with this OUT would create an unusually long shift. Check for a missing OUT / IN before deciding.',
  payroll_period_finalized: 'The punch date is inside a finalized/paid payroll period. Attendance there is locked; use the Admin correction workflow.',
  site_status_unknown: 'The site is not Active today and has no status history, so its status on the punch date is unknown.',
  unmapped: 'The device employee ID is not mapped to a worker/staff member on the punch date.',
  worker_inactive_on_date: 'The worker was Inactive on the punch date (worker status history).',
  worker_status_unknown: 'The worker is currently Inactive and has no status history, so the status on the punch date is unknown.',
  no_assignment: 'The worker has no site/shift assignment on the punch date.',
  multiple_assignments: 'The worker has more than one site/shift assignment on the punch date.',
  site_not_active: 'The site is not Active.',
  staff_not_employed_on_date: 'The staff member was not employed on the punch date.',
  no_supervisor_assignment: 'The staff member has no Staff Supervisor assignment on the punch date.',
  manual_record_exists: 'A manually recorded attendance exists; biometric never changes manual attendance.',
  already_applied: 'This punch is already reflected on the attendance record.',
  record_locked: 'The attendance record is already Submitted/Approved.',
  record_rejected: 'The attendance record is Rejected and is being corrected by the supervisor.',
  human_edited: 'The attendance record was edited by a person; biometric will not overwrite it.',
  ambiguous_consecutive_in: 'A new IN arrived while the previous session is still open (no OUT). Decide whether it is the checkout, a duplicate or a new session.',
  consecutive_in: 'A second IN arrived for a session that is still open.',
  earlier_in_same_day: 'An IN earlier than the recorded check-in arrived for the same day.',
  in_within_session: 'An IN arrived between the recorded check-in and check-out.',
  second_session_same_day: 'An IN arrived after the session of this day was already closed.',
  out_without_in: 'An OUT arrived but there is no earlier session to close.',
  consecutive_out: 'An OUT arrived after the session was already closed.',
  out_within_session: 'An OUT arrived between the recorded check-in and check-out.',
  out_far_from_session: 'The latest open session did not start on the OUT date or the day before.',
  session_not_present: 'The session is not marked Present.',
  open_break: 'The worker has an open break. End the break, then retry.',
  invalid_duration: 'Hours could not be calculated for this check-out.',
  created: 'Attendance session created from this IN.',
  checked_in_existing: 'Check-in set on the existing draft.',
  checked_out: 'Check-out applied to the open session.',
  used_as_checkout: 'Applied as the check-out of the selected session (admin decision).',
  kept_as_new_in: 'Kept as a new IN session (admin decision).',
};

function serviceError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.isOperational = true;
  return error;
}

function outcome(status, result, extra = {}) {
  return {
    status,
    result,
    message: extra.message || MESSAGES[result] || null,
    targetTable: extra.targetTable || null,
    targetRecordId: extra.targetRecordId || null,
    mappingId: extra.mappingId || null,
    entity: extra.entity || null,
  };
}

const toWall = (value) => String(value).replace('T', ' ').slice(0, 19);
const sameWall = (a, b) => a !== null && a !== undefined && toWall(a) === toWall(b);
const dateOf = (value) => String(value).slice(0, 10);

function businessNowWall() {
  const timeZone = process.env.APP_TIME_ZONE || 'Asia/Beirut';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${v.year}-${v.month}-${v.day} ${v.hour}:${v.minute}:${v.second}`;
}

// Returns 'future_punch' | 'punch_too_old' | null.
//   future: punched_at later than now (+5 min clock tolerance) -> NeedsReview
//           (retriable once the time has passed; never permanently Invalid)
//   too old: received (imported) more than MAX_PUNCH_AGE_DAYS days after
//           punched_at -> Invalid unless an Admin restored it (D-04)
function checkPunchWindow(punchWall, receivedDate = null, ignoreAge = false) {
  const now = businessNowWall();
  const [d, t] = now.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const tol = new Date(Date.UTC(y, mo - 1, da, h, mi + 5));
  const pad = (n) => String(n).padStart(2, '0');
  const nowPlus = `${tol.getUTCFullYear()}-${pad(tol.getUTCMonth() + 1)}-${pad(tol.getUTCDate())} ${pad(tol.getUTCHours())}:${pad(tol.getUTCMinutes())}:00`;
  if (punchWall > nowPlus) return 'future_punch';
  if (!ignoreAge) {
    const reference = receivedDate || businessToday();
    if (punchWall.slice(0, 10) < addDays(reference, -MAX_PUNCH_AGE_DAYS)) return 'punch_too_old';
  }
  return null;
}

function lockState(rec) {
  if (rec.status === 'Submitted' || rec.status === 'Approved') return 'record_locked';
  if (rec.status === 'Rejected') return 'record_rejected';
  return null;
}

function isOpenSession(rec) {
  return Boolean(rec && rec.check_in_time && !rec.check_out_time && rec.attendance_status === 'Present');
}

// Any audit row on the record means a person touched it (biometric
// processing itself never writes audit rows on attendance tables).
async function isHumanTouched(table, id, executor) {
  const [rows] = await executor.execute(
    'SELECT 1 FROM auditlogs WHERE table_name = ? AND record_id = ? LIMIT 1',
    [table, id]
  );
  return rows.length > 0;
}

// The person's latest session (any site/shift) that started strictly before
// the punch. Look-back is bounded by the punch retention window only.
async function latestSessionBefore(kind, ownerId, punchWall, executor) {
  const t = TABLES[kind];
  const lowerBound = `${addDays(punchWall.slice(0, 10), -(MAX_PUNCH_AGE_DAYS + 2))} 00:00:00`;
  const [rows] = await executor.execute(
    `SELECT * FROM ${t.table}
     WHERE ${t.owner} = ? AND check_in_time IS NOT NULL
       AND check_in_time < ? AND check_in_time >= ?
     ORDER BY check_in_time DESC, ${t.pk} DESC
     LIMIT 1 FOR UPDATE`,
    [ownerId, punchWall, lowerBound]
  );
  return rows[0] || null;
}

// D-05: the site status that applied on the punch date (site_status_history).
async function siteCheck(siteId, date, executor) {
  const r = await getSiteStatusOnDate(siteId, date, executor);
  if (r.status === 'Active') return null;
  if (r.status === 'Unknown') {
    return { result: 'site_status_unknown', message: `Site "${r.site ? r.site.site_name : siteId}" is ${r.site ? r.site.site_status : 'missing'} today and has no status history, so its status on ${date} is unknown.` };
  }
  return { result: 'site_not_active', message: `Site "${r.site ? r.site.site_name : siteId}" was ${r.status} on ${date}.` };
}

// ---------------- Worker helpers ----------------

// Date-ranged assignment on the punch date. Status is NOT read from
// workers.status any more: historical status comes from worker_status_history.
async function resolveWorkerAssignment(workerId, punchDate, executor = db) {
  const [rows] = await executor.execute(
    `SELECT wsa.worker_id, wsa.site_id, wsa.shift_type
     FROM workersiteassignments wsa
     WHERE wsa.worker_id = ?
       AND wsa.assigned_date <= ?
       AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ?)
     ORDER BY wsa.assigned_date DESC`,
    [workerId, punchDate, punchDate]
  );
  if (rows.length === 0) return { none: true };
  if (rows.length > 1) return { multiple: true };
  return {
    siteId: rows[0].site_id,
    shiftType: ['Day', 'Night'].includes(rows[0].shift_type) ? rows[0].shift_type : 'Day',
  };
}

// ---------------- Staff helpers ----------------

async function staffSiteOnDate(staffId, date, executor) {
  const [rows] = await executor.execute(
    `SELECT site_id FROM staff_site_assignments
     WHERE staff_id = ? AND assigned_date <= ?
       AND (unassigned_date IS NULL OR unassigned_date >= ?)
     ORDER BY assigned_date DESC LIMIT 1`,
    [staffId, date, date]
  );
  if (rows.length) return rows[0].site_id;
  const [[sm]] = await executor.execute('SELECT site_id FROM staff_members WHERE staff_id = ?', [staffId]);
  return sm?.site_id || null;
}

async function staffStandardMinutes(rec, executor) {
  if (Number(rec.standard_minutes_snapshot) > 0) return Number(rec.standard_minutes_snapshot);
  const comp = await getStaffCompensationForDate(rec.staff_id, dateOf(rec.record_date), executor);
  return Math.round((comp ? comp.standard_daily_hours : 8) * 60);
}

async function writeStaffHours(rec, inWall, outWall, executor) {
  const snapshotMinutes = await staffStandardMinutes(rec, executor);
  const shift = calculateStaffShiftHours({
    checkInRaw: inWall,
    checkOutRaw: outWall,
    lunchStartRaw: rec.lunch_start_time,
    lunchEndRaw: rec.lunch_end_time,
    recordDate: inWall.slice(0, 10),
    standardDailyHours: snapshotMinutes / 60,
  });
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

// ---------------- IN on an existing record of the same date ----------------

async function inOnExistingRecord(kind, ex, punchWall, executor) {
  const t = TABLES[kind];
  const id = ex[t.pk];
  const target = { targetTable: t.table, targetRecordId: id };

  if (ex.source !== 'Biometric') return outcome('Skipped', 'manual_record_exists', target);
  if (ex.check_in_time && sameWall(ex.check_in_time, punchWall)) {
    return outcome('Skipped', 'already_applied', target);
  }

  const locked = lockState(ex);
  if (locked) return outcome('NeedsReview', locked, target);

  if (ex.check_in_time) {
    const inWall = toWall(ex.check_in_time);
    if (punchWall < inWall) return outcome('NeedsReview', 'earlier_in_same_day', target);
    if (!ex.check_out_time) return outcome('NeedsReview', 'consecutive_in', target);
    if (punchWall <= toWall(ex.check_out_time)) return outcome('NeedsReview', 'in_within_session', target);
    return outcome('NeedsReview', 'second_session_same_day', target);
  }

  // Biometric Draft without a check-in (only possible after a human change).
  if (await isHumanTouched(t.table, id, executor)) return outcome('NeedsReview', 'human_edited', target);

  if (kind === 'Worker') {
    await executor.execute(
      `UPDATE attendance
       SET check_in_time = ?, attendance_status = 'Present', management_leave_hours = 0,
           total_working_hours = NULL, overtime_hours = 0, remarks = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE attendance_id = ? AND status = 'Draft' AND source = 'Biometric'`,
      [punchWall, id]
    );
  } else {
    await executor.execute(
      `UPDATE staff_attendance
       SET check_in_time = ?, attendance_status = 'Present', updated_at = CURRENT_TIMESTAMP
       WHERE staff_attendance_id = ? AND status = 'Draft' AND source = 'Biometric'`,
      [punchWall, id]
    );
  }
  return outcome('Processed', 'checked_in_existing', target);
}

// ---------------- Worker IN ----------------

async function workerIn(workerId, punchWall, userId, executor, override) {
  const punchDate = punchWall.slice(0, 10);

  const status = await getWorkerStatusOnDate(workerId, punchDate, executor);
  if (status.status === 'Inactive') return outcome('NeedsReview', 'worker_inactive_on_date');
  if (status.status !== 'Active') return outcome('NeedsReview', 'worker_status_unknown');

  const assignment = await resolveWorkerAssignment(workerId, punchDate, executor);
  if (assignment.none) return outcome('NeedsReview', 'no_assignment');
  if (assignment.multiple) return outcome('NeedsReview', 'multiple_assignments');

  const siteIssue = await siteCheck(assignment.siteId, punchDate, executor);
  if (siteIssue) return outcome('NeedsReview', siteIssue.result, { message: siteIssue.message });

  if (await findLockedWorkerBatch(executor, { siteId: assignment.siteId, date: punchDate })) {
    return outcome('NeedsReview', 'payroll_period_finalized');
  }

  const [rows] = await executor.execute(
    `SELECT * FROM attendance
     WHERE worker_id = ? AND site_id = ? AND shift_type = ? AND record_date = ?
     LIMIT 1 FOR UPDATE`,
    [workerId, assignment.siteId, assignment.shiftType, punchDate]
  );
  if (rows.length) return inOnExistingRecord('Worker', rows[0], punchWall, executor);

  if (!override.keepAsNewIn) {
    const latest = await latestSessionBefore('Worker', workerId, punchWall, executor);
    if (isOpenSession(latest)) {
      return outcome('NeedsReview', 'ambiguous_consecutive_in', {
        targetTable: 'attendance', targetRecordId: latest.attendance_id,
      });
    }
  }

  const [ins] = await executor.execute(
    `INSERT INTO attendance
       (worker_id, site_id, shift_type, record_date, check_in_time, attendance_status,
        status, recorded_by_user_id, source)
     VALUES (?, ?, ?, ?, ?, 'Present', 'Draft', ?, 'Biometric')`,
    [workerId, assignment.siteId, assignment.shiftType, punchDate, punchWall, userId]
  );
  return outcome('Processed', override.keepAsNewIn ? 'kept_as_new_in' : 'created', {
    targetTable: 'attendance', targetRecordId: ins.insertId,
  });
}

// ---------------- Staff IN ----------------

async function staffIn(staffId, punchWall, userId, executor, override) {
  const punchDate = punchWall.slice(0, 10);

  // Historical employment spans only (staff_status_history), never current status.
  if (!(await isEmployedOnDate(staffId, punchDate, executor))) {
    return outcome('NeedsReview', 'staff_not_employed_on_date');
  }

  const [sup] = await executor.execute(
    `SELECT 1 FROM staff_supervisor_assignments
     WHERE staff_id = ? AND assigned_date <= ?
       AND (unassigned_date IS NULL OR unassigned_date >= ?) LIMIT 1`,
    [staffId, punchDate, punchDate]
  );
  if (!sup.length) return outcome('NeedsReview', 'no_supervisor_assignment');

  const siteId = await staffSiteOnDate(staffId, punchDate, executor);
  if (siteId) {
    const siteIssue = await siteCheck(siteId, punchDate, executor);
    if (siteIssue) return outcome('NeedsReview', siteIssue.result, { message: siteIssue.message });
  }
  if (await findLockedStaffBatch(executor, { date: punchDate })) {
    return outcome('NeedsReview', 'payroll_period_finalized');
  }

  const [rows] = await executor.execute(
    'SELECT * FROM staff_attendance WHERE staff_id = ? AND record_date = ? LIMIT 1 FOR UPDATE',
    [staffId, punchDate]
  );
  if (rows.length) return inOnExistingRecord('Staff', rows[0], punchWall, executor);

  if (!override.keepAsNewIn) {
    const latest = await latestSessionBefore('Staff', staffId, punchWall, executor);
    if (isOpenSession(latest)) {
      return outcome('NeedsReview', 'ambiguous_consecutive_in', {
        targetTable: 'staff_attendance', targetRecordId: latest.staff_attendance_id,
      });
    }
  }

  // D3: standard hours that applied on the punch date.
  const comp = await getStaffCompensationForDate(staffId, punchDate, executor);
  const hours = comp ? comp.standard_daily_hours : 8;

  // Friday: created with is_friday_worked = 0. The supervisor must confirm it
  // (submit is blocked until confirmed, see staffAttendanceSupervisorController).
  const [ins] = await executor.execute(
    `INSERT INTO staff_attendance
       (staff_id, record_date, check_in_time, attendance_status, is_friday_worked, is_paid,
        is_management_paid_absence, standard_minutes_snapshot, recorded_by_user_id, status, source)
     VALUES (?, ?, ?, 'Present', 0, 1, 0, ?, ?, 'Draft', 'Biometric')`,
    [staffId, punchDate, punchWall, Math.round(hours * 60), userId]
  );
  return outcome('Processed', override.keepAsNewIn ? 'kept_as_new_in' : 'created', {
    targetTable: 'staff_attendance', targetRecordId: ins.insertId,
  });
}

// ---------------- OUT (and admin "Use as Checkout") ----------------

async function applyOut(kind, ownerId, punchWall, executor, override) {
  const t = TABLES[kind];
  const punchDate = punchWall.slice(0, 10);
  const latest = await latestSessionBefore(kind, ownerId, punchWall, executor);

  let rec = latest;
  if (override.useAsCheckout) {
    if (!latest || latest[t.pk] !== Number(override.targetRecordId)) {
      throw serviceError('Use as Checkout is only allowed on the person\'s latest session before this punch.', 409);
    }
  }
  if (!rec) return outcome('NeedsReview', 'out_without_in');

  const id = rec[t.pk];
  const target = { targetTable: t.table, targetRecordId: id };

  if (rec.source !== 'Biometric') {
    if (override.useAsCheckout) throw serviceError('Biometric never modifies a manual attendance record.', 409);
    return outcome('Skipped', 'manual_record_exists', target);
  }

  if (rec.check_out_time && sameWall(rec.check_out_time, punchWall)) {
    return outcome('Skipped', 'already_applied', target);
  }

  const locked = lockState(rec);
  if (locked) {
    if (override.useAsCheckout) throw serviceError('The session is not a Draft anymore.', 409);
    return outcome('NeedsReview', locked, target);
  }

  if (rec.check_out_time && !override.useAsCheckout) {
    return outcome('NeedsReview', punchWall > toWall(rec.check_out_time) ? 'consecutive_out' : 'out_within_session', target);
  }

  if (rec.attendance_status !== 'Present') {
    if (override.useAsCheckout) throw serviceError('The session is not marked Present.', 409);
    return outcome('NeedsReview', 'session_not_present', target);
  }

  // B2: an automatic OUT only closes a session of the same or previous calendar date.
  const sessionDate = dateOf(rec.record_date);
  if (!override.useAsCheckout && sessionDate !== punchDate && sessionDate !== addDays(punchDate, -1)) {
    return outcome('NeedsReview', 'out_far_from_session', target);
  }

  // D-02: never change attendance inside a finalized/paid payroll period.
  const lockedBatch = kind === 'Worker'
    ? await findLockedWorkerBatch(executor, { siteId: rec.site_id, date: sessionDate })
    : await findLockedStaffBatch(executor, { date: sessionDate });
  if (lockedBatch) {
    if (override.useAsCheckout) throw serviceError(MESSAGES.payroll_period_finalized, 409);
    return outcome('NeedsReview', 'payroll_period_finalized', target);
  }

  // D-09 / §11: duration is a warning signal only. An automatic OUT never
  // closes a session that would become unreasonably long (e.g. Sunday IN with
  // no OUT, closed by Monday's OUT ~30 h later): the punch goes to Needs Review
  // and an Admin decides (Use as Checkout applies it explicitly, flagged).
  if (!override.useAsCheckout) {
    const longCheck = await anomalyService.evaluateSession(toWall(rec.check_in_time), punchWall, sessionDate);
    if (longCheck) {
      return outcome('NeedsReview', 'long_duration', { ...target, message: `${MESSAGES.long_duration} ${longCheck.detail}` });
    }
  }

  if (kind === 'Worker') {
    const siteIssue = await siteCheck(rec.site_id, sessionDate, executor);
    if (siteIssue) {
      if (override.useAsCheckout) throw serviceError(siteIssue.message, 409);
      return outcome('NeedsReview', siteIssue.result, { ...target, message: siteIssue.message });
    }
    const [[openLeave]] = await executor.execute(
      'SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NULL LIMIT 1',
      [id]
    );
    if (openLeave) {
      if (override.useAsCheckout) throw serviceError('The worker has an open break. End it first.', 409);
      return outcome('NeedsReview', 'open_break', target);
    }
  }

  const inWall = toWall(rec.check_in_time);
  await executor.query('SAVEPOINT bio_out');
  try {
    if (kind === 'Worker') {
      await executor.execute(
        `UPDATE attendance SET check_out_time = ?, updated_at = CURRENT_TIMESTAMP
         WHERE attendance_id = ? AND status = 'Draft' AND source = 'Biometric'`,
        [punchWall, id]
      );
      await attendanceService.calculateWorkingHours(id, executor);
    } else {
      await executor.execute(
        `UPDATE staff_attendance SET check_out_time = ?, updated_at = CURRENT_TIMESTAMP
         WHERE staff_attendance_id = ? AND status = 'Draft' AND source = 'Biometric'`,
        [punchWall, id]
      );
      await writeStaffHours(rec, inWall, punchWall, executor);
      const staffAnomaly = await anomalyService.evaluateSession(inWall, punchWall, sessionDate);
      await anomalyService.applyAnomalyFlag(executor, 'staff_attendance', 'staff_attendance_id', id, staffAnomaly);
    }
    await executor.query('RELEASE SAVEPOINT bio_out');
  } catch (calcError) {
    await executor.query('ROLLBACK TO SAVEPOINT bio_out');
    if (override.useAsCheckout) throw serviceError(calcError.message, 409);
    return outcome('NeedsReview', 'invalid_duration', { ...target, message: `Hours could not be calculated: ${calcError.message}` });
  }

  return outcome('Processed', override.useAsCheckout ? 'used_as_checkout' : 'checked_out', target);
}

// ---------------- Entry point ----------------

/**
 * Resolve and apply one punch on the CALLER's connection/transaction.
 *
 * @param punch    { device_employee_id, punched_at, punch_type }
 * @param override { keepAsNewIn?: true } | { useAsCheckout?: true, targetRecordId }
 * @returns outcome { status, result, message, mappingId, targetTable, targetRecordId, entity }
 */
async function resolvePunch(punch, recordedByUserId, executor, override = {}) {
  const userId = Number(recordedByUserId);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw serviceError('A valid recordedByUserId is required for biometric attendance.');
  }
  if (!punch || !punch.device_employee_id || !punch.punched_at) {
    throw serviceError('device_employee_id and punched_at are required.');
  }
  if (!['IN', 'OUT'].includes(punch.punch_type)) {
    throw serviceError(`Unsupported punch type: ${punch.punch_type}`);
  }

  const punchWall = toWall(punch.punched_at);
  const receivedDate = punch.received_at ? String(punch.received_at).slice(0, 10) : null;
  const windowIssue = checkPunchWindow(punchWall, receivedDate, override.ignoreWindow === true);
  if (windowIssue === 'future_punch') return outcome('NeedsReview', 'future_punch');
  if (windowIssue) return outcome('Invalid', windowIssue);

  const mapping = await biometricDeviceUserService.resolveDeviceUser(
    punch.device_employee_id, punchWall, executor
  );
  if (!mapping) return outcome('NeedsReview', 'unmapped');

  const kind = mapping.entity_type;
  if (kind !== 'Worker' && kind !== 'Staff') {
    throw serviceError(`Unsupported biometric entity type: ${kind}`, 409);
  }
  const ownerId = kind === 'Worker' ? mapping.worker_id : mapping.staff_id;

  let result;
  if (override.useAsCheckout || punch.punch_type === 'OUT') {
    result = await applyOut(kind, ownerId, punchWall, executor, override);
  } else if (kind === 'Worker') {
    result = await workerIn(ownerId, punchWall, userId, executor, override);
  } else {
    result = await staffIn(ownerId, punchWall, userId, executor, override);
  }

  result.mappingId = mapping.mapping_id;
  result.entity = { type: kind, id: ownerId };
  return result;
}

/**
 * Backwards-compatible single-punch entry (own transaction). Kept for any
 * caller outside the queue; the queue uses resolvePunch inside its own
 * transaction so the queue row is committed atomically with the change.
 */
async function processPunch(punch, recordedByUserId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await resolvePunch(punch, recordedByUserId, connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  MESSAGES,
  MAX_PUNCH_AGE_DAYS,
  resolvePunch,
  processPunch,
  resolveWorkerAssignment,
  latestSessionBefore,
  isOpenSession,
  checkPunchWindow,
  toWall,
};
