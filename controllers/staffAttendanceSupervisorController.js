const db = require('../config/db');
const { getAssignedStaffIdsForSupervisor } = require('./staffSupervisorAssignmentController');
const {
  isValidDateOnly,
  isFriday,
  calculateStaffShiftHours,
} = require('../services/staffAttendanceService');
const { getActiveSpansOverlapping } = require('../services/staffEmploymentService');
const { getStaffCompensationForDate } = require('../services/staffCompensationService');
const { businessToday } = require('../services/businessDate');
const { assertStaffDateEditable, findLockedStaffBatch } = require('../services/payrollLock');
const weekGate = require('../services/weekGate');
const anomalyService = require('../services/anomalyService');

// #2: compare two wall-clock values to the minute ('YYYY-MM-DD HH:MM').
const sameMinute = (a, b) => Boolean(a && b) &&
  String(a).replace('T', ' ').slice(0, 16) === String(b).replace('T', ' ').slice(0, 16);

const ATTENDANCE_STATUSES = ['Present', 'Absent', 'Sick', 'Vacation', 'Holiday'];

// 'draft'  -> saved in DB with status 'Draft' (invisible to admin, ignored by payroll)
// 'submit' -> status 'Submitted' (goes to the admin review queue) — the ORIGINAL behavior
const SAVE_MODES = ['draft', 'submit'];

class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.isOperational = true;
    this.statusCode = statusCode;
  }
}

