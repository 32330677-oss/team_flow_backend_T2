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
    return res.status(200).json({
      status: 'success', batchId: batch.id, batchStatus: batch.status,
      alreadyImported: ['Completed', 'CompletedWithErrors'].includes(batch.status),
    });
  } catch (error) {
    console.error('CREATE IMPORT BATCH ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to create import batch.' });
  }
};

// POST /api/attendance/punches
exports.addPunches = async (req, res) => {
  const batchId = Number(req.body?.batchId);
  const punches = req.body?.punches;
  if (!Number.isInteger(batchId) || batchId <= 0 || !Array.isArray(punches) ||
      punches.length === 0 || punches.length > MAX_PUNCHES_PER_REQUEST) {
    return res.status(400).json({ status: 'error', message: `batchId and 1-${MAX_PUNCHES_PER_REQUEST} punches are required.` });
  }
  try {
    const [batches] = await db.execute('SELECT id, status FROM attendance_import_batches WHERE id = ?', [batchId]);
    if (!batches.length) return res.status(404).json({ status: 'error', message: 'Batch not found.' });
    if (['Completed', 'CompletedWithErrors'].includes(batches[0].status)) {
      return res.status(409).json({ status: 'error', message: 'This batch is already completed.' });
    }

    let inserted = 0, duplicates = 0;
    const errors = [];
    for (let i = 0; i < punches.length; i += 1) {
      const { value, error } = validatePunch(punches[i]);
      if (error) { errors.push({ index: i, reason: error }); continue; }
      try {
        await db.execute(
          `INSERT INTO attendance_punches
             (batch_id, device_employee_id, punched_at, raw_punch_code, punch_type, raw_line, line_number, dedupe_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [batchId, value.deviceEmployeeId, value.punchedAt, value.rawPunchCode,
           value.punchType, value.rawLine, value.lineNumber, value.dedupeKey]);
        inserted += 1;
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') duplicates += 1; // UNIQUE(dedupe_key) is the real guard
        else throw e;
      }
    }
    return res.status(200).json({ status: 'success', inserted, duplicates, errors: errors.length, errorDetails: errors.slice(0, 20) });
  } catch (error) {
    console.error('ADD PUNCHES ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to store punches.' });
  }
};

// POST /api/attendance/import-batches/:batchId/complete
// body: { totalRows, validRows, errorRows, errors: [{lineNumber, reason, rawLine}] }
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

  try {
    const [[found]] = await db.execute('SELECT id FROM attendance_import_batches WHERE id = ?', [batchId]).then(([r]) => [r]);
    if (!found) return res.status(404).json({ status: 'error', message: 'Batch not found.' });

    const [[cnt]] = await db.execute('SELECT COUNT(*) AS c FROM attendance_punches WHERE batch_id = ?', [batchId]).then(([r]) => [r]);
    const inserted = Number(cnt.c);
    const duplicates = Math.max(0, validRows - inserted);
    const status = validRows === 0 ? 'Failed' : (errorRows > 0 ? 'CompletedWithErrors' : 'Completed');

    await db.execute(
      `UPDATE attendance_import_batches
       SET status = ?, total_rows = ?, inserted_rows = ?, duplicate_rows = ?, error_rows = ?,
           error_details = ?, imported_at = NOW()
       WHERE id = ?`,
      [status, totalRows, inserted, duplicates, errorRows, JSON.stringify(errorDetails), batchId]);

    await db.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('attendance_import_batches', ?, 'BIOMETRIC_IMPORT_COMPLETED', NULL, NULL, ?)`,
      [batchId, JSON.stringify({ status, totalRows, inserted, duplicates, errorRows })]);

    return res.status(200).json({ status: 'success', batchStatus: status, total: totalRows, inserted, duplicates, errors: errorRows });
  } catch (error) {
    console.error('COMPLETE IMPORT BATCH ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to complete import batch.' });
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

// GET /api/attendance/punches/unmapped   (Admin JWT) — device IDs with no mapping
exports.getUnmappedDeviceIds = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT p.device_employee_id, COUNT(*) AS punches,
              MIN(p.punched_at) AS first_punch, MAX(p.punched_at) AS last_punch
       FROM attendance_punches p
       LEFT JOIN attendance_device_users u
         ON u.device_employee_id = p.device_employee_id AND u.active = 1
        AND DATE(p.punched_at) >= u.effective_from
        AND (u.effective_to IS NULL OR DATE(p.punched_at) <= u.effective_to)
       WHERE u.id IS NULL
       GROUP BY p.device_employee_id
       ORDER BY last_punch DESC`);
    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('GET UNMAPPED DEVICE IDS ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load unmapped device ids.' });
  }
};