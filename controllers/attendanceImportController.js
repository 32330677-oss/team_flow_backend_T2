const crypto = require('crypto');
const db = require('../config/db');

const DT_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const MAX_PUNCHES_PER_REQUEST = 500;

// Wall-clock validation only: no timezone conversion anywhere.
function normalizeDateTime(value) {
  const m = DT_RE.exec(String(value || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map((v, i) => (i === 0 ? v : Number(v)));
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d ||
      dt.getUTCHours() !== h || dt.getUTCMinutes() !== mi || dt.getUTCSeconds() !== s) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${m[2]}-${m[3]} ${p(h)}:${p(mi)}:${p(s)}`;
}

// Key is built from RAW device values (not the mapped IN/OUT) so fixing the
// IN/OUT mapping later never causes previously imported punches to re-import.
function buildDedupeKey(deviceEmployeeId, punchedAt, rawPunchCode) {
  return crypto.createHash('sha256')
    .update(`${deviceEmployeeId}|${punchedAt}|${rawPunchCode}`)
    .digest('hex');
}

function validatePunch(p) {
  if (!p || typeof p !== 'object') return { error: 'Invalid punch object.' };
  const deviceEmployeeId = String(p.deviceEmployeeId ?? '').trim();
  if (!/^\d{1,20}$/.test(deviceEmployeeId)) return { error: 'Invalid deviceEmployeeId.' };
  const punchedAt = normalizeDateTime(p.punchedAt);
  if (!punchedAt) return { error: 'Invalid punchedAt.' };
  const rawPunchCode = String(p.rawPunchCode ?? '').trim();
  if (!/^[A-Za-z0-9]{1,10}$/.test(rawPunchCode)) return { error: 'Invalid rawPunchCode.' };
  if (!['IN', 'OUT'].includes(p.punchType)) return { error: 'punchType must be IN or OUT.' };
  const rawLine = String(p.rawLine ?? '').slice(0, 500);
  if (!rawLine) return { error: 'rawLine is required.' };
  const lineNumber = Number.isInteger(p.lineNumber) && p.lineNumber > 0 ? p.lineNumber : null;
  return {
    value: {
      deviceEmployeeId, punchedAt, rawPunchCode, punchType: p.punchType, rawLine, lineNumber,
      dedupeKey: buildDedupeKey(deviceEmployeeId, punchedAt, rawPunchCode),
    },
  };
}

// POST /api/attendance/import-batches   (idempotent by checksum)
exports.createBatch = async (req, res) => {
  const sourceFile = String(req.body?.source_file || '').trim().slice(0, 255);
  const checksum = String(req.body?.checksum || '').trim().toLowerCase();
  if (!sourceFile || !/^[a-f0-9]{64}$/.test(checksum)) {
    return res.status(400).json({ status: 'error', message: 'source_file and a SHA-256 checksum are required.' });
  }
  const find = async () => {
    const [rows] = await db.execute(
      'SELECT id, status FROM attendance_import_batches WHERE checksum = ? LIMIT 1', [checksum]);
    return rows[0] || null;
  };
  try {
    let batch = await find();
    if (!batch) {
      try {
        const [r] = await db.execute(
          `INSERT INTO attendance_import_batches (source_file, checksum, status) VALUES (?, ?, 'Pending')`,
          [sourceFile, checksum]);
        return res.status(201).json({ status: 'success', batchId: r.insertId, batchStatus: 'Pending', alreadyImported: false });
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY') throw e;
        batch = await find(); // concurrent creation
      }
    }
      if (batch.status === 'Pending') {
      await db.execute(
        `UPDATE attendance_import_batches
         SET error_rows = 0
         WHERE id = ? AND status = 'Pending'`,
        [batch.id]
      );
    }

    return res.status(200).json({
      status: 'success',
      batchId: batch.id,
      batchStatus: batch.status,
      alreadyImported: ['Completed', 'CompletedWithErrors'].includes(batch.status),
    });
  } catch (error) {
    console.error('CREATE IMPORT BATCH ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to create import batch.' });
  }
};

// A3 + C5: a duplicate raw punch is never inserted twice, but it must not stay
// unprocessable either:
//   - C5: if the existing punch has no queue row, create it (Pending).
//   - A3: if the existing punch belongs to a batch that never completed
//     (Pending/Failed, i.e. abandoned), move it to the batch that is now
//     delivering it. The raw row itself is unchanged except batch_id, and the
//     move is audited. Nothing is deleted.
// Returns true when the punch was recovered (re-pointed or queue row created).
async function healDuplicatePunch(connection, dedupeKey, batchId) {
  let changed = false;
  try {
    await connection.beginTransaction();
    const [[punch]] = await connection.execute(
      `SELECT p.id, p.batch_id, b.status AS batch_status
       FROM attendance_punches p
       JOIN attendance_import_batches b ON b.id = p.batch_id
       WHERE p.dedupe_key = ? FOR UPDATE`,
      [dedupeKey]
    );
    if (!punch) { await connection.rollback(); return false; }

    if (punch.batch_id !== batchId && ['Pending', 'Failed'].includes(punch.batch_status)) {
      const [moved] = await connection.execute(
        'UPDATE attendance_punches SET batch_id = ? WHERE id = ? AND batch_id = ?',
        [batchId, punch.id, punch.batch_id]
      );
      if (moved.affectedRows === 1) {
        changed = true;
        await connection.execute(
          `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
           VALUES ('attendance_punches', ?, 'PUNCH_BATCH_REPOINTED', NULL, ?, ?)`,
          [punch.id, JSON.stringify({ batch_id: punch.batch_id, batch_status: punch.batch_status }),
            JSON.stringify({ batch_id: batchId })]
        );
      }
    }

    const [queued] = await connection.execute(
      `INSERT IGNORE INTO attendance_punch_processing (punch_id, processing_status) VALUES (?, 'Pending')`,
      [punch.id]
    );
    if (queued.affectedRows === 1) changed = true;

    await connection.commit();
    return changed;
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    throw error;
  }
}

exports.addPunches = async (req, res) => {
  const batchId = Number(req.body?.batchId);
  const punches = req.body?.punches;
  if (!Number.isInteger(batchId) || batchId <= 0 || !Array.isArray(punches) ||
      punches.length === 0 || punches.length > MAX_PUNCHES_PER_REQUEST) {
    return res.status(400).json({ status: 'error', message: `batchId and 1-${MAX_PUNCHES_PER_REQUEST} punches are required.` });
  }

  let connection = null;
  try {
    const [batches] = await db.execute('SELECT id, status FROM attendance_import_batches WHERE id = ?', [batchId]);
    if (!batches.length) return res.status(404).json({ status: 'error', message: 'Batch not found.' });
    if (['Completed', 'CompletedWithErrors'].includes(batches[0].status)) {
      return res.status(409).json({ status: 'error', message: 'This batch is already completed.' });
    }
    // #8: a Failed batch never accepts punches (they would never be processed).
    // The message is deliberately different from "already completed" so the
    // connector moves the file to failed/ instead of processed/.
    if (batches[0].status === 'Failed') {
      return res.status(409).json({
        status: 'error',
        message: 'This batch has failed and cannot accept punches. Export the device file again.',
      });
    }

    connection = await db.getConnection();

    let inserted = 0, duplicates = 0, recovered = 0;
    const errors = [];
    for (let i = 0; i < punches.length; i += 1) {
      const { value, error } = validatePunch(punches[i]);
      if (error) { errors.push({ index: i, reason: error }); continue; }

      let rawInserted = false;
      try {
        await connection.beginTransaction();

        const [punchResult] = await connection.execute(
          `INSERT INTO attendance_punches
             (batch_id, device_employee_id, punched_at, raw_punch_code, punch_type, raw_line, line_number, dedupe_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [batchId, value.deviceEmployeeId, value.punchedAt, value.rawPunchCode,
           value.punchType, value.rawLine, value.lineNumber, value.dedupeKey]);
        rawInserted = true;

        await connection.execute(
          `INSERT INTO attendance_punch_processing (punch_id, processing_status)
           VALUES (?, 'Pending')`,
          [punchResult.insertId]);

        await connection.commit();
        inserted += 1;
      } catch (e) {
        try { await connection.rollback(); } catch (_) {}
        // UNIQUE(dedupe_key) on the RAW insert is the real duplicate guard.
        if (e.code === 'ER_DUP_ENTRY' && !rawInserted) {
          duplicates += 1;
          if (await healDuplicatePunch(connection, value.dedupeKey, batchId)) recovered += 1;
        } else throw e;
      }
    }
        if (errors.length > 0) {
      await db.execute(
        'UPDATE attendance_import_batches SET error_rows = error_rows + ? WHERE id = ?',
        [errors.length, batchId]);
    }
    return res.status(200).json({ status: 'success', inserted, duplicates, recovered, errors: errors.length, errorDetails: errors.slice(0, 20) });
  } catch (error) {
    console.error('ADD PUNCHES ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to store punches.' });
  } finally {
    if (connection) connection.release();
  }
};

