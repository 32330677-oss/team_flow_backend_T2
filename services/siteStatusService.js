// services/siteStatusService.js
//
// D-05: historical processing must use the site status that applied on the
// punch / attendance date, never only the current sites.site_status.
//
// site_status_history holds every status change with its effective date
// (inclusive). Resolution for date D:
//   * history rows exist  -> last row with effective_date <= D; before the
//                            first row, that row's old_status applies.
//   * no history          -> current status Active  => 'Active'
//                            current status not Active => 'Unknown' (we do not
//                            know since when; never guessed -> review)

const db = require('../config/db');

async function getSiteStatusOnDate(siteId, date, executor = db) {
  const [[site]] = await executor.execute(
    'SELECT site_id, site_name, site_status FROM sites WHERE site_id = ? LIMIT 1',
    [siteId]
  );
  if (!site) return { status: 'Missing', site: null, source: 'missing' };

  let history = [];
  try {
    const [rows] = await executor.execute(
      `SELECT old_status, new_status, DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date
       FROM site_status_history WHERE site_id = ?
       ORDER BY effective_date ASC, site_status_history_id ASC`,
      [siteId]
    );
    history = rows;
  } catch (error) {
    if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
  }

  if (history.length === 0) {
    return site.site_status === 'Active'
      ? { status: 'Active', site, source: 'current' }
      : { status: 'Unknown', site, source: 'no_history' };
  }
  let status = history[0].old_status || null;
  for (const row of history) {
    if (row.effective_date <= date) status = row.new_status;
    else break;
  }
  if (!status) return { status: 'Unknown', site, source: 'history_no_initial_status' };
  return { status, site, source: 'history' };
}

async function recordSiteStatusChange(executor, { siteId, oldStatus, newStatus, effectiveDate, reason, userId }) {
  await executor.execute(
    `INSERT INTO site_status_history (site_id, old_status, new_status, effective_date, reason, changed_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [siteId, oldStatus || null, newStatus, effectiveDate, reason || null, userId || null]
  );
}

module.exports = { getSiteStatusOnDate, recordSiteStatusChange };
