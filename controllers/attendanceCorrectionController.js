// controllers/attendanceCorrectionController.js
//
// D-02 / §12 / §14: the ONLY way to change attendance that normal workflows
// may no longer touch (Approved records, or any record inside a Finalized /
// Paid payroll period). Worker and Staff records are handled by separate
// functions.
//
// Rules:
//   * Admin only (route), reason mandatory.
//   * The full original row and the corrected values are stored in
//     attendance_corrections_log, plus an auditlogs row.
//   * The finalized payroll is NEVER changed. When the corrected record lies
//     inside a Finalized/Paid batch, the correction is marked
//     payroll_effect = 'AdjustmentRequired', adjustment_status = 'Open'.
//     No adjustment amount is calculated (no business rule exists for it);
//     the open item is listed for the payroll team, who resolve it with a note.
//   * The workflow status is not changed (an Approved record stays Approved:
//     the Admin is the approver).

const db = require('../config/db');
const attendanceService = require('../services/attendanceService');
const settingsCache = require('../services/settingsCache');
const { findLockedWorkerBatch, findLockedStaffBatch } = require('../services/payrollLock');
const { calculateStaffShiftHours } = require('../services/staffAttendanceService');
const { getStaffCompensationForDate } = require('../services/staffCompensationService');
const anomalyService = require('../services/anomalyService');

class OpError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.isOperational = true;
    this.statusCode = statusCode;
  }
}

const STATUSES = ['Present', 'Absent', 'Sick', 'Vacation', 'Holiday'];

function wall(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value));
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}`;
}

function nowWall() {
  const timeZone = process.env.APP_TIME_ZONE || 'Asia/Beirut';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${v.year}-${v.month}-${v.day} ${v.hour}:${v.minute}:${v.second}`;
}

function send(res, error, fallback) {
  if (error && error.isOperational) return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
  console.error(fallback, error);
  return res.status(500).json({ status: 'error', message: fallback });
}

function requireReason(body) {
  const reason = String(body?.reason || '').trim();
  if (reason.length < 5) throw new OpError('A correction reason (at least 5 characters) is required.');
  return reason.slice(0, 1000);
}

