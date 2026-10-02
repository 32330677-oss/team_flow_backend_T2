// controllers/biometricReviewController.js
//
// Phase 2 — Biometric Daily Review (Admin only).
//
//   GET  /api/biometric/processing/review?date=YYYY-MM-DD[&scope=unresolved]
//   POST /api/biometric/processing/items/:punchId/retry
//   POST /api/biometric/processing/items/:punchId/use-as-checkout   { target_record_id, reason? }
//   POST /api/biometric/processing/items/:punchId/keep-as-new-in    { reason? }
//   POST /api/biometric/processing/items/:punchId/mark-duplicate    { note? }
//   POST /api/biometric/processing/items/:punchId/review-later      { note }
//   POST /api/biometric/processing/items/:punchId/requeue           { reason }   (D6)
//   POST /api/biometric/processing/items/dismiss                    { punch_ids[], note }
//   GET  /api/biometric/processing/mapping-impact/:mappingId                     (D6 / C2)
//   POST /api/biometric/processing/batches/:batchId/close           { reason }
//   POST /api/biometric/processing/records/submit-for-review        (D2)
//        { kind: 'Worker'|'Staff', record_id, reason, lunch_decision? }
//
// Every action is explicit, audited, and never deletes raw punches or
// attendance. Worker and staff records are handled by separate code paths.

const db = require('../config/db');
const { processQueueItem, businessNow, LOCK_KEY, logProcessing } = require('../services/biometricPunchProcessor');
const biometricDeviceUserService = require('../services/biometricDeviceUserService');
const attendanceService = require('../services/attendanceService');
const { calculateStaffShiftHours, isFriday } = require('../services/staffAttendanceService');
const { getStaffCompensationForDate } = require('../services/staffCompensationService');
const { businessToday, isValidDateOnly, addDays } = require('../services/businessDate');
const { acquireCreateLock, releaseCreateLock } = require('../middleware/duplicateGuard');
const { assertWorkerDateEditable, assertStaffDateEditable } = require('../services/payrollLock');

const STALE_BATCH_MINUTES = Math.max(5, Number(process.env.BIOMETRIC_STALE_BATCH_MINUTES) || 60);

