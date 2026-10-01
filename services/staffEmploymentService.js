// services/staffEmploymentService.js
//
// The single source of truth for whether a staff member was employed on a
// calendar date. Active spans are reconstructed from the original hire anchor
// plus staff_status_history. Existing date semantics are preserved:
// a status change effective on D starts/ends eligibility at the history
// boundary, and a termination is effective for payroll/attendance from D
// onward (therefore the active span ends on D - 1).

const db = require('../config/db');
const { businessToday } = require('./businessDate');

function toDateOnly(value) {
    if (!value) return null;
    return String(value).slice(0, 10);
}

function isValidDateOnly(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const [year, month, day] = String(value).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

function subtractOneDay(dateStr) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

/**
 * Builds all complete Active spans for one staff member in chronological order.
 * end === null means the span is open-ended.
 */
async function getActiveSpans(staffId, executor = db) {
    const [staffRows] = await executor.execute(
        `SELECT hire_date, first_hire_date, termination_date, status
         FROM staff_members WHERE staff_id = ? LIMIT 1`,
        [staffId]
    );
    if (staffRows.length === 0) return [];

    const staff = staffRows[0];
    // first_hire_date is the immutable anchor when present; hire_date is the
    // verified legacy fallback for rows created before that column was used.
    const anchor = toDateOnly(staff.first_hire_date) || toDateOnly(staff.hire_date);
    if (!anchor || !isValidDateOnly(anchor)) return [];

    const [history] = await executor.execute(
        `SELECT new_status, effective_date
         FROM staff_status_history
         WHERE staff_id = ?
         ORDER BY effective_date ASC, status_history_id ASC`,
        [staffId]
    );

    // A legacy Inactive row without a status-history boundary or explicit
    // termination date is ambiguous. Do not guess an end date or treat it as
    // currently employed; diagnostics identify these rows for review.
    if (history.length === 0 && staff.status !== 'Active' && !staff.termination_date) return [];

    const spans = [];
    let cursorDate = anchor;
    let cursorStatus = 'Active';

    for (const row of history) {
        const rowDate = toDateOnly(row.effective_date);
        if (!rowDate || !isValidDateOnly(rowDate)) continue;

        if (cursorStatus === 'Active') {
            const lastActiveDay = subtractOneDay(rowDate);
            if (lastActiveDay >= cursorDate) {
                spans.push({ start: cursorDate, end: lastActiveDay });
            }
        }

        cursorStatus = row.new_status;
        cursorDate = rowDate;
    }

    if (cursorStatus === 'Active') {
        spans.push({ start: cursorDate, end: null });
    } else if (spans.length === 0 && staff.status !== 'Active' && staff.termination_date) {
        // Legacy terminated rows may have no status-history rows. Use only the
        // explicit stored termination date; never manufacture one.
        const terminationDate = toDateOnly(staff.termination_date);
        const lastActiveDay = terminationDate && isValidDateOnly(terminationDate)
            ? subtractOneDay(terminationDate)
            : null;
        if (lastActiveDay && lastActiveDay >= anchor) {
            spans.push({ start: anchor, end: lastActiveDay });
        }
    }

    return spans;
}

/**
 * Returns Active spans intersecting [periodStart, periodEnd], clipped to the
 * requested period and never beyond the current date (the established payroll
 * behavior: future days cannot become automatic absences).
 */
async function getActiveSpansOverlapping(staffId, periodStart, periodEnd, executor = db) {
    if (!isValidDateOnly(periodStart) || !isValidDateOnly(periodEnd) || periodStart > periodEnd) return [];

    // B10: business date (Asia/Beirut), not the UTC date.
    const todayStr = businessToday();
    const clampedPeriodEnd = periodEnd > todayStr ? todayStr : periodEnd;
    if (periodStart > clampedPeriodEnd) return [];

    const spans = await getActiveSpans(staffId, executor);
    const overlapping = [];

    for (const span of spans) {
        const spanEnd = span.end || clampedPeriodEnd;
        const clippedStart = span.start > periodStart ? span.start : periodStart;
        const clippedEnd = spanEnd < clampedPeriodEnd ? spanEnd : clampedPeriodEnd;
        if (clippedStart <= clippedEnd) {
            overlapping.push({ start: clippedStart, end: clippedEnd });
        }
    }
    return overlapping;
}

async function isEmployedOnDate(staffId, date, executor = db) {
    const spans = await getActiveSpansOverlapping(staffId, date, date, executor);
    return spans.length > 0;
}

async function isReturningEmployee(staffId, executor = db) {
    const spans = await getActiveSpans(staffId, executor);
    return spans.length > 1;
}

module.exports = {
    getActiveSpans,
    getActiveSpansOverlapping,
    isEmployedOnDate,
    isReturningEmployee,
};
