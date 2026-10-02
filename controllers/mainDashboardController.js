// controllers/mainDashboardController.js
//
// Live Site Operations dashboard (Admin only).
//
//   GET /api/main-dashboard/live[?date=YYYY-MM-DD]
//   GET /api/main-dashboard/sites/:siteId[?date=YYYY-MM-DD]
//
// Read-only. Every figure comes from existing tables and follows the rules the
// rest of the system already applies:
//   * An assignment is effective on date D when
//       assigned_date <= D AND (unassigned_date IS NULL OR unassigned_date >= D)
//     (unassigned_date is an EXCLUSIVE end: attendance, submitDay, payroll).
//   * "Expected" = Active workers with an effective assignment to an Active
//     site for that site + shift on D. There is no work calendar and no shift
//     start time in the schema, so lateness is NOT calculated.
//   * A worker's record "for D" is chosen like getSiteWorkers/submitDay do:
//     record_date = D first; otherwise a record from D-1 that is still open
//     (Draft, checked in, no check-out) or that crossed midnight.
//   * Day and Night are never merged: every figure is per site + shift.
//   * "Has a supervisor" uses the same rule as the biometric orphan-draft
//     check: shift sites need an Active 'Supervisor' in site_shifts for that
//     shift; non-shift sites need sites.supervisor_id to be an Active
//     'Supervisor'.
//   * Payroll only pays Approved worker attendance (adminPayrollController),
//     so records that are not Approved after the last payroll batch covering a
//     site are reported as "not payroll-ready".
//   * Worker attendance and staff attendance are reported separately.

const pool = require('../config/db');
const { businessToday, isValidDateOnly, addDays } = require('../services/businessDate');
const { isFriday } = require('../services/staffAttendanceService');
const { businessNow } = require('../services/biometricPunchProcessor');
const biometricReview = require('../controllers/biometricReviewController');

const REFRESH_SECONDS = 60;

function intEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

// The only threshold on this dashboard. No business rule for "unusually high
// absence" exists in the system, so it is configurable and returned in the
// response so the UI can show the rule it was evaluated with.
const HIGH_ABSENCE_PCT = intEnv('DASHBOARD_HIGH_ABSENCE_PCT', 25, 1, 100);
const HIGH_ABSENCE_MIN = intEnv('DASHBOARD_HIGH_ABSENCE_MIN', 3, 1, 10000);

