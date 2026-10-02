// controllers/staffLunchAdminController.js
//
// B4 — Lunch for BIOMETRIC staff records (Admin).
//
// The device only produces IN/OUT, so biometric staff records have no lunch.
// The Admin applies (or removes) a lunch window explicitly; nothing is ever
// applied automatically. Staff only — worker lunch keeps its own flow
// (attendanceleaveperiods / submitDay).
//
//   GET  /api/staff-attendance/admin/lunch?date=YYYY-MM-DD
//   POST /api/staff-attendance/admin/lunch/apply
//        { date, staff_attendance_ids: [..], lunch_start: 'HH:MM', lunch_end: 'HH:MM' }
//        { date, staff_attendance_ids: [..], remove: true }

const db = require('../config/db');
const { findLockedStaffBatch } = require('../services/payrollLock');
const { calculateStaffShiftHours, isValidDateOnly } = require('../services/staffAttendanceService');
const { getStaffCompensationForDate } = require('../services/staffCompensationService');

const toWall = (v) => (v ? String(v).replace('T', ' ').slice(0, 19) : null);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

exports.getLunchDay = async (req, res) => {
  const { date } = req.query;
  if (!isValidDateOnly(date)) {
    return res.status(400).json({ status: 'error', message: 'A valid date (YYYY-MM-DD) is required.' });
  }
  try {
    const [rows] = await db.execute(
      `SELECT sa.staff_attendance_id, sa.staff_id, sm.full_name, sm.staff_unique_id, sm.position,
              sa.check_in_time, sa.check_out_time, sa.lunch_start_time, sa.lunch_end_time,
              sa.lunch_deducted_hours, sa.regular_hours, sa.overtime_hours,
              sa.status, sa.attendance_status, sa.source
       FROM staff_attendance sa
       JOIN staff_members sm ON sm.staff_id = sa.staff_id
       WHERE sa.record_date = ? AND sa.source = 'Biometric' AND sa.attendance_status = 'Present'
       ORDER BY sm.full_name`,
      [date]
    );
    const data = rows.map((r) => ({
      ...r,
      lunch_applied: Boolean(r.lunch_start_time && r.lunch_end_time),
      editable: r.status === 'Draft',
    }));
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('GET STAFF LUNCH DAY ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load staff lunch for this date.' });
  }
};

exports.applyLunch = async (req, res) => {
  const { date, staff_attendance_ids: ids, lunch_start: startText, lunch_end: endText } = req.body || {};
  const remove = req.body?.remove === true;
  const adminId = req.user.user_id;

  if (!isValidDateOnly(date)) {
    return res.status(400).json({ status: 'error', message: 'A valid date (YYYY-MM-DD) is required.' });
  }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 ||
      ids.some((id) => !Number.isInteger(Number(id)) || Number(id) <= 0)) {
    return res.status(400).json({ status: 'error', message: 'staff_attendance_ids must contain 1-500 ids.' });
  }
  if (!remove && (!TIME_RE.test(String(startText || '')) || !TIME_RE.test(String(endText || '')))) {
    return res.status(400).json({ status: 'error', message: 'lunch_start and lunch_end must be HH:MM.' });
  }
  const lunchStart = remove ? null : `${date} ${startText}:00`;
  const lunchEnd = remove ? null : `${date} ${endText}:00`;
  if (!remove && lunchEnd <= lunchStart) {
    return res.status(400).json({ status: 'error', message: 'Lunch end must be after lunch start.' });
  }

  const connection = await db.getConnection();
  const results = { updated: [], skipped: [] };
  try {
    await connection.beginTransaction();
    if (await findLockedStaffBatch(connection, { date })) {
      throw Object.assign(new Error(`${date} is inside a finalized/paid staff payroll period; lunch can no longer be changed here.`), { isOperational: true, statusCode: 409 });
    }
    for (const rawId of [...new Set(ids.map(Number))]) {
      const [[rec]] = await connection.execute(
        'SELECT * FROM staff_attendance WHERE staff_attendance_id = ? FOR UPDATE', [rawId]);
      if (!rec || String(rec.record_date).slice(0, 10) !== date) {
        results.skipped.push({ staff_attendance_id: rawId, reason: 'Record not found for this date.' }); continue;
      }
      if (rec.source !== 'Biometric') {
        results.skipped.push({ staff_attendance_id: rawId, reason: 'Only biometric records are handled here.' }); continue;
      }
      if (rec.status !== 'Draft') {
        results.skipped.push({ staff_attendance_id: rawId, reason: `Record is ${rec.status}; only Drafts can change.` }); continue;
      }
      if (rec.attendance_status !== 'Present' || !rec.check_in_time) {
        results.skipped.push({ staff_attendance_id: rawId, reason: 'Record has no check-in.' }); continue;
      }
      const inWall = toWall(rec.check_in_time);
      const outWall = toWall(rec.check_out_time);
      if (!remove) {
        if (lunchStart < inWall || (outWall && lunchEnd > outWall)) {
          results.skipped.push({ staff_attendance_id: rawId, reason: 'Lunch must be inside the check-in/check-out shift.' }); continue;
        }
      }

      let regular = rec.regular_hours;
      let overtime = rec.overtime_hours;
      let lunchHours = 0;
      if (outWall) {
        const snapshotMinutes = Number(rec.standard_minutes_snapshot) > 0
          ? Number(rec.standard_minutes_snapshot)
          : Math.round(((await getStaffCompensationForDate(rec.staff_id, date, connection))?.standard_daily_hours || 8) * 60);
        try {
          const shift = calculateStaffShiftHours({
            checkInRaw: inWall, checkOutRaw: outWall,
            lunchStartRaw: lunchStart, lunchEndRaw: lunchEnd,
            recordDate: date, standardDailyHours: snapshotMinutes / 60,
          });
          regular = shift.regularHours.toFixed(2);
          overtime = shift.overtimeHours.toFixed(2);
          lunchHours = shift.lunchHours;
        } catch (calcError) {
          results.skipped.push({ staff_attendance_id: rawId, reason: calcError.message }); continue;
        }
      } else if (!remove) {
        lunchHours = Math.round(((new Date(lunchEnd.replace(' ', 'T') + 'Z') - new Date(lunchStart.replace(' ', 'T') + 'Z')) / 3600000) * 100) / 100;
      }

      await connection.execute(
        `UPDATE staff_attendance
         SET lunch_start_time = ?, lunch_end_time = ?, lunch_deducted_hours = ?,
             regular_hours = ?, overtime_hours = ?
         WHERE staff_attendance_id = ? AND status = 'Draft'`,
        [lunchStart, lunchEnd, Number(lunchHours).toFixed(2), regular, overtime, rawId]
      );
      await connection.execute(
        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
         VALUES ('staff_attendance', ?, ?, ?, ?, ?)`,
        [rawId, remove ? 'ADMIN_STAFF_LUNCH_REMOVED' : 'ADMIN_STAFF_LUNCH_APPLIED', adminId,
          JSON.stringify({ lunch_start_time: rec.lunch_start_time, lunch_end_time: rec.lunch_end_time }),
          JSON.stringify({ lunch_start_time: lunchStart, lunch_end_time: lunchEnd })]
      );
      results.updated.push(rawId);
    }
    await connection.commit();
    return res.status(200).json({
      status: 'success',
      message: `${results.updated.length} record(s) updated, ${results.skipped.length} skipped.`,
      data: results,
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    if (error.isOperational) return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
    console.error('APPLY STAFF LUNCH ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to apply lunch.' });
  } finally {
    connection.release();
  }
};
