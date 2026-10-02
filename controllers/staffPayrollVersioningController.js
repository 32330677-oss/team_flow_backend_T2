// controllers/staffPayrollVersioningController.js
//
// Staff payroll finalization, correction (supersede) and void.
//
// D-03 (same policy as worker payroll):
//   Generated (not finalized) -> may be VOIDED with a reason (nothing deleted).
//   Finalized (not paid)      -> corrected only by SUPERSEDE: the replacement is
//                                generated and verified first, then the old
//                                batch becomes Superseded, in ONE transaction.
//                                If generation fails, the old batch is unchanged.
//   Paid                      -> never reopened / superseded (API-enforced).

const pool = require('../config/db');
const { generateStaffPayrollBatch } = require('./StaffPayrollController');

// PATCH /api/staff-payroll/batch/:batchId/finalize
async function finalizeBatch(req, res) {
  const batchId = Number(req.params.batchId);
  const userId = req.user?.user_id;
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid batch id.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT * FROM staff_payroll_batches WHERE staff_payroll_batch_id = ? FOR UPDATE',
      [batchId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ status: 'error', message: 'Payroll batch not found.' });
    }
    const batch = rows[0];
    if (batch.status === 'Superseded' || batch.status === 'Voided') {
      await connection.rollback();
      return res.status(409).json({ status: 'error', message: `A ${batch.status.toLowerCase()} batch cannot be finalized.` });
    }
    if (batch.is_finalized) {
      await connection.rollback();
      return res.status(409).json({ status: 'error', message: 'This batch is already finalized.' });
    }

    await connection.execute(
      `UPDATE staff_payroll_batches
       SET is_finalized = 1, finalized_by_user_id = ?, finalized_at = NOW()
       WHERE staff_payroll_batch_id = ?`,
      [userId, batchId]
    );
    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_payroll_batches', ?, 'FINALIZED', ?, ?, ?)`,
      [batchId, userId, JSON.stringify({ is_finalized: false }), JSON.stringify({ is_finalized: true })]
    );
    await connection.commit();
    return res.json({ status: 'success', message: 'Payroll batch finalized. Staff attendance in this period is now locked for normal editing. It can now be marked as paid.' });
  } catch (error) {
    await connection.rollback();
    console.error('finalizeBatch:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to finalize payroll batch.' });
  } finally {
    connection.release();
  }
}

// POST /api/staff-payroll/batch/:batchId/new-version   { reason, acknowledge_pending? }
// Atomic supersede: Validate -> generate replacement -> verify -> supersede -> commit.
async function createNewVersion(req, res) {
  const batchId = Number(req.params.batchId);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid batch id.' });
  }
  if (reason.length < 5) {
    return res.status(400).json({ status: 'error', message: 'A reason (at least 5 characters) is required to supersede a payroll batch.' });
  }
  try {
    const [[batch]] = await pool.execute('SELECT * FROM staff_payroll_batches WHERE staff_payroll_batch_id = ?', [batchId]);
    if (!batch) return res.status(404).json({ status: 'error', message: 'Payroll batch not found.' });
    if (batch.status === 'Paid') {
      return res.status(409).json({ status: 'error', message: 'A Paid batch cannot be superseded. Record the difference through the correction/adjustment workflow.' });
    }
    if (batch.status !== 'Generated') {
      return res.status(409).json({ status: 'error', message: `Only the active batch of a period can be superseded (this one is ${batch.status}).` });
    }
    req.body = {
      start_date: String(batch.start_date).slice(0, 10),
      end_date: String(batch.end_date).slice(0, 10),
      acknowledge_pending: req.body?.acknowledge_pending === true,
    };
    req._supersede = { batchId, reason: reason.slice(0, 500) };
    return generateStaffPayrollBatch(req, res);
  } catch (error) {
    console.error('createNewVersion:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to supersede payroll batch.' });
  }
}

// PATCH /api/staff-payroll/batch/:batchId/void   { reason }
async function voidBatch(req, res) {
  const batchId = Number(req.params.batchId);
  const reason = String(req.body?.reason || '').trim();
  const userId = req.user?.user_id;
  if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ status: 'error', message: 'Invalid batch id.' });
  if (reason.length < 5) return res.status(400).json({ status: 'error', message: 'A reason (at least 5 characters) is required to void a batch.' });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[batch]] = await connection.execute('SELECT * FROM staff_payroll_batches WHERE staff_payroll_batch_id = ? FOR UPDATE', [batchId]);
    if (!batch) { await connection.rollback(); return res.status(404).json({ status: 'error', message: 'Payroll batch not found.' }); }
    if (batch.status !== 'Generated' || batch.is_finalized) {
      await connection.rollback();
      return res.status(409).json({ status: 'error', message: batch.is_finalized
        ? 'A finalized batch cannot be voided. Use Supersede (with a reason) to correct it.'
        : `Only a Generated batch can be voided (this one is ${batch.status}).` });
    }
    await connection.execute(
      `UPDATE staff_payroll_batches SET status = 'Voided', voided_by_user_id = ?, voided_at = NOW(), void_reason = ?
       WHERE staff_payroll_batch_id = ? AND status = 'Generated' AND is_finalized = 0`,
      [userId, reason.slice(0, 500), batchId]
    );
    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_payroll_batches', ?, 'VOIDED', ?, ?, ?)`,
      [batchId, userId, JSON.stringify({ status: batch.status }), JSON.stringify({ status: 'Voided', reason })]
    );
    await connection.commit();
    return res.json({ status: 'success', message: `Batch #${batchId} voided. It stays in the history; its period can be generated again.` });
  } catch (error) {
    await connection.rollback();
    console.error('voidBatch:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to void the batch.' });
  } finally {
    connection.release();
  }
}

// GET /api/staff-payroll/batch/:batchId/versions
async function getVersionChain(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid batch id.' });
  }
  try {
    const [anchorRows] = await pool.execute(
      'SELECT * FROM staff_payroll_batches WHERE staff_payroll_batch_id = ?',
      [batchId]
    );
    if (!anchorRows.length) {
      return res.status(404).json({ status: 'error', message: 'Payroll batch not found.' });
    }
    const [allForPeriod] = await pool.execute(
      `SELECT spb.*, u.full_name AS generated_by
       FROM staff_payroll_batches spb
       JOIN users u ON u.user_id = spb.generated_by_user_id
       WHERE spb.start_date = ? AND spb.end_date = ?
       ORDER BY spb.version_number ASC`,
      [anchorRows[0].start_date, anchorRows[0].end_date]
    );
    return res.json({ status: 'success', data: allForPeriod });
  } catch (error) {
    console.error('getVersionChain:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load version history.' });
  }
}

module.exports = { finalizeBatch, createNewVersion, voidBatch, getVersionChain };