const SEVERITY_RANK = { critical: 0, warning: 1, action: 2, info: 3 };

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value) {
  return value === null || value === undefined ? null : String(value);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function resolveDate(raw) {
  const today = businessToday();
  if (raw === undefined || raw === null || raw === '') return { date: today, today };
  if (!isValidDateOnly(raw)) throw badRequest('date must use YYYY-MM-DD.');
  if (raw > today) throw badRequest('date cannot be in the future.');
  return { date: String(raw), today };
}

function rulesPayload() {
  return {
    expected_workers: 'Active workers with an assignment effective on the date (assigned_date <= date <= unassigned_date, the last assigned day) to an Active site, counted per site and shift.',
    record_for_date: 'Record dated today; otherwise a record from yesterday that is still open (Draft, checked in, not checked out) or that crossed midnight.',
    overdue_draft: 'Draft records dated before today (Night shift: before yesterday) — the supervisor has not submitted that day.',
    supervisor_required: 'Shift sites need an Active Supervisor in site_shifts for the shift; non-shift sites need sites.supervisor_id to be an Active Supervisor.',
    payroll_ready: 'Worker payroll includes Approved attendance only. Records dated after the last non-superseded payroll batch covering the site and before today that are not Approved are not payroll-ready.',
    high_absence: { percent: HIGH_ABSENCE_PCT, min_absent: HIGH_ABSENCE_MIN, description: `Absent (status 'Absent' only) >= ${HIGH_ABSENCE_MIN} workers and >= ${HIGH_ABSENCE_PCT}% of expected. Configurable with DASHBOARD_HIGH_ABSENCE_PCT / DASHBOARD_HIGH_ABSENCE_MIN.` },
    not_available: [
      'Lateness / "should have checked in by now": no shift start or end times exist in the database.',
      'Whether today is a working day for workers: there is no worker work calendar (Holiday is a per-record status).',
    ],
  };
}

// ---------------------------------------------------------------------------
// Per-worker state for the date (shared by the overview aggregation and the
// site drill-down so both always show the same numbers).
// ---------------------------------------------------------------------------
function workerStateSql(siteFilterSql) {
  return `
    SELECT wsa.site_id, wsa.shift_type, w.worker_id, w.full_name, w.worker_unique_id, w.job_position,
           DATE_FORMAT(wsa.assigned_date, '%Y-%m-%d') AS assigned_date,
           a.attendance_id, DATE_FORMAT(a.record_date, '%Y-%m-%d') AS record_date,
           a.attendance_status, a.status AS workflow_status, a.source,
           a.check_in_time, a.check_out_time,
           CASE WHEN a.attendance_id IS NULL THEN 0
                WHEN EXISTS (SELECT 1 FROM attendanceleaveperiods alp
                             WHERE alp.attendance_id = a.attendance_id
                               AND alp.leave_end_time IS NULL) THEN 1
                ELSE 0 END AS on_break
    FROM workersiteassignments wsa
    JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
    JOIN sites s ON s.site_id = wsa.site_id AND s.site_status = 'Active'
    LEFT JOIN attendance a ON a.attendance_id = (
        SELECT a2.attendance_id
        FROM attendance a2
        WHERE a2.worker_id = wsa.worker_id
          AND a2.site_id = wsa.site_id
          AND a2.shift_type = wsa.shift_type
          AND (a2.record_date = ?
               OR (a2.record_date = ? AND a2.check_in_time IS NOT NULL
                   AND ((a2.check_out_time IS NULL AND a2.status = 'Draft')
                        OR (a2.check_out_time IS NOT NULL AND DATE(a2.check_out_time) > a2.record_date))))
        ORDER BY (a2.record_date = ?) DESC, a2.attendance_id DESC
        LIMIT 1)
    WHERE wsa.assigned_date <= ?
      AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ?)
      ${siteFilterSql}`;
}

function workerStateParams(date, prevDate, siteParams) {
  return [date, prevDate, date, date, date, ...siteParams];
}

function workerState(row) {
  if (!row.attendance_id) return 'not_recorded';
  switch (row.attendance_status) {
    case 'Absent': return 'absent';
    case 'Sick': return 'sick';
    case 'Vacation': return 'vacation';
    case 'Holiday': return 'holiday';
    default: break;
  }
  if (row.check_out_time) return 'checked_out';
  if (row.check_in_time && Number(row.on_break) === 1) return 'on_break';
  if (row.check_in_time) return 'on_site';
  return 'present';
}

// ---------------------------------------------------------------------------
// Data loading — one set-based query per concern, run in parallel.
// ---------------------------------------------------------------------------
async function loadSiteData(date, siteId) {
  const prevDate = addDays(date, -1);
  const scoped = siteId !== null;
  const siteParams = scoped ? [siteId] : [];

  const sitesSql = `
    SELECT s.site_id, s.site_name, s.location, s.supports_shifts, s.supervisor_id,
           s.contract_id, c.contract_name, p.project_name,
           u.full_name AS supervisor_name, u.status AS supervisor_status, u.role AS supervisor_role
    FROM sites s
    LEFT JOIN contracts c ON c.contract_id = s.contract_id
    LEFT JOIN projects p ON p.project_id = c.project_id
    LEFT JOIN users u ON u.user_id = s.supervisor_id
    WHERE s.site_status = 'Active'${scoped ? ' AND s.site_id = ?' : ''}
    ORDER BY s.site_name`;

  const shiftsSql = `
    SELECT ss.site_id, ss.shift_type, ss.supervisor_id,
           u.full_name AS supervisor_name, u.status AS supervisor_status, u.role AS supervisor_role
    FROM site_shifts ss
    JOIN sites s ON s.site_id = ss.site_id AND s.site_status = 'Active'
    LEFT JOIN users u ON u.user_id = ss.supervisor_id
    ${scoped ? 'WHERE ss.site_id = ?' : ''}`;

  const aggSql = `
    SELECT x.site_id, x.shift_type,
           COUNT(*) AS expected,
           SUM(x.attendance_id IS NULL) AS not_recorded,
           SUM(x.attendance_status = 'Present') AS present,
           SUM(x.attendance_status = 'Present' AND x.check_in_time IS NOT NULL
               AND x.check_out_time IS NULL AND x.on_break = 0) AS on_site_now,
           SUM(x.attendance_status = 'Present' AND x.check_in_time IS NOT NULL
               AND x.check_out_time IS NULL AND x.on_break = 1) AS on_break,
           SUM(x.attendance_status = 'Present' AND x.check_out_time IS NOT NULL) AS checked_out,
           SUM(x.record_date = ? AND x.check_in_time IS NOT NULL AND x.check_out_time IS NULL) AS carried_over_open,
           SUM(x.attendance_status = 'Absent') AS absent,
           SUM(x.attendance_status = 'Sick') AS sick,
           SUM(x.attendance_status = 'Vacation') AS vacation,
           SUM(x.attendance_status = 'Holiday') AS holiday,
           SUM(x.workflow_status = 'Draft') AS wf_draft,
           SUM(x.workflow_status = 'Submitted') AS wf_submitted,
           SUM(x.workflow_status = 'Approved') AS wf_approved,
           SUM(x.workflow_status = 'Rejected') AS wf_rejected,
           SUM(x.source = 'Biometric') AS biometric_records,
           MAX(COALESCE(x.check_out_time, x.check_in_time)) AS last_check_event
    FROM (${workerStateSql(scoped ? 'AND wsa.site_id = ?' : '')}) x
    GROUP BY x.site_id, x.shift_type`;

  // Records dated D at an Active site with no effective assignment for that
  // worker/site/shift on that date (data integrity).
  const unassignedSql = `
    SELECT a.site_id, a.shift_type, a.attendance_id, a.worker_id, w.full_name,
           a.attendance_status, a.status AS workflow_status
    FROM attendance a
    JOIN sites s ON s.site_id = a.site_id AND s.site_status = 'Active'
    JOIN workers w ON w.worker_id = a.worker_id
    WHERE a.record_date = ?${scoped ? ' AND a.site_id = ?' : ''}
      AND NOT EXISTS (
        SELECT 1 FROM workersiteassignments wsa
        JOIN workers w2 ON w2.worker_id = wsa.worker_id AND w2.status = 'Active'
        WHERE wsa.worker_id = a.worker_id AND wsa.site_id = a.site_id AND wsa.shift_type = a.shift_type
          AND wsa.assigned_date <= a.record_date
          AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= a.record_date))
    ORDER BY w.full_name
    LIMIT 500`;

  // Workflow backlog, all dates (the backlog is what still needs action).
  const backlogSql = `
    SELECT a.site_id, a.shift_type, a.status, s.site_status, s.site_name,
           COUNT(*) AS cnt, DATE_FORMAT(MIN(a.record_date), '%Y-%m-%d') AS oldest
    FROM attendance a
    JOIN sites s ON s.site_id = a.site_id
    WHERE (a.status IN ('Submitted', 'Rejected')
           OR (a.status = 'Draft' AND a.record_date < ?
               AND NOT (a.shift_type = 'Night' AND a.record_date = ?)))
      ${scoped ? 'AND a.site_id = ?' : ''}
    GROUP BY a.site_id, a.shift_type, a.status, s.site_status, s.site_name`;

  const lastPayrollSql = `
    SELECT s2.site_id,
           (SELECT DATE_FORMAT(MAX(pb.end_date), '%Y-%m-%d')
            FROM payrollbatches pb
            WHERE pb.status <> 'Superseded'
              AND (pb.scope_site_id IS NULL OR pb.scope_site_id = s2.site_id)) AS last_end
    FROM sites s2
    WHERE s2.site_status = 'Active'${scoped ? ' AND s2.site_id = ?' : ''}`;

  const notReadySql = `
    SELECT a.site_id, a.shift_type, COUNT(*) AS cnt, DATE_FORMAT(MIN(a.record_date), '%Y-%m-%d') AS oldest
    FROM attendance a
    JOIN (${lastPayrollSql}) le ON le.site_id = a.site_id
    WHERE a.status <> 'Approved'
      AND a.record_date < ?
      AND (le.last_end IS NULL OR a.record_date > le.last_end)
    GROUP BY a.site_id, a.shift_type`;

  const transfersSql = `
    SELECT t.request_id, t.worker_id, w.full_name AS worker_name,
           t.current_site_id, cs.site_name AS current_site_name, t.current_shift_type,
           t.target_site_id, ts.site_name AS target_site_name, t.target_shift_type,
           DATE_FORMAT(t.effective_date, '%Y-%m-%d') AS effective_date,
           DATE_FORMAT(t.created_at, '%Y-%m-%d %H:%i') AS created_at,
           u.full_name AS requested_by_name
    FROM worker_transfer_requests t
    JOIN workers w ON w.worker_id = t.worker_id
    JOIN sites cs ON cs.site_id = t.current_site_id
    JOIN sites ts ON ts.site_id = t.target_site_id
    LEFT JOIN users u ON u.user_id = t.requested_by_user_id
    WHERE t.status = 'Pending'${scoped ? ' AND (t.current_site_id = ? OR t.target_site_id = ?)' : ''}
    ORDER BY t.created_at ASC, t.request_id ASC
    LIMIT 200`;

  const [
    [sites], [shifts], [agg], [unassigned], [backlog], [lastPayroll], [notReady], [transfers],
  ] = await Promise.all([
    pool.query(sitesSql, siteParams),
    pool.query(shiftsSql, siteParams),
    pool.query(aggSql, [prevDate, ...workerStateParams(date, prevDate, siteParams)]),
    pool.query(unassignedSql, [date, ...siteParams]),
    pool.query(backlogSql, [date, prevDate, ...siteParams]),
    pool.query(lastPayrollSql, siteParams),
    pool.query(notReadySql, [...siteParams, date]),
    pool.query(transfersSql, scoped ? [siteId, siteId] : []),
  ]);

  // Biometric items linked to a worker attendance record (so to a site+shift).
  let biometricBySite = [];
  let biometricAvailable = true;
  let biometricError = null;
  try {
    const [rows] = await pool.query(
      `SELECT pr.target_table, a.site_id, a.shift_type, COUNT(*) AS cnt
       FROM attendance_punch_processing pr
       LEFT JOIN attendance a ON pr.target_table = 'attendance' AND a.attendance_id = pr.target_record_id
       WHERE pr.processing_status IN ('NeedsReview', 'Failed')
       ${scoped ? "AND pr.target_table = 'attendance' AND a.site_id = ?" : ''}
       GROUP BY pr.target_table, a.site_id, a.shift_type`,
      siteParams
    );
    biometricBySite = rows;
  } catch (error) {
    biometricAvailable = false;
    biometricError = error.code || 'ERROR';
    console.error('dashboard biometric attribution:', error.message);
  }

  return {
    prevDate, sites, shifts, agg, unassigned, backlog, lastPayroll, notReady, transfers,
    biometricBySite, biometricAvailable, biometricError,
  };
}

function unitKey(siteId, shiftType) {
  return `${siteId}|${shiftType}`;
}

function supervisorInfo(row) {
  if (!row || !row.supervisor_id) return null;
  return {
    user_id: num(row.supervisor_id),
    full_name: str(row.supervisor_name),
    status: str(row.supervisor_status),
    role: str(row.supervisor_role),
    valid: row.supervisor_status === 'Active' && row.supervisor_role === 'Supervisor',
  };
}

function exception(severity, code, title, detail, extra = {}) {
  return { severity, code, title, detail, ...extra };
}

function completionState(u) {
  if (u.expected === 0) return 'no_workers';
  const recorded = u.expected - u.not_recorded;
  if (recorded === 0) return 'not_started';
  if (recorded < u.expected) return 'in_progress';
  if (u.workflow.approved === recorded) return 'approved';
  if (u.workflow.submitted + u.workflow.approved === recorded) return 'submitted';
  if (u.workflow.rejected > 0) return 'has_rejected';
  return 'all_recorded';
}

function buildSites(data, { date, today }) {
  const isToday = date === today;
  const aggMap = new Map(data.agg.map((r) => [unitKey(r.site_id, r.shift_type), r]));
  const shiftMap = new Map(data.shifts.map((r) => [unitKey(r.site_id, r.shift_type), r]));
  const lastEndMap = new Map(data.lastPayroll.map((r) => [num(r.site_id), str(r.last_end)]));
  const notReadyMap = new Map(data.notReady.map((r) => [unitKey(r.site_id, r.shift_type), r]));

  const backlogMap = new Map();
  for (const r of data.backlog) {
    if (r.site_status !== 'Active') continue;
    const key = unitKey(r.site_id, r.shift_type);
    const b = backlogMap.get(key) || {
      submitted: 0, submitted_oldest: null, rejected: 0, rejected_oldest: null,
      overdue_draft: 0, overdue_draft_oldest: null,
    };
    if (r.status === 'Submitted') { b.submitted = num(r.cnt); b.submitted_oldest = str(r.oldest); }
    if (r.status === 'Rejected') { b.rejected = num(r.cnt); b.rejected_oldest = str(r.oldest); }
    if (r.status === 'Draft') { b.overdue_draft = num(r.cnt); b.overdue_draft_oldest = str(r.oldest); }
    backlogMap.set(key, b);
  }

  const unassignedMap = new Map();
  for (const r of data.unassigned) {
    const key = unitKey(r.site_id, r.shift_type);
    unassignedMap.set(key, (unassignedMap.get(key) || 0) + 1);
  }

  const transferMap = new Map();
  const bumpTransfer = (siteId, shift, field) => {
    const key = unitKey(siteId, shift);
    const t = transferMap.get(key) || { outgoing: 0, incoming: 0 };
    t[field] += 1;
    transferMap.set(key, t);
  };
  for (const t of data.transfers) {
    bumpTransfer(t.current_site_id, t.current_shift_type, 'outgoing');
    bumpTransfer(t.target_site_id, t.target_shift_type, 'incoming');
  }

  const bioMap = new Map();
  for (const r of data.biometricBySite) {
    if (r.target_table !== 'attendance' || r.site_id === null) continue;
    bioMap.set(unitKey(r.site_id, r.shift_type), num(r.cnt));
  }

  return data.sites.map((site) => {
    const siteId = num(site.site_id);
    const supportsShifts = Number(site.supports_shifts) === 1;
    const candidateShifts = new Set(supportsShifts ? ['Day', 'Night'] : ['Day']);
    // A shift that has data on a non-shift site is still shown (it is a
    // configuration problem that must be visible, not hidden).
    for (const map of [aggMap, backlogMap, unassignedMap, transferMap, bioMap]) {
      for (const key of map.keys()) {
        const [sid, shift] = key.split('|');
        if (Number(sid) === siteId) candidateShifts.add(shift);
      }
    }

    const units = [];
    for (const shiftType of ['Day', 'Night']) {
      if (!candidateShifts.has(shiftType)) continue;
      const key = unitKey(siteId, shiftType);
      const a = aggMap.get(key);
      const hasShiftRow = shiftMap.has(key);
      const b = backlogMap.get(key) || {
        submitted: 0, submitted_oldest: null, rejected: 0, rejected_oldest: null,
        overdue_draft: 0, overdue_draft_oldest: null,
      };
      const transfers = transferMap.get(key) || { outgoing: 0, incoming: 0 };
      const biometricUnresolved = bioMap.get(key) || 0;
      const unassignedCount = unassignedMap.get(key) || 0;
      const nr = notReadyMap.get(key);
      const expected = num(a && a.expected);

      // Skip a shift-site shift that has no configuration and no data at all.
      const hasAnyData = expected > 0 || b.submitted || b.rejected || b.overdue_draft ||
        transfers.outgoing || transfers.incoming || biometricUnresolved || unassignedCount || (nr && num(nr.cnt));
      if (supportsShifts && !hasShiftRow && !hasAnyData) continue;
      if (!supportsShifts && shiftType === 'Night' && !hasAnyData) continue;

      const supervisor = supportsShifts
        ? supervisorInfo(shiftMap.get(key))
        : (shiftType === 'Day' ? supervisorInfo(site) : null);

      const unit = {
        shift_type: shiftType,
        is_shift_site: supportsShifts,
        supervisor,
        has_valid_supervisor: Boolean(supervisor && supervisor.valid),
        expected,
        not_recorded: num(a && a.not_recorded),
        present: num(a && a.present),
        on_site_now: num(a && a.on_site_now),
        on_break: num(a && a.on_break),
        checked_out: num(a && a.checked_out),
        carried_over_open: num(a && a.carried_over_open),
        absent: num(a && a.absent),
        sick: num(a && a.sick),
        vacation: num(a && a.vacation),
        holiday: num(a && a.holiday),
        biometric_records: num(a && a.biometric_records),
        workflow: {
          draft: num(a && a.wf_draft),
          submitted: num(a && a.wf_submitted),
          approved: num(a && a.wf_approved),
          rejected: num(a && a.wf_rejected),
        },
        backlog: b,
        transfers,
        biometric_unresolved: biometricUnresolved,
        unassigned_attendance: unassignedCount,
        payroll: {
          last_covered_end: lastEndMap.get(siteId) || null,
          not_ready: num(nr && nr.cnt),
          not_ready_oldest: nr ? str(nr.oldest) : null,
        },
        last_check_event: a ? str(a.last_check_event) : null,
        exceptions: [],
      };
      unit.recorded = unit.expected - unit.not_recorded;
      unit.completion = completionState(unit);

      const where = { site_id: siteId, site_name: site.site_name, shift_type: shiftType };
      const ex = unit.exceptions;

      if (!supportsShifts && shiftType === 'Night' && expected > 0) {
        ex.push(exception('critical', 'SHIFT_CONFIG',
          'Night assignments on a site without shifts',
          `${expected} worker(s) are assigned to the Night shift, but this site does not support shifts. The supervisor attendance page only loads the Day shift for this site.`,
          { ...where, count: expected, action: 'assignments' }));
      }
      // (A Night unit on a non-shift site is already reported as SHIFT_CONFIG.)
      if (expected > 0 && !unit.has_valid_supervisor && (supportsShifts || shiftType === 'Day')) {
        let detail = 'No supervisor is assigned';
        if (supervisor && supervisor.status !== 'Active') detail = `Assigned supervisor ${supervisor.full_name || ''} is ${supervisor.status}`;
        else if (supervisor && supervisor.role !== 'Supervisor') detail = `Assigned user ${supervisor.full_name || ''} has role ${supervisor.role}, not Supervisor`;
        ex.push(exception('critical', 'NO_SUPERVISOR', 'No active supervisor',
          `${detail}. Attendance for ${expected} worker(s) cannot be recorded or submitted by a supervisor.`,
          { ...where, count: expected, action: 'supervisors' }));
      }
      if (unit.carried_over_open > 0 && shiftType === 'Day') {
        ex.push(exception('warning', 'PREVIOUS_DAY_OPEN', 'Open check-in from yesterday',
          `${unit.carried_over_open} Day-shift worker(s) checked in yesterday and were never checked out.`,
          { ...where, count: unit.carried_over_open, action: 'site' }));
      }
      if (b.rejected > 0) {
        ex.push(exception('warning', 'REJECTED_PENDING', 'Rejected attendance awaiting supervisor',
          `${b.rejected} rejected record(s) not yet corrected and resubmitted (oldest ${b.rejected_oldest}).`,
          { ...where, count: b.rejected, oldest: b.rejected_oldest, action: 'attendance_review' }));
      }
      if (b.overdue_draft > 0) {
        ex.push(exception('warning', 'OVERDUE_DRAFT', 'Day not submitted',
          `${b.overdue_draft} Draft record(s) from earlier days were never submitted (oldest ${b.overdue_draft_oldest}).`,
          { ...where, count: b.overdue_draft, oldest: b.overdue_draft_oldest, action: 'site' }));
      }
      if (unit.absent >= HIGH_ABSENCE_MIN && expected > 0 && (unit.absent * 100) / expected >= HIGH_ABSENCE_PCT) {
        ex.push(exception('warning', 'HIGH_ABSENCE', 'High absence',
          `${unit.absent} of ${expected} expected worker(s) are Absent (rule: >= ${HIGH_ABSENCE_MIN} and >= ${HIGH_ABSENCE_PCT}%).`,
          { ...where, count: unit.absent, action: 'site' }));
      }
      if (biometricUnresolved > 0) {
        ex.push(exception('warning', 'BIOMETRIC_REVIEW', 'Biometric punches need review',
          `${biometricUnresolved} punch(es) linked to this site/shift are NeedsReview or Failed.`,
          { ...where, count: biometricUnresolved, action: 'biometric_review' }));
      }
      if (unassignedCount > 0) {
        ex.push(exception('warning', 'UNASSIGNED_ATTENDANCE', 'Attendance without assignment',
          `${unassignedCount} record(s) dated ${date} belong to workers with no effective assignment to this site/shift on that date.`,
          { ...where, count: unassignedCount, action: 'site' }));
      }
      if (b.submitted > 0) {
        ex.push(exception('action', 'SUBMITTED_WAITING', 'Waiting for admin review',
          `${b.submitted} submitted record(s) waiting for approval (oldest ${b.submitted_oldest}). Only Approved records are paid.`,
          { ...where, count: b.submitted, oldest: b.submitted_oldest, action: 'attendance_review' }));
      }
      const pendingTransfers = transfers.outgoing + transfers.incoming;
      if (pendingTransfers > 0) {
        ex.push(exception('action', 'TRANSFERS_PENDING', 'Pending transfers',
          `${transfers.outgoing} outgoing and ${transfers.incoming} incoming transfer request(s) waiting for a decision.`,
          { ...where, count: pendingTransfers, action: 'transfers' }));
      }
      if (expected > 0 && unit.not_recorded > 0) {
        if (!isToday) {
          ex.push(exception('warning', 'MISSING_RECORDS', 'Workers without a record',
            `${unit.not_recorded} of ${expected} expected worker(s) have no attendance record for ${date}.`,
            { ...where, count: unit.not_recorded, action: 'site' }));
        } else if (unit.recorded === 0) {
          ex.push(exception('info', 'NOT_STARTED', 'No attendance recorded yet today',
            `None of the ${expected} expected worker(s) has a record yet. No shift start time is configured, so this is not treated as late.`,
            { ...where, count: expected, action: 'site' }));
        }
      }
      ex.sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]);
      units.push(unit);
    }

    const worst = units
      .flatMap((u) => u.exceptions)
      .filter((e) => e.severity !== 'info')
      .reduce((acc, e) => (acc === null || SEVERITY_RANK[e.severity] < SEVERITY_RANK[acc] ? e.severity : acc), null);

    return {
      site_id: siteId,
      site_name: site.site_name,
      location: str(site.location),
      contract_id: site.contract_id === null ? null : num(site.contract_id),
      contract_name: str(site.contract_name),
      project_name: str(site.project_name),
      supports_shifts: supportsShifts,
      attention: worst || 'ok',
      expected: units.reduce((s, u) => s + u.expected, 0),
      units,
    };
  });
}

