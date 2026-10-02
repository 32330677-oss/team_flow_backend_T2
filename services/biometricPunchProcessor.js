// services/biometricPunchProcessor.js
//
// Queue runner for attendance_punch_processing.
//
// Phase 2:
//   * #1  The attendance change and the queue row are written in ONE
//         transaction (processQueueItem). A crash can no longer leave the
//         attendance changed while the punch is still Pending.
//   * B1  Outcomes are classified honestly:
//           Processed   - the punch changed attendance
//           Skipped     - informational, nothing to do (already applied,
//                         manual record exists)
//           NeedsReview - a person must decide (Daily Review)
//           Invalid     - can never be processed (future / too old)
//           Failed      - unexpected error (auto-retried, capped)
//           Dismissed   - closed by an admin with a note
//   * B7  Pending first, then Failed with attempts < MAX_AUTO_ATTEMPTS, oldest
//         first; inside a run punches are applied chronologically. Attempts
//         never grow without limit: Failed items stop auto-retrying after
//         MAX_AUTO_ATTEMPTS (explicit retry stays possible).
//   * Raw rows in attendance_punches are never written here.

const db = require('../config/db');
const biometricAttendanceService = require('./biometricAttendanceService');
const { acquireCreateLock, releaseCreateLock } = require('../middleware/duplicateGuard');

const LOCK_KEY = 'biometric_punch_processing';
const COMPLETED_BATCH_STATUSES = ['Completed', 'CompletedWithErrors'];
const MAX_AUTO_ATTEMPTS = 3;
const OUTCOME_STATUSES = ['Processed', 'Skipped', 'NeedsReview', 'Invalid', 'Failed'];

function createError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.isOperational = true;
  return error;
}

function businessNow() {
  const timeZone = process.env.APP_TIME_ZONE || 'Asia/Beirut';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${v.year}-${v.month}-${v.day} ${v.hour}:${v.minute}:${v.second}`;
}

/** Defensive: anything unrecognized becomes Failed (never silently Processed). */
function classifyOutcome(result) {
  if (!result || typeof result !== 'object' || !OUTCOME_STATUSES.includes(result.status)) {
    return {
      status: 'Failed',
      result: 'unknown_outcome',
      error: 'The processing step returned an unrecognized value.',
    };
  }
  return { status: result.status, result: result.result, error: result.message || null };
}

// H-06 / §18: append-only processing history (never updated or deleted).
async function logProcessing(executor, { punchId, event, status, result = null, error = null, mappingId = null,
  targetTable = null, targetRecordId = null, reason = null, userId = null }) {
  try {
    await executor.execute(
      `INSERT INTO attendance_punch_processing_log
         (punch_id, event, processing_status, processing_result, processing_error, mapping_id,
          target_table, target_record_id, reason, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [punchId, String(event).slice(0, 40), status, result, error ? String(error).slice(0, 2000) : null,
        mappingId || null, targetTable || null, targetRecordId || null, reason ? String(reason).slice(0, 500) : null, userId || null]
    );
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
}

/**
 * Processes ONE queue item atomically.
 *
 * @param punchId
 * @param options.userId           user performing the run/action
 * @param options.allowedStatuses  the item must currently be in one of these
 * @param options.override         passed to resolvePunch (review actions)
 * @param options.resolution       { note } -> also stamps resolved_* (admin actions)
 * @param options.audit            { actionType, reason } -> auditlogs row on the queue item
 * @param options.requireCompletedBatch (default true)
 * @param options.throwOnNeedsReview  admin actions: a NeedsReview result is an error (409)
 */
