const db = require('../config/db');
const biometricAttendanceService = require('./biometricAttendanceService');
const {
  acquireCreateLock,
  releaseCreateLock,
} = require('../middleware/duplicateGuard');

const LOCK_KEY = 'biometric_punch_processing';
const COMPLETED_BATCH_STATUSES = ['Completed', 'CompletedWithErrors'];

const SKIPPED_STATUSES = new Set([
  'unmapped', 'no_assignment', 'future_punch', 'punch_too_old',
  'staff_inactive', 'not_employed_on_date', 'no_supervisor_assignment',
]);
const SKIPPED_ACTIONS = new Set(['no_open_attendance', 'no_check_in']);
const PROCESSED_ACTIONS = new Set([
  'created', 'checked_in_existing', 'checked_in_updated_earlier',
  'already_checked_in', 'checked_out', 'checked_out_updated_later',
  'already_checked_out', 'ignored_locked', 'ignored_rejected',
  'ignored_manual',   // NEW
]);
const FAILED_ACTIONS = new Set(['invalid_checkout_time', 'open_break', 'conflict_review']);
const FAILED_MESSAGES = {
  invalid_checkout_time: 'Check-out time is not after the existing check-in time. Requires review.',
  open_break: 'Worker has an open break. End the break, then retry.',
  conflict_review: 'Another attendance record conflicts with this punch. Requires review.',
};

function createError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Maps a processPunch() return value to { status, result, error }.
 * Anything not explicitly recognized becomes Failed (never silently Processed).
 */
function classifyOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') {
    return {
      status: 'Failed',
      result: 'unknown_outcome',
      error: 'processPunch() returned an unrecognized value.',
    };
  }

  if (outcome.processed !== true) {
    const status = String(outcome.status || '');
    if (SKIPPED_STATUSES.has(status)) {
      return { status: 'Skipped', result: status, error: null };
    }
    return {
      status: 'Failed',
      result: status || 'unknown_status',
      error: `Unrecognized unresolved status: "${status}".`,
    };
  }

  const action = String(outcome.result?.action || '');

   if (FAILED_ACTIONS.has(action)) {
    return { status: 'Failed', result: action, error: FAILED_MESSAGES[action] };
  }
  if (SKIPPED_ACTIONS.has(action)) {
    return { status: 'Skipped', result: action, error: null };
  }
  if (PROCESSED_ACTIONS.has(action)) {
    return { status: 'Processed', result: action, error: null };
  }

  return {
    status: 'Failed',
    result: action || 'unknown_action',
    error: `Unrecognized processing action: "${action}".`,
  };
}

/**
 * Processes eligible punches chronologically.
 * Never writes to attendance_punches; all metadata goes to attendance_punch_processing.
 */
async function processPendingPunches({
  recordedByUserId,
  limit = 200,
  retryFailed = false,
  retrySkipped = true,
}) {
  if (!Number.isInteger(recordedByUserId) || recordedByUserId <= 0) {
    throw createError('A valid recordedByUserId is required.', 400);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
    throw createError('limit must be an integer between 1 and 2000.', 400);
  }

const statuses = ['Pending'];
if (retrySkipped) statuses.push('Skipped');
if (retryFailed === true) statuses.push('Failed');

  const connection = await db.getConnection();
  let lockAcquired = false;

  try {
    // timeout 0: fail immediately if another run holds the lock
    lockAcquired = await acquireCreateLock(connection, LOCK_KEY, 0);
    if (!lockAcquired) {
      throw createError('Another biometric processing run is already in progress.', 409);
    }

    const statusPlaceholders = statuses.map(() => '?').join(',');
    const batchPlaceholders = COMPLETED_BATCH_STATUSES.map(() => '?').join(',');

    const [rows] = await connection.execute(
      `SELECT p.id, p.device_employee_id, p.punched_at, p.punch_type
       FROM attendance_punch_processing pr
       JOIN attendance_punches p ON p.id = pr.punch_id
       JOIN attendance_import_batches b ON b.id = p.batch_id
       WHERE pr.processing_status IN (${statusPlaceholders})
         AND b.status IN (${batchPlaceholders})
         AND NOT (pr.processing_status = 'Skipped' AND pr.processing_result = 'punch_too_old')
       ORDER BY FIELD(pr.processing_status, 'Pending', 'Skipped', 'Failed') ASC,
                p.punched_at ASC, p.id ASC
       LIMIT ${limit}`,
      [...statuses, ...COMPLETED_BATCH_STATUSES]
    );

    // Priority decides WHICH punches are taken; inside the run they go chronologically (IN before OUT).
    rows.sort((a, b) =>
      String(a.punched_at).localeCompare(String(b.punched_at)) || Number(a.id) - Number(b.id));

    const summary = {
      selected: rows.length,
      processed: 0,
      skipped: 0,
      failed: 0,
      retry_failed: retryFailed,
      retry_skipped: retrySkipped,
    };

    for (const row of rows) {
      // attempts increments only immediately before processPunch()
      await connection.execute(
        `UPDATE attendance_punch_processing
         SET attempts = attempts + 1
         WHERE punch_id = ?`,
        [row.id]
      );

      let classified;
      try {
        const outcome = await biometricAttendanceService.processPunch(
          {
            device_employee_id: row.device_employee_id,
            punched_at: row.punched_at,
            punch_type: row.punch_type,
          },
          recordedByUserId
        );
        classified = classifyOutcome(outcome);
      } catch (error) {
        classified = {
          status: 'Failed',
          result: 'exception',
          error: String(error.message || 'Unknown error').slice(0, 2000),
        };
      }

      await connection.execute(
        `UPDATE attendance_punch_processing
         SET processing_status = ?,
             processing_result = ?,
             processing_error = ?,
             processed_at = NOW(),
             processed_by_user_id = ?
         WHERE punch_id = ?`,
        [
          classified.status,
          classified.result,
          classified.error,
          recordedByUserId,
          row.id,
        ]
      );

      if (classified.status === 'Processed') summary.processed += 1;
      else if (classified.status === 'Skipped') summary.skipped += 1;
      else summary.failed += 1;
    }

    return summary;
  } finally {
    if (lockAcquired) {
      await releaseCreateLock(connection, LOCK_KEY);
    }
    connection.release();
  }
}

module.exports = {
  processPendingPunches,
  classifyOutcome,
};