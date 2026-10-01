// services/staffCompensationService.js
//
// D3 / #12 — historical staff compensation.
//
// staff_compensation_history mirrors workercompensationhistory:
//   (staff_id, monthly_salary, standard_daily_hours, paid_leave_types,
//    effective_from, effective_to [inclusive], reason, changed_by_user_id)
//
// Resolution for a date D:
//   - a history row covering D        -> that row (source 'history')
//   - no row covers D (legacy staff,
//     never changed since Phase 2)    -> the current staff_members profile
//                                        (source 'profile'). This is exactly
//                                        the pre-Phase-2 behavior; nothing is
//                                        backfilled or guessed.
//
// The first versioned change of a legacy staff member writes a "baseline"
// row with the values that were in effect until the day before the change
// (from the hire anchor), so dates before the change keep their old values.

const db = require('../config/db');
const { addDays, toDateOnly, isValidDateOnly } = require('./businessDate');

const DEFAULT_PAID_LEAVE_TYPES = ['Sick', 'Vacation', 'Holiday'];

// Reason written on the automatic "baseline" row (recordStaffCompensationChange).
// A baseline row is NOT explicit history: it is the profile value at the time of
// the first versioned change, assumed back to the hire anchor.
const BASELINE_REASON = 'Baseline: values in effect before the first versioned change';

function parsePaidLeaveTypes(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_PAID_LEAVE_TYPES;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_PAID_LEAVE_TYPES;
  } catch (_) {
    return DEFAULT_PAID_LEAVE_TYPES;
  }
}