async function processQueueItem(punchId, {
  userId,
  allowedStatuses = ['Pending'],
  override = {},
  resolution = null,
  audit = null,
  requireCompletedBatch = true,
  throwOnNeedsReview = false,
} = {}) {
  const connection = await db.getConnection();
  let committed = false;
  let item = null;
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT pr.id AS processing_id, pr.processing_status, pr.processing_result, pr.attempts,
              pr.mapping_id, pr.target_table, pr.target_record_id, pr.window_override,
              p.id AS punch_id, p.device_employee_id, p.punched_at, p.punch_type, p.created_at AS received_at,
              b.status AS batch_status
       FROM attendance_punch_processing pr
       JOIN attendance_punches p ON p.id = pr.punch_id
       JOIN attendance_import_batches b ON b.id = p.batch_id
       WHERE pr.punch_id = ?
       FOR UPDATE`,
      [punchId]
    );
    if (!rows.length) throw createError('Punch is not in the processing queue.', 404);
    item = rows[0];

    if (!allowedStatuses.includes(item.processing_status)) {
      await connection.rollback();
      return { skippedConcurrent: true, status: item.processing_status, result: item.processing_result };
    }
    if (requireCompletedBatch && !COMPLETED_BATCH_STATUSES.includes(item.batch_status)) {
      throw createError(`The import batch of this punch is ${item.batch_status}. Only punches of completed batches are processed.`, 409);
    }

    const result = await biometricAttendanceService.resolvePunch(
      { device_employee_id: item.device_employee_id, punched_at: item.punched_at, punch_type: item.punch_type,
        received_at: item.received_at },
      userId,
      connection,
      { ...override, ignoreWindow: Number(item.window_override) === 1 }
    );
    const classified = classifyOutcome(result);

    if (throwOnNeedsReview && classified.status !== 'Processed') {
      throw createError(
        `The action could not be applied: ${classified.error || classified.result}`,
        409
      );
    }

    const now = businessNow();
    await connection.execute(
      `UPDATE attendance_punch_processing
       SET processing_status = ?, processing_result = ?, processing_error = ?,
           attempts = attempts + 1, processed_at = ?, processed_by_user_id = ?,
           mapping_id = ?, target_table = ?, target_record_id = ?,
           resolved_at = ?, resolved_by_user_id = ?, resolution_note = ?
       WHERE punch_id = ?`,
      [
        classified.status, classified.result, classified.error ? String(classified.error).slice(0, 2000) : null,
        now, userId,
        result.mappingId || null, result.targetTable || null, result.targetRecordId || null,
        resolution ? now : null, resolution ? userId : null,
        resolution ? String(resolution.note || '').slice(0, 500) || null : null,
        punchId,
      ]
    );

    // H-06: every processing outcome is kept (the queue row holds only the latest).
    await logProcessing(connection, {
      punchId, event: audit ? audit.actionType : 'PROCESSED', status: classified.status, result: classified.result,
      error: classified.error, mappingId: result.mappingId, targetTable: result.targetTable,
      targetRecordId: result.targetRecordId, reason: audit ? audit.reason : null, userId,
    });

    if (audit) {
      await connection.execute(
        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
         VALUES ('attendance_punch_processing', ?, ?, ?, ?, ?)`,
        [item.processing_id, audit.actionType, userId,
          JSON.stringify({
            processing_status: item.processing_status, processing_result: item.processing_result,
            mapping_id: item.mapping_id, target_table: item.target_table, target_record_id: item.target_record_id,
          }),
          JSON.stringify({
            punch_id: punchId, processing_status: classified.status, processing_result: classified.result,
            mapping_id: result.mappingId || null, target_table: result.targetTable || null,
            target_record_id: result.targetRecordId || null, reason: audit.reason || null,
          })]
      );
      // A human decision that changed an attendance record is also recorded on that record.
      if (classified.status === 'Processed' && result.targetTable && result.targetRecordId) {
        await connection.execute(
          `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
           VALUES (?, ?, ?, ?, NULL, ?)`,
          [result.targetTable, result.targetRecordId, audit.actionType, userId,
            JSON.stringify({ punch_id: punchId, punched_at: String(item.punched_at), reason: audit.reason || null })]
        );
      }
    }

    await connection.commit();
    committed = true;
    return { ...classified, mappingId: result.mappingId, targetTable: result.targetTable, targetRecordId: result.targetRecordId };
  } catch (error) {
    if (!committed) {
      try { await connection.rollback(); } catch (_) {}
    }
    // Operational errors of explicit admin actions go back to the caller untouched.
    if (error.isOperational) throw error;

    // Unexpected error: record Failed in a separate statement (the attendance
    // change of this punch was rolled back together with everything else).
    if (item) {
      try {
        await db.execute(
          `UPDATE attendance_punch_processing
           SET processing_status = 'Failed', processing_result = 'exception', processing_error = ?,
               attempts = attempts + 1, processed_at = ?, processed_by_user_id = ?
           WHERE punch_id = ?`,
          [String(error.message || 'Unknown error').slice(0, 2000), businessNow(), userId, punchId]
        );
        await logProcessing(db, { punchId, event: 'PROCESSED', status: 'Failed', result: 'exception',
          error: String(error.message || 'Unknown error'), userId });
      } catch (_) {}
    }
    return { status: 'Failed', result: 'exception', error: String(error.message || 'Unknown error') };
  } finally {
    connection.release();
  }
}

