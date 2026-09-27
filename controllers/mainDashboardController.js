const pool = require('../config/db');

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function localDateString(date = new Date()) {
  // Attendance dates are wall-clock dates, not UTC dates. The server's
  // configured timezone must therefore be used for the dashboard date.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function number(value) {
  return Number(value || 0);
}

async function getOverview(req, res) {
  try {
    const today = localDateString();
    let { start_date, end_date } = req.query;
    if (!isValidDate(end_date)) end_date = today;
    if (!isValidDate(start_date)) {
      const start = new Date(`${end_date}T00:00:00`);
      start.setDate(start.getDate() - 13);
      start_date = localDateString(start);
    }
    if (end_date < start_date) {
      return res.status(400).json({ status: 'error', message: 'start_date must be before or equal to end_date.' });
    }

    // Every KPI below is based on the same definition: an active worker with
    // an assignment effective on the relevant date and an active site.
    const assignmentToday = `
      JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
      JOIN sites s ON s.site_id = wsa.site_id AND s.site_status = 'Active'
      WHERE wsa.assigned_date <= ?
        AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ?)`;

    const [[assignedTotals]] = await pool.execute(
      `SELECT COUNT(DISTINCT wsa.worker_id) AS total_assigned
       FROM workersiteassignments wsa
       ${assignmentToday}`,
      [today, today]
    );
    const totalAssignedWorkers = number(assignedTotals.total_assigned);

    const [todayRows] = await pool.execute(
      `SELECT
         COUNT(DISTINCT CASE WHEN a.attendance_status = 'Present' THEN a.worker_id END) AS present_today,
         COUNT(DISTINCT CASE WHEN a.attendance_status IN ('Sick','Vacation','Holiday') THEN a.worker_id END) AS on_leave_today,
         COUNT(DISTINCT CASE WHEN a.attendance_status = 'Absent' THEN a.worker_id END) AS absent_today,
         COUNT(DISTINCT CASE WHEN a.check_in_time IS NOT NULL AND a.check_out_time IS NULL
                              AND alp.attendance_id IS NULL THEN a.worker_id END) AS currently_working_now,
         COUNT(DISTINCT CASE WHEN alp.attendance_id IS NOT NULL THEN a.worker_id END) AS on_break_now
       FROM attendance a
       JOIN workers w ON w.worker_id = a.worker_id AND w.status = 'Active'
       JOIN sites s ON s.site_id = a.site_id AND s.site_status = 'Active'
JOIN workersiteassignments wsa
  ON wsa.worker_id = a.worker_id
 AND wsa.site_id = a.site_id
 AND wsa.shift_type = a.shift_type
 AND wsa.assigned_date <= a.record_date
        AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= a.record_date)
       LEFT JOIN (
         SELECT DISTINCT a2.attendance_id
         FROM attendanceleaveperiods alp2
         JOIN attendance a2 ON a2.attendance_id = alp2.attendance_id
         WHERE alp2.leave_end_time IS NULL AND a2.record_date = ?
       ) alp ON alp.attendance_id = a.attendance_id
       WHERE a.record_date = ? AND a.status <> 'Rejected'`,
      [today, today]
    );
    const todaySummary = todayRows[0] || {};
    const presentToday = number(todaySummary.present_today);
    const currentlyWorkingNow = number(todaySummary.currently_working_now);
    const onBreakNowCount = number(todaySummary.on_break_now);
    const onLeaveToday = number(todaySummary.on_leave_today);
    const absentToday = number(todaySummary.absent_today);
    const attendanceRate = totalAssignedWorkers > 0
      ? Math.round((presentToday / totalAssignedWorkers) * 10000) / 100
      : 0;

    const [onLeaveNowRows] = await pool.execute(
      `SELECT DISTINCT w.full_name, s.site_name, alp.leave_type, alp.leave_start_time
       FROM attendanceleaveperiods alp
       JOIN attendance a ON a.attendance_id = alp.attendance_id
       JOIN workers w ON w.worker_id = a.worker_id AND w.status = 'Active'
       JOIN sites s ON s.site_id = a.site_id AND s.site_status = 'Active'
JOIN workersiteassignments wsa
  ON wsa.worker_id = a.worker_id
 AND wsa.site_id = a.site_id
 AND wsa.shift_type = a.shift_type
 AND wsa.assigned_date <= a.record_date
 AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= a.record_date)
       WHERE alp.leave_end_time IS NULL AND a.record_date = ? AND a.status <> 'Rejected'
       ORDER BY alp.leave_start_time DESC`,
      [today]
    );

    const [siteRows] = await pool.query(
      `SELECT s.site_id, s.site_name,
              COUNT(DISTINCT wsa.worker_id) AS assigned_workers,
              COUNT(DISTINCT CASE WHEN a.check_in_time IS NOT NULL AND a.check_out_time IS NULL
                                   AND alp.attendance_id IS NULL THEN wsa.worker_id END) AS currently_working,
              COUNT(DISTINCT CASE WHEN a.check_in_time IS NOT NULL THEN wsa.worker_id END) AS checked_in_today,
              COUNT(DISTINCT CASE WHEN alp.attendance_id IS NOT NULL THEN wsa.worker_id END) AS on_break_now,
              COUNT(DISTINCT CASE WHEN a.attendance_status IN ('Sick','Vacation','Holiday') THEN wsa.worker_id END) AS on_leave_today,
              COUNT(DISTINCT CASE WHEN a.attendance_status = 'Absent' THEN wsa.worker_id END) AS absent_today,
              MAX(CASE WHEN a.status IN ('Submitted','Approved') THEN 1 ELSE 0 END) AS is_submitted
       FROM sites s
       JOIN workersiteassignments wsa
         ON wsa.site_id = s.site_id AND wsa.assigned_date <= ?
        AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ?)
       JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
LEFT JOIN attendance a
  ON a.worker_id = wsa.worker_id
 AND a.site_id = wsa.site_id
 AND a.shift_type = wsa.shift_type
 AND a.record_date = ?
 AND a.status <> 'Rejected'
       LEFT JOIN attendanceleaveperiods alp
         ON alp.attendance_id = a.attendance_id AND alp.leave_end_time IS NULL
       WHERE s.site_status = 'Active'
       GROUP BY s.site_id, s.site_name
       ORDER BY currently_working DESC, s.site_name`,
      [today, today, today]
    );

    const [attendanceSeriesRows] = await pool.query(
      `WITH RECURSIVE date_series AS (
         SELECT DATE(?) AS dt
         UNION ALL
         SELECT DATE_ADD(dt, INTERVAL 1 DAY) FROM date_series WHERE dt < DATE(?)
       )
       SELECT ds.dt AS record_date,
              COUNT(DISTINCT CASE WHEN a.attendance_status = 'Present' THEN wsa.worker_id END) AS present_count,
              COUNT(DISTINCT CASE WHEN a.attendance_status IN ('Sick','Vacation','Holiday') THEN wsa.worker_id END) AS leave_count,
              COUNT(DISTINCT CASE WHEN a.attendance_status = 'Absent' THEN wsa.worker_id END) AS absent_count
       FROM date_series ds
       LEFT JOIN workersiteassignments wsa
         ON wsa.assigned_date <= ds.dt
        AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ds.dt)
       LEFT JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
       LEFT JOIN sites s ON s.site_id = wsa.site_id AND s.site_status = 'Active'
LEFT JOIN attendance a
  ON a.worker_id = wsa.worker_id
 AND a.site_id = wsa.site_id
 AND a.shift_type = wsa.shift_type
 AND a.record_date = ds.dt
 AND a.status <> 'Rejected'
       GROUP BY ds.dt ORDER BY ds.dt`,
      [start_date, end_date]
    );

    const [dailyHoursRows] = await pool.query(
      `WITH RECURSIVE date_series AS (
         SELECT DATE(?) AS dt
         UNION ALL
         SELECT DATE_ADD(dt, INTERVAL 1 DAY) FROM date_series WHERE dt < DATE(?)
       )
       SELECT ds.dt AS record_date,
              COALESCE(SUM(CASE WHEN a.attendance_status = 'Present' THEN COALESCE(a.total_working_hours, 0) ELSE 0 END), 0) AS regular_hours,
              COALESCE(SUM(CASE WHEN a.attendance_status = 'Present' THEN COALESCE(a.overtime_hours, 0) ELSE 0 END), 0) AS overtime_hours
       FROM date_series ds
       LEFT JOIN workersiteassignments wsa
         ON wsa.assigned_date <= ds.dt
        AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ds.dt)
       LEFT JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
       LEFT JOIN sites s ON s.site_id = wsa.site_id AND s.site_status = 'Active'
LEFT JOIN attendance a
  ON a.worker_id = wsa.worker_id
 AND a.site_id = wsa.site_id
 AND a.shift_type = wsa.shift_type
 AND a.record_date = ds.dt
 AND a.status <> 'Rejected'
       GROUP BY ds.dt ORDER BY ds.dt`,
      [start_date, end_date]
    );

    const [lastPaidRows] = await pool.query(
      `SELECT pb.payroll_batch_id, pb.start_date, pb.end_date, pb.total_amount, pb.total_workers,
              MAX(p.paid_date) AS paid_date
       FROM payrollbatches pb
       JOIN payroll p ON p.payroll_batch_id = pb.payroll_batch_id
       WHERE pb.status = 'Paid'
       GROUP BY pb.payroll_batch_id, pb.start_date, pb.end_date, pb.total_amount, pb.total_workers
       ORDER BY paid_date DESC LIMIT 1`
    );
    const lastPaidPayroll = lastPaidRows.length ? {
      batch_id: lastPaidRows[0].payroll_batch_id,
      period: `${String(lastPaidRows[0].start_date).slice(0, 10)} - ${String(lastPaidRows[0].end_date).slice(0, 10)}`,
      total_amount: number(lastPaidRows[0].total_amount),
      total_workers: number(lastPaidRows[0].total_workers),
      paid_date: lastPaidRows[0].paid_date ? String(lastPaidRows[0].paid_date).slice(0, 10) : null,
    } : null;

    const [latestBatchRows] = await pool.query(
      `SELECT payroll_batch_id, start_date, end_date, total_workers, status, generated_at, total_amount
       FROM payrollbatches WHERE status <> 'Superseded'
       ORDER BY generated_at DESC LIMIT 1`
    );
    const latestPayrollBatch = latestBatchRows.length ? {
      batch_id: latestBatchRows[0].payroll_batch_id,
      period: `${String(latestBatchRows[0].start_date).slice(0, 10)} - ${String(latestBatchRows[0].end_date).slice(0, 10)}`,
      total_amount: number(latestBatchRows[0].total_amount),
      total_workers: number(latestBatchRows[0].total_workers),
      status: latestBatchRows[0].status,
    } : null;

    const [positionRows] = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(job_position),''),'Others') AS position, COUNT(*) AS cnt
       FROM workers WHERE status = 'Active' GROUP BY position ORDER BY cnt DESC`
    );
    const [topSiteRows] = await pool.query(
      `SELECT s.site_name, COUNT(DISTINCT wsa.worker_id) AS worker_count
       FROM workersiteassignments wsa
       JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
       JOIN sites s ON s.site_id = wsa.site_id AND s.site_status = 'Active'
       WHERE wsa.assigned_date <= ? AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ?)
       GROUP BY s.site_id, s.site_name ORDER BY worker_count DESC LIMIT 6`,
      [today, today]
    );
    const [[pendingRow]] = await pool.execute(`SELECT COUNT(*) AS cnt FROM attendance WHERE status = 'Submitted'`);
    const [[rejectedRow]] = await pool.execute(`SELECT COUNT(*) AS cnt FROM attendance WHERE status = 'Rejected'`);

    return res.json({
      status: 'success',
      data: {
        range: { start_date, end_date },
        kpis: {
          total_workers: totalAssignedWorkers,
          currently_working_now: currentlyWorkingNow,
          present_today: presentToday,
          on_leave_today: onLeaveToday,
          absent_today: absentToday,
          attendance_rate: attendanceRate,
          pending_reviews: number(pendingRow.cnt),
          rejected_records: number(rejectedRow.cnt),
          on_break_now: onBreakNowCount,
        },
        live_sites: siteRows.map(r => ({
          site_id: r.site_id,
          site_name: r.site_name,
          assigned_workers: number(r.assigned_workers),
          currently_working: number(r.currently_working),
          checked_in_today: number(r.checked_in_today),
          on_break_now: number(r.on_break_now),
          on_leave_today: number(r.on_leave_today),
          absent_today: number(r.absent_today),
          is_submitted: number(r.is_submitted) === 1,
        })),
        on_leave_now: onLeaveNowRows.map(r => ({
          full_name: r.full_name,
          site_name: r.site_name,
          leave_type: r.leave_type,
          leave_start_time: r.leave_start_time,
        })),
        attendance_overview: attendanceSeriesRows.map(r => ({
          date: String(r.record_date).slice(0, 10),
          present: number(r.present_count),
          on_leave: number(r.leave_count),
          absent: number(r.absent_count),
        })),
        daily_hours_series: dailyHoursRows.map(r => ({
          date: String(r.record_date).slice(0, 10),
          regular_hours: number(r.regular_hours),
          overtime_hours: number(r.overtime_hours),
        })),
        last_paid_payroll: lastPaidPayroll,
        latest_payroll_batch: latestPayrollBatch,
        workers_by_position: positionRows.map(r => ({ position: r.position, count: number(r.cnt) })),
        top_sites: topSiteRows.map(r => ({ site_name: r.site_name, worker_count: number(r.worker_count) })),
      },
    });
  } catch (error) {
    console.error('getOverview:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load dashboard overview.' });
  }
}

module.exports = { getOverview };
