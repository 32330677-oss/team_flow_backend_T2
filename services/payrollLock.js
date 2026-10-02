// services/payrollLock.js
//
// D-02: once a payroll period is Finalized (or Paid), normal attendance
// operations for dates inside that period are locked, for workers and staff
// separately. Only the explicit Admin correction workflow
// (attendanceCorrectionController) may change such records, and it never
// changes the finalized payroll itself.
//
// "Locked" = an active (not Superseded / not Voided) batch with
// is_finalized = 1 that covers the date (worker batches: and the site, when the
// batch is scoped to one site).

class PayrollLockedError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.isOperational = true;
    this.statusCode = 409;
    this.code = 'PAYROLL_PERIOD_FINALIZED';
    this.extra = extra;
  }
}

async function findLockedWorkerBatch(executor, { siteId, date }) {
  const [rows] = await executor.execute(
    `SELECT payroll_batch_id, start_date, end_date, scope_site_id, status, is_finalized
     FROM payrollbatches
     WHERE status IN ('Generated', 'Paid') AND is_finalized = 1
       AND start_date <= ? AND end_date >= ?
       AND (scope_site_id IS NULL OR scope_site_id = ?)
     ORDER BY payroll_batch_id DESC LIMIT 1`,
    [date, date, siteId]
  );
  return rows[0] || null;
}

async function findLockedStaffBatch(executor, { date }) {
  const [rows] = await executor.execute(
    `SELECT staff_payroll_batch_id, start_date, end_date, status, is_finalized
     FROM staff_payroll_batches
     WHERE status IN ('Generated', 'Paid') AND is_finalized = 1
       AND start_date <= ? AND end_date >= ?
     ORDER BY staff_payroll_batch_id DESC LIMIT 1`,
    [date, date]
  );
  return rows[0] || null;
}

function lockMessage(kind, batch, date) {
  const id = kind === 'Worker' ? batch.payroll_batch_id : batch.staff_payroll_batch_id;
  return `${date} is inside ${kind === 'Worker' ? 'worker' : 'staff'} payroll batch #${id} ` +
    `(${String(batch.start_date).slice(0, 10)} to ${String(batch.end_date).slice(0, 10)}), which is ` +
    `${batch.status === 'Paid' ? 'Paid' : 'Finalized'}. Normal attendance changes are locked for this period. ` +
    'An Admin can use "Correct finalized attendance" (reason required); the finalized payroll is not changed.';
}

async function assertWorkerDateEditable(executor, siteId, date) {
  const d = String(date).slice(0, 10);
  const batch = await findLockedWorkerBatch(executor, { siteId, date: d });
  if (batch) {
    throw new PayrollLockedError(lockMessage('Worker', batch, d), { payroll_batch_id: batch.payroll_batch_id });
  }
}

async function assertStaffDateEditable(executor, date) {
  const d = String(date).slice(0, 10);
  const batch = await findLockedStaffBatch(executor, { date: d });
  if (batch) {
    throw new PayrollLockedError(lockMessage('Staff', batch, d), { staff_payroll_batch_id: batch.staff_payroll_batch_id });
  }
}

/** Express helper: turn a PayrollLockedError into the standard JSON reply. */
function sendLocked(res, error) {
  return res.status(409).json({ status: 'error', code: error.code, message: error.message, ...(error.extra || {}) });
}

module.exports = {
  PayrollLockedError,
  findLockedWorkerBatch,
  findLockedStaffBatch,
  assertWorkerDateEditable,
  assertStaffDateEditable,
  sendLocked,
};
