// controllers/staffSupervisorAssignmentController.js
//
// Tracks which StaffSupervisor a staff member is currently assigned to.
// Mirrors staffAssignmentController.js's pattern (worker->site assignments)
// but for staff->supervisor assignments. Kept as a separate file/table per
// the "don't merge staff and worker logic" precedent already in this codebase.

const db = require('../config/db');
const { businessToday, addDays } = require('../services/businessDate');
const { activeOn } = require('../services/assignmentDates');

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// GET /api/staff/:id/supervisor-assignments
exports.getHistory = async (req, res) => {
  const staffId = Number(req.params.id);
  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid staff id.' });
  }
  try {
    const [rows] = await db.execute(
      `SELECT ssa.*, u.full_name AS supervisor_name, ab.full_name AS assigned_by_name
       FROM staff_supervisor_assignments ssa
       JOIN users u ON u.user_id = ssa.supervisor_user_id
       LEFT JOIN users ab ON ab.user_id = ssa.assigned_by_user_id
       WHERE ssa.staff_id = ?
       ORDER BY ssa.assigned_date DESC, ssa.staff_assignment_id DESC`,
      [staffId]
    );
    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('GET STAFF SUPERVISOR ASSIGNMENT HISTORY ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load assignment history.' });
  }
};

// POST /api/staff/:id/supervisor-assignments
// body: { supervisor_user_id, assigned_date, notes }
exports.assignSupervisor = async (req, res) => {
  const staffId = Number(req.params.id);
  const { supervisor_user_id, assigned_date, notes } = req.body || {};
  const adminId = req.user.user_id;

  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid staff id.' });
  }
  const supervisorId = Number(supervisor_user_id);
  if (!Number.isInteger(supervisorId) || supervisorId <= 0) {
    return res.status(400).json({ status: 'error', message: 'supervisor_user_id is required.' });
  }
  const effectiveDate = isValidDateOnly(assigned_date) ? assigned_date : businessToday();   // B10

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [staffRows] = await connection.execute(
      'SELECT staff_id, status FROM staff_members WHERE staff_id = ? FOR UPDATE',
      [staffId]
    );
    if (staffRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ status: 'error', message: 'Staff member not found.' });
    }
    if (staffRows[0].status === 'Terminated') {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'Cannot assign a supervisor to a terminated staff member.' });
    }

    const [supRows] = await connection.execute(
      `SELECT user_id, role, status FROM users WHERE user_id = ? LIMIT 1`,
      [supervisorId]
    );
    if (supRows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'The specified supervisor account does not exist.' });
    }
    if (supRows[0].role !== 'StaffSupervisor') {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'The specified user is not a Staff Supervisor.' });
    }
    if (supRows[0].status !== 'Active') {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'The specified supervisor account is inactive.' });
    }

    // Close any open assignment (explicit reassignment event, mirrors
    // staffAssignmentController.assignToSite's close-then-reopen behavior).
    await connection.execute(
      // §5: the old assignment's LAST day is the day before the new one starts.
      `UPDATE staff_supervisor_assignments
       SET unassigned_date = ?
       WHERE staff_id = ? AND unassigned_date IS NULL`,
      [addDays(effectiveDate, -1), staffId]
    );

    await connection.execute(
      `INSERT INTO staff_supervisor_assignments
         (staff_id, supervisor_user_id, assigned_by_user_id, assigned_date, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [staffId, supervisorId, adminId, effectiveDate, notes || null]
    );

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_members', ?, 'SUPERVISOR_ASSIGNED', ?, NULL, ?)`,
      [staffId, adminId, JSON.stringify({ supervisor_user_id: supervisorId, assigned_date: effectiveDate, notes })]
    );

    await connection.commit();
    return res.status(201).json({ status: 'success', message: 'Staff Supervisor assigned successfully.' });
  } catch (error) {
    await connection.rollback();
    console.error('ASSIGN STAFF SUPERVISOR ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'An error occurred while assigning the supervisor.' });
  } finally {
    connection.release();
  }
};