function formatToMySqlDateTime(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(String(value));
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '00'] = match;
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${mo}-${d} ${pad(h)}:${pad(mi)}:${pad(s)}`;
}

// GET /api/staff-attendance/supervisor/day?date=YYYY-MM-DD
// Returns every assigned staff member (Active, plus Inactive ones who still
// have an attendance record on this historical date) with their record (if
// any) for that date, including Draft records, so the supervisor sees what
// was saved earlier. Terminated staff are excluded implicitly because
// termination closes the supervisor assignment (see staffLifecycleController).
exports.getDayView = async (req, res) => {
  const { date } = req.query;
  if (!isValidDateOnly(date)) {
    return res.status(400).json({ status: 'error', message: 'A valid date (YYYY-MM-DD) is required.' });
  }
  const supervisorId = req.user.user_id;
  try {
    const assignedIds = await getAssignedStaffIdsForSupervisor(supervisorId);
    if (assignedIds.length === 0) {
      return res.status(200).json({ status: 'success', data: [] });
    }
    const placeholders = assignedIds.map(() => '?').join(',');
    const [rows] = await db.execute(
      `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.position, sm.standard_daily_hours,
              sm.status AS staff_current_status,
              sa.staff_attendance_id, sa.attendance_status, sa.check_in_time, sa.check_out_time,
              sa.regular_hours, sa.overtime_hours, sa.lunch_deducted_hours,
              sa.lunch_start_time, sa.lunch_end_time,
              COALESCE(sa.standard_minutes_snapshot, ROUND(sm.standard_daily_hours * 60)) AS standard_minutes_snapshot,
              sa.is_friday_worked, sa.status, sa.admin_rejection_notes,
              sa.source, sa.anomaly_code, sa.anomaly_detail
       FROM staff_members sm
       LEFT JOIN staff_attendance sa ON sa.staff_id = sm.staff_id AND sa.record_date = ?
       WHERE sm.staff_id IN (${placeholders})
       ORDER BY sm.full_name`,
      [date, ...assignedIds]
    );
    // Historical employment on that date (staff_status_history spans), never
    // today's status; a record that already exists is always shown.
    const eligibleRows = [];
    for (const row of rows) {
      const spans = await getActiveSpansOverlapping(row.staff_id, date, date);
      if (spans.length > 0 || row.staff_attendance_id) eligibleRows.push(row);
    }
    const locked = await findLockedStaffBatch(db, { date });
    const gate = await weekGate.previousWeekStaffDrafts(db, { staffIds: assignedIds, recordDate: date });

    res.status(200).json({
      status: 'success',
      data: eligibleRows,
      is_friday: isFriday(date), // lets the frontend show the confirmation banner
      day: {
        record_date: date,
        business_today: businessToday(),
        payroll_locked: Boolean(locked),
        payroll_lock_batch_id: locked ? locked.staff_payroll_batch_id : null,
        previous_week_drafts: gate.days,
        previous_week: { start: gate.prevStart, end: gate.prevEnd },
      },
    });
  } catch (error) {
    console.error('GET SUPERVISOR DAY VIEW ERROR:', error);
    res.status(500).json({ status: 'error', message: 'Failed to load staff attendance for this date.' });
  }
};

// POST /api/staff-attendance/supervisor/bulk-set
// body: {
//   record_date,
//   mode: 'draft' | 'submit'   (optional, default 'submit' = previous behavior),
//   entries: [{ staff_id, attendance_status, check_in_time, check_out_time, friday_confirmed }]
// }
//
// Only the staff members listed in `entries` are touched. Everything else that was
// saved earlier for the same date is left exactly as it is.
//
// State rules:
//   - Approved                -> locked, always skipped.
//   - mode 'draft'  on Submitted -> skipped (already with the admin; use Submit to update it).
//   - mode 'draft'  on Draft / Rejected / no record -> saved as Draft.
//   - mode 'submit' on anything not Approved -> saved as Submitted.
//
// friday_confirmed must be explicitly true for any 'Present' entry when
// record_date falls on a Friday (in BOTH modes, because the flag is stored on the
// record and payroll depends on it).
exports.bulkSetAttendance = async (req, res) => {
  const { record_date, entries } = req.body || {};
  const isResubmit = req.body?.resubmit_rejected === true;
  const supervisorId = req.user.user_id;

  if (!isValidDateOnly(record_date)) {
    return res.status(400).json({
      status: 'error',
      message: 'A valid record_date (YYYY-MM-DD) is required.'
    });
  }
const maxAllowed = businessToday();   // B10: business date, not the UTC date

if (record_date > maxAllowed) {
  return res.status(400).json({ status: 'error', message: 'Attendance date cannot be in the future.' });
}


  if (!Array.isArray(entries) || (entries.length === 0 && (req.body?.mode || 'submit') === 'draft')) {
    return res.status(400).json({
      status: 'error',
      message: 'At least one attendance entry is required when saving a draft.'
    });
  }

  const requestedMode = req.body?.mode;
  if (requestedMode !== undefined && !SAVE_MODES.includes(requestedMode)) {
    return res.status(400).json({
      status: 'error',
      message: `mode must be one of: ${SAVE_MODES.join(', ')}.`
    });
  }
  const mode = requestedMode || 'submit';
  const isDraftMode = mode === 'draft';

  if (isResubmit && (isDraftMode || entries.length !== 1)) {
    return res.status(400).json({
      status: 'error',
      message: 'A rejected resubmission must contain exactly one attendance entry.'
    });
  }
  const targetStatus = isDraftMode ? 'Draft' : 'Submitted';

  const dayIsFriday = isFriday(record_date);

  const connection = await db.getConnection();
  const results = { updated: [], skipped: [] };

  try {
    const assignedIds = await getAssignedStaffIdsForSupervisor(supervisorId, connection);
    if (assignedIds.length === 0) {
      throw new AppError('No active staff members are assigned to this supervisor.');
    }
    const assignedSet = new Set(assignedIds);

    await connection.beginTransaction();
    await assertStaffDateEditable(connection, record_date);   // D-02
    if (mode === 'submit' && !isResubmit) {
      const gate = await weekGate.previousWeekStaffDrafts(connection, { staffIds: assignedIds, recordDate: record_date });
      if (gate.days.length > 0) throw weekGate.gateError(gate);   // §10
    }

    if (isResubmit) {
      const staffId = Number(entries[0]?.staff_id);
      const [[rejected]] = await connection.execute(
        `SELECT staff_attendance_id, staff_id, status
         FROM staff_attendance
         WHERE staff_id = ? AND record_date = ?
         LIMIT 1 FOR UPDATE`,
        [staffId, record_date]
      );
      if (!rejected || rejected.status !== 'Rejected') {
        throw new AppError('Only an attendance record currently marked Rejected can be resubmitted.');
      }
    }

    // Day submission is all-or-nothing: validate every active employee in the
    // current supervisor assignment scope before changing any workflow state.
    if (mode === 'submit' && !isResubmit) {
      const [requiredRows] = await connection.execute(
        `SELECT sm.staff_id, sm.full_name, sa.attendance_status
         FROM staff_members sm
         LEFT JOIN staff_attendance sa
           ON sa.staff_id = sm.staff_id AND sa.record_date = ?
         WHERE sm.staff_id IN (${assignedIds.map(() => '?').join(',')})
         ORDER BY sm.full_name`,
        [record_date, ...assignedIds]
      );
      const eligibleRequiredRows = [];
      for (const row of requiredRows) {
        const spans = await getActiveSpansOverlapping(row.staff_id, record_date, record_date, connection);
        if (spans.length > 0) eligibleRequiredRows.push(row);
      }
      const entriesByStaffId = new Map(
        entries.map((entry) => [Number(entry.staff_id), entry.attendance_status])
      );
      const missing = eligibleRequiredRows.filter((row) => {
        const status = entriesByStaffId.has(row.staff_id)
          ? entriesByStaffId.get(row.staff_id)
          : row.attendance_status;
        return !ATTENDANCE_STATUSES.includes(status);
      });
      if (missing.length > 0) {
        const names = missing.map((row) => row.full_name).join(', ');
        throw new AppError(
          `Cannot submit attendance. The following staff members have no attendance status: ${names}`
        );
      }
    }

    for (const entry of entries) {
      const staffId = Number(entry.staff_id);
      const status = entry.attendance_status;

      if (
        !Number.isInteger(staffId) ||
        staffId <= 0 ||
        !ATTENDANCE_STATUSES.includes(status)
      ) {
        results.skipped.push({
          staff_id: entry.staff_id,
          reason: 'Invalid entry'
        });
        continue;
      }

      if (!assignedSet.has(staffId)) {
        results.skipped.push({
          staff_id: staffId,
          reason: 'Staff member is not assigned to you.'
        });
        continue;
      }

      // Friday is a non-working day by default.
      // Recording Present on Friday requires explicit confirmation.
      const fridayConfirmed = entry.friday_confirmed === true;

      if (dayIsFriday && status === 'Present' && !fridayConfirmed) {
        results.skipped.push({
          staff_id: staffId,
          reason:
            'Friday is normally a non-working day. Confirmation is required to record attendance for this staff member.',
          requires_friday_confirmation: true,
        });
        continue;
      }

      const [staffRows] = await connection.execute(
        'SELECT standard_daily_hours, status FROM staff_members WHERE staff_id = ? FOR UPDATE',
        [staffId]
      );

      // Historical employment is checked just below (spans on record_date);
      // today's status is not used for past days.
      if (!staffRows.length) {
        results.skipped.push({
          staff_id: staffId,
          reason: 'Staff member not found.'
        });
        continue;
      }

      const employmentSpans = await getActiveSpansOverlapping(
        staffId,
        record_date,
        record_date,
        connection
      );
      if (employmentSpans.length === 0) {
        results.skipped.push({
          staff_id: staffId,
          reason: 'Staff member was not employed on this date.'
        });
        continue;
      }

      // D3: standard hours that applied on record_date (history), not today's profile.
      const compOnDate = await getStaffCompensationForDate(staffId, record_date, connection);
      const standardHours = compOnDate ? compOnDate.standard_daily_hours : Number(staffRows[0].standard_daily_hours || 8);

      /*
       * Get the existing attendance row and lock it (moved up: #2/#3 need it
       * before validating the entry). Old values are kept for change
       * detection and for an accurate audit record.
       */
      const [existing] = await connection.execute(
        `SELECT
           staff_attendance_id,
           attendance_status,
           check_in_time,
           check_out_time,
           regular_hours,
           overtime_hours,
           lunch_deducted_hours,
           lunch_start_time,
           lunch_end_time,
           is_friday_worked,
           friday_confirmed_by_user_id,
           recorded_by_user_id,
           admin_rejection_notes,
           standard_minutes_snapshot,
           status,
           source
         FROM staff_attendance
         WHERE staff_id = ? AND record_date = ?
         LIMIT 1
         FOR UPDATE`,
        [staffId, record_date]
      );
      const existingRow = existing.length > 0 ? existing[0] : null;
      const isBiometricRow = existingRow && existingRow.source === 'Biometric';

      let regularHours = 0;
      let overtimeHours = 0;
      let lunchHours = 0;
      let checkIn = null;
      let checkOut = null;
      let lunchStart = null;
      let lunchEnd = null;
      let rawCheckIn = null;
      let rawCheckOut = null;
      let biometricInOnlyDraft = false;

if (status === 'Present') {
  rawCheckIn = formatToMySqlDateTime(entry.check_in_time);
  rawCheckOut = formatToMySqlDateTime(entry.check_out_time);

  // #2: an unchanged biometric time (same minute) keeps the stored value
  // exactly, seconds included. Only an explicit edit changes it.
  if (isBiometricRow) {
    if (sameMinute(rawCheckIn, existingRow.check_in_time)) rawCheckIn = String(existingRow.check_in_time).replace('T', ' ').slice(0, 19);
    if (sameMinute(rawCheckOut, existingRow.check_out_time)) rawCheckOut = String(existingRow.check_out_time).replace('T', ' ').slice(0, 19);
  }

  // #3: in DRAFT mode only, a biometric record that has an IN and is still
  // waiting for its OUT may be saved without a check-out (OUT stays NULL,
  // hours stay empty). Submit still requires both times (checked below).
  biometricInOnlyDraft = Boolean(isDraftMode && !rawCheckOut && rawCheckIn &&
    isBiometricRow && existingRow.check_in_time && !existingRow.check_out_time);

  if (biometricInOnlyDraft) {
    if (rawCheckIn.slice(0, 10) !== record_date) {
      results.skipped.push({ staff_id: staffId, reason: 'Check-in date must match the attendance date.' });
      continue;
    }
    const rawLunchStart = entry.lunch_start_time ? formatToMySqlDateTime(entry.lunch_start_time) : null;
    const rawLunchEnd = entry.lunch_end_time ? formatToMySqlDateTime(entry.lunch_end_time) : null;
    if ((entry.lunch_start_time && !rawLunchStart) || (entry.lunch_end_time && !rawLunchEnd) ||
        (Boolean(rawLunchStart) !== Boolean(rawLunchEnd)) ||
        (rawLunchStart && (rawLunchEnd <= rawLunchStart || rawLunchStart < rawCheckIn))) {
      results.skipped.push({ staff_id: staffId, reason: 'Invalid lunch start/end time.' });
      continue;
    }
    checkIn = rawCheckIn;
    checkOut = null;
    lunchStart = rawLunchStart;
    lunchEnd = rawLunchEnd;
    regularHours = null;
    overtimeHours = null;
    lunchHours = 0;
  } else if (!rawCheckIn || !rawCheckOut) {
    results.skipped.push({
      staff_id: staffId,
      reason:
        'Check-in and check-out times are required for Present status.'
    });
    continue;
  }
}

if (status === 'Present' && !biometricInOnlyDraft) {

  // Check-in date must match the attendance record date.
  if (rawCheckIn.slice(0, 10) !== record_date) {
    results.skipped.push({
      staff_id: staffId,
      reason: 'Check-in date must match the attendance date.'
    });
    continue;
  }

        const rawLunchStart = entry.lunch_start_time ? formatToMySqlDateTime(entry.lunch_start_time) : null;
        const rawLunchEnd = entry.lunch_end_time ? formatToMySqlDateTime(entry.lunch_end_time) : null;
        if ((entry.lunch_start_time && !rawLunchStart) || (entry.lunch_end_time && !rawLunchEnd)) {
          results.skipped.push({ staff_id: staffId, reason: 'Invalid lunch start/end time.' });
          continue;
        }
        try {
          const shift = calculateStaffShiftHours({
            checkInRaw: rawCheckIn,
            checkOutRaw: rawCheckOut,
            lunchStartRaw: rawLunchStart,
            lunchEndRaw: rawLunchEnd,
            recordDate: record_date,
            standardDailyHours: standardHours,
          });

          regularHours = shift.regularHours;
          overtimeHours = shift.overtimeHours;
          lunchHours = shift.lunchHours;
          checkIn = rawCheckIn;
          checkOut = rawCheckOut;
          lunchStart = rawLunchStart;
          lunchEnd = rawLunchEnd;
        } catch (shiftError) {
          results.skipped.push({
            staff_id: staffId,
            reason: shiftError.message
          });
          continue;
        }
      }

      const isFridayWorked =
        dayIsFriday && status === 'Present' && fridayConfirmed ? 1 : 0;

      const fridayConfirmedBy =
        isFridayWorked ? supervisorId : null;

      /*
       * ============================================================
       * EXISTING ATTENDANCE
       * ============================================================
       */
      if (existing.length > 0) {
        const existingRecord = existing[0];

        if (existingRecord.status === 'Approved' || existingRecord.status === 'Submitted' || (existingRecord.status === 'Rejected' && !isResubmit)) {
          results.skipped.push({
            staff_id: staffId,
            reason: existingRecord.status === 'Approved'
              ? 'Already approved by Admin; cannot modify.'
              : 'Already submitted for review; cannot modify until Admin rejects it.'
          });
          continue;
        }

        const snapshotMinutes = Number(existingRecord.standard_minutes_snapshot) > 0
          ? Number(existingRecord.standard_minutes_snapshot)
          : Math.round(standardHours * 60);
      if (status === 'Present' && checkIn && checkOut && existingRecord.standard_minutes_snapshot) {
  // (IN-only biometric drafts keep their hours empty until the OUT exists.)
  const historicalShift = calculateStaffShiftHours({
    checkInRaw: checkIn,
    checkOutRaw: checkOut,
    lunchStartRaw: lunchStart,   // ✅ إضافة
    lunchEndRaw: lunchEnd,       // ✅ إضافة
    recordDate: record_date,
    standardDailyHours: snapshotMinutes / 60,
  });
          regularHours = historicalShift.regularHours;
          overtimeHours = historicalShift.overtimeHours;
          lunchHours = historicalShift.lunchHours;
        }

        const oldValues = {
          record_date,
          status: existingRecord.status,
          attendance_status: existingRecord.attendance_status,
          check_in_time: existingRecord.check_in_time,
          check_out_time: existingRecord.check_out_time,
          regular_hours: Number(existingRecord.regular_hours || 0),
          overtime_hours: Number(existingRecord.overtime_hours || 0),
          lunch_deducted_hours: Number(
            existingRecord.lunch_deducted_hours || 0
          ),
          is_friday_worked: Number(
            existingRecord.is_friday_worked || 0
          ),
          friday_confirmed_by_user_id: existingRecord.friday_confirmed_by_user_id,
          standard_minutes_snapshot: existingRecord.standard_minutes_snapshot,
          lunch_start_time: existingRecord.lunch_start_time,
          lunch_end_time: existingRecord.lunch_end_time,
        };

        const newValues = {
          record_date,
          status: targetStatus,
          attendance_status: status,
          check_in_time: checkIn,
          check_out_time: checkOut,
          regular_hours: regularHours === null ? null : Number(regularHours.toFixed(2)),
          overtime_hours: overtimeHours === null ? null : Number(overtimeHours.toFixed(2)),
          lunch_deducted_hours: Number(lunchHours.toFixed(2)),
          is_friday_worked: isFridayWorked,
          friday_confirmed_by_user_id: fridayConfirmedBy,
          standard_minutes_snapshot: snapshotMinutes,
          lunch_start_time: lunchStart,
          lunch_end_time: lunchEnd,
        };

        // Audit only when something meaningful changed (data OR workflow status).
        const attendanceChanged =
          oldValues.status !== newValues.status ||
          Number(oldValues.standard_minutes_snapshot || 0) !== Number(newValues.standard_minutes_snapshot || 0) ||
          String(oldValues.lunch_start_time || '') !== String(newValues.lunch_start_time || '') ||
          String(oldValues.lunch_end_time || '') !== String(newValues.lunch_end_time || '') ||
          oldValues.attendance_status !== newValues.attendance_status ||
          String(oldValues.check_in_time || '') !==
            String(newValues.check_in_time || '') ||
          String(oldValues.check_out_time || '') !==
            String(newValues.check_out_time || '') ||
          Number(oldValues.regular_hours) !==
            Number(newValues.regular_hours) ||
          Number(oldValues.overtime_hours) !==
            Number(newValues.overtime_hours) ||
          Number(oldValues.lunch_deducted_hours) !==
            Number(newValues.lunch_deducted_hours) ||
          Number(oldValues.is_friday_worked) !==
            Number(newValues.is_friday_worked) ||
          Number(oldValues.friday_confirmed_by_user_id || 0) !==
            Number(newValues.friday_confirmed_by_user_id || 0);

        // Submitting clears the old rejection note (original behavior).
        // Saving a draft keeps it, so the supervisor still sees why it was rejected.
        const rejectionNotes = isDraftMode
          ? existingRecord.admin_rejection_notes
          : null;

        // D-11: Sick is NOT paid by default. Changing a record to Sick sets
        // is_paid = 0; only an Admin "Mark as Paid" decision makes it paid.
        // Leaving Sick for a paid-leave status restores the previous default (1).
        await connection.execute(
          `UPDATE staff_attendance
           SET is_paid = CASE WHEN ? = 'Sick' AND attendance_status <> 'Sick' THEN 0
                              WHEN ? <> 'Sick' AND attendance_status = 'Sick' THEN 1
                              ELSE is_paid END,
               attendance_status = ?, check_in_time = ?, check_out_time = ?,
               regular_hours = ?, overtime_hours = ?, lunch_deducted_hours = ?,
               is_friday_worked = ?, friday_confirmed_by_user_id = ?, standard_minutes_snapshot = ?,
               lunch_start_time = ?, lunch_end_time = ?,
               status = ?, recorded_by_user_id = ?,
               admin_rejection_notes = ?, approved_by_user_id = NULL, approval_date = NULL
           WHERE staff_attendance_id = ?`,
          [
            status,
            status,
            status,
            checkIn,
            checkOut,
            regularHours === null ? null : regularHours.toFixed(2),
            overtimeHours === null ? null : overtimeHours.toFixed(2),
            lunchHours.toFixed(2),
            isFridayWorked,
            fridayConfirmedBy,
            snapshotMinutes,
            lunchStart,
            lunchEnd,
            targetStatus,
            supervisorId,
            rejectionNotes,
            existingRecord.staff_attendance_id,
          ]
        );
        const anomalyU = status === 'Present' && checkIn && checkOut
          ? await anomalyService.evaluateSession(checkIn, checkOut, record_date) : null;
        await anomalyService.applyAnomalyFlag(connection, 'staff_attendance', 'staff_attendance_id', existingRecord.staff_attendance_id, anomalyU);

        if (attendanceChanged) {
          let actionType;
          if (isDraftMode) {
            actionType = 'SUPERVISOR_ATTENDANCE_DRAFT_SAVED';
          } else if (existingRecord.status === 'Draft') {
            actionType = 'SUPERVISOR_ATTENDANCE_SUBMITTED';
          } else {
            actionType = 'SUPERVISOR_ATTENDANCE_UPDATED';
          }

          await connection.execute(
            `INSERT INTO auditlogs
               (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES
               ('staff_attendance', ?, ?, ?, ?, ?)`,
            [
              existingRecord.staff_attendance_id,
              actionType,
              supervisorId,
              JSON.stringify(oldValues),
              JSON.stringify(newValues),
            ]
          );
        }

        results.updated.push(staffId);
      }

      /*
       * ============================================================
       * NEW ATTENDANCE
       * ============================================================
       */
      else {
        const [insertResult] = await connection.execute(
          `INSERT INTO staff_attendance
             (staff_id, record_date, attendance_status, check_in_time, check_out_time,
              regular_hours, overtime_hours, lunch_deducted_hours,
              is_friday_worked, friday_confirmed_by_user_id, standard_minutes_snapshot,
              lunch_start_time, lunch_end_time,
              recorded_by_user_id, status, is_paid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            staffId,
            record_date,
            status,
            checkIn,
            checkOut,
            regularHours.toFixed(2),
            overtimeHours.toFixed(2),
            lunchHours.toFixed(2),
            isFridayWorked,
            fridayConfirmedBy,
            Math.round(standardHours * 60),
            lunchStart,
            lunchEnd,
            supervisorId,
            targetStatus,
            status === 'Sick' ? 0 : 1,   // D-11: Sick unpaid by default
          ]
        );

        const staffAttendanceId = insertResult.insertId;
        const anomalyI = status === 'Present' && checkIn && checkOut
          ? await anomalyService.evaluateSession(checkIn, checkOut, record_date) : null;
        await anomalyService.applyAnomalyFlag(connection, 'staff_attendance', 'staff_attendance_id', staffAttendanceId, anomalyI);

        await connection.execute(
          `INSERT INTO auditlogs
             (table_name, record_id, action_type, user_id, old_values, new_values)
           VALUES
             ('staff_attendance', ?, ?, ?, NULL, ?)`,
          [
            staffAttendanceId,
            isDraftMode
              ? 'SUPERVISOR_ATTENDANCE_DRAFT_SAVED'
              : 'SUPERVISOR_ATTENDANCE_CREATED',
            supervisorId,
            JSON.stringify({
              staff_id: staffId,
              record_date,
              status: targetStatus,
              attendance_status: status,
              check_in_time: checkIn,
              check_out_time: checkOut,
              regular_hours: Number(regularHours.toFixed(2)),
              overtime_hours: Number(overtimeHours.toFixed(2)),
              lunch_deducted_hours: Number(lunchHours.toFixed(2)),
              is_friday_worked: isFridayWorked,
              friday_confirmed_by_user_id: fridayConfirmedBy,
            }),
          ]
        );

        results.updated.push(staffId);
      }
    }

    if (mode === 'submit' && !isResubmit) {
      const [drafts] = await connection.execute(
        `SELECT sa.staff_attendance_id, sa.staff_id, sa.attendance_status,
                sa.check_in_time, sa.check_out_time, sa.is_friday_worked, sm.full_name
         FROM staff_attendance sa
         JOIN staff_members sm ON sm.staff_id = sa.staff_id
         WHERE sa.record_date = ? AND sa.status = 'Draft'
           AND sa.staff_id IN (${assignedIds.map(() => '?').join(',')})
         FOR UPDATE OF sa`,
        [record_date, ...assignedIds]
      );

      // Rule: Present without a real check-in AND check-out can never become Submitted.
      const incomplete = drafts.filter((d) =>
        d.attendance_status === 'Present' && (!d.check_in_time || !d.check_out_time));
      if (incomplete.length > 0) {
        throw new AppError(
          `Cannot submit. Missing check-out (wait for the biometric OUT or enter it manually): ` +
          incomplete.map((d) => d.full_name).join(', ')
        );
      }

      // Biometric Friday records are created unconfirmed; they must be confirmed first.
      if (dayIsFriday) {
        const unconfirmed = drafts.filter((d) =>
          d.attendance_status === 'Present' && Number(d.is_friday_worked) !== 1);
        if (unconfirmed.length > 0) {
          throw new AppError(
            `Friday attendance needs confirmation for: ${unconfirmed.map((d) => d.full_name).join(', ')}`
          );
        }
      }

      for (const draft of drafts) {
        await connection.execute(
          `UPDATE staff_attendance
           SET status = 'Submitted', admin_rejection_notes = NULL,
               approved_by_user_id = NULL, approval_date = NULL
           WHERE staff_attendance_id = ? AND status = 'Draft'`,
          [draft.staff_attendance_id]
        );
        results.updated.push(draft.staff_id);
        await connection.execute(
          `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
           VALUES ('staff_attendance', ?, 'SUPERVISOR_ATTENDANCE_SUBMITTED', ?, ?, ?)`,
          [draft.staff_attendance_id, supervisorId, JSON.stringify({ status: 'Draft' }),
            JSON.stringify({ status: 'Submitted', staff_id: draft.staff_id, record_date })]
        );
      }
    }

    if (mode === 'submit' && !isResubmit && results.skipped.some((item) =>
      !['Already approved by Admin; cannot modify.',
        'Already submitted for review; cannot modify until Admin rejects it.',
        'Rejected records must be resubmitted individually.'].includes(item.reason)
    )) {
      throw new AppError(
        `Attendance submission failed: ${results.skipped.map((item) => `staff ${item.staff_id}: ${item.reason}`).join('; ')}`
      );
    }

    await connection.commit();

    res.status(200).json({
      status: 'success',
      mode,
      message: isDraftMode
        ? `${results.updated.length} record(s) saved as draft.`
        : `${results.updated.length} record(s) submitted for review.`,
      data: results
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}

    console.error(
      'SUPERVISOR BULK SET STAFF ATTENDANCE ERROR:',
      error
    );

    if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
      return res.status(409).json({
        status: 'error',
        message: 'Attendance was created or changed by another request. Refresh the attendance date and try again.'
      });
    }

    if (error.isOperational) {
      return res.status(error.statusCode || 400).json({
        status: 'error', ...(error.code ? { code: error.code } : {}), message: error.message, ...(error.extra || {}),
      });
    }
    res.status(500).json({
      status: 'error',
      message: isDraftMode ? 'Failed to save staff attendance draft.' : 'Failed to submit staff attendance.'
    });
  } finally {
    connection.release();
  }
};

// POST /api/staff-attendance/supervisor/resubmit-rejected
// Resubmits exactly one rejected staff/date record through the same validated
// save path; it never promotes other Draft records for the day.
exports.resubmitRejected = async (req, res) => {
  req.body = { ...(req.body || {}), mode: 'submit', resubmit_rejected: true };
  return exports.bulkSetAttendance(req, res);
};
