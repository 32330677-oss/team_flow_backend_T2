// services/businessDate.js
//
// One shared definition of the BUSINESS date (Asia/Beirut by default,
// override with APP_TIME_ZONE). Every "today" used for a business rule
// (no future attendance, default effective dates, punch age window, ...)
// must come from here instead of new Date().toISOString() (UTC) or the
// DB server's CURDATE()/NOW() (whatever timezone MySQL runs in).
//
// All helpers work on plain 'YYYY-MM-DD' strings and never shift a
// wall-clock value through the local timezone.

function businessToday(now = new Date()) {
  const timeZone = process.env.APP_TIME_ZONE || 'Asia/Beirut';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const v = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${v.year}-${v.month}-${v.day}`;
}

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// Pure date-string arithmetic (UTC math on a date-only value: no DST/offset drift).
function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + Number(n)));
  return date.toISOString().slice(0, 10);
}

function toDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    // Only reached if a driver returns Date objects; the pool uses dateStrings.
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

module.exports = { businessToday, isValidDateOnly, addDays, toDateOnly };
