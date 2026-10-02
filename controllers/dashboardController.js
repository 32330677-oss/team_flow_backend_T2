const pool = require('../config/db');

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}

function isSpecificSite(value) {
  return value !== undefined && value !== null && !['', 'null', '0', 'All'].includes(String(value));
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

// ============================================================
// 1) DAILY DASHBOARD
// GET /api/dashboard/daily?date=YYYY-MM-DD&site_id=optional
// ============================================================
async function getDailyDashboard(req, res) {
  const { date, site_id } = req.query;
  const targetDate = isValidDate(date) ? date : new Date().toISOString().slice(0, 10);
  const scoped = isSpecificSite(site_id);

  try {
    const siteFilter = scoped ? ' AND s.site_id = ?' : '';
    const siteParams = scoped ? [site_id] : [];

    const [sitesRows] = await pool.execute(
      `SELECT
          s.site_id,
          s.site_name,
          COUNT(DISTINCT w.worker_id) AS total_assigned,
          COUNT(DISTINCT CASE WHEN a.check_in_time IS NOT NULL AND a.check_out_time IS NULL AND alp.leave_id IS NULL THEN w.worker_id END) AS currently_working,
          COUNT(DISTINCT CASE WHEN alp.leave_id IS NOT NULL THEN w.worker_id END) AS on_break,
          COUNT(DISTINCT CASE WHEN a.check_out_time IS NOT NULL THEN w.worker_id END) AS checked_out,
          COUNT(DISTINCT CASE WHEN a.check_in_time IS NOT NULL THEN w.worker_id END) AS attended_total,
          COUNT(DISTINCT CASE WHEN a.attendance_status = 'Absent' THEN w.worker_id END) AS absent_count,
          COUNT(DISTINCT CASE WHEN a.attendance_status = 'Sick' THEN w.worker_id END) AS sick_count,
          COUNT(DISTINCT CASE WHEN a.attendance_status = 'Vacation' THEN w.worker_id END) AS vacation_count,
          COUNT(DISTINCT CASE WHEN a.attendance_status = 'Holiday' THEN w.worker_id END) AS holiday_count
       FROM sites s
       LEFT JOIN workersiteassignments wsa ON wsa.site_id = s.site_id AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= CURDATE())
       LEFT JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
       LEFT JOIN attendance a ON a.worker_id = w.worker_id AND a.site_id = s.site_id AND a.record_date = ?
       LEFT JOIN attendanceleaveperiods alp ON alp.attendance_id = a.attendance_id AND alp.leave_end_time IS NULL
       WHERE s.site_status = 'Active'${siteFilter}
       GROUP BY s.site_id, s.site_name
       ORDER BY s.site_name`,
      [targetDate, ...siteParams]
    );

    const sites = sitesRows.map((row) => {
      const totalAssigned = Number(row.total_assigned);
      const attendedTotal = Number(row.attended_total);
      const notCheckedIn = Math.max(
        0,
        totalAssigned -
          attendedTotal -
          Number(row.absent_count) -
          Number(row.sick_count) -
          Number(row.vacation_count) -
          Number(row.holiday_count)
      );
      return {
        site_id: row.site_id,
        site_name: row.site_name,
        total_assigned: totalAssigned,
        currently_working: Number(row.currently_working),
        on_break: Number(row.on_break),
        checked_out: Number(row.checked_out),
        not_checked_in: notCheckedIn,
        absent_count: Number(row.absent_count),
        sick_count: Number(row.sick_count),
        vacation_count: Number(row.vacation_count),
        holiday_count: Number(row.holiday_count),
        attendance_rate: pct(attendedTotal, totalAssigned),
      };
    });

    const totals = sites.reduce(
      (acc, s) => {
        acc.total_assigned += s.total_assigned;
        acc.currently_working += s.currently_working;
        acc.on_break += s.on_break;
        acc.checked_out += s.checked_out;
        acc.not_checked_in += s.not_checked_in;
        acc.absent_count += s.absent_count;
        acc.sick_count += s.sick_count;
        acc.vacation_count += s.vacation_count;
        acc.holiday_count += s.holiday_count;
        return acc;
      },
      {
        total_assigned: 0,
        currently_working: 0,
        on_break: 0,
        checked_out: 0,
        not_checked_in: 0,
        absent_count: 0,
        sick_count: 0,
        vacation_count: 0,
        holiday_count: 0,
      }
    );

    const attendedOverall = totals.currently_working + totals.on_break + totals.checked_out;
    totals.attendance_rate = pct(attendedOverall, totals.total_assigned);

    const workflowFilter = scoped ? ' AND site_id = ?' : '';
    const workflowParams = scoped ? [site_id] : [];
    const [workflowRows] = await pool.execute(
      `SELECT status, COUNT(*) AS count FROM attendance WHERE record_date = ?${workflowFilter} GROUP BY status`,
      [targetDate, ...workflowParams]
    );
    const workflow = { Draft: 0, Submitted: 0, Approved: 0, Rejected: 0 };
    workflowRows.forEach((r) => {
      workflow[r.status] = Number(r.count);
    });

    return res.json({ success: true, date: targetDate, totals, workflow, sites });
  } catch (error) {
    console.error('getDailyDashboard:', error);
    return res.status(500).json({ success: false, message: 'Failed to load the daily dashboard.' });
  }
}

// ============================================================
// 2) WEEKLY DASHBOARD
// GET /api/dashboard/weekly?start_date=&end_date=&site_id=optional
// ============================================================
async function getWeeklyDashboard(req, res) {
  const { start_date, end_date, site_id } = req.query;
  if (!isValidDate(start_date) || !isValidDate(end_date)) {
    return res.status(400).json({ success: false, message: 'start_date and end_date must use YYYY-MM-DD.' });
  }
  if (end_date < start_date) {
    return res.status(400).json({ success: false, message: 'end_date must be after or equal to start_date.' });
  }
  const dayCount = Math.round((new Date(`${end_date}T00:00:00Z`) - new Date(`${start_date}T00:00:00Z`)) / 86400000) + 1;
  if (dayCount > 31) {
    return res.status(400).json({ success: false, message: 'Range too large for the weekly view (max 31 days).' });
  }
  const scoped = isSpecificSite(site_id);

  try {
    const assignSiteFilter = scoped ? ' AND wsa.site_id = ?' : '';
    const assignSiteParams = scoped ? [site_id] : [];
    const attSiteFilter = scoped ? ' AND a.site_id = ?' : '';
    const attSiteParams = scoped ? [site_id] : [];

    // Day-by-day attendance rate (line chart source)
    const [dailySeries] = await pool.query(
      `WITH RECURSIVE date_series AS (
          SELECT DATE(?) AS dt
          UNION ALL
          SELECT DATE_ADD(dt, INTERVAL 1 DAY) FROM date_series WHERE dt < DATE(?)
       )
       SELECT
          ds.dt AS record_date,
          COUNT(DISTINCT w.worker_id) AS total_assigned,
          COUNT(DISTINCT CASE WHEN a.check_in_time IS NOT NULL THEN w.worker_id END) AS attended
       FROM date_series ds
       LEFT JOIN workersiteassignments wsa
          ON wsa.assigned_date <= ds.dt
          AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ds.dt)${assignSiteFilter}
       LEFT JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
       LEFT JOIN attendance a ON a.worker_id = w.worker_id AND a.site_id = wsa.site_id AND a.record_date = ds.dt
       GROUP BY ds.dt
       ORDER BY ds.dt`,
      [start_date, end_date, ...assignSiteParams]
    );

    const daily = dailySeries.map((row) => ({
      date: String(row.record_date).slice(0, 10),
      total_assigned: Number(row.total_assigned),
      attended: Number(row.attended),
      attendance_rate: pct(Number(row.attended), Number(row.total_assigned)),
    }));

    // Hours summary
    const [hoursRows] = await pool.execute(
      `SELECT
          COALESCE(SUM(total_working_hours), 0) AS regular_hours,
          COALESCE(SUM(overtime_hours), 0) AS overtime_hours
       FROM attendance a
       WHERE a.record_date BETWEEN ? AND ?${attSiteFilter}`,
      [start_date, end_date, ...attSiteParams]
    );

    // Top absentees this week
    const [topAbsentees] = await pool.execute(
      `SELECT w.worker_id, w.full_name, COUNT(*) AS absent_days
       FROM attendance a
       JOIN workers w ON w.worker_id = a.worker_id
       WHERE a.record_date BETWEEN ? AND ? AND a.attendance_status = 'Absent'${attSiteFilter}
       GROUP BY w.worker_id, w.full_name
       ORDER BY absent_days DESC
       LIMIT 5`,
      [start_date, end_date, ...attSiteParams]
    );

    // Review / rejection rate
    const [reviewRows] = await pool.execute(
      `SELECT status, COUNT(*) AS count
       FROM attendance a
       WHERE a.record_date BETWEEN ? AND ? AND a.status IN ('Submitted', 'Approved', 'Rejected')${attSiteFilter}
       GROUP BY status`,
      [start_date, end_date, ...attSiteParams]
    );
    const review = { Submitted: 0, Approved: 0, Rejected: 0 };
    reviewRows.forEach((r) => {
      review[r.status] = Number(r.count);
    });
    const reviewedTotal = review.Approved + review.Rejected;
    const rejectionRate = pct(review.Rejected, reviewedTotal);

    // Site comparison over the whole period (person-days based rate)
    const [siteComparison] = await pool.execute(
      `SELECT
          s.site_id,
          s.site_name,
          COUNT(DISTINCT w.worker_id) AS total_assigned,
          COUNT(DISTINCT CASE WHEN a.check_in_time IS NOT NULL THEN CONCAT(a.worker_id, '-', a.record_date) END) AS attended_person_days
       FROM sites s
       LEFT JOIN workersiteassignments wsa ON wsa.site_id = s.site_id AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= CURDATE())
       LEFT JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
       LEFT JOIN attendance a ON a.worker_id = w.worker_id AND a.site_id = s.site_id AND a.record_date BETWEEN ? AND ?
       WHERE s.site_status = 'Active'${scoped ? ' AND s.site_id = ?' : ''}
       GROUP BY s.site_id, s.site_name
       ORDER BY s.site_name`,
      scoped ? [start_date, end_date, site_id] : [start_date, end_date]
    );

    return res.json({
      success: true,
      start_date,
      end_date,
      daily,
      hours: {
        regular_hours: Number(hoursRows[0].regular_hours),
        overtime_hours: Number(hoursRows[0].overtime_hours),
      },
      top_absentees: topAbsentees.map((r) => ({
        worker_id: r.worker_id,
        full_name: r.full_name,
        absent_days: Number(r.absent_days),
      })),
      review: { ...review, rejection_rate: rejectionRate },
      site_comparison: siteComparison.map((r) => ({
        site_id: r.site_id,
        site_name: r.site_name,
        total_assigned: Number(r.total_assigned),
        attendance_rate: pct(Number(r.attended_person_days), Number(r.total_assigned) * dayCount),
      })),
    });
  } catch (error) {
    console.error('getWeeklyDashboard:', error);
    return res.status(500).json({ success: false, message: 'Failed to load the weekly dashboard.' });
  }
}

// ============================================================
// 3) MONTHLY DASHBOARD
// GET /api/dashboard/monthly?month=YYYY-MM&site_id=optional
// ============================================================
async function getMonthlyDashboard(req, res) {
  const { month, site_id } = req.query;
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) {
    return res.status(400).json({ success: false, message: 'month must use YYYY-MM format.' });
  }
  const [year, mo] = month.split('-').map(Number);
  const daysInMonth = new Date(year, mo, 0).getDate();
  const startDate = `${month}-01`;
  const endDate = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  const scoped = isSpecificSite(site_id);

  try {
    const attSiteFilter = scoped ? ' AND a.site_id = ?' : '';
    const attSiteParams = scoped ? [site_id] : [];
    const assignSiteFilter = scoped ? ' AND wsa.site_id = ?' : '';
    const assignSiteParams = scoped ? [site_id] : [];

    // Overall summary
    const [summaryRows] = await pool.execute(
      `SELECT
          COUNT(DISTINCT w.worker_id) AS total_assigned,
          COUNT(DISTINCT CASE WHEN a.check_in_time IS NOT NULL THEN CONCAT(a.worker_id, '-', a.record_date) END) AS attended_person_days,
          COALESCE(SUM(a.total_working_hours), 0) AS regular_hours,
          COALESCE(SUM(a.overtime_hours), 0) AS overtime_hours
       FROM workersiteassignments wsa
       JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
       LEFT JOIN attendance a ON a.worker_id = w.worker_id AND a.site_id = wsa.site_id AND a.record_date BETWEEN ? AND ?
       WHERE (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= CURDATE())${assignSiteFilter}`,
      [startDate, endDate, ...assignSiteParams]
    );

    const totalAssigned = Number(summaryRows[0].total_assigned);
    const attendedPersonDays = Number(summaryRows[0].attended_person_days);
    const regularHours = Number(summaryRows[0].regular_hours);
    const overtimeHours = Number(summaryRows[0].overtime_hours);
    const totalHours = regularHours + overtimeHours;
    const attendanceRate = pct(attendedPersonDays, totalAssigned * daysInMonth);

    // Calendar heatmap (day-by-day)
    const [calendarRows] = await pool.query(
      `WITH RECURSIVE date_series AS (
          SELECT DATE(?) AS dt
          UNION ALL
          SELECT DATE_ADD(dt, INTERVAL 1 DAY) FROM date_series WHERE dt < DATE(?)
       )
       SELECT
          ds.dt AS record_date,
          COUNT(DISTINCT w.worker_id) AS total_assigned,
          COUNT(DISTINCT CASE WHEN a.check_in_time IS NOT NULL THEN w.worker_id END) AS attended
       FROM date_series ds
       LEFT JOIN workersiteassignments wsa
          ON wsa.assigned_date <= ds.dt
          AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ds.dt)${assignSiteFilter}
       LEFT JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
       LEFT JOIN attendance a ON a.worker_id = w.worker_id AND a.site_id = wsa.site_id AND a.record_date = ds.dt
       GROUP BY ds.dt
       ORDER BY ds.dt`,
      [startDate, endDate, ...assignSiteParams]
    );
    const calendar = calendarRows.map((row) => ({
      date: String(row.record_date).slice(0, 10),
      attendance_rate: pct(Number(row.attended), Number(row.total_assigned)),
    }));

    // Top absentees
    const [topAbsentees] = await pool.execute(
      `SELECT w.worker_id, w.full_name, COUNT(*) AS absent_days
       FROM attendance a
       JOIN workers w ON w.worker_id = a.worker_id
       WHERE a.record_date BETWEEN ? AND ? AND a.attendance_status = 'Absent'${attSiteFilter}
       GROUP BY w.worker_id, w.full_name
       ORDER BY absent_days DESC
       LIMIT 5`,
      [startDate, endDate, ...attSiteParams]
    );

    // Worker turnover (best-effort, based on updated_at since no history table exists)
    const [turnoverRows] = await pool.execute(
      `SELECT COUNT(*) AS deactivated_count
       FROM workers
       WHERE status = 'Inactive' AND updated_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)`,
      [`${startDate} 00:00:00`, `${endDate} 00:00:00`]
    );

    // Approved transfers this month
    const [transferRows] = await pool.execute(
      `SELECT COUNT(*) AS approved_transfers
       FROM worker_transfer_requests
       WHERE status = 'Approved' AND updated_at BETWEEN ? AND DATE_ADD(?, INTERVAL 1 DAY)`,
      [`${startDate} 00:00:00`, `${endDate} 00:00:00`]
    );

    // Supervisor performance snapshot
    const [supervisorPerf] = await pool.execute(
      `SELECT
          u.user_id, u.full_name,
          COUNT(*) AS total_recorded,
          SUM(CASE WHEN a.status = 'Approved' THEN 1 ELSE 0 END) AS approved_count,
          SUM(CASE WHEN a.status = 'Rejected' THEN 1 ELSE 0 END) AS rejected_count
       FROM attendance a
       JOIN users u ON u.user_id = a.recorded_by_user_id
       WHERE a.record_date BETWEEN ? AND ?${attSiteFilter}
       GROUP BY u.user_id, u.full_name
       ORDER BY total_recorded DESC`,
      [startDate, endDate, ...attSiteParams]
    );

    // Site comparison
    const [siteComparison] = await pool.execute(
      `SELECT
          s.site_id,
          s.site_name,
          COUNT(DISTINCT w.worker_id) AS total_assigned,
          COUNT(DISTINCT CASE WHEN a.check_in_time IS NOT NULL THEN CONCAT(a.worker_id, '-', a.record_date) END) AS attended_person_days
       FROM sites s
       LEFT JOIN workersiteassignments wsa ON wsa.site_id = s.site_id AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= CURDATE())
       LEFT JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
       LEFT JOIN attendance a ON a.worker_id = w.worker_id AND a.site_id = s.site_id AND a.record_date BETWEEN ? AND ?
       WHERE s.site_status = 'Active'${scoped ? ' AND s.site_id = ?' : ''}
       GROUP BY s.site_id, s.site_name
       ORDER BY s.site_name`,
      scoped ? [startDate, endDate, site_id] : [startDate, endDate]
    );

    return res.json({
      success: true,
      month,
      start_date: startDate,
      end_date: endDate,
      summary: {
        total_assigned: totalAssigned,
        attendance_rate: attendanceRate,
        regular_hours: regularHours,
        overtime_hours: overtimeHours,
        overtime_share: pct(overtimeHours, totalHours),
      },
      calendar,
      top_absentees: topAbsentees.map((r) => ({
        worker_id: r.worker_id,
        full_name: r.full_name,
        absent_days: Number(r.absent_days),
      })),
      turnover: {
        deactivated_workers: Number(turnoverRows[0].deactivated_count),
        approved_transfers: Number(transferRows[0].approved_transfers),
      },
      supervisor_performance: supervisorPerf.map((r) => ({
        user_id: r.user_id,
        full_name: r.full_name,
        total_recorded: Number(r.total_recorded),
        approved_count: Number(r.approved_count),
        rejected_count: Number(r.rejected_count),
        approval_rate: pct(Number(r.approved_count), Number(r.total_recorded)),
      })),
      site_comparison: siteComparison.map((r) => ({
        site_id: r.site_id,
        site_name: r.site_name,
        total_assigned: Number(r.total_assigned),
        attendance_rate: pct(Number(r.attended_person_days), Number(r.total_assigned) * daysInMonth),
      })),
    });
  } catch (error) {
    console.error('getMonthlyDashboard:', error);
    return res.status(500).json({ success: false, message: 'Failed to load the monthly dashboard.' });
  }
}

module.exports = { getDailyDashboard, getWeeklyDashboard, getMonthlyDashboard };