// ---------------------------------------------------------------------------
// Worker attendance
// POST /api/attendance/:attendance_id/admin-correction
// body: { reason, attendance_status?, check_in_time?, check_out_time?, management_leave_hours? }
// ---------------------------------------------------------------------------
exports.correctWorkerAttendance = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const reason = requireReason(req.body);
    const attendanceId = Number(req.params.attendance_id);
    if (!Number.isInteger(attendanceId) || attendanceId <= 0) throw new OpError('Invalid attendance id.');
    const userId = req.user.user_id;

    await connection.beginTransaction();
    const [[original]] = await connection.execute('SELECT * FROM attendance WHERE attendance_id = ? FOR UPDATE', [attendanceId]);
    if (!original) throw new OpError('Attendance record not found.', 404);
    const recordDate = String(original.record_date).slice(0, 10);

    const status = req.body.attendance_status ? (req.body.attendance_status === 'Annual' ? 'Vacation' : req.body.attendance_status) : original.attendance_status;
    if (!STATUSES.includes(status)) throw new OpError('Invalid attendance status.');

    let checkIn = null;
    let checkOut = null;
    if (status === 'Present') {
      checkIn = req.body.check_in_time !== undefined ? wall(req.body.check_in_time) : wall(original.check_in_time);
      checkOut = req.body.check_out_time !== undefined ? wall(req.body.check_out_time) : wall(original.check_out_time);
      if (!checkIn || !checkOut) throw new OpError('Present requires both a check-in and a check-out.');
      if (checkIn.slice(0, 10) !== recordDate) throw new OpError(`Check-in must be on the record date (${recordDate}).`);
      if (checkOut <= checkIn) throw new OpError('Check-out must be after check-in.');
      if (checkOut > nowWall()) throw new OpError('Check-out cannot be in the future.');
      const [leaves] = await connection.execute(
        'SELECT leave_start_time, leave_end_time FROM attendanceleaveperiods WHERE attendance_id = ?', [attendanceId]);
      for (const l of leaves) {
        if (!l.leave_end_time) throw new OpError('The record has an open break. End or correct it first.');
        if (wall(l.leave_start_time) < checkIn || wall(l.leave_end_time) > checkOut) {
          throw new OpError('An existing break would fall outside the corrected shift. Correct the break first.');
        }
      }
    } else {
      const [[breaks]] = await connection.execute('SELECT COUNT(*) AS cnt FROM attendanceleaveperiods WHERE attendance_id = ?', [attendanceId]);
      if (Number(breaks.cnt) > 0) throw new OpError('This record has recorded breaks; it can only stay Present.');
    }

    let mgmt = Number(original.management_leave_hours || 0);
    if (req.body.management_leave_hours !== undefined) {
      mgmt = Number(req.body.management_leave_hours);
      if (!Number.isFinite(mgmt) || mgmt < 0 || mgmt > 24) throw new OpError('management_leave_hours must be between 0 and 24.');
    }

    const locked = await findLockedWorkerBatch(connection, { siteId: original.site_id, date: recordDate });

    await connection.execute(
      `UPDATE attendance SET attendance_status = ?, check_in_time = ?, check_out_time = ?, management_leave_hours = ?
       WHERE attendance_id = ?`,
      [status, checkIn, checkOut, mgmt.toFixed(2), attendanceId]
    );

    if (status === 'Present') {
      await attendanceService.calculateWorkingHours(attendanceId, connection);
    } else {
      let standardMinutes = Number(original.standard_minutes_snapshot);
      if (!(standardMinutes > 0)) standardMinutes = Number(await settingsCache.getSettingForDate('standard_work_minutes', recordDate, '600')) || 600;
      const regular = mgmt > 0 ? Math.min(mgmt, standardMinutes / 60) : null;
      const overtime = mgmt > 0 ? Math.max(0, mgmt - standardMinutes / 60) : 0;
      await connection.execute(
        `UPDATE attendance SET total_working_hours = ?, overtime_hours = ?, anomaly_code = NULL, anomaly_detail = NULL
         WHERE attendance_id = ?`,
        [regular === null ? null : regular.toFixed(2), overtime.toFixed(2), attendanceId]
      );
    }

    const [[corrected]] = await connection.execute('SELECT * FROM attendance WHERE attendance_id = ?', [attendanceId]);
    const changedMoneyFields = ['attendance_status', 'total_working_hours', 'overtime_hours', 'management_leave_hours']
      .some((k) => String(original[k] ?? '') !== String(corrected[k] ?? ''));
    const effect = locked && changedMoneyFields && original.status === 'Approved' ? 'AdjustmentRequired' : 'None';

    const [log] = await connection.execute(
      `INSERT INTO attendance_corrections_log
         (record_table, record_id, person_id, record_date, original_values, corrected_values, reason,
          corrected_by_user_id, corrected_at, locked_batch_table, locked_batch_id, payroll_effect, adjustment_status)
       VALUES ('attendance', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [attendanceId, original.worker_id, recordDate, JSON.stringify(original), JSON.stringify(corrected), reason,
        userId, nowWall(), locked ? 'payrollbatches' : null, locked ? locked.payroll_batch_id : null,
        effect, effect === 'AdjustmentRequired' ? 'Open' : 'NotApplicable']
    );
    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('attendance', ?, 'ADMIN_CORRECTION', ?, ?, ?)`,
      [attendanceId, userId, JSON.stringify(original),
        JSON.stringify({ correction_id: log.insertId, reason, attendance_status: status, check_in_time: checkIn,
          check_out_time: checkOut, management_leave_hours: mgmt, locked_batch_id: locked ? locked.payroll_batch_id : null })]
    );
    await connection.commit();

    return res.status(200).json({
      status: 'success',
      message: effect === 'AdjustmentRequired'
        ? `Correction saved. Payroll batch #${locked.payroll_batch_id} is ${locked.status === 'Paid' ? 'Paid' : 'Finalized'} and was NOT changed; an open payroll adjustment item was recorded (#${log.insertId}).`
        : 'Correction saved.',
      data: { correction_id: log.insertId, payroll_effect: effect, locked_batch_id: locked ? locked.payroll_batch_id : null, record: corrected },
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    return send(res, error, 'Failed to save the correction.');
  } finally {
    connection.release();
  }
};

