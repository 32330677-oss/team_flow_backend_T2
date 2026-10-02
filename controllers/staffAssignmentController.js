// controllers/staffAssignmentController.js
//
// Tracks which site a staff member is currently assigned to, and keeps full
// history (mirrors workerSiteAssignments for workers, kept as a separate
// table/file per the "don't merge staff and worker logic" requirement).
//
// Wire into routes/staffRoutes.js:
//   const staffAssignmentController = require('../controllers/staffAssignmentController');
//   router.get('/:id/assignments', restrictTo('Admin'), staffAssignmentController.getHistory);
//   router.post('/:id/assignments', restrictTo('Admin'), staffAssignmentController.assignToSite);
//   router.delete('/:id/assignments/current', restrictTo('Admin'), staffAssignmentController.unassignCurrent);

const db = require('../config/db');
const { businessToday, addDays } = require('../services/businessDate');
const { activeOn } = require('../services/assignmentDates');

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// GET /api/staff/:id/assignments
exports.getHistory = async (req, res) => {
  const staffId = Number(req.params.id);
  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid staff id.' });
  }
  try {
    const [rows] = await db.execute(
      `SELECT ssa.*, s.site_name, u.full_name AS assigned_by_name
       FROM staff_site_assignments ssa
       JOIN sites s ON s.site_id = ssa.site_id
       LEFT JOIN users u ON u.user_id = ssa.assigned_by_user_id
       WHERE ssa.staff_id = ?
       ORDER BY ssa.assigned_date DESC, ssa.staff_assignment_id DESC`,
      [staffId]
    );
    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('GET STAFF ASSIGNMENT HISTORY ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load assignment history.' });
  }
};

// POST /api/staff/:id/assignments
// body: { site_id, assigned_date, notes }
// Closes any currently open assignment for this staff member and opens a new one.
// A staff member with NO site (e.g. moved into a pure supervisor role with no
// fixed site) is represented simply by having no open assignment row.
exports.assignToSite = async (req, res) => {
  const staffId = Number(req.params.id);
  const { site_id, assigned_date, notes } = req.body || {};
  const adminId = req.user.user_id;

  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid staff id.' });
  }
  if (!site_id) {
    return res.status(400).json({ status: 'error', message: 'site_id is required.' });
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
      return res.status(400).json({ status: 'error', message: 'Cannot assign a terminated staff member to a site.' });
    }

    const [siteRows] = await connection.execute('SELECT site_id FROM sites WHERE site_id = ? LIMIT 1', [site_id]);
    if (siteRows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'The specified site does not exist.' });
    }

    // Close any open assignment (idempotent no-op if same site — still closes
    // and reopens so the history reflects an explicit re-assignment event).
    await connection.execute(
      // §5: the old assignment's LAST day is the day before the new one starts.
      `UPDATE staff_site_assignments
       SET unassigned_date = ?
       WHERE staff_id = ? AND unassigned_date IS NULL`,
      [addDays(effectiveDate, -1), staffId]
    );

    await connection.execute(
      `INSERT INTO staff_site_assignments
         (staff_id, site_id, assigned_by_user_id, assigned_date, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [staffId, site_id, adminId, effectiveDate, notes || null]
    );

    // Keep staff_members.site_id in sync as the cheap "current site" pointer.
    await connection.execute('UPDATE staff_members SET site_id = ? WHERE staff_id = ?', [site_id, staffId]);

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_members', ?, 'SITE_ASSIGNED', ?, NULL, ?)`,
      [staffId, adminId, JSON.stringify({ site_id, assigned_date: effectiveDate, notes })]
    );

    await connection.commit();
    return res.status(201).json({ status: 'success', message: 'Staff member assigned to site successfully.' });
  } catch (error) {
    await connection.rollback();
    console.error('ASSIGN STAFF TO SITE ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'An error occurred while assigning the staff member.' });
  } finally {
    connection.release();
  }
};

// DELETE /api/staff/:id/assignments/current
// Unassigns the staff member from their current site without assigning a new one
// (e.g. a site engineer who becomes a floating supervisor).
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
      `UPDATE staff_site_assignments
       SET unassigned_date = ?
       WHERE staff_id = ? AND unassigned_date IS NULL AND assigned_date <= DATE_ADD(?, INTERVAL 1 DAY)`,
      [effectiveDate, staffId, effectiveDate]
    );
    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ status: 'error', message: 'Staff member has no open site assignment.' });
    }

    await connection.execute('UPDATE staff_members SET site_id = NULL WHERE staff_id = ?', [staffId]);

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_members', ?, 'SITE_UNASSIGNED', ?, NULL, ?)`,
      [staffId, adminId, JSON.stringify({ unassigned_date: effectiveDate })]
    );

    await connection.commit();
    return res.status(200).json({ status: 'success', message: 'Staff member unassigned from site successfully.' });
  } catch (error) {
    await connection.rollback();
    console.error('UNASSIGN STAFF FROM SITE ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'An error occurred while unassigning the staff member.' });
  } finally {
    connection.release();
  }
};