class OpError extends Error {
  constructor(message, statusCode = 400, extra = null) {
    super(message);
    this.isOperational = true;
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

function sendError(res, error, fallback) {
  if (error.isOperational) {
    return res.status(error.statusCode || 400).json({
      status: 'error', message: error.message, ...(error.extra || {}),
    });
  }
  console.error(fallback, error);
  return res.status(500).json({ status: 'error', message: fallback });
}

function requireUser(req) {
  const userId = Number(req.user?.user_id);
  if (!Number.isInteger(userId) || userId <= 0) throw new OpError('Authenticated user id is missing.', 401);
  return userId;
}

function requireText(value, name, max = 500) {
  const text = String(value ?? '').trim();
  if (!text) throw new OpError(`${name} is required.`);
  return text.slice(0, max);
}

function parsePunchId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new OpError('Invalid punch id.');
  return id;
}

const toWall = (v) => (v ? String(v).replace('T', ' ').slice(0, 19) : null);

// Serialize admin actions with the processing run (same named lock).
async function withProcessingLock(fn) {
  const connection = await db.getConnection();
  let locked = false;
  try {
    locked = await acquireCreateLock(connection, LOCK_KEY, 10);
    if (!locked) throw new OpError('Biometric processing is running. Try again in a moment.', 409);
    return await fn();
  } finally {
    if (locked) await releaseCreateLock(connection, LOCK_KEY);
    connection.release();
  }
}

// ---------------------------------------------------------------------------
// Valid actions per item (the same function guards the POST endpoints).
// ---------------------------------------------------------------------------
function isOpenDraftBiometric(target) {
  return Boolean(target && target.source === 'Biometric' && target.status === 'Draft' &&
    target.check_in_time && !target.check_out_time && target.attendance_status === 'Present');
}
function isDraftBiometric(target) {
  return Boolean(target && target.source === 'Biometric' && target.status === 'Draft');
}

// ctx.currentMappingId: mapping that resolves the punch TODAY (may differ from
// the one recorded on the item, or exist when none was recorded).
function validActions(item, target, ctx = {}) {
  const status = item.processing_status;
  const result = item.processing_result;
  if (status === 'Failed') return ['retry', 'dismiss'];
  // D-04: an Invalid (too old) punch can be restored for processing with a reason.
  if (status === 'Invalid') return result === 'punch_too_old' ? ['restore_for_processing'] : [];
  // §18: a closed item can be requeued when a (different / new) valid mapping
  // resolves it now — including an unmapped punch that was Dismissed earlier.
  if (['Processed', 'Skipped', 'Dismissed'].includes(status)) {
    const current = ctx.currentMappingId ? Number(ctx.currentMappingId) : null;
    const used = item.mapping_id ? Number(item.mapping_id) : null;
    return current && current !== used ? ['requeue'] : (used && !current ? ['requeue'] : []);
  }
  if (status !== 'NeedsReview') return [];

  const base = ['dismiss', 'review_later'];
  const actions = [];
  switch (result) {
    case 'unmapped':
      actions.push('map_employee', 'retry');
      break;
    case 'ambiguous_consecutive_in':
      if (isOpenDraftBiometric(target)) actions.push('use_as_checkout', 'enter_checkout');
      actions.push('mark_duplicate', 'keep_as_new_in');
      break;
    case 'consecutive_in':
      if (isOpenDraftBiometric(target)) actions.push('use_as_checkout', 'enter_checkout');
      actions.push('mark_duplicate');
      break;
    case 'earlier_in_same_day':
    case 'in_within_session':
    case 'second_session_same_day':
      actions.push('mark_duplicate');
      break;
    case 'consecutive_out':
    case 'out_within_session':
      if (isDraftBiometric(target)) actions.push('use_as_checkout');
      actions.push('mark_duplicate');
      break;
    case 'out_far_from_session':
      if (isOpenDraftBiometric(target)) actions.push('use_as_checkout', 'enter_checkout');
      break;
    case 'long_duration':
      // Admin decides explicitly; applying it flags the record for approval review.
      if (isOpenDraftBiometric(target)) actions.push('use_as_checkout', 'enter_checkout');
      actions.push('mark_duplicate');
      break;
    default:
      break;
  }
  // Retry is always safe: it re-runs the normal rules, which never overwrite
  // human data. Useful after the underlying data was fixed.
  if (!actions.includes('retry')) actions.push('retry');
  return [...actions, ...base];
}

async function loadItem(punchId, executor = db) {
  const [[item]] = await executor.execute(
    `SELECT pr.id AS processing_id, pr.punch_id, pr.processing_status, pr.processing_result,
            pr.processing_error, pr.attempts, pr.processed_at, pr.mapping_id,
            pr.target_table, pr.target_record_id, pr.resolved_at, pr.resolved_by_user_id,
            pr.resolution_note,
            p.device_employee_id, p.punched_at, p.punch_type, p.raw_punch_code, p.batch_id,
            b.status AS batch_status
     FROM attendance_punch_processing pr
     JOIN attendance_punches p ON p.id = pr.punch_id
     JOIN attendance_import_batches b ON b.id = p.batch_id
     WHERE pr.punch_id = ?`,
    [punchId]
  );
  if (!item) throw new OpError('Punch is not in the processing queue.', 404);
  return item;
}

async function loadTarget(table, id, executor = db) {
  if (!table || !id) return null;
  if (table === 'attendance') {
    const [[r]] = await executor.execute(
      `SELECT a.attendance_id AS record_id, 'attendance' AS target_table, a.worker_id AS person_id,
              w.full_name, w.worker_unique_id AS unique_id, a.site_id, s.site_name, a.shift_type,
              DATE_FORMAT(a.record_date, '%Y-%m-%d') AS record_date, a.check_in_time, a.check_out_time,
              a.attendance_status, a.status, a.source, a.total_working_hours, a.overtime_hours
       FROM attendance a
       JOIN workers w ON w.worker_id = a.worker_id
       JOIN sites s ON s.site_id = a.site_id
       WHERE a.attendance_id = ?`,
      [id]
    );
    return r || null;
  }
  if (table === 'staff_attendance') {
    const [[r]] = await executor.execute(
      `SELECT sa.staff_attendance_id AS record_id, 'staff_attendance' AS target_table, sa.staff_id AS person_id,
              sm.full_name, sm.staff_unique_id AS unique_id, NULL AS site_id, NULL AS site_name, NULL AS shift_type,
              DATE_FORMAT(sa.record_date, '%Y-%m-%d') AS record_date, sa.check_in_time, sa.check_out_time,
              sa.attendance_status, sa.status, sa.source, sa.regular_hours, sa.overtime_hours
       FROM staff_attendance sa
       JOIN staff_members sm ON sm.staff_id = sa.staff_id
       WHERE sa.staff_attendance_id = ?`,
      [id]
    );
    return r || null;
  }
  return null;
}

async function loadMapping(mappingId, executor = db) {
  if (!mappingId) return null;
  const [[m]] = await executor.execute(
    `SELECT adu.id, adu.device_employee_id, adu.entity_type, adu.worker_id, adu.staff_id,
            DATE_FORMAT(adu.effective_from, '%Y-%m-%d') AS effective_from,
            DATE_FORMAT(adu.effective_to, '%Y-%m-%d') AS effective_to, adu.active,
            COALESCE(w.full_name, sm.full_name) AS person_name,
            COALESCE(w.worker_unique_id, sm.staff_unique_id) AS person_unique_id
     FROM attendance_device_users adu
     LEFT JOIN workers w ON w.worker_id = adu.worker_id
     LEFT JOIN staff_members sm ON sm.staff_id = adu.staff_id
     WHERE adu.id = ?`,
    [mappingId]
  );
  return m || null;
}

// ---------------------------------------------------------------------------
// GET /review
// ---------------------------------------------------------------------------
exports.getDailyReview = async (req, res) => {
  try {
    const date = req.query.date || businessToday();
    if (!isValidDateOnly(date)) throw new OpError('A valid date (YYYY-MM-DD) is required.');
    const scopeUnresolved = req.query.scope === 'unresolved';
    const includeAll = req.query.include === 'all';
    const dayStart = `${date} 00:00:00`;
    const nextDayStart = `${addDays(date, 1)} 00:00:00`;

    // Counts for the selected day.
    const [countRows] = await db.execute(
      `SELECT pr.processing_status, COUNT(*) AS cnt
       FROM attendance_punch_processing pr
       JOIN attendance_punches p ON p.id = pr.punch_id
       WHERE p.punched_at >= ? AND p.punched_at < ?
       GROUP BY pr.processing_status`,
      [dayStart, nextDayStart]
    );
    const byStatus = { Pending: 0, Processed: 0, Skipped: 0, NeedsReview: 0, Invalid: 0, Failed: 0, Dismissed: 0 };
    for (const r of countRows) byStatus[r.processing_status] = Number(r.cnt);

    const [[unresolved]] = await db.execute(
      `SELECT COUNT(*) AS cnt FROM attendance_punch_processing WHERE processing_status IN ('NeedsReview','Failed')`
    );
    const today = businessToday();
    const [[resolvedToday]] = await db.execute(
      `SELECT COUNT(*) AS cnt FROM attendance_punch_processing
       WHERE resolved_at >= ? AND resolved_at < ?`,
      [`${today} 00:00:00`, `${addDays(today, 1)} 00:00:00`]
    );
    const [reasonRows] = await db.execute(
      `SELECT pr.processing_result, COUNT(*) AS cnt
       FROM attendance_punch_processing pr
       JOIN attendance_punches p ON p.id = pr.punch_id
       WHERE pr.processing_status = 'NeedsReview' ${scopeUnresolved ? '' : 'AND p.punched_at >= ? AND p.punched_at < ?'}
       GROUP BY pr.processing_result`,
      scopeUnresolved ? [] : [dayStart, nextDayStart]
    );

    // Items.
    const statuses = includeAll
      ? ['Pending', 'Processed', 'Skipped', 'NeedsReview', 'Invalid', 'Failed', 'Dismissed']
      : req.query.include === 'closed'
        ? ['NeedsReview', 'Failed', 'Invalid', 'Dismissed']
        : ['NeedsReview', 'Failed'];
    const placeholders = statuses.map(() => '?').join(',');
    const [items] = await db.execute(
      `SELECT pr.id AS processing_id, pr.punch_id, pr.processing_status, pr.processing_result,
              pr.processing_error, pr.attempts, pr.processed_at, pr.mapping_id,
              pr.target_table, pr.target_record_id, pr.resolved_at, pr.resolved_by_user_id,
              pr.resolution_note,
              p.device_employee_id, p.punched_at, p.punch_type, p.raw_punch_code, p.batch_id,
              b.status AS batch_status
       FROM attendance_punch_processing pr
       JOIN attendance_punches p ON p.id = pr.punch_id
       JOIN attendance_import_batches b ON b.id = p.batch_id
       WHERE pr.processing_status IN (${placeholders})
         ${scopeUnresolved ? '' : 'AND p.punched_at >= ? AND p.punched_at < ?'}
       ORDER BY p.punched_at ASC, p.id ASC
       LIMIT 500`,
      scopeUnresolved ? statuses : [...statuses, dayStart, nextDayStart]
    );

    const data = [];
    for (const item of items) {
      const target = await loadTarget(item.target_table, item.target_record_id);
      let mapping = await loadMapping(item.mapping_id);
      let mappingSource = mapping ? 'used' : null;
      if (!mapping) {
        const current = await biometricDeviceUserService.resolveDeviceUser(
          item.device_employee_id, toWall(item.punched_at));
        if (current) {
          mapping = await loadMapping(current.mapping_id);
          mappingSource = 'current';
        }
      }
      const currentNow = await biometricDeviceUserService.resolveDeviceUser(item.device_employee_id, toWall(item.punched_at));
      data.push({
        ...item,
        punched_at: toWall(item.punched_at),
        message: item.processing_error,
        mapping,
        mapping_source: mappingSource,
        target,
        actions: validActions(item, target, { currentMappingId: currentNow ? currentNow.mapping_id : null }),
      });
    }

    // Missing checkouts on this date (open biometric drafts), worker and staff.
    const [missingWorkers] = await db.execute(
      `SELECT 'attendance' AS target_table, a.attendance_id AS record_id, w.full_name,
              w.worker_unique_id AS unique_id, s.site_name, a.shift_type,
              DATE_FORMAT(a.record_date, '%Y-%m-%d') AS record_date, a.check_in_time
       FROM attendance a
       JOIN workers w ON w.worker_id = a.worker_id
       JOIN sites s ON s.site_id = a.site_id
       WHERE a.source = 'Biometric' AND a.status = 'Draft' AND a.attendance_status = 'Present'
         AND a.check_in_time IS NOT NULL AND a.check_out_time IS NULL AND a.record_date = ?
       ORDER BY w.full_name`,
      [date]
    );
    const [missingStaff] = await db.execute(
      `SELECT 'staff_attendance' AS target_table, sa.staff_attendance_id AS record_id, sm.full_name,
              sm.staff_unique_id AS unique_id, NULL AS site_name, NULL AS shift_type,
              DATE_FORMAT(sa.record_date, '%Y-%m-%d') AS record_date, sa.check_in_time
       FROM staff_attendance sa
       JOIN staff_members sm ON sm.staff_id = sa.staff_id
       WHERE sa.source = 'Biometric' AND sa.status = 'Draft' AND sa.attendance_status = 'Present'
         AND sa.check_in_time IS NOT NULL AND sa.check_out_time IS NULL AND sa.record_date = ?
       ORDER BY sm.full_name`,
      [date]
    );

    const orphanWorkers = await findOrphanWorkerDrafts(db, { date });
    const orphanStaff = await findOrphanStaffDrafts(db, { date });

    const [unmapped] = await db.execute(
      `SELECT p.device_employee_id, COUNT(*) AS punches, MIN(p.punched_at) AS first_punch, MAX(p.punched_at) AS last_punch
       FROM attendance_punches p
       WHERE p.punched_at >= ? AND p.punched_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM attendance_device_users u
           WHERE u.device_employee_id = p.device_employee_id AND u.active = 1
             AND u.effective_from <= DATE(p.punched_at)
             AND (u.effective_to IS NULL OR DATE(p.punched_at) <= u.effective_to))
       GROUP BY p.device_employee_id`,
      [dayStart, nextDayStart]
    );

    return res.status(200).json({
      status: 'success',
      data: {
        date,
        scope: scopeUnresolved ? 'unresolved' : 'date',
        counts: {
          by_status: byStatus,
          still_unresolved_total: Number(unresolved.cnt),
          resolved_today: Number(resolvedToday.cnt),
          needs_review_by_reason: Object.fromEntries(reasonRows.map((r) => [r.processing_result, Number(r.cnt)])),
          missing_checkouts: missingWorkers.length + missingStaff.length,
          orphan_drafts: orphanWorkers.length + orphanStaff.length,
          unmapped_device_ids: unmapped.length,
        },
        items: data,
        missing_checkouts: [...missingWorkers, ...missingStaff],
        orphan_drafts: [...orphanWorkers, ...orphanStaff],
        unmapped_device_ids: unmapped,
      },
    });
  } catch (error) {
    return sendError(res, error, 'Failed to load the daily review.');
  }
};

// ---------------------------------------------------------------------------
// Item actions
// ---------------------------------------------------------------------------
async function assertAction(punchId, action) {
  const item = await loadItem(punchId);
  const target = await loadTarget(item.target_table, item.target_record_id);
  const currentNow = await biometricDeviceUserService.resolveDeviceUser(item.device_employee_id, toWall(item.punched_at));
  const actions = validActions(item, target, { currentMappingId: currentNow ? currentNow.mapping_id : null });
  if (!actions.includes(action)) {
    throw new OpError(
      `"${action}" is not valid for this item (status ${item.processing_status}, reason ${item.processing_result}).`,
      409
    );
  }
  return { item, target };
}

function actionResponse(res, message, result) {
  return res.status(200).json({ status: 'success', message, data: result });
}

exports.retryItem = async (req, res) => {
  try {
    const userId = requireUser(req);
    const punchId = parsePunchId(req.params.punchId);
    const { item } = await assertAction(punchId, 'retry');
    const result = await withProcessingLock(() => processQueueItem(punchId, {
      userId,
      allowedStatuses: [item.processing_status],
      audit: { actionType: 'BIOMETRIC_REVIEW_RETRY', reason: req.body?.reason || null },
    }));
    if (result.skippedConcurrent) throw new OpError('The item changed meanwhile. Refresh and try again.', 409);
    return actionResponse(res, `Retried: ${result.status} (${result.result}).`, result);
  } catch (error) {
    return sendError(res, error, 'Failed to retry the punch.');
  }
};

exports.useAsCheckout = async (req, res) => {
  try {
    const userId = requireUser(req);
    const punchId = parsePunchId(req.params.punchId);
    const { item, target } = await assertAction(punchId, 'use_as_checkout');
    const targetRecordId = Number(req.body?.target_record_id ?? target?.record_id);
    if (!target || targetRecordId !== Number(target.record_id)) {
      throw new OpError('target_record_id must be the session shown for this item.', 409);
    }
    const reason = String(req.body?.reason || 'Admin: use as checkout').slice(0, 500);
    const result = await withProcessingLock(() => processQueueItem(punchId, {
      userId,
      allowedStatuses: [item.processing_status],
      override: { useAsCheckout: true, targetRecordId },
      resolution: { note: reason },
      audit: { actionType: 'BIOMETRIC_REVIEW_USE_AS_CHECKOUT', reason },
      throwOnNeedsReview: true,
    }));
    if (result.skippedConcurrent) throw new OpError('The item changed meanwhile. Refresh and try again.', 409);
    return actionResponse(res, 'Punch applied as the session check-out.', result);
  } catch (error) {
    return sendError(res, error, 'Failed to apply the punch as check-out.');
  }
};

exports.keepAsNewIn = async (req, res) => {
  try {
    const userId = requireUser(req);
    const punchId = parsePunchId(req.params.punchId);
    const { item } = await assertAction(punchId, 'keep_as_new_in');
    if (item.punch_type !== 'IN') throw new OpError('Only an IN punch can be kept as a new IN.', 409);
    const reason = String(req.body?.reason || 'Admin: keep as new IN').slice(0, 500);
    const result = await withProcessingLock(() => processQueueItem(punchId, {
      userId,
      allowedStatuses: [item.processing_status],
      override: { keepAsNewIn: true },
      resolution: { note: reason },
      audit: { actionType: 'BIOMETRIC_REVIEW_KEEP_AS_NEW_IN', reason },
      throwOnNeedsReview: true,
    }));
    if (result.skippedConcurrent) throw new OpError('The item changed meanwhile. Refresh and try again.', 409);
    return actionResponse(res, 'Punch kept as a new IN session.', result);
  } catch (error) {
    return sendError(res, error, 'Failed to keep the punch as a new IN.');
  }
};

// Closes NeedsReview/Failed items without touching attendance.
async function closeItems(punchIds, { userId, newStatus, result, note, actionType, requiredAction }) {
  const connection = await db.getConnection();
  const closed = [];
  try {
    await connection.beginTransaction();
    for (const punchId of punchIds) {
      const [[item]] = await connection.execute(
        `SELECT pr.*, p.punch_type FROM attendance_punch_processing pr
         JOIN attendance_punches p ON p.id = pr.punch_id
         WHERE pr.punch_id = ? FOR UPDATE`,
        [punchId]
      );
      if (!item) throw new OpError(`Punch ${punchId} is not in the processing queue.`, 404);
      const target = await loadTarget(item.target_table, item.target_record_id, connection);
      if (!validActions(item, target).includes(requiredAction)) {
        throw new OpError(`Punch ${punchId}: "${requiredAction}" is not valid (status ${item.processing_status}).`, 409);
      }
      const now = businessNow();
      if (newStatus) {
        await connection.execute(
          `UPDATE attendance_punch_processing
           SET processing_status = ?, processing_result = COALESCE(?, processing_result),
               resolved_at = ?, resolved_by_user_id = ?, resolution_note = ?
           WHERE punch_id = ?`,
          [newStatus, result, now, userId, note.slice(0, 500), punchId]
        );
      } else {
        // Review later: stays NeedsReview, only the note is kept.
        await connection.execute(
          `UPDATE attendance_punch_processing SET resolution_note = ? WHERE punch_id = ?`,
          [`[Review later ${now}] ${note}`.slice(0, 500), punchId]
        );
      }
      await connection.execute(
        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
         VALUES ('attendance_punch_processing', ?, ?, ?, ?, ?)`,
        [item.id, actionType, userId,
          JSON.stringify({ processing_status: item.processing_status, processing_result: item.processing_result }),
          JSON.stringify({ punch_id: punchId, processing_status: newStatus || item.processing_status, note })]
      );
      await logProcessing(connection, {
        punchId, event: actionType, status: newStatus || item.processing_status,
        result: result || item.processing_result, mappingId: item.mapping_id, targetTable: item.target_table,
        targetRecordId: item.target_record_id, reason: note, userId,
      });
      closed.push(punchId);
    }
    await connection.commit();
    return closed;
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }
}

exports.markDuplicate = async (req, res) => {
  try {
    const userId = requireUser(req);
    const punchId = parsePunchId(req.params.punchId);
    const note = String(req.body?.note || 'Marked as duplicate punch').trim();
    const closed = await closeItems([punchId], {
      userId, newStatus: 'Dismissed', result: 'marked_duplicate', note,
      actionType: 'BIOMETRIC_REVIEW_MARK_DUPLICATE', requiredAction: 'mark_duplicate',
    });
    return actionResponse(res, 'Punch marked as duplicate.', { punch_ids: closed });
  } catch (error) {
    return sendError(res, error, 'Failed to mark the punch as duplicate.');
  }
};

exports.reviewLater = async (req, res) => {
  try {
    const userId = requireUser(req);
    const punchId = parsePunchId(req.params.punchId);
    const note = requireText(req.body?.note, 'note', 450);
    await closeItems([punchId], {
      userId, newStatus: null, result: null, note,
      actionType: 'BIOMETRIC_REVIEW_LATER', requiredAction: 'review_later',
    });
    return actionResponse(res, 'Kept for later review.', { punch_id: punchId });
  } catch (error) {
    return sendError(res, error, 'Failed to save the review note.');
  }
};

exports.dismissItems = async (req, res) => {
  try {
    const userId = requireUser(req);
    const note = requireText(req.body?.note, 'note');
    const ids = Array.isArray(req.body?.punch_ids) ? req.body.punch_ids.map(Number) : [];
    if (!ids.length || ids.length > 500 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      throw new OpError('punch_ids must contain 1-500 valid punch ids.');
    }
    const closed = await closeItems([...new Set(ids)], {
      userId, newStatus: 'Dismissed', result: null, note,
      actionType: 'BIOMETRIC_REVIEW_DISMISS', requiredAction: 'dismiss',
    });
    return actionResponse(res, `${closed.length} item(s) dismissed.`, { punch_ids: closed });
  } catch (error) {
    return sendError(res, error, 'Failed to dismiss the items.');
  }
};

// ---------------------------------------------------------------------------
// D6 — requeue a Processed punch after its mapping was corrected.
// Allowed only when the mapping that was USED no longer resolves for the
// punch date (voided/ended/replaced). The previous result stays in the audit
// log; the attendance record it created/changed is NOT touched (the admin
// corrects it through the normal human workflow, see mapping impact).
// ---------------------------------------------------------------------------
// §18 / D6 — requeue a closed punch so it is processed again with the mapping
// that resolves it NOW. Allowed when:
//   * the item was Processed/Skipped/Dismissed under a mapping that no longer
//     resolves (voided / ended / replaced), or
//   * the item had NO mapping (e.g. an unmapped punch that was Dismissed) and
//     a valid mapping now exists for the punch date.
// The raw punch, the previous result (auditlogs + processing log) and the
// Dismiss decision are kept. The attendance record created earlier is NOT
// touched (corrected through the normal human workflow, see mapping impact).
exports.requeueItem = async (req, res) => {
  try {
    const userId = requireUser(req);
    const punchId = parsePunchId(req.params.punchId);
    const reason = requireText(req.body?.reason, 'reason');
    const item = await loadItem(punchId);
    if (!['Processed', 'Skipped', 'Dismissed'].includes(item.processing_status)) {
      throw new OpError('Only a Processed, Skipped or Dismissed punch can be requeued.', 409);
    }
    const current = await biometricDeviceUserService.resolveDeviceUser(item.device_employee_id, toWall(item.punched_at));
    if (item.mapping_id) {
      if (current && Number(current.mapping_id) === Number(item.mapping_id)) {
        throw new OpError('The punch still resolves to the same mapping. Correct (end/void) the mapping first.', 409);
      }
    } else if (!current) {
      throw new OpError('No valid mapping covers this punch date yet. Create the device mapping first, then requeue.', 409);
    }

    const result = await withProcessingLock(async () => {
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [upd] = await connection.execute(
          `UPDATE attendance_punch_processing
           SET processing_status = 'Pending', processing_result = NULL, processing_error = NULL,
               mapping_id = NULL, target_table = NULL, target_record_id = NULL,
               resolved_at = NULL, resolved_by_user_id = NULL, resolution_note = NULL
           WHERE punch_id = ? AND processing_status = ?`,
          [punchId, item.processing_status]
        );
        if (upd.affectedRows !== 1) throw new OpError('The item changed meanwhile. Refresh and try again.', 409);
        await connection.execute(
          `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
           VALUES ('attendance_punch_processing', ?, 'BIOMETRIC_PUNCH_REQUEUED', ?, ?, ?)`,
          [item.processing_id, userId,
            JSON.stringify({
              processing_status: item.processing_status, processing_result: item.processing_result,
              mapping_id: item.mapping_id, target_table: item.target_table, target_record_id: item.target_record_id,
              resolution_note: item.resolution_note,
            }),
            JSON.stringify({ punch_id: punchId, processing_status: 'Pending', reason, new_mapping_id: current?.mapping_id || null })]
        );
        await logProcessing(connection, {
          punchId, event: 'BIOMETRIC_PUNCH_REQUEUED', status: 'Pending', result: null,
          mappingId: current?.mapping_id || null, reason, userId,
        });
        await connection.commit();
      } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        throw error;
      } finally {
        connection.release();
      }
      return processQueueItem(punchId, { userId, allowedStatuses: ['Pending'] });
    });

    return actionResponse(res, `Requeued and reprocessed: ${result.status} (${result.result}).`, {
      ...result,
      previous: { mapping_id: item.mapping_id, target_table: item.target_table, target_record_id: item.target_record_id },
    });
  } catch (error) {
    return sendError(res, error, 'Failed to requeue the punch.');
  }
};

// D-04 — restore an Invalid (too old) punch for processing.
// The raw punch is never edited; the queue item gets window_override = 1 with
// who/when/why, goes back to Pending and is processed by the normal pipeline.
exports.restoreInvalidItem = async (req, res) => {
  try {
    const userId = requireUser(req);
    const punchId = parsePunchId(req.params.punchId);
    const reason = requireText(req.body?.reason, 'reason');
    const { item } = await assertAction(punchId, 'restore_for_processing');
    const result = await withProcessingLock(async () => {
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [upd] = await connection.execute(
          `UPDATE attendance_punch_processing
           SET processing_status = 'Pending', window_override = 1, window_override_reason = ?,
               window_override_by_user_id = ?, window_override_at = ?
           WHERE punch_id = ? AND processing_status = 'Invalid'`,
          [reason, userId, businessNow(), punchId]
        );
        if (upd.affectedRows !== 1) throw new OpError('The item changed meanwhile. Refresh and try again.', 409);
        await connection.execute(
          `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
           VALUES ('attendance_punch_processing', ?, 'BIOMETRIC_INVALID_RESTORED', ?, ?, ?)`,
          [item.processing_id, userId, JSON.stringify({ processing_status: 'Invalid', processing_result: item.processing_result }),
            JSON.stringify({ punch_id: punchId, processing_status: 'Pending', window_override: 1, reason })]
        );
        await logProcessing(connection, { punchId, event: 'BIOMETRIC_INVALID_RESTORED', status: 'Pending', reason, userId });
        await connection.commit();
      } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        throw error;
      } finally {
        connection.release();
      }
      return processQueueItem(punchId, { userId, allowedStatuses: ['Pending'] });
    });
    return actionResponse(res, `Restored and processed: ${result.status} (${result.result}).`, result);
  } catch (error) {
    return sendError(res, error, 'Failed to restore the punch.');
  }
};

// GET /items/:punchId/history — raw punch + full processing history (H-06).
exports.getItemHistory = async (req, res) => {
  try {
    const punchId = parsePunchId(req.params.punchId);
    const item = await loadItem(punchId);
    const [[raw]] = await db.execute(
      `SELECT id, batch_id, device_employee_id, punched_at, raw_punch_code, punch_type, raw_line, line_number, created_at
       FROM attendance_punches WHERE id = ?`, [punchId]);
    const [log] = await db.execute(
      `SELECT l.log_id, l.event, l.processing_status, l.processing_result, l.processing_error, l.mapping_id,
              l.target_table, l.target_record_id, l.reason, l.created_at, u.full_name AS user_name
       FROM attendance_punch_processing_log l LEFT JOIN users u ON u.user_id = l.user_id
       WHERE l.punch_id = ? ORDER BY l.log_id ASC`, [punchId]);
    return res.status(200).json({ status: 'success', data: { item, raw_punch: raw, history: log } });
  } catch (error) {
    return sendError(res, error, 'Failed to load the punch history.');
  }
};

// ---------------------------------------------------------------------------
// D6 / C2 — mapping impact
// ---------------------------------------------------------------------------
exports.getMappingImpact = async (req, res) => {
  try {
    const mappingId = Number(req.params.mappingId);
    if (!Number.isInteger(mappingId) || mappingId <= 0) throw new OpError('Invalid mapping id.');
    const mapping = await loadMapping(mappingId);
    if (!mapping) throw new OpError('Mapping not found.', 404);

    const [punches] = await db.execute(
      `SELECT pr.punch_id, pr.processing_status, pr.processing_result, pr.processing_error,
              pr.target_table, pr.target_record_id, pr.processed_at, pr.attempts,
              p.device_employee_id, p.punched_at, p.punch_type, p.batch_id
       FROM attendance_punch_processing pr
       JOIN attendance_punches p ON p.id = pr.punch_id
       WHERE pr.mapping_id = ?
       ORDER BY p.punched_at ASC, p.id ASC`,
      [mappingId]
    );

    const records = new Map();
    const punchData = [];
    for (const p of punches) {
      const current = await biometricDeviceUserService.resolveDeviceUser(p.device_employee_id, toWall(p.punched_at));
      const stillResolves = Boolean(current && Number(current.mapping_id) === mappingId);
      punchData.push({
        ...p,
        punched_at: toWall(p.punched_at),
        current_mapping_id: current ? current.mapping_id : null,
        can_requeue: ['Processed', 'Skipped', 'Dismissed'].includes(p.processing_status) && !stillResolves,
      });
      if (p.target_table && p.target_record_id) {
        const key = `${p.target_table}:${p.target_record_id}`;
        if (!records.has(key)) {
          const target = await loadTarget(p.target_table, p.target_record_id);
          if (target) records.set(key, { ...target, punch_ids: [] });
        }
        if (records.has(key)) records.get(key).punch_ids.push(p.punch_id);
      }
    }

    return res.status(200).json({
      status: 'success',
      data: {
        mapping,
        punches: punchData,
        affected_records: [...records.values()],
        summary: {
          punches: punchData.length,
          affected_records: records.size,
          requeueable: punchData.filter((p) => p.can_requeue).length,
        },
      },
    });
  } catch (error) {
    return sendError(res, error, 'Failed to load the mapping impact.');
  }
};

// ---------------------------------------------------------------------------
// Close a stale Pending import batch (interrupted upload). Its received
// punches become processable (CompletedWithErrors). Never deletes anything.
// ---------------------------------------------------------------------------
exports.closeStaleBatch = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const userId = requireUser(req);
    const batchId = Number(req.params.batchId);
    if (!Number.isInteger(batchId) || batchId <= 0) throw new OpError('Invalid batch id.');
    const reason = requireText(req.body?.reason, 'reason');

    await connection.beginTransaction();
    const [[batch]] = await connection.execute(
      `SELECT b.id, b.status, b.created_at,
              (SELECT COUNT(*) FROM attendance_punches p WHERE p.batch_id = b.id) AS punch_count,
              (SELECT MAX(p.created_at) FROM attendance_punches p WHERE p.batch_id = b.id) AS last_punch_received,
              TIMESTAMPDIFF(MINUTE, GREATEST(b.created_at,
                 COALESCE((SELECT MAX(p.created_at) FROM attendance_punches p WHERE p.batch_id = b.id), b.created_at)),
                 CURRENT_TIMESTAMP) AS idle_minutes
       FROM attendance_import_batches b WHERE b.id = ? FOR UPDATE`,
      [batchId]
    );
    if (!batch) throw new OpError('Batch not found.', 404);
    if (batch.status !== 'Pending') throw new OpError(`Only a Pending batch can be closed (this one is ${batch.status}).`, 409);
    if (Number(batch.idle_minutes) < STALE_BATCH_MINUTES) {
      throw new OpError(`The batch received data ${batch.idle_minutes} minute(s) ago. It can be closed after ${STALE_BATCH_MINUTES} idle minutes (an upload may still be running).`, 409);
    }

    const [upd] = await connection.execute(
      `UPDATE attendance_import_batches
       SET status = 'CompletedWithErrors', inserted_rows = ?, imported_at = NOW(),
           error_details = ?
       WHERE id = ? AND status = 'Pending'`,
      [Number(batch.punch_count), JSON.stringify({ closed_by_admin: true, reason, received_punches: Number(batch.punch_count) }), batchId]
    );
    if (upd.affectedRows !== 1) throw new OpError('The batch changed meanwhile. Refresh and try again.', 409);
    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('attendance_import_batches', ?, 'BIOMETRIC_BATCH_CLOSED', ?, ?, ?)`,
      [batchId, userId, JSON.stringify({ status: 'Pending' }),
        JSON.stringify({ status: 'CompletedWithErrors', reason, received_punches: Number(batch.punch_count) })]
    );
    await connection.commit();
    return res.status(200).json({
      status: 'success',
      message: `Batch #${batchId} closed. ${batch.punch_count} received punch(es) can now be processed.`,
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    return sendError(res, error, 'Failed to close the batch.');
  } finally {
    connection.release();
  }
};

// ---------------------------------------------------------------------------
// D2 — Admin "Submit for review" of an orphaned biometric Draft.
// Orphaned = no current supervisor able to review it, OR its site is no longer
// Active. The admin gives a reason; the record then goes through the normal
// submission validation and becomes Submitted (NOT Approved).
// ---------------------------------------------------------------------------
const WORKER_SUPERVISOR_EXISTS = `(
   (s.supports_shifts = 1 AND EXISTS (
      SELECT 1 FROM site_shifts ss JOIN users u ON u.user_id = ss.supervisor_id
      WHERE ss.site_id = a.site_id AND ss.shift_type = a.shift_type
        AND u.status = 'Active' AND u.role = 'Supervisor'))
   OR (s.supports_shifts = 0 AND EXISTS (
      SELECT 1 FROM users u WHERE u.user_id = s.supervisor_id
        AND u.status = 'Active' AND u.role = 'Supervisor')))`;

async function findOrphanWorkerDrafts(executor, { date = null, recordId = null, forUpdate = false }) {
  const where = [];
  const params = [];
  if (date) { where.push('a.record_date = ?'); params.push(date); }
  if (recordId) { where.push('a.attendance_id = ?'); params.push(recordId); }
  const [rows] = await executor.execute(
    `SELECT 'attendance' AS target_table, a.attendance_id AS record_id, w.full_name,
            w.worker_unique_id AS unique_id, s.site_name, s.site_status, a.shift_type,
            DATE_FORMAT(a.record_date, '%Y-%m-%d') AS record_date, a.check_in_time, a.check_out_time,
            a.attendance_status,
            CASE WHEN s.site_status <> 'Active' THEN 'site_not_active'
                 WHEN NOT ${WORKER_SUPERVISOR_EXISTS} THEN 'no_supervisor'
                 ELSE NULL END AS orphan_reason
     FROM attendance a
     JOIN workers w ON w.worker_id = a.worker_id
     JOIN sites s ON s.site_id = a.site_id
     WHERE a.source = 'Biometric' AND a.status = 'Draft'
       ${where.length ? `AND ${where.join(' AND ')}` : ''}
     ORDER BY a.record_date, w.full_name
     ${forUpdate ? 'FOR UPDATE OF a' : ''}`,
    params
  );
  return rows.filter((r) => r.orphan_reason);
}

async function findOrphanStaffDrafts(executor, { date = null, recordId = null, forUpdate = false }) {
  const today = businessToday();
  const where = [];
  const params = [today, today];
  if (date) { where.push('sa.record_date = ?'); params.push(date); }
  if (recordId) { where.push('sa.staff_attendance_id = ?'); params.push(recordId); }
  const [rows] = await executor.execute(
    `SELECT 'staff_attendance' AS target_table, sa.staff_attendance_id AS record_id, sm.full_name,
            sm.staff_unique_id AS unique_id, COALESCE(s1.site_name, s2.site_name) AS site_name,
            COALESCE(s1.site_status, s2.site_status) AS site_status, NULL AS shift_type,
            DATE_FORMAT(sa.record_date, '%Y-%m-%d') AS record_date, sa.check_in_time, sa.check_out_time,
            sa.attendance_status, sa.is_friday_worked,
            EXISTS (SELECT 1 FROM staff_supervisor_assignments ssa
                    JOIN users u ON u.user_id = ssa.supervisor_user_id
                    WHERE ssa.staff_id = sa.staff_id AND ssa.assigned_date <= ?
                      AND (ssa.unassigned_date IS NULL OR ssa.unassigned_date >= ?)
                      AND u.status = 'Active' AND u.role = 'StaffSupervisor') AS has_supervisor
     FROM staff_attendance sa
     JOIN staff_members sm ON sm.staff_id = sa.staff_id
     LEFT JOIN staff_site_assignments ssite ON ssite.staff_assignment_id = (
         SELECT x.staff_assignment_id FROM staff_site_assignments x
         WHERE x.staff_id = sa.staff_id AND x.assigned_date <= sa.record_date
           AND (x.unassigned_date IS NULL OR x.unassigned_date >= sa.record_date)
         ORDER BY x.assigned_date DESC LIMIT 1)
     LEFT JOIN sites s1 ON s1.site_id = ssite.site_id
     LEFT JOIN sites s2 ON s2.site_id = sm.site_id
     WHERE sa.source = 'Biometric' AND sa.status = 'Draft'
       ${where.length ? `AND ${where.join(' AND ')}` : ''}
     ORDER BY sa.record_date, sm.full_name
     ${forUpdate ? 'FOR UPDATE OF sa' : ''}`,
    params
  );
  return rows
    .map((r) => ({
      ...r,
      orphan_reason: (r.site_status && r.site_status !== 'Active')
        ? 'site_not_active'
        : (Number(r.has_supervisor) === 1 ? null : 'no_supervisor'),
    }))
    .filter((r) => r.orphan_reason);
}

async function workerLunchCheck(connection, rec) {
  const recordDate = String(rec.record_date).slice(0, 10);
  const prev = addDays(recordDate, -1);
  const [[siteLunch]] = await connection.execute(
    `SELECT MIN(alp.leave_start_time) AS lunch_start, MAX(alp.leave_end_time) AS lunch_end
     FROM attendanceleaveperiods alp
     JOIN attendance a2 ON a2.attendance_id = alp.attendance_id
     WHERE a2.site_id = ? AND a2.shift_type = ? AND alp.leave_type = 'Lunch'
       AND alp.leave_end_time IS NOT NULL
       AND (a2.record_date = ? OR (a2.record_date = ?
            AND a2.check_out_time IS NOT NULL AND DATE(a2.check_out_time) > a2.record_date))`,
    [rec.site_id, rec.shift_type, recordDate, prev]
  );
  const [[hasLunch]] = await connection.execute(
    `SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_type = 'Lunch' LIMIT 1`,
    [rec.attendance_id]
  );
  const start = siteLunch?.lunch_start ? toWall(siteLunch.lunch_start) : null;
  const end = siteLunch?.lunch_end ? toWall(siteLunch.lunch_end) : null;
  const inWall = toWall(rec.check_in_time);
  const outWall = toWall(rec.check_out_time);
  const overlaps = !start || (inWall < end && outWall > start);
  return { needsDecision: !hasLunch && overlaps, siteLunchStart: start, siteLunchEnd: end };
}

async function applyWorkerLunchDecision(connection, rec, decision, lunch, userId) {
  const { normalizeTimeForShift, parseAttendanceDate } = require('./attendanceController')._shared;
  const attendanceId = rec.attendance_id;
  if (decision.worked_through_lunch === true) {
    const reason = String(decision.reason || '').trim();
    if (!reason) throw new OpError('A reason is required when the worker worked through lunch.');
    await connection.execute(
      `UPDATE attendance SET remarks = CONCAT(COALESCE(remarks, ''), CASE WHEN remarks IS NULL OR remarks = '' THEN '' ELSE ' | ' END, ?) WHERE attendance_id = ?`,
      [`Worked through lunch: ${reason}`, attendanceId]
    );
    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('attendance', ?, 'LUNCH_SKIPPED_CONFIRMED', ?, NULL, ?)`,
      [attendanceId, userId, JSON.stringify({ worked_through_lunch: true, reason })]
    );
    return;
  }
  if (!lunch.siteLunchStart || !lunch.siteLunchEnd) {
    throw new OpError('No site lunch period is recorded for this site/shift/date. Record the lunch time or confirm the worker worked through lunch.');
  }
  const checkInDate = parseAttendanceDate(toWall(rec.check_in_time));
  const checkOutDate = parseAttendanceDate(toWall(rec.check_out_time));
  const lunchStart = normalizeTimeForShift(lunch.siteLunchStart, checkInDate, checkOutDate);
  const lunchEnd = normalizeTimeForShift(lunch.siteLunchEnd, checkInDate, checkOutDate);
  const lunchStartDate = parseAttendanceDate(lunchStart);
  const lunchEndDate = parseAttendanceDate(lunchEnd);
  if (!lunchStartDate || !lunchEndDate || lunchEndDate <= lunchStartDate) {
    throw new OpError('The site lunch period is not valid for this shift.');
  }
  if (lunchStartDate < checkOutDate && lunchEndDate > checkInDate) {
    if (lunchStartDate < checkInDate || lunchEndDate > checkOutDate) {
      throw new OpError('The site lunch period is not completely inside this shift.');
    }
    const [inserted] = await connection.execute(
      `INSERT INTO attendanceleaveperiods (attendance_id, leave_start_time, leave_end_time, leave_type) VALUES (?, ?, ?, 'Lunch')`,
      [attendanceId, lunchStart, lunchEnd]
    );
    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('attendanceleaveperiods', ?, 'LUNCH_AUTO_CREATE_ON_SUBMIT', ?, NULL, ?)`,
      [inserted.insertId, userId, JSON.stringify({ attendance_id: attendanceId, leave_start_time: lunchStart, leave_end_time: lunchEnd, leave_type: 'Lunch' })]
    );
  }
  await connection.execute(
    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
     VALUES ('attendance', ?, 'LUNCH_NOT_WORKED_CONFIRMED', ?, NULL, ?)`,
    [attendanceId, userId, JSON.stringify({ worked_through_lunch: false })]
  );
}

exports.adminSubmitForReview = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const userId = requireUser(req);
    const kind = req.body?.kind;
    if (!['Worker', 'Staff'].includes(kind)) throw new OpError('kind must be Worker or Staff.');
    const recordId = Number(req.body?.record_id);
    if (!Number.isInteger(recordId) || recordId <= 0) throw new OpError('Invalid record_id.');
    const reason = requireText(req.body?.reason, 'reason');

    await connection.beginTransaction();

    if (kind === 'Worker') {
      const [[rec]] = await connection.execute('SELECT * FROM attendance WHERE attendance_id = ? FOR UPDATE', [recordId]);
      if (!rec) throw new OpError('Record not found.', 404);
      if (rec.source !== 'Biometric') throw new OpError('Only biometric records can be submitted by Admin.', 409);
      if (rec.status !== 'Draft') throw new OpError(`Only a Draft can be submitted (this record is ${rec.status}).`, 409);
      const [orphan] = await findOrphanWorkerDrafts(connection, { recordId });
      if (!orphan) throw new OpError('This draft has an active supervisor and an Active site. The supervisor must submit it through the normal day submission.', 409);
      await assertWorkerDateEditable(connection, rec.site_id, rec.record_date);   // D-02

      // Normal submission validation (same rules as submitDay).
      if (rec.attendance_status === 'Present') {
        if (!rec.check_in_time || !rec.check_out_time) {
          throw new OpError('Present requires both a check-in and a check-out before submission.');
        }
        const [[openLeave]] = await connection.execute(
          'SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NULL LIMIT 1',
          [recordId]
        );
        if (openLeave) throw new OpError('End the active break before submitting.');
        const lunch = await workerLunchCheck(connection, rec);
        if (lunch.needsDecision) {
          const decision = req.body?.lunch_decision;
          if (!decision || typeof decision !== 'object') {
            throw new OpError('This worker has no recorded lunch. Confirm whether the worker worked during lunch.', 409, {
              code: 'LUNCH_DECISION_REQUIRED',
              lunch_period: { start: lunch.siteLunchStart, end: lunch.siteLunchEnd },
            });
          }
          await applyWorkerLunchDecision(connection, rec, decision, lunch, userId);
        }
        await attendanceService.calculateWorkingHours(recordId, connection);
      }

      const [upd] = await connection.execute(
        `UPDATE attendance SET status = 'Submitted', admin_rejection_notes = NULL
         WHERE attendance_id = ? AND status = 'Draft'`,
        [recordId]
      );
      if (upd.affectedRows !== 1) throw new OpError('The record changed meanwhile. Refresh and try again.', 409);
      await connection.execute(
        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
         VALUES ('attendance', ?, 'ADMIN_SUBMIT_FOR_REVIEW', ?, ?, ?)`,
        [recordId, userId, JSON.stringify({ status: 'Draft' }),
          JSON.stringify({ status: 'Submitted', reason, orphan_reason: orphan.orphan_reason })]
      );
    } else {
      const [[rec]] = await connection.execute('SELECT * FROM staff_attendance WHERE staff_attendance_id = ? FOR UPDATE', [recordId]);
      if (!rec) throw new OpError('Record not found.', 404);
      if (rec.source !== 'Biometric') throw new OpError('Only biometric records can be submitted by Admin.', 409);
      if (rec.status !== 'Draft') throw new OpError(`Only a Draft can be submitted (this record is ${rec.status}).`, 409);
      const [orphan] = await findOrphanStaffDrafts(connection, { recordId });
      if (!orphan) throw new OpError('This draft has an active Staff Supervisor and an Active site. The supervisor must submit it.', 409);
      await assertStaffDateEditable(connection, rec.record_date);   // D-02

      const recordDate = String(rec.record_date).slice(0, 10);
      if (rec.attendance_status === 'Present') {
        if (!rec.check_in_time || !rec.check_out_time) {
          throw new OpError('Present requires both a check-in and a check-out before submission.');
        }
        if (isFriday(recordDate) && Number(rec.is_friday_worked) !== 1) {
          throw new OpError('Friday attendance must be confirmed by a Staff Supervisor before submission.', 409, { code: 'FRIDAY_CONFIRMATION_REQUIRED' });
        }
        const comp = await getStaffCompensationForDate(rec.staff_id, recordDate, connection);
        const snapshotMinutes = Number(rec.standard_minutes_snapshot) > 0
          ? Number(rec.standard_minutes_snapshot) : Math.round((comp ? comp.standard_daily_hours : 8) * 60);
        let shift;
        try {
          shift = calculateStaffShiftHours({
            checkInRaw: toWall(rec.check_in_time), checkOutRaw: toWall(rec.check_out_time),
            lunchStartRaw: rec.lunch_start_time, lunchEndRaw: rec.lunch_end_time,
            recordDate, standardDailyHours: snapshotMinutes / 60,
          });
        } catch (calcError) {
          throw new OpError(calcError.message);
        }
        await connection.execute(
          `UPDATE staff_attendance SET regular_hours = ?, overtime_hours = ?, lunch_deducted_hours = ?,
                  standard_minutes_snapshot = COALESCE(standard_minutes_snapshot, ?)
           WHERE staff_attendance_id = ?`,
          [shift.regularHours.toFixed(2), shift.overtimeHours.toFixed(2), shift.lunchHours.toFixed(2), snapshotMinutes, recordId]
        );
      }
      const [upd] = await connection.execute(
        `UPDATE staff_attendance SET status = 'Submitted', admin_rejection_notes = NULL,
                approved_by_user_id = NULL, approval_date = NULL
         WHERE staff_attendance_id = ? AND status = 'Draft'`,
        [recordId]
      );
      if (upd.affectedRows !== 1) throw new OpError('The record changed meanwhile. Refresh and try again.', 409);
      await connection.execute(
        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
         VALUES ('staff_attendance', ?, 'ADMIN_SUBMIT_FOR_REVIEW', ?, ?, ?)`,
        [recordId, userId, JSON.stringify({ status: 'Draft' }),
          JSON.stringify({ status: 'Submitted', reason, orphan_reason: orphan.orphan_reason })]
      );
    }

    await connection.commit();
    return res.status(200).json({ status: 'success', message: 'Record submitted for review. It still needs Admin approval.' });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    return sendError(res, error, 'Failed to submit the record for review.');
  } finally {
    connection.release();
  }
};

exports._internal = { validActions, findOrphanWorkerDrafts, findOrphanStaffDrafts };