// ---------------------------------------------------------------------------
// Staff attendance (separate logic)
// POST /api/staff-attendance/admin/:id/correction
// body: { reason, attendance_status?, check_in_time?, check_out_time?, lunch_start_time?, lunch_end_time?, is_paid? }
// ---------------------------------------------------------------------------
exports.correctStaffAttendance = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const reason = requireReason(req.body);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new OpError('Invalid staff attendance id.');
    const userId = req.user.user_id;

    await connection.beginTransaction();
    const [[original]] = await connection.execute('SELECT * FROM staff_attendance WHERE staff_attendance_id = ? FOR UPDATE', [id]);
    if (!original) throw new OpError('Staff attendance record not found.', 404);
    const recordDate = String(original.record_date).slice(0, 10);

    const status = req.body.attendance_status || original.attendance_status;
    if (!STATUSES.includes(status)) throw new OpError('Invalid attendance status.');

    let checkIn = null; let checkOut = null; let lunchStart = null; let lunchEnd = null;
    let regular = 0; let overtime = 0; let lunchHours = 0;
    if (status === 'Present') {
      checkIn = req.body.check_in_time !== undefined ? wall(req.body.check_in_time) : wall(original.check_in_time);
      checkOut = req.body.check_out_time !== undefined ? wall(req.body.check_out_time) : wall(original.check_out_time);
      lunchStart = req.body.lunch_start_time !== undefined ? wall(req.body.lunch_start_time) : wall(original.lunch_start_time);
      lunchEnd = req.body.lunch_end_time !== undefined ? wall(req.body.lunch_end_time) : wall(original.lunch_end_time);
      if (!checkIn || !checkOut) throw new OpError('Present requires both a check-in and a check-out.');
      if (checkIn.slice(0, 10) !== recordDate) throw new OpError(`Check-in must be on the record date (${recordDate}).`);
      if (checkOut > nowWall()) throw new OpError('Check-out cannot be in the future.');
      const snapshot = Number(original.standard_minutes_snapshot) > 0 ? Number(original.standard_minutes_snapshot)
        : Math.round(((await getStaffCompensationForDate(original.staff_id, recordDate, connection))?.standard_daily_hours || 8) * 60);
      let shift;
      try {
        shift = calculateStaffShiftHours({ checkInRaw: checkIn, checkOutRaw: checkOut, lunchStartRaw: lunchStart,
          lunchEndRaw: lunchEnd, recordDate, standardDailyHours: snapshot / 60 });
      } catch (calcError) {
        throw new OpError(calcError.message);
      }
      regular = shift.regularHours; overtime = shift.overtimeHours; lunchHours = shift.lunchHours;
    }

    let isPaid = Number(original.is_paid);
    if (req.body.is_paid === 0 || req.body.is_paid === 1 || req.body.is_paid === true || req.body.is_paid === false) {
      isPaid = req.body.is_paid === true || req.body.is_paid === 1 ? 1 : 0;
    }

    const locked = await findLockedStaffBatch(connection, { date: recordDate });

    await connection.execute(
      `UPDATE staff_attendance
       SET attendance_status = ?, check_in_time = ?, check_out_time = ?, lunch_start_time = ?, lunch_end_time = ?,
           regular_hours = ?, overtime_hours = ?, lunch_deducted_hours = ?, is_paid = ?,
           paid_decision_by_user_id = CASE WHEN is_paid <> ? THEN ? ELSE paid_decision_by_user_id END,
           paid_decision_at = CASE WHEN is_paid <> ? THEN NOW() ELSE paid_decision_at END
       WHERE staff_attendance_id = ?`,
      [status, checkIn, checkOut, lunchStart, lunchEnd, regular.toFixed(2), overtime.toFixed(2), lunchHours.toFixed(2),
        isPaid, isPaid, userId, isPaid, id]
    );
    const anomaly = status === 'Present' ? await anomalyService.evaluateSession(checkIn, checkOut, recordDate) : null;
    await anomalyService.applyAnomalyFlag(connection, 'staff_attendance', 'staff_attendance_id', id, anomaly);

    const [[corrected]] = await connection.execute('SELECT * FROM staff_attendance WHERE staff_attendance_id = ?', [id]);
    const changedMoneyFields = ['attendance_status', 'regular_hours', 'overtime_hours', 'is_paid']
      .some((k) => String(original[k] ?? '') !== String(corrected[k] ?? ''));
    const effect = locked && changedMoneyFields && original.status === 'Approved' ? 'AdjustmentRequired' : 'None';

    const [log] = await connection.execute(
      `INSERT INTO attendance_corrections_log
         (record_table, record_id, person_id, record_date, original_values, corrected_values, reason,
          corrected_by_user_id, corrected_at, locked_batch_table, locked_batch_id, payroll_effect, adjustment_status)
       VALUES ('staff_attendance', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, original.staff_id, recordDate, JSON.stringify(original), JSON.stringify(corrected), reason, userId, nowWall(),
        locked ? 'staff_payroll_batches' : null, locked ? locked.staff_payroll_batch_id : null,
        effect, effect === 'AdjustmentRequired' ? 'Open' : 'NotApplicable']
    );
    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_attendance', ?, 'ADMIN_CORRECTION', ?, ?, ?)`,
      [id, userId, JSON.stringify(original), JSON.stringify({ correction_id: log.insertId, reason, attendance_status: status,
        check_in_time: checkIn, check_out_time: checkOut, is_paid: isPaid, locked_batch_id: locked ? locked.staff_payroll_batch_id : null })]
    );
    await connection.commit();
    return res.status(200).json({
      status: 'success',
      message: effect === 'AdjustmentRequired'
        ? `Correction saved. Staff payroll batch #${locked.staff_payroll_batch_id} was NOT changed; an open payroll adjustment item was recorded (#${log.insertId}).`
        : 'Correction saved.',
      data: { correction_id: log.insertId, payroll_effect: effect, record: corrected },
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    return send(res, error, 'Failed to save the staff correction.');
  } finally {
    connection.release();
  }
};