/**
 * Processes eligible punches chronologically.
 *   - Pending
 *   - Failed with attempts < MAX_AUTO_ATTEMPTS (automatic, capped)
 *   - Failed with attempts >= MAX_AUTO_ATTEMPTS only when retryFailed === true
 * NeedsReview / Invalid / Skipped / Dismissed are never picked automatically.
 */
async function processPendingPunches({
  recordedByUserId,
  limit = 200,
  retryFailed = false,
}) {
  if (!Number.isInteger(recordedByUserId) || recordedByUserId <= 0) {
    throw createError('A valid recordedByUserId is required.', 400);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
    throw createError('limit must be an integer between 1 and 2000.', 400);
  }

  const connection = await db.getConnection();
  let lockAcquired = false;

  try {
    lockAcquired = await acquireCreateLock(connection, LOCK_KEY, 0);
    if (!lockAcquired) {
      throw createError('Another biometric processing run is already in progress.', 409);
    }

    const batchPlaceholders = COMPLETED_BATCH_STATUSES.map(() => '?').join(',');
    const failedClause = retryFailed === true
      ? `pr.processing_status = 'Failed'`
      : `(pr.processing_status = 'Failed' AND pr.attempts < ${MAX_AUTO_ATTEMPTS})`;

    const [rows] = await connection.execute(
      `SELECT p.id, p.punched_at, pr.processing_status
       FROM attendance_punch_processing pr
       JOIN attendance_punches p ON p.id = pr.punch_id
       JOIN attendance_import_batches b ON b.id = p.batch_id
       WHERE (pr.processing_status = 'Pending' OR ${failedClause})
         AND b.status IN (${batchPlaceholders})
       ORDER BY FIELD(pr.processing_status, 'Pending', 'Failed') ASC,
                p.punched_at ASC, p.id ASC
       LIMIT ${limit}`,
      COMPLETED_BATCH_STATUSES
    );

    // Priority decides WHICH punches are taken; inside the run they go chronologically.
    rows.sort((a, b) =>
      String(a.punched_at).localeCompare(String(b.punched_at)) || Number(a.id) - Number(b.id));

    const summary = {
      selected: rows.length,
      processed: 0,
      skipped: 0,
      needs_review: 0,
      invalid: 0,
      failed: 0,
      retry_failed: retryFailed === true,
      max_auto_attempts: MAX_AUTO_ATTEMPTS,
    };

    for (const row of rows) {
      const allowed = row.processing_status === 'Pending' ? ['Pending'] : ['Failed'];
      const r = await processQueueItem(row.id, { userId: recordedByUserId, allowedStatuses: allowed });
      if (r.skippedConcurrent) { summary.selected -= 1; continue; }
      if (r.status === 'Processed') summary.processed += 1;
      else if (r.status === 'Skipped') summary.skipped += 1;
      else if (r.status === 'NeedsReview') summary.needs_review += 1;
      else if (r.status === 'Invalid') summary.invalid += 1;
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
  LOCK_KEY,
  MAX_AUTO_ATTEMPTS,
  COMPLETED_BATCH_STATUSES,
  businessNow,
  processPendingPunches,
  processQueueItem,
  classifyOutcome,
  logProcessing,
};
