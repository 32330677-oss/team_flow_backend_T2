// services/workerStatusService.js
//
// D1 — historical worker status.
//
// worker_status_history holds every Active <-> Inactive change with the
// date it took effect (inclusive: the new status applies FROM effective_date).
// This mirrors staff_status_history (staffLifecycleController).
//
// Resolution for a calendar date D:
//   1. History rows exist  -> the last row with effective_date <= D gives the
//      status; before the first row, that row's old_status applies.
//   2. No history at all   -> legacy worker (created before Phase 2, never
//      changed since):
//        current status Active   -> 'Active' (nothing ever changed)
//        current status Inactive -> 'Unknown' (we do NOT know since when;
//                                   never guessed — callers send to review)
//
// workers.status stays the CURRENT status; this service is the only source
// for historical dates.

const db = require('../config/db');
const { toDateOnly, isValidDateOnly } = require('./businessDate');

async function getWorkerStatusOnDate(workerId, date, executor = db) {
  if (!isValidDateOnly(date)) throw new Error(`Invalid date: ${date}`);

  const [[worker]] = await executor.execute(
    'SELECT worker_id, status FROM workers WHERE worker_id = ? LIMIT 1',
    [workerId]
  );
  if (!worker) return { status: 'Unknown', source: 'missing_worker' };

  const [history] = await executor.execute(
    `SELECT old_status, new_status, effective_date
     FROM worker_status_history
     WHERE worker_id = ?
     ORDER BY effective_date ASC, status_history_id ASC`,
    [workerId]
  );

  if (history.length === 0) {
    return worker.status === 'Active'
      ? { status: 'Active', source: 'legacy_current' }
      : { status: 'Unknown', source: 'legacy_inactive_no_history' };
  }

  let status = history[0].old_status || null;
  for (const row of history) {
    if (toDateOnly(row.effective_date) <= date) status = row.new_status;
    else break;
  }
  if (!status) return { status: 'Unknown', source: 'history_no_initial_status' };
  return { status, source: 'history' };
}

async function getLastStatusChange(workerId, executor = db) {
  const [[row]] = await executor.execute(
    `SELECT status_history_id, old_status, new_status, effective_date
     FROM worker_status_history
     WHERE worker_id = ?
     ORDER BY effective_date DESC, status_history_id DESC
     LIMIT 1`,
    [workerId]
  );
  return row || null;
}

/**
 * Writes one history row. Must run inside the caller's transaction, in the
 * same transaction that updates workers.status.
 */
async function recordWorkerStatusChange(executor, {
  workerId, oldStatus, newStatus, effectiveDate, reason, userId,
}) {
  await executor.execute(
    `INSERT INTO worker_status_history
       (worker_id, old_status, new_status, effective_date, reason, changed_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [workerId, oldStatus || null, newStatus, effectiveDate, reason || null, userId || null]
  );
}

module.exports = { getWorkerStatusOnDate, getLastStatusChange, recordWorkerStatusChange };
