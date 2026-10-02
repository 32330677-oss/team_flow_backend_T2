// services/weekGate.js
//
// §10 Weekly submission gating.
//
// Week definition: the attendance week ends on Friday (the weekly rest day
// used everywhere in the system: staff required days exclude Friday, the
// weekly labour template has 6 working days + a separate "Friday" column),
// so the week runs Saturday -> Friday. The start day is configurable with the
// setting attendance_week_start_day (0 = Sunday ... 6 = Saturday, default 6).
//
// Rule: a day in week W cannot be SUBMITTED while ACTUAL attendance records
// dated in week W-1 (same site + shift for workers, same supervisor scope for
// staff) are still Draft. A missing record (e.g. a Friday with no work) never
// blocks: only existing Draft rows count. The record_date is used (never the
// punch timestamp), so a Night Shift whose OUT is on the next calendar day
// belongs to the week of its record_date.

const settingsCache = require('./settingsCache');
const { addDays } = require('./businessDate');

async function weekStartDay(dateStr) {
  const v = Number(await settingsCache.getSettingForDate('attendance_week_start_day', dateStr, '6'));
  return Number.isInteger(v) && v >= 0 && v <= 6 ? v : 6;
}

function dayOfWeek(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

async function weekBounds(dateStr) {
  const start = await weekStartDay(dateStr);
  const offset = (dayOfWeek(dateStr) - start + 7) % 7;
  const weekStart = addDays(dateStr, -offset);
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}

async function previousWeekBounds(dateStr) {
  const { weekStart } = await weekBounds(dateStr);
  return { prevStart: addDays(weekStart, -7), prevEnd: addDays(weekStart, -1) };
}

/** Draft worker attendance in the previous week for the same site/shift. */
async function previousWeekWorkerDrafts(executor, { siteId, shiftType, recordDate }) {
  const { prevStart, prevEnd } = await previousWeekBounds(recordDate);
  const [rows] = await executor.execute(
    `SELECT DATE_FORMAT(a.record_date, '%Y-%m-%d') AS record_date, COUNT(*) AS drafts
     FROM attendance a
     WHERE a.site_id = ? AND a.shift_type = ? AND a.status = 'Draft'
       AND a.record_date BETWEEN ? AND ?
     GROUP BY a.record_date ORDER BY a.record_date`,
    [siteId, shiftType, prevStart, prevEnd]
  );
  return { prevStart, prevEnd, days: rows.map((r) => ({ record_date: r.record_date, drafts: Number(r.drafts) })) };
}

/** Draft staff attendance in the previous week for the given staff ids. */
async function previousWeekStaffDrafts(executor, { staffIds, recordDate }) {
  const { prevStart, prevEnd } = await previousWeekBounds(recordDate);
  if (!staffIds.length) return { prevStart, prevEnd, days: [] };
  const [rows] = await executor.query(
    `SELECT DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date, COUNT(*) AS drafts
     FROM staff_attendance
     WHERE staff_id IN (?) AND status = 'Draft' AND record_date BETWEEN ? AND ?
     GROUP BY record_date ORDER BY record_date`,
    [staffIds, prevStart, prevEnd]
  );
  return { prevStart, prevEnd, days: rows.map((r) => ({ record_date: r.record_date, drafts: Number(r.drafts) })) };
}

function gateError(gate) {
  const error = new Error(
    `The previous week (${gate.prevStart} to ${gate.prevEnd}) still has Draft attendance on ` +
    `${gate.days.map((d) => d.record_date).join(', ')}. Submit those days first.`
  );
  error.isOperational = true;
  error.statusCode = 409;
  error.code = 'PREVIOUS_WEEK_UNSUBMITTED';
  error.extra = { previous_week: gate };
  return error;
}

module.exports = {
  weekBounds,
  previousWeekBounds,
  previousWeekWorkerDrafts,
  previousWeekStaffDrafts,
  gateError,
};