// DELETE /api/staff/:id/supervisor-assignments/current
exports.unassignCurrent = async (req, res) => {
  const staffId = Number(req.params.id);
  // §5: the date given is the LAST assigned day (inclusive). `unassigned_date`
  // is accepted as the same meaning for older clients.
  const lastDay = (req.body || {}).last_day ?? (req.body || {}).unassigned_date;
  const adminId = req.user.user_id;

  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid staff id.' });
  }
  if (!isValidDateOnly(lastDay)) {
    return res.status(400).json({ status: 'error', message: 'last_day (YYYY-MM-DD) is required: the LAST day of the current assignment.' });
  }
  const effectiveDate = lastDay;

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.execute(
      `UPDATE staff_supervisor_assignments
       SET unassigned_date = ?
       WHERE staff_id = ? AND unassigned_date IS NULL AND assigned_date <= DATE_ADD(?, INTERVAL 1 DAY)`,
      [effectiveDate, staffId, effectiveDate]
    );
    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ status: 'error', message: 'Staff member has no open supervisor assignment.' });
    }

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_members', ?, 'SUPERVISOR_UNASSIGNED', ?, NULL, ?)`,
      [staffId, adminId, JSON.stringify({ unassigned_date: effectiveDate })]
    );

    await connection.commit();
    return res.status(200).json({ status: 'success', message: 'Staff Supervisor unassigned successfully.' });
  } catch (error) {
    await connection.rollback();
    console.error('UNASSIGN STAFF SUPERVISOR ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'An error occurred while unassigning the supervisor.' });
  } finally {
    connection.release();
  }
};
// POST /api/staff/supervisor-assignments/bulk
// body: { staff_ids: number[], supervisor_user_id, assigned_date, notes }
// Assigns the SAME supervisor to multiple staff members in one call.
// Reuses the exact same per-staff logic as assignSupervisor (close-then-reopen),
// just looped inside a single transaction so it's all-or-partial with a clear report.
exports.bulkAssignSupervisor = async (req, res) => {
  const { staff_ids, supervisor_user_id, assigned_date, notes } = req.body || {};
  const adminId = req.user.user_id;

  if (!Array.isArray(staff_ids) || staff_ids.length === 0) {
    return res.status(400).json({ status: 'error', message: 'staff_ids must be a non-empty array.' });
  }
  const supervisorId = Number(supervisor_user_id);
  if (!Number.isInteger(supervisorId) || supervisorId <= 0) {
    return res.status(400).json({ status: 'error', message: 'supervisor_user_id is required.' });
  }
  const effectiveDate = isValidDateOnly(assigned_date) ? assigned_date : businessToday();   // B10

  const uniqueStaffIds = [...new Set(staff_ids.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (uniqueStaffIds.length === 0) {
    return res.status(400).json({ status: 'error', message: 'No valid staff ids provided.' });
  }

  const connection = await db.getConnection();
  const updated = [];
  const skipped = [];
  try {
    await connection.beginTransaction();

    // Validate the supervisor once (shared across the whole batch).
    const [supRows] = await connection.execute(
      `SELECT user_id, role, status FROM users WHERE user_id = ? LIMIT 1`,
      [supervisorId]
    );
    if (supRows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'The specified supervisor account does not exist.' });
    }
    if (supRows[0].role !== 'StaffSupervisor') {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'The specified user is not a Staff Supervisor.' });
    }
    if (supRows[0].status !== 'Active') {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'The specified supervisor account is inactive.' });
    }

    for (const staffId of uniqueStaffIds) {
      const [staffRows] = await connection.execute(
        'SELECT staff_id, status FROM staff_members WHERE staff_id = ? FOR UPDATE',
        [staffId]
      );
      if (staffRows.length === 0) {
        skipped.push({ staff_id: staffId, reason: 'Staff member not found.' });
        continue;
      }
      if (staffRows[0].status === 'Terminated') {
        skipped.push({ staff_id: staffId, reason: 'Staff member is terminated.' });
        continue;
      }

      // Same close-then-reopen pattern as the single-assign endpoint,
      // so each staff member's history stays independent and correct.
      await connection.execute(
        `UPDATE staff_supervisor_assignments
         SET unassigned_date = ?
         WHERE staff_id = ? AND unassigned_date IS NULL`,
        [addDays(effectiveDate, -1), staffId]
      );

      await connection.execute(
        `INSERT INTO staff_supervisor_assignments
           (staff_id, supervisor_user_id, assigned_by_user_id, assigned_date, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [staffId, supervisorId, adminId, effectiveDate, notes || null]
      );

      await connection.execute(
        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
         VALUES ('staff_members', ?, 'SUPERVISOR_ASSIGNED', ?, NULL, ?)`,
        [staffId, adminId, JSON.stringify({ supervisor_user_id: supervisorId, assigned_date: effectiveDate, notes, bulk: true })]
      );

      updated.push(staffId);
    }

    await connection.commit();
    return res.status(200).json({
      status: 'success',
      message: `Supervisor assigned to ${updated.length} staff member(s).`,
      data: { updated, skipped },
    });
  } catch (error) {
    await connection.rollback();
    console.error('BULK ASSIGN STAFF SUPERVISOR ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'An error occurred while bulk-assigning the supervisor.' });
  } finally {
    connection.release();
  }
};
// Shared helper — used by staffAttendanceController.js for scope filtering.
// B10: "today" is the business date (Asia/Beirut), not the DB server's CURDATE().
exports.getAssignedStaffIdsForSupervisor = async (supervisorUserId, executor = db) => {
  const today = businessToday();
  const [rows] = await executor.execute(
   `SELECT staff_id FROM staff_supervisor_assignments
 WHERE supervisor_user_id = ?
   AND ${activeOn('', '?')}`,
    [supervisorUserId, today, today]
  );
  return rows.map((r) => r.staff_id);
};


// GET /api/staff/my-assigned-staff  (StaffSupervisor only)
exports.getMyAssignedStaff = async (req, res) => {
  const supervisorId = req.user.user_id;
  try {
    const [rows] = await db.execute(
      `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.position,
              sm.standard_daily_hours, sm.status
       FROM staff_supervisor_assignments ssa
       JOIN staff_members sm ON sm.staff_id = ssa.staff_id
       WHERE ssa.supervisor_user_id = ?
         AND ${activeOn('ssa')}
         AND sm.status = 'Active'
       ORDER BY sm.full_name`,
      [supervisorId, businessToday(), businessToday()]
    );
    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('GET MY ASSIGNED STAFF ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load assigned staff.' });
  }
};