// GET /api/attendance/corrections?adjustment_status=Open&record_table=attendance
exports.listCorrections = async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (['NotApplicable', 'Open', 'Resolved'].includes(req.query.adjustment_status)) {
      where.push('c.adjustment_status = ?'); params.push(req.query.adjustment_status);
    }
    if (['attendance', 'staff_attendance'].includes(req.query.record_table)) {
      where.push('c.record_table = ?'); params.push(req.query.record_table);
    }
    const [rows] = await db.execute(
      `SELECT c.correction_id, c.record_table, c.record_id, c.person_id,
              DATE_FORMAT(c.record_date, '%Y-%m-%d') AS record_date, c.reason, c.corrected_at,
              c.locked_batch_table, c.locked_batch_id, c.payroll_effect, c.adjustment_status,
              c.resolved_at, c.resolution_note, c.original_values, c.corrected_values,
              u.full_name AS corrected_by, ru.full_name AS resolved_by,
              COALESCE(w.full_name, sm.full_name) AS person_name
       FROM attendance_corrections_log c
       JOIN users u ON u.user_id = c.corrected_by_user_id
       LEFT JOIN users ru ON ru.user_id = c.resolved_by_user_id
       LEFT JOIN workers w ON c.record_table = 'attendance' AND w.worker_id = c.person_id
       LEFT JOIN staff_members sm ON c.record_table = 'staff_attendance' AND sm.staff_id = c.person_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY c.correction_id DESC
       LIMIT 500`,
      params
    );
    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    return send(res, error, 'Failed to load corrections.');
  }
};

// PATCH /api/attendance/corrections/:correction_id/resolve  { note }
// Records that the payroll team handled an open adjustment (outside the
// system or in a later batch). No amount is calculated here.
exports.resolveAdjustment = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const id = Number(req.params.correction_id);
    const note = String(req.body?.note || '').trim();
    if (!Number.isInteger(id) || id <= 0) throw new OpError('Invalid correction id.');
    if (note.length < 5) throw new OpError('A resolution note (at least 5 characters) is required.');
    await connection.beginTransaction();
    const [[row]] = await connection.execute('SELECT * FROM attendance_corrections_log WHERE correction_id = ? FOR UPDATE', [id]);
    if (!row) throw new OpError('Correction not found.', 404);
    if (row.adjustment_status !== 'Open') throw new OpError(`Only an Open adjustment can be resolved (this one is ${row.adjustment_status}).`, 409);
    await connection.execute(
      `UPDATE attendance_corrections_log SET adjustment_status = 'Resolved', resolved_by_user_id = ?, resolved_at = ?, resolution_note = ?
       WHERE correction_id = ?`,
      [req.user.user_id, nowWall(), note.slice(0, 1000), id]
    );
    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('attendance_corrections_log', ?, 'ADJUSTMENT_RESOLVED', ?, ?, ?)`,
      [id, req.user.user_id, JSON.stringify({ adjustment_status: 'Open' }), JSON.stringify({ adjustment_status: 'Resolved', note })]
    );
    await connection.commit();
    return res.status(200).json({ status: 'success', message: 'Adjustment marked as resolved.' });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    return send(res, error, 'Failed to resolve the adjustment.');
  } finally {
    connection.release();
  }
};