function toJsonText(value) {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizeHours(value) {
  return Number(value) > 0 ? Number(value) : 8;
}

function fromRow(row, source) {
  return {
    compensation_id: row.staff_compensation_id ?? null,
    monthly_salary: Number(row.monthly_salary),
    standard_daily_hours: normalizeHours(row.standard_daily_hours),
    paid_leave_types: parsePaidLeaveTypes(row.paid_leave_types),
    effective_from: row.effective_from ? toDateOnly(row.effective_from) : null,
    effective_to: row.effective_to ? toDateOnly(row.effective_to) : null,
    source,
  };
}

async function loadProfile(staffId, executor) {
  const [[sm]] = await executor.execute(
    `SELECT staff_id, monthly_salary, standard_daily_hours, paid_leave_types,
            hire_date, first_hire_date
     FROM staff_members WHERE staff_id = ? LIMIT 1`,
    [staffId]
  );
  return sm || null;
}

async function loadHistory(staffId, executor) {
  const [rows] = await executor.execute(
    `SELECT staff_compensation_id, monthly_salary, standard_daily_hours, paid_leave_types,
            effective_from, effective_to, reason
     FROM staff_compensation_history
     WHERE staff_id = ?
     ORDER BY effective_from ASC, staff_compensation_id ASC`,
    [staffId]
  );
  return rows;
}

/** Compensation that applied to one staff member on one date. */
async function getStaffCompensationForDate(staffId, date, executor = db) {
  if (!isValidDateOnly(date)) throw new Error(`Invalid date: ${date}`);
  const history = await loadHistory(staffId, executor);
  const row = history.find((h) =>
    toDateOnly(h.effective_from) <= date && (!h.effective_to || toDateOnly(h.effective_to) >= date));
  if (row) return fromRow(row, 'history');
  const profile = await loadProfile(staffId, executor);
  if (!profile) return null;
  return fromRow(profile, 'profile');
}

/**
 * Returns a resolver (date -> compensation) for a whole period, loading the
 * history once. Used by payroll so every date uses ITS OWN values.
 */
async function buildStaffCompensationResolver(staffId, executor = db) {
  const history = await loadHistory(staffId, executor);
  const profile = await loadProfile(staffId, executor);
  const profileComp = profile ? fromRow(profile, 'profile') : null;
  const historyComps = history.map((h) => fromRow(h, 'history'));
  return (date) => historyComps.find((h) =>
    h.effective_from <= date && (!h.effective_to || h.effective_to >= date)) || profileComp;
}

/**
 * Writes a versioned compensation change. Must run inside the caller's
 * transaction (the same one that updates staff_members).
 *
 * @param current   the staff_members row BEFORE the update
 * @param next      { monthly_salary, standard_daily_hours, paid_leave_types(JSON string|null) }
 */
async function recordStaffCompensationChange(executor, {
  current, next, effectiveFrom, reason, userId,
}) {
  const staffId = current.staff_id;

  const [openRows] = await executor.execute(
    `SELECT staff_compensation_id, effective_from
     FROM staff_compensation_history
     WHERE staff_id = ? AND effective_to IS NULL
     ORDER BY effective_from DESC, staff_compensation_id DESC
     LIMIT 1 FOR UPDATE`,
    [staffId]
  );

  if (openRows.length > 0) {
    const openFrom = toDateOnly(openRows[0].effective_from);
    if (effectiveFrom <= openFrom) {
      const error = new Error(
        `The new effective date must be after the current compensation period start date (${openFrom}).`
      );
      error.isOperational = true;
      throw error;
    }
    await executor.execute(
      'UPDATE staff_compensation_history SET effective_to = ? WHERE staff_compensation_id = ?',
      [addDays(effectiveFrom, -1), openRows[0].staff_compensation_id]
    );
  } else {
    const [[{ cnt }]] = await executor.execute(
      'SELECT COUNT(*) AS cnt FROM staff_compensation_history WHERE staff_id = ?',
      [staffId]
    );
    const anchor = toDateOnly(current.first_hire_date) || toDateOnly(current.hire_date);
    if (Number(cnt) === 0 && anchor && effectiveFrom > anchor) {
      // Baseline: the values that were in effect until the day before this change.
      await executor.execute(
        `INSERT INTO staff_compensation_history
           (staff_id, monthly_salary, standard_daily_hours, paid_leave_types,
            effective_from, effective_to, reason, changed_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [staffId, current.monthly_salary, current.standard_daily_hours,
          toJsonText(current.paid_leave_types),
          anchor, addDays(effectiveFrom, -1),
          BASELINE_REASON, userId || null]
      );
    }
  }

  await executor.execute(
    `INSERT INTO staff_compensation_history
       (staff_id, monthly_salary, standard_daily_hours, paid_leave_types,
        effective_from, effective_to, reason, changed_by_user_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    [staffId, next.monthly_salary, next.standard_daily_hours, toJsonText(next.paid_leave_types),
      effectiveFrom, reason || null, userId || null]
  );
}

/**
 * D3 (final decision) — historical fallback hierarchy for staff payroll.
 *
 * For every date the value comes from, in this order:
 *   1. explicit staff_compensation_history row covering the date
 *      (not the automatic baseline row)                            -> 'history'
 *   2. a reliable historical snapshot already stored:
 *        - standard hours: staff_attendance.standard_minutes_snapshot
 *          of that day's record (passed in by the caller)
 *        - monthly salary: staff_payroll.monthly_salary_snapshot of earlier
 *          batches covering the date (all must agree)              -> 'snapshot'
 *   3. the automatic baseline row covering the date                -> 'baseline'
 *   4. the current staff_members profile, ONLY when the staff member has no
 *      compensation history at all                                 -> 'profile'
 *
 * Nothing is invented. A field is UNRESOLVED (value null + reason) when
 *   - earlier payroll snapshots for the date disagree, or
 *   - history exists for the staff member but no row covers the date and no
 *     snapshot exists (the profile is then known not to be reliable).
 *
 * Earlier staff_payroll rows that were themselves split across several
 * compensation segments (audited as COMPENSATION_SEGMENTS) are not used as
 * salary snapshots: a single stored salary does not describe all their dates.
 */
async function buildStaffCompensationTimeline(staffId, executor = db, { excludeBatchId = null } = {}) {
  const history = (await loadHistory(staffId, executor)).map((h) => ({
    ...fromRow(h, 'history'),
    isBaseline: h.reason === BASELINE_REASON,
  }));
  const profile = await loadProfile(staffId, executor);
  const profileComp = profile ? fromRow(profile, 'profile') : null;

  const [snapRows] = await executor.execute(
    `SELECT sp.staff_payroll_id, sp.monthly_salary_snapshot,
            DATE_FORMAT(COALESCE(sp.employed_from, b.start_date), '%Y-%m-%d') AS from_date,
            DATE_FORMAT(COALESCE(sp.employed_to, b.end_date), '%Y-%m-%d') AS to_date
     FROM staff_payroll sp
     JOIN staff_payroll_batches b ON b.staff_payroll_batch_id = sp.staff_payroll_batch_id
     WHERE sp.staff_id = ?
       AND sp.monthly_salary_snapshot IS NOT NULL
       AND (? IS NULL OR sp.staff_payroll_batch_id <> ?)
       AND NOT EXISTS (
         SELECT 1 FROM auditlogs al
         WHERE al.table_name = 'staff_payroll' AND al.record_id = sp.staff_payroll_id
           AND al.action_type = 'COMPENSATION_SEGMENTS')`,
    [staffId, excludeBatchId, excludeBatchId]
  );
  const salarySnapshots = snapRows.map((r) => ({
    value: Number(r.monthly_salary_snapshot), from: r.from_date, to: r.to_date,
  }));

  const hasHistory = history.length > 0;
  const covers = (row, date) => row.effective_from <= date && (!row.effective_to || row.effective_to >= date);

  /**
   * @param date            YYYY-MM-DD
   * @param hoursSnapshot   standard hours from that day's attendance snapshot (or null)
   */
  return function resolve(date, { hoursSnapshot = null } = {}) {
    const explicit = history.find((h) => !h.isBaseline && covers(h, date)) || null;
    const baseline = history.find((h) => h.isBaseline && covers(h, date)) || null;
    const unresolved = [];
    const notCovered = 'compensation history exists for this staff member but does not cover this date, and no reliable snapshot exists';

    // Monthly salary
    let monthly_salary = null; let salary_source = null;
    if (explicit) { monthly_salary = explicit.monthly_salary; salary_source = 'history'; }
    else {
      const values = [...new Set(salarySnapshots.filter((sn) => sn.from <= date && sn.to >= date).map((sn) => sn.value))];
      if (values.length > 1) {
        unresolved.push({ field: 'monthly_salary', reason: `conflicting payroll snapshots (${values.join(', ')})` });
      } else if (values.length === 1) { monthly_salary = values[0]; salary_source = 'snapshot'; }
      else if (baseline) { monthly_salary = baseline.monthly_salary; salary_source = 'baseline'; }
      else if (hasHistory) { unresolved.push({ field: 'monthly_salary', reason: notCovered }); }
      else if (profileComp) { monthly_salary = profileComp.monthly_salary; salary_source = 'profile'; }
    }

    // Standard daily hours
    let standard_daily_hours = null; let hours_source = null;
    const snapHours = Number(hoursSnapshot) > 0 ? Number(hoursSnapshot) : null;
    if (explicit) { standard_daily_hours = explicit.standard_daily_hours; hours_source = 'history'; }
    else if (snapHours !== null) { standard_daily_hours = snapHours; hours_source = 'snapshot'; }
    else if (baseline) { standard_daily_hours = baseline.standard_daily_hours; hours_source = 'baseline'; }
    else if (hasHistory) { unresolved.push({ field: 'standard_daily_hours', reason: notCovered }); }
    else if (profileComp) { standard_daily_hours = profileComp.standard_daily_hours; hours_source = 'profile'; }

    // Paid leave types (no snapshot exists for this value)
    let paid_leave_types = null; let leave_types_source = null;
    if (explicit) { paid_leave_types = explicit.paid_leave_types; leave_types_source = 'history'; }
    else if (baseline) { paid_leave_types = baseline.paid_leave_types; leave_types_source = 'baseline'; }
    else if (!hasHistory && profileComp) { paid_leave_types = profileComp.paid_leave_types; leave_types_source = 'profile'; }
    // else: left null; the caller flags it only if a leave record needs it.

    return {
      date, monthly_salary, standard_daily_hours, paid_leave_types,
      salary_source, hours_source, leave_types_source, unresolved,
    };
  };
}

module.exports = {
  BASELINE_REASON,
  buildStaffCompensationTimeline,
  DEFAULT_PAID_LEAVE_TYPES,
  parsePaidLeaveTypes,
  getStaffCompensationForDate,
  buildStaffCompensationResolver,
  recordStaffCompensationChange,
};
