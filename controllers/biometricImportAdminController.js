const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const multer = require('multer');
const db = require('../config/db');

const ALLOWED_EXT = new Set(['.txt', '.csv', '.dat']);
const MAX_BYTES = 5 * 1024 * 1024;
const RUN_TIMEOUT_MS = 120000;
let running = false; // single backend process; Connector is also checksum-idempotent

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
}).single('file');

exports.uploadMiddleware = (req, res, next) =>
  upload(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        status: 'error',
        message: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 5 MB.' : 'Invalid upload.',
      });
    }
    next();
  });

// Reads the Connector's own config.json so folder paths have a single source of truth.
function connectorPaths() {
  const dir = process.env.BIOMETRIC_CONNECTOR_DIR;
  if (!dir) return null;
  try {
    const root = path.resolve(dir);
    const mainJs = path.join(root, 'src', 'main.js');
    const cfgPath = path.join(root, 'config', 'config.json');
    if (!fs.existsSync(mainJs) || !fs.existsSync(cfgPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const abs = (p) => path.resolve(root, p);
    return {
      root,
      mainJs,
      incoming: abs(cfg.folders.incoming),
      failed: abs(cfg.folders.failed),
      pattern: new RegExp(cfg.filePattern || '\\.(txt|csv|dat)$', 'i'),
    };
  } catch (_) {
    return null;
  }
}

function countFiles(dir, filter) {
  try {
    return fs.readdirSync(dir).filter(filter).length;
  } catch (_) {
    return 0;
  }
}

function notConfigured(res) {
  return res.status(501).json({
    status: 'error',
    message:
      'Connector is not reachable from this backend. Set BIOMETRIC_CONNECTOR_DIR to the Connector folder on the same machine.',
  });
}

function runConnector(p) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [p.mainJs],
      {
        cwd: p.root,
        timeout: RUN_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          ASIK_API_URL:
            process.env.BIOMETRIC_CONNECTOR_API_URL ||
            `http://127.0.0.1:${process.env.PORT || 5000}`,
          ASIK_CONNECTOR_TOKEN: process.env.ATTENDANCE_CONNECTOR_TOKEN || '',
        },
      },
      (err, stdout, stderr) => {
        const lines = (String(stdout || '') + String(stderr || '')).split(/\r?\n/).filter(Boolean);
        resolve({
          exit_code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          timed_out: Boolean(err && err.killed),
          output: lines.slice(-30),
        });
      }
    );
  });
}

async function audit(userId, action, payload) {
  try {
    await db.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('attendance_import_batches', 0, ?, ?, NULL, ?)`,
      [action, userId, JSON.stringify(payload)]
    );
  } catch (e) {
    console.error('BIOMETRIC IMPORT AUDIT ERROR:', e.message);
  }
}

// POST /api/biometric/import-file  (multipart field "file")
exports.uploadAndRun = async (req, res) => {
  const p = connectorPaths();
  if (!p) return notConfigured(res);
  if (running) return res.status(409).json({ status: 'error', message: 'An import is already running.' });

  const file = req.file;
  if (!file || !file.buffer || file.buffer.length === 0) {
    return res.status(400).json({ status: 'error', message: 'A non-empty file is required.' });
  }
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return res.status(400).json({ status: 'error', message: 'Only .txt, .csv or .dat files are allowed.' });
  }
  if (file.buffer.includes(0)) {
    return res.status(400).json({ status: 'error', message: 'File does not look like a text export.' });
  }

  running = true;
  try {
    const base = path.basename(file.originalname, ext).replace(/[^\w-]/g, '_').slice(0, 40) || 'file';
    const savedAs = `asik_${Date.now()}_${base}${ext}`;
    fs.mkdirSync(p.incoming, { recursive: true });
    fs.writeFileSync(path.join(p.incoming, savedAs), file.buffer, { flag: 'wx' });

    await audit(req.user.user_id, 'BIOMETRIC_FILE_UPLOADED', { saved_as: savedAs, bytes: file.buffer.length });
    const result = await runConnector(p);
    return res.status(200).json({ status: 'success', data: { saved_as: savedAs, ...result } });
  } catch (error) {
    console.error('BIOMETRIC UPLOAD/RUN ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to save the file or run the Connector.' });
  } finally {
    running = false;
  }
};

// POST /api/biometric/import-run  (process whatever is already in incoming)
exports.runOnly = async (req, res) => {
  const p = connectorPaths();
  if (!p) return notConfigured(res);
  if (running) return res.status(409).json({ status: 'error', message: 'An import is already running.' });
  running = true;
  try {
    await audit(req.user.user_id, 'BIOMETRIC_CONNECTOR_RUN', {});
    const result = await runConnector(p);
    return res.status(200).json({ status: 'success', data: result });
  } catch (error) {
    console.error('BIOMETRIC RUN ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to run the Connector.' });
  } finally {
    running = false;
  }
};

// GET /api/biometric/import-batches?limit=30
exports.listBatches = async (req, res) => {
  const requested = Number(req.query.limit);
  const limit = Number.isInteger(requested) && requested >= 1 && requested <= 100 ? requested : 30;
  try {
    const [rows] = await db.query(
      `SELECT id, source_file, status, total_rows, inserted_rows, duplicate_rows, error_rows,
              imported_at, created_at
       FROM attendance_import_batches
       ORDER BY id DESC
       LIMIT ${limit}`
    );
    const p = connectorPaths();
    const connector = p
      ? {
          enabled: true,
          running,
          incoming_files: countFiles(p.incoming, (f) => p.pattern.test(f)),
          failed_files: countFiles(p.failed, (f) => p.pattern.test(f)),
        }
      : { enabled: false, running: false, incoming_files: 0, failed_files: 0 };
    return res.status(200).json({ status: 'success', data: rows, connector });
  } catch (error) {
    console.error('LIST IMPORT BATCHES ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load import batches.' });
  }
};

// GET /api/biometric/import-batches/:batchId
exports.getBatchDetail = async (req, res) => {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid batch id.' });
  }
  try {
    const [rows] = await db.execute('SELECT * FROM attendance_import_batches WHERE id = ?', [batchId]);
    if (!rows.length) return res.status(404).json({ status: 'error', message: 'Batch not found.' });
    const b = rows[0];

    const [proc] = await db.execute(
      `SELECT pr.processing_status, COUNT(*) AS cnt
       FROM attendance_punches p
       JOIN attendance_punch_processing pr ON pr.punch_id = p.id
       WHERE p.batch_id = ?
       GROUP BY pr.processing_status`,
      [batchId]
    );
    const processing = { Pending: 0, Processed: 0, Skipped: 0, Failed: 0 };
    proc.forEach((r) => { processing[r.processing_status] = Number(r.cnt); });

    let errors = b.error_details;
    if (typeof errors === 'string') {
      try { errors = JSON.parse(errors); } catch (_) { errors = []; }
    }
if (
  errors &&
  !Array.isArray(errors) &&
  Array.isArray(errors.parse_errors)
) {
  errors = errors.parse_errors;
}
    return res.status(200).json({
      status: 'success',
      data: {
        batch: {
          id: b.id, source_file: b.source_file, status: b.status,
          total_rows: b.total_rows, inserted_rows: b.inserted_rows,
          duplicate_rows: b.duplicate_rows, error_rows: b.error_rows,
          imported_at: b.imported_at, created_at: b.created_at,
        },
        processing,
        errors: Array.isArray(errors) ? errors : [],
      },
    });
  } catch (error) {
    console.error('GET IMPORT BATCH DETAIL ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load batch.' });
  }
};