function summarize(sites) {
  const s = {
    active_sites: sites.length,
    sites_with_workers: 0,
    sites_needing_attention: 0,
    expected: 0, recorded: 0, not_recorded: 0, present: 0, on_site_now: 0, on_break: 0,
    checked_out: 0, carried_over_open: 0, absent: 0, sick: 0, vacation: 0, holiday: 0,
    workflow: { draft: 0, submitted: 0, approved: 0, rejected: 0 },
    units_without_supervisor: 0,
  };
  for (const site of sites) {
    if (site.expected > 0) s.sites_with_workers += 1;
    if (site.attention === 'critical' || site.attention === 'warning') s.sites_needing_attention += 1;
    for (const u of site.units) {
      for (const k of ['expected', 'recorded', 'not_recorded', 'present', 'on_site_now', 'on_break',
        'checked_out', 'carried_over_open', 'absent', 'sick', 'vacation', 'holiday']) {
        s[k] += u[k];
      }
      for (const k of Object.keys(s.workflow)) s.workflow[k] += u.workflow[k];
      if (u.expected > 0 && !u.has_valid_supervisor && (u.is_shift_site || u.shift_type === 'Day')) {
        s.units_without_supervisor += 1;
      }
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Global sections (overview only)
// ---------------------------------------------------------------------------
async function loadBiometricGlobal(data) {
  if (!data.biometricAvailable) {
    return { available: false, reason: `Biometric review data is not available (${data.biometricError}).` };
  }
  try {
    const [[statusRows], [reasonRows], [lastPunchRows], [lastBatchRows], orphanWorkers, orphanStaff] = await Promise.all([
      pool.query(
        `SELECT processing_status, COUNT(*) AS cnt
         FROM attendance_punch_processing
         WHERE processing_status IN ('Pending', 'NeedsReview', 'Failed')
         GROUP BY processing_status`
      ),
      pool.query(
        `SELECT processing_result, COUNT(*) AS cnt
         FROM attendance_punch_processing
         WHERE processing_status = 'NeedsReview'
         GROUP BY processing_result
         ORDER BY cnt DESC`
      ),
      pool.query(`SELECT MAX(punched_at) AS last_punch_at FROM attendance_punches`),
      pool.query(
        `SELECT id, status, source_file, DATE_FORMAT(imported_at, '%Y-%m-%d %H:%i:%s') AS imported_at
         FROM attendance_import_batches ORDER BY id DESC LIMIT 1`
      ),
      biometricReview._internal.findOrphanWorkerDrafts(pool, {}),
      biometricReview._internal.findOrphanStaffDrafts(pool, {}),
    ]);
    const byStatus = { Pending: 0, NeedsReview: 0, Failed: 0 };
    for (const r of statusRows) byStatus[r.processing_status] = num(r.cnt);

    let workerLinked = 0;
    let staffLinked = 0;
    let unlinked = 0;
    for (const r of data.biometricBySite) {
      if (r.target_table === 'attendance' && r.site_id !== null) workerLinked += num(r.cnt);
      else if (r.target_table === 'staff_attendance') staffLinked += num(r.cnt);
      else unlinked += num(r.cnt);
    }
    const lastBatch = lastBatchRows[0] || null;
    return {
      available: true,
      unresolved_total: byStatus.NeedsReview + byStatus.Failed,
      needs_review: byStatus.NeedsReview,
      failed: byStatus.Failed,
      pending_queue: byStatus.Pending,
      linked_to_worker_sites: workerLinked,
      linked_to_staff: staffLinked,
      not_linked: unlinked,
      by_reason: reasonRows.map((r) => ({ reason: str(r.processing_result) || 'unknown', count: num(r.cnt) })),
      orphan_drafts: { workers: orphanWorkers.length, staff: orphanStaff.length },
      last_punch_at: lastPunchRows[0] ? str(lastPunchRows[0].last_punch_at) : null,
      last_import: lastBatch ? {
        batch_id: num(lastBatch.id),
        status: str(lastBatch.status),
        source_file: str(lastBatch.source_file),
        imported_at: str(lastBatch.imported_at),
      } : null,
    };
  } catch (error) {
    console.error('dashboard biometric global:', error.message);
    return { available: false, reason: `Biometric review data is not available (${error.code || 'ERROR'}).` };
  }
}

async function loadPayrollGlobal() {
  try {
    const [rows] = await pool.query(
      `SELECT pb.payroll_batch_id, DATE_FORMAT(pb.start_date, '%Y-%m-%d') AS start_date,
              DATE_FORMAT(pb.end_date, '%Y-%m-%d') AS end_date, pb.scope_site_id,
              s.site_name AS scope_site_name, pb.status, pb.is_finalized, pb.version_number
       FROM payrollbatches pb
       LEFT JOIN sites s ON s.site_id = pb.scope_site_id
       WHERE pb.status <> 'Superseded'
       ORDER BY pb.end_date DESC, pb.generated_at DESC, pb.payroll_batch_id DESC
       LIMIT 10`
    );
    const mapBatch = (r) => ({
      batch_id: num(r.payroll_batch_id),
      start_date: str(r.start_date),
      end_date: str(r.end_date),
      scope_site_id: r.scope_site_id === null ? null : num(r.scope_site_id),
      scope_site_name: str(r.scope_site_name),
      status: str(r.status),
      is_finalized: Number(r.is_finalized) === 1,
      version_number: num(r.version_number),
      state: r.status === 'Paid' ? 'paid' : (Number(r.is_finalized) === 1 ? 'awaiting_payment' : 'awaiting_finalization'),
    });
    const batches = rows.map(mapBatch);
    return {
      available: true,
      latest_batch: batches[0] || null,
      open_batches: batches.filter((b) => b.state !== 'paid'),
    };
  } catch (error) {
    console.error('dashboard payroll:', error.message);
    return { available: false, reason: 'Payroll data is not available.' };
  }
}

async function loadStaffGlobal(date) {
  try {
    const [[todayRows], [backlogRows], [[activeRow]]] = await Promise.all([
      pool.query(
        `SELECT attendance_status, status, COUNT(*) AS cnt
         FROM staff_attendance WHERE record_date = ?
         GROUP BY attendance_status, status`,
        [date]
      ),
      pool.query(
        `SELECT status, COUNT(*) AS cnt, DATE_FORMAT(MIN(record_date), '%Y-%m-%d') AS oldest
         FROM staff_attendance WHERE status IN ('Submitted', 'Rejected')
         GROUP BY status`
      ),
      pool.query(`SELECT COUNT(*) AS cnt FROM staff_members WHERE status = 'Active'`),
    ]);
    const byStatus = {};
    const workflow = { Draft: 0, Submitted: 0, Approved: 0, Rejected: 0 };
    let recorded = 0;
    for (const r of todayRows) {
      const key = str(r.attendance_status) || 'Unknown';
      byStatus[key] = (byStatus[key] || 0) + num(r.cnt);
      if (r.status in workflow) workflow[r.status] += num(r.cnt);
      recorded += num(r.cnt);
    }
    const backlog = { submitted: 0, submitted_oldest: null, rejected: 0, rejected_oldest: null };
    for (const r of backlogRows) {
      if (r.status === 'Submitted') { backlog.submitted = num(r.cnt); backlog.submitted_oldest = str(r.oldest); }
      if (r.status === 'Rejected') { backlog.rejected = num(r.cnt); backlog.rejected_oldest = str(r.oldest); }
    }
    return {
      available: true,
      is_friday: isFriday(date),
      active_staff: num(activeRow && activeRow.cnt),
      recorded_today: recorded,
      by_attendance_status: byStatus,
      workflow_today: workflow,
      backlog,
    };
  } catch (error) {
    console.error('dashboard staff:', error.message);
    return { available: false, reason: 'Staff attendance data is not available.' };
  }
}

async function loadIntegrityGlobal(date) {
  const [[multi], [inactiveSites]] = await Promise.all([
    pool.query(
      `SELECT w.worker_id, w.full_name, COUNT(*) AS assignments,
              GROUP_CONCAT(CONCAT(s.site_name, ' (', wsa.shift_type, ')') ORDER BY s.site_name SEPARATOR ', ') AS placements
       FROM workersiteassignments wsa
       JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
       JOIN sites s ON s.site_id = wsa.site_id
       WHERE wsa.assigned_date <= ? AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ?)
       GROUP BY w.worker_id, w.full_name
       HAVING COUNT(*) > 1
       ORDER BY w.full_name
       LIMIT 50`,
      [date, date]
    ),
    pool.query(
      `SELECT s.site_id, s.site_name, s.site_status, COUNT(DISTINCT wsa.worker_id) AS workers
       FROM workersiteassignments wsa
       JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
       JOIN sites s ON s.site_id = wsa.site_id AND s.site_status <> 'Active'
       WHERE wsa.assigned_date <= ? AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ?)
       GROUP BY s.site_id, s.site_name, s.site_status
       ORDER BY s.site_name`,
      [date, date]
    ),
  ]);
  return {
    multiple_assignments: multi.map((r) => ({
      worker_id: num(r.worker_id), full_name: r.full_name,
      assignments: num(r.assignments), placements: str(r.placements),
    })),
    open_assignments_at_inactive_sites: inactiveSites.map((r) => ({
      site_id: num(r.site_id), site_name: r.site_name, site_status: r.site_status, workers: num(r.workers),
    })),
  };
}

function globalExceptions({ data, biometric, payroll, staff, integrity }) {
  const list = [];

  const inactiveBacklog = new Map();
  for (const r of data.backlog) {
    if (r.site_status === 'Active') continue;
    const b = inactiveBacklog.get(r.site_id) || { site_name: r.site_name, site_status: r.site_status, count: 0 };
    b.count += num(r.cnt);
    inactiveBacklog.set(r.site_id, b);
  }
  for (const [siteId, b] of inactiveBacklog) {
    list.push(exception('warning', 'INACTIVE_SITE_BACKLOG', 'Unfinished attendance at a non-active site',
      `${b.count} Draft/Submitted/Rejected record(s) at ${b.site_name} (${b.site_status}). No supervisor works this site any more.`,
      { site_id: num(siteId), site_name: b.site_name, count: b.count, action: 'attendance_review' }));
  }

  if (integrity.multiple_assignments.length > 0) {
    list.push(exception('critical', 'MULTIPLE_ASSIGNMENTS', 'Workers with more than one active assignment',
      `${integrity.multiple_assignments.length} worker(s) have more than one effective assignment today: ` +
      integrity.multiple_assignments.slice(0, 5).map((m) => `${m.full_name} — ${m.placements}`).join('; ') +
      (integrity.multiple_assignments.length > 5 ? '; …' : ''),
      { count: integrity.multiple_assignments.length, action: 'assignments' }));
  }
  for (const s of integrity.open_assignments_at_inactive_sites) {
    list.push(exception('info', 'INACTIVE_SITE_ASSIGNMENTS', 'Open assignments at a non-active site',
      `${s.workers} active worker(s) still have an open assignment at ${s.site_name} (${s.site_status}); they are not counted as expected anywhere.`,
      { site_id: s.site_id, site_name: s.site_name, count: s.workers, action: 'assignments' }));
  }

  if (biometric.available) {
    const notSiteLinked = biometric.not_linked;
    if (notSiteLinked > 0) {
      list.push(exception('warning', 'BIOMETRIC_UNLINKED', 'Biometric punches not linked to a record',
        `${notSiteLinked} NeedsReview/Failed punch(es) are not linked to any attendance record (e.g. unmapped device IDs).`,
        { count: notSiteLinked, action: 'biometric_review' }));
    }
    const orphans = biometric.orphan_drafts.workers + biometric.orphan_drafts.staff;
    if (orphans > 0) {
      list.push(exception('warning', 'BIOMETRIC_ORPHAN_DRAFTS', 'Biometric drafts nobody can review',
        `${orphans} biometric Draft record(s) (${biometric.orphan_drafts.workers} worker, ${biometric.orphan_drafts.staff} staff) have no active supervisor or belong to a non-active site.`,
        { count: orphans, action: 'biometric_review' }));
    }
    if (biometric.linked_to_staff > 0) {
      list.push(exception('warning', 'BIOMETRIC_STAFF_REVIEW', 'Staff biometric punches need review',
        `${biometric.linked_to_staff} NeedsReview/Failed punch(es) are linked to staff attendance.`,
        { count: biometric.linked_to_staff, action: 'biometric_review' }));
    }
    if (biometric.pending_queue > 0) {
      list.push(exception('info', 'BIOMETRIC_PENDING', 'Punches not processed yet',
        `${biometric.pending_queue} received punch(es) are still Pending processing.`,
        { count: biometric.pending_queue, action: 'biometric_processing' }));
    }
  }

  if (payroll.available) {
    for (const b of payroll.open_batches) {
      const scope = b.scope_site_name ? ` (${b.scope_site_name})` : '';
      if (b.state === 'awaiting_finalization') {
        list.push(exception('action', 'PAYROLL_NOT_FINALIZED', 'Payroll batch awaiting finalization',
          `Batch #${b.batch_id}${scope}, ${b.start_date} → ${b.end_date}, is generated but not finalized.`,
          { count: 1, action: 'payroll' }));
      } else if (b.state === 'awaiting_payment') {
        list.push(exception('action', 'PAYROLL_NOT_PAID', 'Payroll batch awaiting payment',
          `Batch #${b.batch_id}${scope}, ${b.start_date} → ${b.end_date}, is finalized but not marked paid.`,
          { count: 1, action: 'payroll' }));
      }
    }
  }

  if (staff.available) {
    if (staff.backlog.rejected > 0) {
      list.push(exception('warning', 'STAFF_REJECTED', 'Rejected staff attendance',
        `${staff.backlog.rejected} rejected staff record(s) awaiting correction (oldest ${staff.backlog.rejected_oldest}).`,
        { count: staff.backlog.rejected, action: 'staff' }));
    }
    if (staff.backlog.submitted > 0) {
      list.push(exception('action', 'STAFF_SUBMITTED', 'Staff attendance waiting for review',
        `${staff.backlog.submitted} submitted staff record(s) waiting for review (oldest ${staff.backlog.submitted_oldest}).`,
        { count: staff.backlog.submitted, action: 'staff' }));
    }
  }
  return list;
}

function sendError(res, error, label) {
  if (error.statusCode === 400) {
    return res.status(400).json({ status: 'error', message: error.message });
  }
  if (error.statusCode === 404) {
    return res.status(404).json({ status: 'error', message: error.message });
  }
  console.error(`${label}:`, error);
  return res.status(500).json({ status: 'error', message: 'Failed to load the operations dashboard.' });
}

// ---------------------------------------------------------------------------
// GET /api/main-dashboard/live
// ---------------------------------------------------------------------------
async function getLiveOperations(req, res) {
  try {
    const { date, today } = resolveDate(req.query.date);
    const data = await loadSiteData(date, null);
    const sites = buildSites(data, { date, today });

    const [biometric, payroll, staff, integrity] = await Promise.all([
      loadBiometricGlobal(data),
      loadPayrollGlobal(),
      loadStaffGlobal(date),
      loadIntegrityGlobal(date),
    ]);

    const siteExceptions = sites.flatMap((s) => s.units.flatMap((u) => u.exceptions));
    const exceptions = [...siteExceptions, ...globalExceptions({ data, biometric, payroll, staff, integrity })]
      .sort((x, y) => (SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]) || (num(y.count) - num(x.count)));

    // Sites needing attention first, then by name.
    const rank = { critical: 0, warning: 1, action: 2, ok: 3 };
    sites.sort((x, y) => (rank[x.attention] - rank[y.attention]) || String(x.site_name).localeCompare(String(y.site_name)));

    const backlog = { submitted: 0, rejected: 0, overdue_draft: 0, submitted_oldest: null, rejected_oldest: null, overdue_draft_oldest: null };
    for (const r of data.backlog) {
      const field = r.status === 'Submitted' ? 'submitted' : r.status === 'Rejected' ? 'rejected' : 'overdue_draft';
      backlog[field] += num(r.cnt);
      const oldest = str(r.oldest);
      const key = `${field}_oldest`;
      if (oldest && (!backlog[key] || oldest < backlog[key])) backlog[key] = oldest;
    }

    return res.json({
      status: 'success',
      data: {
        business_date: date,
        is_today: date === today,
        generated_at: businessNow(),
        refresh_seconds: REFRESH_SECONDS,
        delivery: 'polling',
        rules: rulesPayload(),
        summary: summarize(sites),
        backlog,
        exceptions,
        sites,
        transfers: { pending: data.transfers.length, oldest_created_at: data.transfers.length ? data.transfers[0].created_at : null },
        biometric,
        payroll,
        staff,
        integrity,
      },
    });
  } catch (error) {
    return sendError(res, error, 'getLiveOperations');
  }
}

// ---------------------------------------------------------------------------
// GET /api/main-dashboard/sites/:siteId — drill-down
// ---------------------------------------------------------------------------
async function getSiteOperations(req, res) {
  try {
    const siteId = Number(req.params.siteId);
    if (!Number.isInteger(siteId) || siteId <= 0) throw badRequest('Invalid site id.');
    const { date, today } = resolveDate(req.query.date);

    const data = await loadSiteData(date, siteId);
    if (data.sites.length === 0) {
      const error = new Error('Site not found or not Active.');
      error.statusCode = 404;
      throw error;
    }
    const [site] = buildSites(data, { date, today });

    const prevDate = data.prevDate;
    const [[workerRows], [actionRows]] = await Promise.all([
      pool.query(
        `${workerStateSql('AND wsa.site_id = ?')}
         ORDER BY wsa.shift_type, w.full_name`,
        workerStateParams(date, prevDate, [siteId])
      ),
      pool.query(
        `SELECT a.attendance_id, a.shift_type, DATE_FORMAT(a.record_date, '%Y-%m-%d') AS record_date,
                a.status AS workflow_status, a.attendance_status, a.admin_rejection_notes, a.source,
                w.worker_id, w.full_name
         FROM attendance a
         JOIN workers w ON w.worker_id = a.worker_id
         WHERE a.site_id = ?
           AND (a.status IN ('Submitted', 'Rejected')
                OR (a.status = 'Draft' AND a.record_date < ?
                    AND NOT (a.shift_type = 'Night' AND a.record_date = ?)))
         ORDER BY a.record_date ASC, a.shift_type, w.full_name
         LIMIT 300`,
        [siteId, date, prevDate]
      ),
    ]);

    let biometricItems = [];
    let biometricAvailable = data.biometricAvailable;
    if (biometricAvailable) {
      try {
        const [rows] = await pool.query(
          `SELECT pr.punch_id, pr.processing_status, pr.processing_result, p.punched_at, p.punch_type,
                  a.attendance_id, a.shift_type, DATE_FORMAT(a.record_date, '%Y-%m-%d') AS record_date,
                  w.full_name
           FROM attendance_punch_processing pr
           JOIN attendance a ON pr.target_table = 'attendance' AND a.attendance_id = pr.target_record_id
           JOIN attendance_punches p ON p.id = pr.punch_id
           JOIN workers w ON w.worker_id = a.worker_id
           WHERE pr.processing_status IN ('NeedsReview', 'Failed') AND a.site_id = ?
           ORDER BY p.punched_at ASC
           LIMIT 100`,
          [siteId]
        );
        biometricItems = rows.map((r) => ({
          punch_id: num(r.punch_id),
          processing_status: str(r.processing_status),
          processing_result: str(r.processing_result),
          punched_at: str(r.punched_at),
          punch_type: str(r.punch_type),
          attendance_id: num(r.attendance_id),
          shift_type: str(r.shift_type),
          record_date: str(r.record_date),
          full_name: r.full_name,
        }));
      } catch (error) {
        biometricAvailable = false;
        console.error('dashboard site biometric:', error.message);
      }
    }

    return res.json({
      status: 'success',
      data: {
        business_date: date,
        is_today: date === today,
        generated_at: businessNow(),
        rules: rulesPayload(),
        site,
        workers: workerRows.map((r) => ({
          shift_type: r.shift_type,
          worker_id: num(r.worker_id),
          full_name: r.full_name,
          worker_unique_id: str(r.worker_unique_id),
          job_position: str(r.job_position),
          assigned_date: str(r.assigned_date),
          state: workerState(r),
          attendance_id: r.attendance_id === null ? null : num(r.attendance_id),
          record_date: str(r.record_date),
          from_previous_day: Boolean(r.record_date && r.record_date !== date),
          attendance_status: str(r.attendance_status),
          workflow_status: str(r.workflow_status),
          source: str(r.source),
          check_in_time: str(r.check_in_time),
          check_out_time: str(r.check_out_time),
        })),
        unassigned_attendance: data.unassigned.map((r) => ({
          attendance_id: num(r.attendance_id),
          worker_id: num(r.worker_id),
          full_name: r.full_name,
          shift_type: r.shift_type,
          attendance_status: str(r.attendance_status),
          workflow_status: str(r.workflow_status),
        })),
        records_needing_action: actionRows.map((r) => ({
          attendance_id: num(r.attendance_id),
          worker_id: num(r.worker_id),
          full_name: r.full_name,
          shift_type: r.shift_type,
          record_date: str(r.record_date),
          workflow_status: str(r.workflow_status),
          attendance_status: str(r.attendance_status),
          source: str(r.source),
          admin_rejection_notes: str(r.admin_rejection_notes),
          reason: r.workflow_status === 'Submitted' ? 'awaiting_admin_review'
            : r.workflow_status === 'Rejected' ? 'awaiting_resubmission' : 'day_not_submitted',
        })),
        transfers: data.transfers.map((t) => ({
          request_id: num(t.request_id),
          worker_id: num(t.worker_id),
          worker_name: t.worker_name,
          direction: num(t.current_site_id) === siteId && num(t.target_site_id) === siteId
            ? 'shift_change' : (num(t.current_site_id) === siteId ? 'outgoing' : 'incoming'),
          current_site_name: t.current_site_name,
          current_shift_type: t.current_shift_type,
          target_site_name: t.target_site_name,
          target_shift_type: t.target_shift_type,
          effective_date: str(t.effective_date),
          created_at: str(t.created_at),
          requested_by_name: str(t.requested_by_name),
        })),
        biometric: { available: biometricAvailable, items: biometricItems },
      },
    });
  } catch (error) {
    return sendError(res, error, 'getSiteOperations');
  }
}

module.exports = {
  getLiveOperations,
  getSiteOperations,
  _internal: { workerStateSql, workerState, buildSites, summarize, completionState, resolveDate },
};
