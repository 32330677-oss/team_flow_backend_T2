const db = require('../config/db');
const { findLockedWorkerBatch, findLockedStaffBatch } = require('../services/payrollLock');
const attendanceService = require('../services/attendanceService');
const { calculateStaffShiftHours, isValidDateOnly } = require('../services/staffAttendanceService');
const { getStaffCompensationForDate } = require('../services/staffCompensationService');
const { businessToday } = require('../services/businessDate');

class OpError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.isOperational = true;
    this.statusCode = statusCode;
  }
}

function fmt(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(String(value));
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00'] = m;
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

const toWall = (v) => String(v).replace('T', ' ').slice(0, 19);
const parse = (v) => attendanceService.parseWallClockDateTime(v);

function sendError(res, error, fallback) {
  if (error.isOperational) {
    return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
  }
  console.error(fallback, error);
  return res.status(500).json({ status: 'error', message: fallback });
}

// GET /api/biometric/attendance?date=YYYY-MM-DD
exports.listByDate = async (req, res) => {
  const date = req.query.date || businessToday();   // B10: business date
  if (!isValidDateOnly(date)) {
    return res.status(400).json({ status: 'error', message: 'A valid date (YYYY-MM-DD) is required.' });
  }
  try {
    const [workers] = await db.execute(
      `SELECT a.attendance_id, w.worker_unique_id, w.full_name, s.site_name, a.shift_type,
              a.record_date, a.check_in_time, a.check_out_time,
              a.total_working_hours, a.overtime_hours, a.status, a.attendance_status, a.source
       FROM attendance a
       JOIN workers w ON w.worker_id = a.worker_id
       JOIN sites s ON s.site_id = a.site_id
       WHERE a.source = 'Biometric' AND (a.record_date = ? OR DATE(a.check_out_time) = ?)
       ORDER BY s.site_name, w.full_name`,
      [date, date]
    );
    const [staff] = await db.execute(
      `SELECT sa.staff_attendance_id, sm.staff_unique_id, sm.full_name, sm.position,
              sa.record_date, sa.check_in_time, sa.check_out_time,
              sa.regular_hours, sa.overtime_hours, sa.status, sa.attendance_status, sa.source,
              sa.lunch_start_time, sa.lunch_end_time
       FROM staff_attendance sa
       JOIN staff_members sm ON sm.staff_id = sa.staff_id
       WHERE sa.source = 'Biometric' AND (sa.record_date = ? OR DATE(sa.check_out_time) = ?)
       ORDER BY sm.full_name`,
      [date, date]
    );
    return res.status(200).json({ status: 'success', workers, staff });
  } catch (error) {
    return sendError(res, error, 'Failed to load biometric attendance.');
  }
};

async function editRecord(req, res, kind) {
  const id = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim();
  const adminId = req.user.user_id;

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid id.' });
  }
  if (!reason) {
    return res.status(400).json({ status: 'error', message: 'A reason is required.' });
  }
  const inRaw = req.body?.check_in_time;
  const outRaw = req.body?.check_out_time;
  // #16: an explicit request to clear a wrong check-out (never touches the raw punch).
  const clearOut = req.body?.clear_check_out === true;
  const newIn = inRaw ? fmt(inRaw) : null;
  const newOut = outRaw ? fmt(outRaw) : null;
  if ((inRaw && !newIn) || (outRaw && !newOut)) {
    return res.status(400).json({ status: 'error', message: 'Invalid time format.' });
  }
  if (clearOut && newOut) {
    return res.status(400).json({ status: 'error', message: 'Either set a new check-out or clear it, not both.' });
  }
  if (!newIn && !newOut && !clearOut) {
    return res.status(400).json({ status: 'error', message: 'Provide a new check-in or check-out time.' });
  }

  const isWorker = kind === 'Worker';
  const table = isWorker ? 'attendance' : 'staff_attendance';
  const pk = isWorker ? 'attendance_id' : 'staff_attendance_id';

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(`SELECT * FROM ${table} WHERE ${pk} = ? FOR UPDATE`, [id]);
    if (!rows.length) throw new OpError('Record not found.', 404);
    const rec = rows[0];

    if (rec.source !== 'Biometric') throw new OpError('Only biometric-created records can be edited here.');
    if (!['Draft', 'Submitted'].includes(rec.status)) throw new OpError('Approved records are locked.');
    // D-02: finalized/paid payroll periods are locked for normal edits.
    const recDate = String(rec.record_date).slice(0, 10);
    const lockedBatch = isWorker
      ? await findLockedWorkerBatch(connection, { siteId: rec.site_id, date: recDate })
      : await findLockedStaffBatch(connection, { date: recDate });
    if (lockedBatch) throw new OpError(`${recDate} is inside a finalized/paid payroll period. Use "Correct attendance" instead.`, 409);

    if (clearOut) {
      if (rec.status !== 'Draft') {
        throw new OpError('A check-out can only be cleared on a Draft. Reject the record first.');
      }
      if (!rec.check_out_time) throw new OpError('This record has no check-out to clear.');
    }

    const checkIn = newIn || (rec.check_in_time ? toWall(rec.check_in_time) : null);
    const checkOut = clearOut ? null : (newOut || (rec.check_out_time ? toWall(rec.check_out_time) : null));
    if (!checkIn) throw new OpError('A check-in time is required.');

    if (checkIn.slice(0, 10) !== String(rec.record_date).slice(0, 10)) {
      throw new OpError(`Check-in date must match the attendance date (${String(rec.record_date).slice(0, 10)}).`);
    }
    if (checkOut && parse(checkOut) <= parse(checkIn)) {
      throw new OpError('Check-out time must be after check-in time.');
    }

    if (isWorker && checkOut) {
      const [[openLeave]] = await connection.execute(
        'SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NULL LIMIT 1',
        [id]
      );
      if (openLeave) throw new OpError('End the active break first.');
    }

    await connection.execute(
      `UPDATE ${table} SET check_in_time = ?, check_out_time = ?, updated_at = CURRENT_TIMESTAMP WHERE ${pk} = ?`,
      [checkIn, checkOut, id]
    );

    if (clearOut) {
      // Hours can no longer be known; submit stays blocked until a real OUT exists.
      if (isWorker) {
        await connection.execute(
          'UPDATE attendance SET total_working_hours = NULL, overtime_hours = 0 WHERE attendance_id = ?', [id]);
      } else {
        await connection.execute(
          'UPDATE staff_attendance SET regular_hours = NULL, overtime_hours = NULL WHERE staff_attendance_id = ?', [id]);
      }
    }

    if (checkOut) {
      try {
        if (isWorker) {
          await attendanceService.calculateWorkingHours(id, connection);
        } else {
          // D3: standard hours that applied on the record's own date.
          const comp = await getStaffCompensationForDate(
            rec.staff_id, String(rec.record_date).slice(0, 10), connection);
          const profileHours = comp ? comp.standard_daily_hours : 8;
          const snapshotMinutes = Number(rec.standard_minutes_snapshot) > 0
            ? Number(rec.standard_minutes_snapshot) : Math.round(profileHours * 60);
          const shift = calculateStaffShiftHours({
            checkInRaw: checkIn, checkOutRaw: checkOut,
            lunchStartRaw: rec.lunch_start_time, lunchEndRaw: rec.lunch_end_time,
            recordDate: checkIn.slice(0, 10), standardDailyHours: snapshotMinutes / 60,
          });
          await connection.execute(
            `UPDATE staff_attendance
             SET regular_hours = ?, overtime_hours = ?, lunch_deducted_hours = ?,
                 standard_minutes_snapshot = COALESCE(standard_minutes_snapshot, ?)
             WHERE staff_attendance_id = ?`,
            [shift.regularHours.toFixed(2), shift.overtimeHours.toFixed(2), shift.lunchHours.toFixed(2),
              snapshotMinutes, id]
          );
        }
      } catch (calcError) {
        throw new OpError(calcError.message);
      }
    }

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES (?, ?, 'BIOMETRIC_ADMIN_EDIT', ?, ?, ?)`,
      [table, id, adminId,
        JSON.stringify({ check_in_time: rec.check_in_time, check_out_time: rec.check_out_time }),
        JSON.stringify({ check_in_time: checkIn, check_out_time: checkOut, cleared_check_out: clearOut, reason })]
    );

    await connection.commit();
    return res.status(200).json({ status: 'success', message: 'Attendance times updated.' });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    return sendError(res, error, 'Failed to update attendance times.');
  } finally {
    connection.release();
  }
}

exports.editWorkerTimes = (req, res) => editRecord(req, res, 'Worker');
exports.editStaffTimes = (req, res) => editRecord(req, res, 'Staff');