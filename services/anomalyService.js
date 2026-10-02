// services/anomalyService.js
//
// D-09 / R-06 / §11-§13: a configurable duration threshold is used ONLY as a
// warning signal ("Needs Review"). It never decides the shift, never closes or
// changes a session and never rejects a value. The shift always comes from the
// assignment / site shift.
//
// Setting: long_shift_review_hours (dated, system_settings_history).

const settingsCache = require('./settingsCache');

const LONG_SHIFT_CODE = 'long_duration';

async function longShiftThresholdHours(dateStr) {
  const raw = Number(await settingsCache.getSettingForDate('long_shift_review_hours', dateStr, '16'));
  return Number.isFinite(raw) && raw > 0 ? raw : 16;
}

function wallToDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
}

function durationHours(checkIn, checkOut) {
  const a = wallToDate(checkIn);
  const b = wallToDate(checkOut);
  if (!a || !b) return null;
  return (b.getTime() - a.getTime()) / 3600000;
}

/**
 * Returns { code, detail, hours, threshold } when the gross session duration is
 * above the threshold for the record date, otherwise null.
 */
async function evaluateSession(checkIn, checkOut, recordDate) {
  const hours = durationHours(checkIn, checkOut);
  if (hours === null) return null;
  const threshold = await longShiftThresholdHours(String(recordDate).slice(0, 10));
  if (hours > threshold) {
    return {
      code: LONG_SHIFT_CODE,
      detail: `Session lasts ${hours.toFixed(2)} h (review threshold ${threshold} h). Check for a missing check-out or a wrong time.`,
      hours,
      threshold,
    };
  }
  return null;
}

/**
 * Writes/clears the anomaly flag on a worker or staff attendance row (same
 * transaction as the caller). A new anomaly resets any previous acknowledgement.
 */
async function applyAnomalyFlag(executor, table, pkColumn, id, anomaly) {
  if (!['attendance', 'staff_attendance'].includes(table)) throw new Error('Invalid table');
  if (anomaly) {
    await executor.execute(
      `UPDATE ${table}
       SET anomaly_code = ?, anomaly_detail = ?,
           anomaly_ack_by_user_id = CASE WHEN anomaly_code <=> ? AND anomaly_detail <=> ? THEN anomaly_ack_by_user_id ELSE NULL END,
           anomaly_ack_at = CASE WHEN anomaly_code <=> ? AND anomaly_detail <=> ? THEN anomaly_ack_at ELSE NULL END,
           anomaly_ack_note = CASE WHEN anomaly_code <=> ? AND anomaly_detail <=> ? THEN anomaly_ack_note ELSE NULL END
       WHERE ${pkColumn} = ?`,
      [anomaly.code, anomaly.detail.slice(0, 255),
        anomaly.code, anomaly.detail.slice(0, 255),
        anomaly.code, anomaly.detail.slice(0, 255),
        anomaly.code, anomaly.detail.slice(0, 255), id]
    );
  } else {
    await executor.execute(
      `UPDATE ${table}
       SET anomaly_code = NULL, anomaly_detail = NULL, anomaly_ack_by_user_id = NULL,
           anomaly_ack_at = NULL, anomaly_ack_note = NULL
       WHERE ${pkColumn} = ? AND anomaly_code IS NOT NULL`,
      [id]
    );
  }
}

module.exports = {
  LONG_SHIFT_CODE,
  longShiftThresholdHours,
  durationHours,
  evaluateSession,
  applyAnomalyFlag,
};