exports.completeBatch = async (req, res) => {
  const batchId = Number(req.params.batchId);
  const toInt = (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const totalRows = toInt(req.body?.totalRows);
  const validRows = toInt(req.body?.validRows);
  const errorRows = toInt(req.body?.errorRows);
  if (!Number.isInteger(batchId) || batchId <= 0 || totalRows === null || validRows === null || errorRows === null) {
    return res.status(400).json({ status: 'error', message: 'batchId, totalRows, validRows and errorRows are required.' });
  }
  const errorDetails = Array.isArray(req.body?.errors) ? req.body.errors.slice(0, 50) : [];

  // B9: check + update happen in ONE transaction on a locked row, and the
  // UPDATE is guarded by status = 'Pending' (no double completion).
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [found] = await connection.execute(
      'SELECT id, status, error_rows FROM attendance_import_batches WHERE id = ? FOR UPDATE', [batchId]);
    if (!found.length) {
      await connection.rollback();
      return res.status(404).json({ status: 'error', message: 'Batch not found.' });
    }
    const batch = found[0];

    // Idempotent: a completed batch is never recomputed.
    if (['Completed', 'CompletedWithErrors', 'Failed'].includes(batch.status)) {
      await connection.rollback();
      return res.status(200).json({ status: 'success', batchStatus: batch.status, alreadyCompleted: true });
    }

    const serverRejected = Number(batch.error_rows || 0);   // rejected by validatePunch during upload
    const [[cnt]] = await connection.execute(
      'SELECT COUNT(*) AS c FROM attendance_punches WHERE batch_id = ?', [batchId]);
    const inserted = Number(cnt.c);
    const duplicates = Math.max(0, validRows - serverRejected - inserted);
    const totalErrors = errorRows + serverRejected;
    const status = validRows === 0 ? 'Failed' : (totalErrors > 0 ? 'CompletedWithErrors' : 'Completed');

    const [updated] = await connection.execute(
      `UPDATE attendance_import_batches
       SET status = ?, total_rows = ?, inserted_rows = ?, duplicate_rows = ?, error_rows = ?,
           error_details = ?, imported_at = NOW()
       WHERE id = ? AND status = 'Pending'`,
      [status, totalRows, inserted, duplicates, totalErrors,
        JSON.stringify({ parse_errors: errorDetails, server_rejected: serverRejected }), batchId]);
    if (updated.affectedRows !== 1) {
      await connection.rollback();
      return res.status(200).json({ status: 'success', batchStatus: batch.status, alreadyCompleted: true });
    }

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('attendance_import_batches', ?, 'BIOMETRIC_IMPORT_COMPLETED', NULL, NULL, ?)`,
      [batchId, JSON.stringify({ status, totalRows, inserted, duplicates, totalErrors })]);

    await connection.commit();
    return res.status(200).json({ status: 'success', batchStatus: status, total: totalRows, inserted, duplicates, errors: totalErrors });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    console.error('COMPLETE IMPORT BATCH ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to complete import batch.' });
  } finally {
    connection.release();
  }
};

// GET /api/attendance/import-batches/:batchId
exports.getBatch = async (req, res) => {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid batch id.' });
  }
  try {
    const [rows] = await db.execute('SELECT * FROM attendance_import_batches WHERE id = ?', [batchId]);
    if (!rows.length) return res.status(404).json({ status: 'error', message: 'Batch not found.' });
    const b = rows[0];
    return res.status(200).json({
      status: 'success',
      data: { id: b.id, source_file: b.source_file, status: b.status, total: b.total_rows,
              inserted: b.inserted_rows, duplicates: b.duplicate_rows, errors: b.error_rows,
              imported_at: b.imported_at },
    });
  } catch (error) {
    console.error('GET IMPORT BATCH ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load batch.' });
  }
};

// C4: every punch with no covering active mapping on its own date is listed.
// (The old NOT EXISTS clause hid device IDs that had ANY open mapping, even
// when that mapping started after the punch.) Optional ?date=YYYY-MM-DD.
exports.getUnmappedDeviceIds = async (req, res) => {
  const date = req.query?.date;
  if (date !== undefined && date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return res.status(400).json({ status: 'error', message: 'date must be YYYY-MM-DD.' });
  }
  try {
    const params = [];
    let dateFilter = '';
    if (date) {
      dateFilter = ' AND p.punched_at >= ? AND p.punched_at < DATE_ADD(?, INTERVAL 1 DAY)';
      params.push(`${date} 00:00:00`, date);
    }
    const [rows] = await db.execute(
      `SELECT p.device_employee_id, COUNT(*) AS punches,
              MIN(p.punched_at) AS first_punch, MAX(p.punched_at) AS last_punch
       FROM attendance_punches p
       WHERE NOT EXISTS (
           SELECT 1 FROM attendance_device_users u
           WHERE u.device_employee_id = p.device_employee_id AND u.active = 1
             AND u.effective_from <= DATE(p.punched_at)
             AND (u.effective_to IS NULL OR DATE(p.punched_at) <= u.effective_to))${dateFilter}
       GROUP BY p.device_employee_id
       ORDER BY last_punch DESC`,
      params);
    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('GET UNMAPPED DEVICE IDS ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load unmapped device ids.' });
  }
};
