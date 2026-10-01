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
            effective_from, effective_to
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
          'Baseline: values in effect before the first versioned change', userId || null]
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

module.exports = {
  DEFAULT_PAID_LEAVE_TYPES,
  parsePaidLeaveTypes,
  getStaffCompensationForDate,
  buildStaffCompensationResolver,
  recordStaffCompensationChange,
};
