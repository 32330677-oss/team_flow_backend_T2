const db = require('../config/db');
const { processPendingPunches } = require('../services/biometricPunchProcessor');

const ALL_STATUSES = ['Pending', 'Processed', 'Skipped', 'NeedsReview', 'Invalid', 'Failed', 'Dismissed'];
const ISSUE_STATUSES = ['NeedsReview', 'Failed', 'Invalid', 'Skipped', 'Dismissed'];

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function parseIntegerParam(value, name, min, max, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;

  let parsed;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    throw badRequest(`${name} must be an integer between ${min} and ${max}.`);
  }

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw badRequest(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseBooleanParam(value, name, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') throw badRequest(`${name} must be true or false.`);
  return value;
}

function sendError(res, error, fallbackMessage) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (statusCode === 500) console.error(fallbackMessage, error);
  return res.status(statusCode).json({
    status: 'error',
    message: statusCode === 500 ? fallbackMessage : error.message,
  });
}

// POST /api/biometric/processing/process
// body: { limit?, retry_failed? }  (retry_skipped is accepted for old clients and ignored:
// Skipped is now informational-only and never needs a retry)
exports.processPunches = async (req, res) => {
  try {
    const body = req.body || {};
    const limit = parseIntegerParam(body.limit, 'limit', 1, 2000, 200);
    const retryFailed = parseBooleanParam(body.retry_failed, 'retry_failed', false);
    parseBooleanParam(body.retry_skipped, 'retry_skipped', true);

    const userId = Number(req.user?.user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(401).json({ status: 'error', message: 'Authenticated user id is missing.' });
    }

    const summary = await processPendingPunches({
      recordedByUserId: userId,
      limit,
      retryFailed,
    });

    return res.status(200).json({ status: 'success', data: summary });
  } catch (error) {
    return sendError(res, error, 'Failed to process biometric punches.');
  }
};

// GET /api/biometric/processing/status
exports.getProcessingStatus = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT processing_status, COUNT(*) AS cnt
       FROM attendance_punch_processing
       GROUP BY processing_status`
    );

    const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
    for (const row of rows) {
      counts[row.processing_status] = Number(row.cnt);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    return res.status(200).json({ status: 'success', data: { ...counts, total } });
  } catch (error) {
    return sendError(res, error, 'Failed to load processing status.');
  }
};

// GET /api/biometric/processing/failed?limit=100&status=NeedsReview|Failed|Invalid|Skipped|Dismissed
exports.getFailedPunches = async (req, res) => {
  try {
    const limit = parseIntegerParam(req.query.limit, 'limit', 1, 500, 100);

    let statuses = ['NeedsReview', 'Failed'];
    if (req.query.status !== undefined && req.query.status !== '') {
      if (!ISSUE_STATUSES.includes(req.query.status)) {
        throw badRequest(`status must be one of: ${ISSUE_STATUSES.join(', ')}.`);
      }
      statuses = [req.query.status];
    }

    const placeholders = statuses.map(() => '?').join(',');

    const [rows] = await db.execute(
      `SELECT p.id AS punch_id, p.batch_id, p.device_employee_id, p.punched_at,
              p.raw_punch_code, p.punch_type, p.line_number,
              pr.processing_status, pr.processing_result, pr.processing_error,
              pr.attempts, pr.processed_at, pr.processed_by_user_id,
              pr.mapping_id, pr.target_table, pr.target_record_id,
              pr.resolved_at, pr.resolved_by_user_id, pr.resolution_note
       FROM attendance_punch_processing pr
       JOIN attendance_punches p ON p.id = pr.punch_id
       WHERE pr.processing_status IN (${placeholders})
       ORDER BY p.punched_at DESC, p.id DESC
       LIMIT ${limit}`,
      statuses
    );

    return res.status(200).json({ status: 'success', results: rows.length, data: rows });
  } catch (error) {
    return sendError(res, error, 'Failed to load processing issues.');
  }
};
