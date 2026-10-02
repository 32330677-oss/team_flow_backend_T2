// services/assignmentDates.js
//
// ONE definition of assignment date semantics (requirements §5, D-01):
//
//   assigned_date   = FIRST day assigned (inclusive)
//   unassigned_date = LAST day assigned  (inclusive); NULL = open-ended
//
// Example: assigned 2026-09-01, unassigned 2026-09-30 -> 30 Sep is still an
// assigned day, 1 Oct is the first day outside the assignment.
//
// An explicitly empty range (unassigned_date = assigned_date - 1) is how a
// cancelled / zero-day assignment is stored; it never matches any date.
//
// Applies to workersiteassignments, staff_site_assignments and
// staff_supervisor_assignments. The data was converted from the old exclusive
// meaning by migrations/2026_10_hardening/05_data.sql, which writes the marker
// system_settings.assignment_end_semantics = 'inclusive_last_day'.
// The server refuses to start without that marker (see assertSemanticsMarker).

const { addDays } = require('./businessDate');

const SEMANTICS_KEY = 'assignment_end_semantics';
const SEMANTICS_VALUE = 'inclusive_last_day';

/**
 * SQL predicate: the assignment row `alias` covers the date expression `dateExpr`.
 * `dateExpr` is either '?' (bound parameter) or a column reference such as 'a.record_date'.
 */
function activeOn(alias, dateExpr = '?') {
  const a = alias ? `${alias}.` : '';
  return `(${a}assigned_date <= ${dateExpr} AND (${a}unassigned_date IS NULL OR ${a}unassigned_date >= ${dateExpr}))`;
}

/** Number of bound parameters activeOn(alias, '?') needs. */
const ACTIVE_ON_PARAMS = 2;

/**
 * SQL predicate: the assignment is current on `todayExpr` or later (open-ended,
 * or ending today/in the future). Used by "current assignment" lists so an
 * assignment with a future last day is still shown as current.
 */
function currentOrFuture(alias, todayExpr = '?') {
  const a = alias ? `${alias}.` : '';
  return `(${a}unassigned_date IS NULL OR ${a}unassigned_date >= ${todayExpr})`;
}

/**
 * SQL predicate: two ranges [alias.assigned_date, alias.unassigned_date] and
 * [fromExpr, toExpr] (toExpr may be NULL = open) overlap, inclusive both ends.
 * Empty (cancelled) ranges never overlap.
 */
function overlaps(alias, fromExpr = '?', toExpr = '?') {
  const a = alias ? `${alias}.` : '';
  // Placeholder order: fromExpr first, then toExpr.
  return `(COALESCE(${a}unassigned_date, '9999-12-31') >= ${fromExpr}
           AND ${a}assigned_date <= COALESCE(${toExpr}, '9999-12-31')
           AND (${a}unassigned_date IS NULL OR ${a}unassigned_date >= ${a}assigned_date))`;
}

/** Last assigned day for a transfer/new period that starts on `firstNewDay`. */
function lastDayBefore(firstNewDay) {
  return addDays(firstNewDay, -1);
}

async function assertSemanticsMarker(db) {
  const [rows] = await db.execute(
    'SELECT setting_value FROM system_settings WHERE setting_key = ? LIMIT 1',
    [SEMANTICS_KEY]
  );
  const value = rows[0] ? rows[0].setting_value : null;
  if (value !== SEMANTICS_VALUE) {
    const error = new Error(
      `Database assignment end-date semantics marker is "${value}". This backend requires ` +
      `"${SEMANTICS_VALUE}". Run migrations/2026_10_hardening (steps 01-06) before starting this version.`
    );
    error.code = 'ASSIGNMENT_SEMANTICS_MISMATCH';
    throw error;
  }
  return true;
}

module.exports = {
  SEMANTICS_KEY,
  SEMANTICS_VALUE,
  ACTIVE_ON_PARAMS,
  activeOn,
  currentOrFuture,
  overlaps,
  lastDayBefore,
  assertSemanticsMarker,
};
