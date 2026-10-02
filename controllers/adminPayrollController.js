const pool = require('../config/db');
const settingsCache = require('../services/settingsCache');
const { activeOn } = require('../services/assignmentDates');
const { businessToday } = require('../services/businessDate');

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}
function isSpecificSite(value) {
  return value !== undefined && value !== null && !['', 'null', '0', 'All'].includes(String(value));
}
function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

const DEFAULT_STANDARD_MINUTES = 600; // fallback: 10 hours, matches system default

// ============================================================
// UNIFIED OVERTIME POLICY
// Overtime is paid at a single company-wide rate for EVERY worker,
// regardless of pay type (Daily or Hourly) and regardless of that worker's
// own overtime_hourly_rate in workercompensationhistory. That per-worker
// rate is still kept for historical/reporting reasons only.
//
// D-14: the rate is DB-backed and effective-dated (system_settings /
// system_settings_history key overtime_flat_rate_syp, edited by an Admin in
// Attendance Settings). There is NO hard-coded fallback any more: generating
// payroll with overtime for a date that has no configured rate is refused.
// The rate used is snapshotted in payrollitems.overtime_hourly_rate_snapshot,
// so finalized/paid payroll never changes when the setting changes.
//
// Attendance already computes overtime_hours correctly for both pay types
// (see services/attendanceService.js -> calculateWorkingHours): if a Lunch
// leave record was NOT created for a shift (worker worked through lunch),
// that hour is never subtracted from total_working_hours, so it naturally
// pushes the worker past standard_minutes_snapshot and becomes overtime.
// That logic is unchanged and correct — the gap was purely in how payroll
// generation used to IGNORE overtime_hours entirely for Daily workers.
// ============================================================
const PAYROLL_LOCKING_STATUSES = "('Generated','Paid')"; // statuses that count as an active batch

// ============================================================
// generatePayrollBatch
//
// Versioning behavior:
// - "Period identity" = (start_date, end_date, scope_site_id) where
//   scope_site_id is the site_id passed by the admin, or NULL for "all sites".
// - If an active (non-Superseded) batch already exists for that exact
//   period identity:
//     - if it is_finalized  -> reject (period is locked, needs no override
//       here; a finalized period can only be corrected by an explicit
//       management action outside normal generation).
//     - otherwise           -> it gets marked 'Superseded' and the new
//       batch is inserted as version_number + 1, linked via
//       supersedes_batch_id.
// - A brand-new period gets version_number = 1.
// ============================================================
async function generatePayrollBatch(req, res) {
  const { start_date, end_date, site_id } = req.body || {};
  const userId = req.user?.user_id;
  // D-03: set only by supersedeFinalizedBatch (atomic replacement of a
  // Finalized, unpaid batch). Never accepted from the request body.
  const supersede = req._supersede || null;
  const acknowledgePending = req.body?.acknowledge_pending === true;

  if (!userId) return res.status(401).json({ success: false, message: 'Admin identification not found.' });
  if (!isValidDate(start_date) || !isValidDate(end_date)) {
    return res.status(400).json({ success: false, message: 'Dates must use YYYY-MM-DD.' });
  }
  if (end_date < start_date) {
    return res.status(400).json({ success: false, message: 'End date must be after or equal to start date.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const scopedSite = isSpecificSite(site_id);
    const scopeSiteId = scopedSite ? Number(site_id) : null;

    const [overlapping] = await connection.execute(
      `SELECT payroll_batch_id, start_date, end_date, scope_site_id
       FROM payrollbatches
       WHERE status IN ${PAYROLL_LOCKING_STATUSES}
         AND start_date <= ? AND end_date >= ?
         AND NOT (start_date = ? AND end_date = ? AND scope_site_id <=> ?)
         AND (scope_site_id <=> ? OR scope_site_id IS NULL OR ? IS NULL)
       LIMIT 1
       FOR UPDATE`,
      [end_date, start_date, start_date, end_date, scopeSiteId, scopeSiteId, scopeSiteId]
    );
    if (overlapping.length) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: `This period overlaps existing payroll batch #${overlapping[0].payroll_batch_id}. Adjust the dates or supersede/finalize the existing batch first.`
      });
    }

    // --- find any active batch(es) for this exact period + scope ---
    const [existingBatches] = await connection.execute(
      `SELECT payroll_batch_id, version_number, is_finalized, status
       FROM payrollbatches
       WHERE start_date = ? AND end_date = ?
         AND status IN ${PAYROLL_LOCKING_STATUSES}
         AND scope_site_id <=> ?
       ORDER BY version_number DESC
       FOR UPDATE`,
      [start_date, end_date, scopeSiteId]
    );
    // Version numbers continue across Voided/Superseded batches of the period.
    const [[maxVersionRow]] = await connection.execute(
      `SELECT MAX(version_number) AS max_version FROM payrollbatches
       WHERE start_date = ? AND end_date = ? AND scope_site_id <=> ?`,
      [start_date, end_date, scopeSiteId]
    );

    if (existingBatches.length) {
      const paid = existingBatches.find((b) => b.status === 'Paid');
      if (paid) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          message: `This period is already Paid (Batch #${paid.payroll_batch_id}). A paid batch cannot be regenerated or superseded; record differences through the correction/adjustment workflow.`
        });
      }
      const finalizedBlocking = existingBatches.find((b) => b.is_finalized && (!supersede || b.payroll_batch_id !== supersede.batchId));
      if (finalizedBlocking) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          code: 'BATCH_FINALIZED',
          message: `This period is finalized (Batch #${finalizedBlocking.payroll_batch_id}). Use "Supersede (correct) finalized batch" with a reason to replace it.`
        });
      }
    }
    if (supersede && !existingBatches.some((b) => b.payroll_batch_id === supersede.batchId)) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'The batch to supersede is no longer the active batch of this period.' });
    }

    // C-03: unresolved attendance (Draft / Submitted / Rejected) in the period
    // is reported before generating, exactly like staff payroll.
    {
      const pendParams = [start_date, end_date];
      let pendSql = `SELECT a.attendance_id, a.worker_id, w.full_name, a.site_id, s.site_name, a.shift_type,
                            DATE_FORMAT(a.record_date, '%Y-%m-%d') AS record_date, a.status
                     FROM attendance a JOIN workers w ON w.worker_id = a.worker_id JOIN sites s ON s.site_id = a.site_id
                     WHERE a.record_date BETWEEN ? AND ? AND a.status IN ('Draft','Submitted','Rejected')`;
      if (scopedSite) { pendSql += ' AND a.site_id = ?'; pendParams.push(site_id); }
      pendSql += ' ORDER BY a.record_date, w.full_name LIMIT 500';
      const [pendingRows] = await connection.execute(pendSql, pendParams);
      if (pendingRows.length > 0 && !acknowledgePending) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          code: 'PENDING_ATTENDANCE',
          message: `${pendingRows.length} attendance record(s) in this period are not approved (Draft/Submitted/Rejected). ` +
            'They will NOT be paid in this batch. Approve them first, or confirm to generate without them.',
          pending_attendance: pendingRows,
        });
      }
    }

    const attParams = [start_date, end_date];
let attSql = `
  SELECT a.attendance_id, a.worker_id, w.full_name AS worker_name, w.payment_type,
         a.record_date, a.site_id, a.shift_type, a.total_working_hours, a.overtime_hours,
         a.attendance_status, a.standard_minutes_snapshot,
         w.standard_daily_minutes AS worker_custom_minutes,
         (
           SELECT wsa2.contract_id
           FROM workersiteassignments wsa2
           WHERE wsa2.worker_id = a.worker_id
             AND wsa2.site_id = a.site_id
             AND wsa2.shift_type = a.shift_type
             AND ${activeOn('wsa2', 'a.record_date')}
           ORDER BY wsa2.assigned_date DESC, wsa2.assignment_id DESC
           LIMIT 1
         ) AS contract_id
  FROM attendance a
  JOIN workers w ON w.worker_id = a.worker_id
  WHERE a.record_date BETWEEN ? AND ?
    AND a.status = 'Approved'`;

    if (scopedSite) { attSql += ' AND a.site_id = ?'; attParams.push(site_id); }
    attSql += ' ORDER BY w.full_name, a.record_date';

    const [attendanceRows] = await connection.execute(attSql, attParams);

    if (!attendanceRows.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'No Approved attendance found for this period.' });
    }

    const missingAssignment = attendanceRows.filter((r) => r.contract_id === null || r.contract_id === undefined);
    if (missingAssignment.length) {
      await connection.rollback();
      const sample = missingAssignment.slice(0, 5).map(
        (r) => `worker_id=${r.worker_id} site_id=${r.site_id} date=${r.record_date}`
      ).join('; ');
      return res.status(422).json({
        success: false,
        message: `Found ${missingAssignment.length} approved attendance record(s) with no matching site assignment. ` +
          `Payroll cannot be generated until this is fixed (e.g. missing/backdated workersiteassignments row). Examples: ${sample}`
      });
    }

    const workerIds = [...new Set(attendanceRows.map(r => r.worker_id))];
    const [compRows] = await connection.query(
      `SELECT worker_id, payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate,
              effective_from, effective_to
       FROM workercompensationhistory
       WHERE worker_id IN (?)
       ORDER BY worker_id, effective_from`,
      [workerIds]
    );
    const compByWorker = new Map();
    for (const row of compRows) {
      if (!compByWorker.has(row.worker_id)) compByWorker.set(row.worker_id, []);
      compByWorker.get(row.worker_id).push(row);
    }

    function findRateForDate(workerId, dateStr) {
      const periods = compByWorker.get(workerId) || [];
      return periods.find(p =>
        p.effective_from <= dateStr && (p.effective_to === null || p.effective_to >= dateStr)
      ) || null;
    }

    // D3 / #13: the fallback standard minutes and the overtime flat rate are the
    // values that applied on each record's own date (system_settings_history),
    // falling back to the current value / constant when no dated value exists.
    const fallbackStandardMinutesFor = async (dateStr) =>
      Number(await settingsCache.getSettingForDate('standard_work_minutes', dateStr, String(DEFAULT_STANDARD_MINUTES))) ||
      DEFAULT_STANDARD_MINUTES;
    // D-14: no hard-coded fallback. null = not configured for that date.
    const overtimeRateFor = async (dateStr) => {
      const raw = await settingsCache.getSettingForDate('overtime_flat_rate_syp', dateStr, null);
      const v = Number(raw);
      return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(v) && v > 0 ? v : null;
    };
    const missingOtRate = [];

    const groups = new Map();
    const byWorker = new Map();

    for (const rec of attendanceRows) {
      const comp = findRateForDate(rec.worker_id, String(rec.record_date));
      if (!comp) {
        await connection.rollback();
        return res.status(422).json({
          success: false,
          message: `No compensation record found for worker_id=${rec.worker_id} on ${rec.record_date}. Cannot generate payroll.`
        });
      }

      // Grouping key intentionally excludes overtime_hourly_rate: overtime is
      // always paid at the flat company rate regardless of that field. The flat
      // rate itself is dated (D3), so it is part of the key.
      const recordDateStr = String(rec.record_date).slice(0, 10);
      const otRate = await overtimeRateFor(recordDateStr);
      const groupKey = comp.payment_type === 'Daily'
        ? `${rec.worker_id}|${rec.site_id}|Daily|${comp.daily_rate}|OT${otRate}`
        : `${rec.worker_id}|${rec.site_id}|Hourly|${comp.regular_hourly_rate}|OT${otRate}`;

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          worker_id: rec.worker_id,
          site_id: rec.site_id,
          contract_id: rec.contract_id,
          pay_type: comp.payment_type,
          daily_rate: comp.daily_rate,
          regular_hourly_rate: comp.regular_hourly_rate,
          overtime_rate: otRate,
          days_worked: 0,     // PAID day-equivalents (fractional, e.g. 0.5)
          regular_hours: 0,
          overtime_hours: 0,  // now tracked for BOTH pay types
          attendance: [],     // C-07: rows snapshotted with the batch
        });
      }
      const g = groups.get(groupKey);
      if (Number(rec.overtime_hours || 0) > 0 && otRate === null) {
        missingOtRate.push(recordDateStr);
      }
      let snapshotFraction = null;

      if (comp.payment_type === 'Daily') {
        let dayFraction;
        const workedHours = Number(rec.total_working_hours || 0);
        const nonWorkingStatus = ['Absent', 'Sick', 'Vacation', 'Holiday'].includes(rec.attendance_status);
        const hasManagementHours = workedHours > 0 && nonWorkingStatus;
        if (nonWorkingStatus && !hasManagementHours) {
          dayFraction = 0;
        } else {
          // D3 (final decision): explicit settings history -> the record's
          // snapshot -> legacy/current value. The global setting history only
          // applies to workers without their own standard_daily_minutes; for
          // those, the snapshot is the only historical record of their value.
          const hasCustomMinutes = Number(rec.worker_custom_minutes) > 0;
          const explicitMinutes = hasCustomMinutes ? null
            : Number(await settingsCache.getExplicitSettingForDate('standard_work_minutes', recordDateStr));
          const standardMinutes = explicitMinutes > 0
            ? explicitMinutes
            : Number(rec.standard_minutes_snapshot) > 0
              ? Number(rec.standard_minutes_snapshot)
              : await fallbackStandardMinutesFor(recordDateStr);

          const standardHours = standardMinutes / 60;

          dayFraction = standardHours > 0
            ? Math.min(1, workedHours / standardHours)
            : 0;
        }

        g.days_worked += dayFraction;
        snapshotFraction = dayFraction;
        // Daily workers ARE eligible for overtime now: attendance already
        // computes overtime_hours whenever worked hours exceed the standard
        // (e.g. worked through lunch -> 11h shift with a 10h standard -> 1h OT).
        g.overtime_hours += Number(rec.overtime_hours || 0);
      } else {
        g.regular_hours += Number(rec.total_working_hours || 0);
        g.overtime_hours += Number(rec.overtime_hours || 0);
      }
      g.attendance.push({
        attendance_id: rec.attendance_id, worker_id: rec.worker_id, site_id: rec.site_id, shift_type: rec.shift_type,
        record_date: recordDateStr, attendance_status: rec.attendance_status,
        regular_hours: Number(rec.total_working_hours || 0), overtime_hours: Number(rec.overtime_hours || 0),
        day_fraction: snapshotFraction,
      });

      if (!byWorker.has(rec.worker_id)) {
        byWorker.set(rec.worker_id, { worker_id: rec.worker_id, breakdown: [], gross: 0 });
      }
    }

    if (missingOtRate.length) {
      await connection.rollback();
      const dates = [...new Set(missingOtRate)].sort();
      return res.status(422).json({
        success: false,
        code: 'OVERTIME_RATE_NOT_CONFIGURED',
        message: `No overtime rate is configured for ${dates.slice(0, 5).join(', ')}${dates.length > 5 ? ' ...' : ''}. ` +
          'Set the worker overtime rate (Attendance Settings) with an effective date covering these dates, then generate again.',
        dates,
      });
    }

    for (const g of groups.values()) {
      let baseSalary = 0;

      if (g.pay_type === 'Daily') {
        if (!Number.isFinite(Number(g.daily_rate)) || Number(g.daily_rate) <= 0) {
          throw new Error(`Invalid daily_rate for worker ${g.worker_id}`);
        }
        baseSalary = money(g.days_worked * Number(g.daily_rate));
      } else {
        const regularRate = Number(g.regular_hourly_rate);
        if (!Number.isFinite(regularRate) || regularRate <= 0) {
          throw new Error(`Invalid regular hourly rate for worker ${g.worker_id}`);
        }
        baseSalary = money(g.regular_hours * regularRate);
      }

      // Unified flat-rate overtime for everyone, Daily or Hourly.
      const overtimePay = g.overtime_hours > 0 ? money(g.overtime_hours * g.overtime_rate) : 0;

      if (baseSalary === 0 && overtimePay === 0) continue;

      const worker = byWorker.get(g.worker_id);
      worker.breakdown.push({
        siteId: g.site_id,
        contractId: g.contract_id,
        payType: g.pay_type,
        dailyRate: g.daily_rate,
        hourlyRate: g.regular_hourly_rate,
        daysWorked: Number(g.days_worked.toFixed(2)),
        regularHours: g.regular_hours,
        overtimeHours: g.overtime_hours,
        overtimeRate: g.overtime_rate,
        baseSalary,
        overtimePay,
        attendance: g.attendance,
      });
      worker.gross = money(worker.gross + baseSalary + overtimePay);
    }

    for (const [workerId, worker] of [...byWorker.entries()]) {
      if (worker.breakdown.length === 0) byWorker.delete(workerId);
    }
    if (!byWorker.size) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'No payable attendance found for this period.' });
    }

    // --- everything validated and computed: now supersede the old batch(es)
    //     for this exact period+scope and insert the new version ---
    // D-03 / D-10: Validate (done above) -> Generate replacement -> verify ->
    // supersede the old batch -> commit. Everything is ONE transaction: if any
    // step fails, the old batch stays exactly as it was.
    let supersedesId = null;
    const nextVersion = Number(maxVersionRow?.max_version || 0) + 1;
    if (existingBatches.length) supersedesId = existingBatches[0].payroll_batch_id; // ORDER BY version_number DESC
    const currency = String(await settingsCache.getSetting('worker_payroll_currency', 'SYP') || 'SYP').toUpperCase();

    const [batchResult] = await connection.execute(
      `INSERT INTO payrollbatches
         (start_date, end_date, generated_by_user_id, status, scope_site_id, version_number, supersedes_batch_id,
          currency, supersede_reason)
       VALUES (?, ?, ?, 'Generated', ?, ?, ?, ?, ?)`,
      [start_date, end_date, userId, scopeSiteId, nextVersion, supersedesId, currency, supersede ? supersede.reason : null]
    );
    const batchId = batchResult.insertId;
    let totalWorkers = 0;
    let totalAmount = 0;

    for (const worker of byWorker.values()) {
      const [payrollResult] = await connection.execute(
        `INSERT INTO payroll
          (payroll_batch_id, worker_id, start_date, end_date,
           bonus_amount, penalty_amount, deductions_amount,
           gross_salary, net_salary, status, generated_by_user_id)
         VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, 'Generated', ?)`,
        [batchId, worker.worker_id, start_date, end_date, worker.gross, worker.gross, userId]
      );
      const payrollId = payrollResult.insertId;

      for (const item of worker.breakdown) {
        const isDaily = item.payType === 'Daily';
        const [itemResult] = await connection.execute(
          `INSERT INTO payrollitems
            (payroll_id, contract_id, site_id, pay_type, hourly_rate_snapshot,
             overtime_hourly_rate_snapshot, daily_rate_snapshot, days_worked,
             regular_hours_worked, overtime_hours_worked, base_salary, overtime_pay)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            payrollId,
            item.contractId,
            item.siteId,
            item.payType,
            !isDaily ? item.hourlyRate : null,
            item.overtimeHours > 0 ? item.overtimeRate : null,
            isDaily ? item.dailyRate : null,
            isDaily ? item.daysWorked : null,
            !isDaily ? item.regularHours : null,
            item.overtimeHours, // now stored for Daily rows too
            item.baseSalary,
            item.overtimePay
          ]
        );
        // C-07: exact attendance rows / hours used by this item.
        for (const att of item.attendance) {
          await connection.execute(
            `INSERT INTO payroll_attendance_snapshot
               (payroll_batch_id, payroll_item_id, attendance_id, worker_id, site_id, shift_type, record_date,
                attendance_status, regular_hours, overtime_hours, day_fraction)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [batchId, itemResult.insertId, att.attendance_id, att.worker_id, att.site_id, att.shift_type, att.record_date,
              att.attendance_status, att.regular_hours.toFixed(2), att.overtime_hours.toFixed(2),
              att.day_fraction === null ? null : Number(att.day_fraction).toFixed(4)]
          );
        }
      }
      totalWorkers += 1;
      totalAmount = money(totalAmount + worker.gross);
    }

    await connection.execute(
      `UPDATE payrollbatches SET total_workers = ?, total_amount = ? WHERE payroll_batch_id = ?`,
      [totalWorkers, totalAmount, batchId]
    );

    // Verify the replacement before superseding anything.
    const [[verify]] = await connection.execute(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(net_salary), 0) AS total FROM payroll WHERE payroll_batch_id = ?`, [batchId]);
    if (Number(verify.cnt) !== totalWorkers || Math.abs(Number(verify.total) - totalAmount) > 0.01) {
      throw new Error('Replacement batch verification failed; nothing was changed.');
    }
    for (const old of existingBatches) {
      await connection.execute(
        `UPDATE payrollbatches SET status = 'Superseded' WHERE payroll_batch_id = ? AND status IN ${PAYROLL_LOCKING_STATUSES}`,
        [old.payroll_batch_id]
      );
      await connection.execute(
        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
         VALUES ('payrollbatches', ?, 'SUPERSEDED', ?, ?, ?)`,
        [old.payroll_batch_id, userId, JSON.stringify({ status: old.status, is_finalized: old.is_finalized }),
          JSON.stringify({ status: 'Superseded', replaced_by_batch_id: batchId, reason: supersede ? supersede.reason : 'Regenerated (not finalized)' })]
      );
    }
    await connection.commit();

    return res.status(201).json({
      success: true,
      message: supersedesId
        ? `Payroll generated successfully (version ${nextVersion}). Previous version (Batch #${supersedesId}) has been superseded.`
        : 'Payroll generated successfully.',
      currency,
      batch_id: batchId,
      version_number: nextVersion,
      supersedes_batch_id: supersedesId
    });
  } catch (error) {
    await connection.rollback();
    console.error('generatePayrollBatch:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate payroll. No batch was changed.' });
  } finally {
    connection.release();
  }
}

// ============================================================
// PATCH /api/admin/payroll/batch/:batchId/finalize
// Must be called from a UI button with a double-confirmation, exactly like
// the existing _confirmMarkPaid pattern on the frontend. Once finalized, the
// period is locked: generatePayrollBatch will refuse to touch it again.
// ============================================================
async function finalizePayrollBatch(req, res) {
  const batchId = Number(req.params.batchId);
  const userId = req.user?.user_id;
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM payrollbatches WHERE payroll_batch_id = ? FOR UPDATE',
      [batchId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Payroll batch not found.' });
    }
    const batch = rows[0];
    if (batch.status === 'Superseded' || batch.status === 'Voided') {
      await connection.rollback();
      return res.status(409).json({ success: false, message: `A ${batch.status.toLowerCase()} batch cannot be finalized.` });
    }
    if (batch.is_finalized) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'This batch is already finalized.' });
    }

    await connection.execute(
      `UPDATE payrollbatches
       SET is_finalized = 1, finalized_by_user_id = ?, finalized_at = NOW()
       WHERE payroll_batch_id = ?`,
      [userId, batchId]
    );

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('payrollbatches', ?, 'FINALIZED', ?, ?, ?)`,
      [batchId, userId, JSON.stringify({ is_finalized: false }), JSON.stringify({ is_finalized: true })]
    );

    await connection.commit();
    return res.json({
      success: true,
      message: 'Payroll batch finalized. Attendance in this period is now locked for normal editing. ' +
        'The batch can be marked as paid, or replaced only through "Supersede" with a reason.'
    });
  } catch (error) {
    await connection.rollback();
    console.error('finalizePayrollBatch:', error);
    return res.status(500).json({ success: false, message: 'Failed to finalize payroll batch.' });
  } finally {
    connection.release();
  }
}

// ============================================================
// GET /api/admin/payroll/batch/:batchId/versions
// Returns every version generated for the same (start_date, end_date, scope)
// so the UI can show "Version 1 (superseded) -> Version 2 (current)".
// ============================================================
async function getPayrollVersionChain(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  }
  try {
    const [anchorRows] = await pool.execute(
      'SELECT * FROM payrollbatches WHERE payroll_batch_id = ?',
      [batchId]
    );
    if (!anchorRows.length) {
      return res.status(404).json({ success: false, message: 'Payroll batch not found.' });
    }
    const anchor = anchorRows[0];

    const [all] = await pool.execute(
      `SELECT pb.*, u.full_name AS generated_by, fu.full_name AS finalized_by
       FROM payrollbatches pb
       JOIN users u ON u.user_id = pb.generated_by_user_id
       LEFT JOIN users fu ON fu.user_id = pb.finalized_by_user_id
       WHERE pb.start_date = ? AND pb.end_date = ? AND pb.scope_site_id <=> ?
       ORDER BY pb.version_number ASC`,
      [anchor.start_date, anchor.end_date, anchor.scope_site_id]
    );

    return res.json({ success: true, data: all });
  } catch (error) {
    console.error('getPayrollVersionChain:', error);
    return res.status(500).json({ success: false, message: 'Failed to load version history.' });
  }
}

async function getPayrollReport(req, res) {
  try {
    const { site_id } = req.query;
    const scoped = isSpecificSite(site_id);
    const params = [];
    let sql;
    // C-08: ?include_history=1 also lists Superseded and Voided versions.
    const statusFilter = req.query.include_history === '1' ? '1 = 1' : "pb.status IN ('Generated','Paid')";

    // Superseded versions are hidden from the main list — use
    // GET /batch/:batchId/versions to inspect the full history of a period.
    if (scoped) {
      sql = `
        SELECT pb.payroll_batch_id, pb.start_date, pb.end_date, pb.status, pb.generated_at,
               pb.version_number, pb.is_finalized, pb.finalized_at, pb.currency, pb.scope_site_id,
               pb.supersedes_batch_id, pb.void_reason, pb.supersede_reason,
               u.full_name AS generated_by,
               COUNT(DISTINCT p.worker_id) AS total_workers,
               COALESCE(SUM(pi.base_salary + pi.overtime_pay), 0) AS total_amount
        FROM payrollbatches pb
        JOIN users u ON u.user_id = pb.generated_by_user_id
        JOIN payroll p ON p.payroll_batch_id = pb.payroll_batch_id
        JOIN payrollitems pi ON pi.payroll_id = p.payroll_id AND pi.site_id = ?
        WHERE ${statusFilter}
        GROUP BY pb.payroll_batch_id, pb.start_date, pb.end_date, pb.status, pb.generated_at,
                 pb.version_number, pb.is_finalized, pb.finalized_at, pb.currency, pb.scope_site_id,
                 pb.supersedes_batch_id, pb.void_reason, pb.supersede_reason, u.full_name
        ORDER BY pb.generated_at DESC`;
      params.push(site_id);
    } else {
      sql = `
        SELECT pb.payroll_batch_id, pb.start_date, pb.end_date,
               pb.total_workers, pb.total_amount, pb.status, pb.generated_at,
               pb.version_number, pb.is_finalized, pb.finalized_at, pb.currency, pb.scope_site_id,
               pb.supersedes_batch_id, pb.void_reason, pb.supersede_reason,
               u.full_name AS generated_by
        FROM payrollbatches pb
        JOIN users u ON u.user_id = pb.generated_by_user_id
        WHERE ${statusFilter}
        ORDER BY pb.generated_at DESC`;
    }

    const [rows] = await pool.execute(sql, params);
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('getPayrollReport:', error);
    return res.status(500).json({ success: false, message: 'Failed to load payroll reports.' });
  }
}

async function getPayrollBatchDetails(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  try {
    const [batches] = await pool.execute('SELECT * FROM payrollbatches WHERE payroll_batch_id = ?', [batchId]);
    if (!batches.length) return res.status(404).json({ success: false, message: 'Batch not found.' });

    const [payrolls] = await pool.execute(
      `SELECT p.payroll_id, p.gross_salary, p.net_salary,
              p.bonus_amount, p.penalty_amount, p.deductions_amount,
              w.worker_id, w.full_name AS worker_name
       FROM payroll p
       JOIN workers w ON w.worker_id = p.worker_id
       WHERE p.payroll_batch_id = ?
       ORDER BY w.full_name`,
      [batchId]
    );

    const [items] = await pool.execute(
      `SELECT pi.payroll_id, pi.site_id, s.site_name, pi.pay_type,
              pi.regular_hours_worked, pi.overtime_hours_worked,
              pi.hourly_rate_snapshot, pi.overtime_hourly_rate_snapshot,
              pi.daily_rate_snapshot, pi.days_worked,
              pi.base_salary, pi.overtime_pay
       FROM payroll p
       JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
       LEFT JOIN sites s ON s.site_id = pi.site_id
       WHERE p.payroll_batch_id = ?
       ORDER BY s.site_name`,
      [batchId]
    );

    const itemsByPayroll = new Map();
    for (const item of items) {
      if (!itemsByPayroll.has(item.payroll_id)) itemsByPayroll.set(item.payroll_id, []);
      itemsByPayroll.get(item.payroll_id).push(item);
    }

    const workers = payrolls.map((p) => {
      const sites = itemsByPayroll.get(p.payroll_id) || [];
      return {
        ...p,
        pay_type: sites[0]?.pay_type || 'Hourly',
        days_worked: sites.reduce((sum, s) => sum + Number(s.days_worked || 0), 0),
        regular_hours_worked: sites.reduce((sum, s) => sum + Number(s.regular_hours_worked || 0), 0),
        overtime_hours_worked: sites.reduce((sum, s) => sum + Number(s.overtime_hours_worked || 0), 0),
        daily_rate: sites[0]?.daily_rate_snapshot ?? null,
        regular_rate: sites[0]?.hourly_rate_snapshot ?? null,
        // The rate actually used is stored per item (dated, D3). No overtime -> no rate.
        overtime_rate: sites.find((x) => x.overtime_hourly_rate_snapshot != null)
          ? Number(sites.find((x) => x.overtime_hourly_rate_snapshot != null).overtime_hourly_rate_snapshot)
          : null,
        sites,
      };
    });

    return res.json({ success: true, batch: batches[0], workers });
  } catch (error) {
    console.error('getPayrollBatchDetails:', error);
    return res.status(500).json({ success: false, message: 'Failed to load batch details.' });
  }
}

async function markBatchAsPaid(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [batches] = await connection.execute(
      'SELECT status, is_finalized FROM payrollbatches WHERE payroll_batch_id = ? FOR UPDATE',
      [batchId]
    );
    if (!batches.length) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Batch not found.' }); }
    if (batches[0].status === 'Superseded' || batches[0].status === 'Voided') { await connection.rollback(); return res.status(409).json({ success: false, message: `A ${batches[0].status.toLowerCase()} batch cannot be marked as paid.` }); }
    if (batches[0].status === 'Paid') { await connection.rollback(); return res.status(409).json({ success: false, message: 'Batch is already paid.' }); }
    if (!batches[0].is_finalized) { await connection.rollback(); return res.status(409).json({ success: false, message: 'Finalize this payroll batch (management approval) before marking it as paid.' }); }

    // C-09: who marked it paid and when is recorded on the batch and audited.
    const userId = req.user?.user_id;
    await connection.execute(`UPDATE payrollbatches SET status = 'Paid', paid_by_user_id = ?, paid_at = NOW() WHERE payroll_batch_id = ?`, [userId, batchId]);
    await connection.execute(`UPDATE payroll SET status = 'Paid', paid_date = ? WHERE payroll_batch_id = ?`, [businessToday(), batchId]);
    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('payrollbatches', ?, 'MARKED_PAID', ?, ?, ?)`,
      [batchId, userId, JSON.stringify({ status: batches[0].status }), JSON.stringify({ status: 'Paid', paid_date: businessToday() })]
    );
    await connection.commit();
    return res.json({ success: true, message: 'Batch marked as paid.' });
  } catch (error) {
    await connection.rollback();
    console.error('markBatchAsPaid:', error);
    return res.status(500).json({ success: false, message: 'Failed to mark batch as paid.' });
  } finally {
    connection.release();
  }
}

// ============================================================
// D-03: PATCH /api/admin/payroll/batch/:batchId/void   { reason }
// A batch generated by mistake (NOT finalized, NOT paid) is marked Voided.
// Nothing is deleted: payroll rows, items, snapshots and history stay.
// Its period becomes free for a new batch.
// ============================================================
async function voidPayrollBatch(req, res) {
  const batchId = Number(req.params.batchId);
  const reason = String(req.body?.reason || '').trim();
  const userId = req.user?.user_id;
  if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  if (reason.length < 5) return res.status(400).json({ success: false, message: 'A reason (at least 5 characters) is required to void a batch.' });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[batch]] = await connection.execute('SELECT * FROM payrollbatches WHERE payroll_batch_id = ? FOR UPDATE', [batchId]);
    if (!batch) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Batch not found.' }); }
    if (batch.status !== 'Generated') {
      await connection.rollback();
      return res.status(409).json({ success: false, message: `Only a Generated batch can be voided (this one is ${batch.status}).` });
    }
    if (batch.is_finalized) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'A finalized batch cannot be voided. Use Supersede (with a reason) to correct it.' });
    }
    await connection.execute(
      `UPDATE payrollbatches SET status = 'Voided', voided_by_user_id = ?, voided_at = NOW(), void_reason = ?
       WHERE payroll_batch_id = ? AND status = 'Generated' AND is_finalized = 0`,
      [userId, reason.slice(0, 500), batchId]
    );
    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('payrollbatches', ?, 'VOIDED', ?, ?, ?)`,
      [batchId, userId, JSON.stringify({ status: batch.status }), JSON.stringify({ status: 'Voided', reason })]
    );
    await connection.commit();
    return res.json({ success: true, message: `Batch #${batchId} voided. It stays in the history; its period can be generated again.` });
  } catch (error) {
    await connection.rollback();
    console.error('voidPayrollBatch:', error);
    return res.status(500).json({ success: false, message: 'Failed to void the batch.' });
  } finally {
    connection.release();
  }
}

// ============================================================
// D-03: POST /api/admin/payroll/batch/:batchId/supersede   { reason, acknowledge_pending? }
// Correct a FINALIZED (unpaid) batch: generate the replacement for the same
// period/scope inside one transaction, verify it, then mark the old batch
// Superseded. If generation fails the old batch is unchanged. A Paid batch
// can never be superseded (use the correction / adjustment workflow).
// ============================================================
async function supersedeFinalizedBatch(req, res) {
  const batchId = Number(req.params.batchId);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  if (reason.length < 5) return res.status(400).json({ success: false, message: 'A reason (at least 5 characters) is required to supersede a batch.' });
  try {
    const [[batch]] = await pool.execute('SELECT * FROM payrollbatches WHERE payroll_batch_id = ?', [batchId]);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found.' });
    if (batch.status === 'Paid') return res.status(409).json({ success: false, message: 'A Paid batch cannot be superseded. Record the difference through the correction/adjustment workflow.' });
    if (batch.status !== 'Generated') return res.status(409).json({ success: false, message: `Only the active batch of a period can be superseded (this one is ${batch.status}).` });
    if (!batch.is_finalized) return res.status(409).json({ success: false, message: 'This batch is not finalized: generate the same period again (or void it) instead.' });
    req.body = {
      start_date: String(batch.start_date).slice(0, 10),
      end_date: String(batch.end_date).slice(0, 10),
      site_id: batch.scope_site_id,
      acknowledge_pending: req.body?.acknowledge_pending === true,
    };
    req._supersede = { batchId, reason: reason.slice(0, 500) };
    return generatePayrollBatch(req, res);
  } catch (error) {
    console.error('supersedeFinalizedBatch:', error);
    return res.status(500).json({ success: false, message: 'Failed to supersede the batch.' });
  }
}

async function getLastBatchEndDate(req, res) {
  try {
    const { site_id } = req.query || {};
    const params = [];
    let sql = `SELECT MAX(pb.end_date) AS last_end_date FROM payrollbatches pb WHERE pb.status IN ('Generated','Paid')`;
    if (isSpecificSite(site_id)) {
      sql = `SELECT MAX(pb.end_date) AS last_end_date
             FROM payrollbatches pb
             JOIN payroll p ON p.payroll_batch_id = pb.payroll_batch_id
             JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
             WHERE pb.status IN ('Generated','Paid') AND pi.site_id = ?`;
      params.push(site_id);
    }
    const [rows] = await pool.execute(sql, params);
    return res.json({ success: true, last_end_date: rows[0]?.last_end_date || null });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load the last batch date.' });
  }
}
async function exportPayrollExcel(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  }

  try {
    const ExcelJS = require('exceljs');
    const path = require('path');
    const fs = require('fs');

    const [batches] = await pool.execute(
      `SELECT payroll_batch_id, start_date, end_date, total_workers, total_amount, status,
              version_number, is_finalized, scope_site_id, currency
       FROM payrollbatches WHERE payroll_batch_id = ?`,
      [batchId]
    );
    if (!batches.length) return res.status(404).json({ success: false, message: 'Batch not found.' });
    const batch = batches[0];

    const [rows] = await pool.execute(
      `SELECT w.full_name AS worker_name, w.worker_unique_id, p.worker_id,
              s.site_id, s.site_name, pi.pay_type,
              pi.regular_hours_worked, pi.overtime_hours_worked,
              pi.hourly_rate_snapshot, pi.overtime_hourly_rate_snapshot,
              pi.daily_rate_snapshot, pi.days_worked,
              pi.base_salary, pi.overtime_pay, p.net_salary
       FROM payroll p
       JOIN workers w ON w.worker_id = p.worker_id
       JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
       LEFT JOIN sites s ON s.site_id = pi.site_id
       WHERE p.payroll_batch_id = ?
       ORDER BY s.site_name, w.full_name`,
      [batchId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'No payroll items found for this batch.' });
    }

    // ---- (جديد) مجموع الساعات العادية والأوفر تايم لكل عامل من الحضور المعتمد ----
    // للعرض فقط: لا علاقة له بحسابات الرواتب.
    // (payrollitems بيخزّن الساعات للعمال بالساعة فقط، فبنجيبها من attendance لتشمل الكل)
    // C-07: hours come from the batch's own attendance snapshot. Batches
    // generated before the snapshot existed fall back to the attendance as it
    // is recorded today, and the sheet says so explicitly.
    const [snapRows] = await pool.execute(
      `SELECT worker_id, COALESCE(SUM(regular_hours), 0) AS regular_hours, COALESCE(SUM(overtime_hours), 0) AS overtime_hours
       FROM payroll_attendance_snapshot WHERE payroll_batch_id = ? GROUP BY worker_id`, [batchId]);
    const hoursFromSnapshot = snapRows.length > 0;
    let hoursRows = snapRows;
    if (!hoursFromSnapshot) {
      const hoursParams = [batch.start_date, batch.end_date];
      let hoursSql = `
        SELECT worker_id,
               COALESCE(SUM(total_working_hours), 0) AS regular_hours,
               COALESCE(SUM(overtime_hours), 0) AS overtime_hours
        FROM attendance
        WHERE record_date BETWEEN ? AND ?
          AND status = 'Approved'`;
      if (batch.scope_site_id) {
        hoursSql += ' AND site_id = ?';
        hoursParams.push(batch.scope_site_id);
      }
      hoursSql += ' GROUP BY worker_id';
      [hoursRows] = await pool.execute(hoursSql, hoursParams);
    }
    const currencyCode = String(batch.currency || 'SYP').toUpperCase();
    const currencyLabel = currencyCode === 'SYP' ? 'Syrian Pound (ل.س)' : currencyCode;
    const moneyFmt = currencyCode === 'SYP' ? '#,##0 "ل.س"' : `#,##0.00 "${currencyCode}"`;
    const hoursByWorker = new Map();
    for (const h of hoursRows) {
      hoursByWorker.set(h.worker_id, {
        regular: Number(h.regular_hours || 0),
        overtime: Number(h.overtime_hours || 0),
      });
    }

    const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
    const logoPath = path.join(__dirname, '../assets/logo.png');

    const workbook = new ExcelJS.Workbook();

    // اللوغو بيتضاف مرة وحدة للـ workbook وبنعيد استخدام الـ id لكل الشيتات
    let logoId = null;
    try {
      if (fs.existsSync(logoPath)) {
        logoId = workbook.addImage({ filename: logoPath, extension: 'png' });
      }
    } catch (e) {
      console.warn('Logo not added:', e.message);
    }
    function addLogo(sheet) {
      if (logoId === null) return;
      sheet.addImage(logoId, {
        tl: { col: 0.15, row: 0.15 },
        ext: { width: 150, height: 55 },
        editAs: 'oneCell',
      });
    }

    // Group rows by site
    const bySite = new Map();
    for (const row of rows) {
      const key = row.site_id ?? 'unassigned';
      if (!bySite.has(key)) bySite.set(key, { siteName: row.site_name || 'Unassigned', rows: [] });
      bySite.get(key).rows.push(row);
    }

    // Group by worker for the true (deduped) net salary in the Summary sheet
    const byWorker = new Map();
    for (const row of rows) {
      if (!byWorker.has(row.worker_id)) {
        const hrs = hoursByWorker.get(row.worker_id) || { regular: 0, overtime: 0 };
        byWorker.set(row.worker_id, {
          worker_name: row.worker_name,
          worker_unique_id: row.worker_unique_id,
          net_salary: Number(row.net_salary || 0),
          total_regular_hours: hrs.regular,
          total_overtime_hours: hrs.overtime,
          sites: new Set(),
        });
      }
      byWorker.get(row.worker_id).sites.add(row.site_name || 'Unassigned');
    }

    const totalWorkerCount = byWorker.size;

    const workerCountBySite = new Map();
    for (const row of rows) {
      const key = row.site_id ?? 'unassigned';
      if (!workerCountBySite.has(key)) workerCountBySite.set(key, new Set());
      workerCountBySite.get(key).add(row.worker_id);
    }

    // ---------------- Summary sheet ----------------
    const summarySheet = workbook.addWorksheet('Summary');
    addLogo(summarySheet);

    // ترتيب الأعمدة: A,B فراغ للوغو | C No | D ID | E Name | F Sites | G Net |
    //                H Regular Hrs | I OT Hrs | J Signature
    summarySheet.columns = [
      { header: '', key: 'logo_gap', width: 4 },
      { header: '', key: 'logo_gap2', width: 10 },
      { header: 'No.', key: 'number', width: 6 },
      { header: 'Worker ID', key: 'worker_id', width: 16 },
      { header: 'Worker Name', key: 'worker_name', width: 28 },
      { header: 'Sites', key: 'sites', width: 32 },
      { header: 'Net Salary', key: 'net_salary', width: 18 },
      { header: 'Total Hours (Regular + OT)', key: 'total_hours', width: 18 },
      { header: 'Signature', key: 'signature', width: 22 },   // ← عرض التوقيع (كان 80)
    ];

    summarySheet.mergeCells('C1:I1');
    summarySheet.getCell('C1').value = `Payroll Batch #${batchId} (v${batch.version_number}${batch.is_finalized ? ' - Finalized' : ''})`;
    summarySheet.mergeCells('C2:I2');
    summarySheet.getCell('C2').value = `Period: ${dateOnly(batch.start_date)} - ${dateOnly(batch.end_date)}`;
    summarySheet.mergeCells('C3:I3');
    summarySheet.getCell('C3').value = `Currency: ${currencyLabel}${hoursFromSnapshot ? '' : ' — hours as currently recorded (batch generated before hour snapshots)'}`;
    summarySheet.mergeCells('C4:I4');
    summarySheet.getCell('C4').value = `Total Workers Paid: ${totalWorkerCount}`;
    summarySheet.getCell('C4').font = { bold: true };

    summarySheet.getRow(1).height = 28;
    summarySheet.getRow(2).height = 28;
    summarySheet.getRow(3).height = 28;
    summarySheet.getRow(4).height = 28;
    summarySheet.getRow(5).values = ['', '', ...summarySheet.columns.slice(2).map((c) => c.header)];

    const SIGNATURE_ROW_HEIGHT = 85; // ← طول صف التوقيع (كان 65)

    let grandTotalNet = 0;
    let grandHours = 0;
    let idx = 0;
    for (const worker of byWorker.values()) {
      idx += 1;
      const workerTotalHours = worker.total_regular_hours + worker.total_overtime_hours;
      const row = summarySheet.addRow({
        number: idx,
        worker_id: worker.worker_unique_id,
        worker_name: worker.worker_name,
        sites: [...worker.sites].join(', '),
        net_salary: worker.net_salary,
        total_hours: Math.round(workerTotalHours * 100) / 100,
        signature: '',
      });
      row.height = SIGNATURE_ROW_HEIGHT;
      grandTotalNet += worker.net_salary;
      grandHours += workerTotalHours;
    }

    const summaryTotalRow = summarySheet.addRow({
      worker_name: 'GRAND TOTAL',
      net_salary: Math.round(grandTotalNet * 100) / 100,
      total_hours: Math.round(grandHours * 100) / 100,
    });
    summaryTotalRow.font = { bold: true };

    const headerRow = summarySheet.getRow(5);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerRow.height = 32;

    const thinBorder = {
      top: { style: 'thin', color: { argb: 'FFDDDDDD' } },
      bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } },
      left: { style: 'thin', color: { argb: 'FFDDDDDD' } },
      right: { style: 'thin', color: { argb: 'FFDDDDDD' } },
    };

      for (let r = 6; r <= summarySheet.rowCount; r += 1) {
      summarySheet.getCell(r, 7).numFmt = moneyFmt;   // Net Salary (G)
      summarySheet.getCell(r, 8).numFmt = '0.00';          // Total Hours (H)
      for (const col of [8, 9]) {
        summarySheet.getCell(r, col).alignment = { vertical: 'middle', horizontal: 'center' };
      }
      summarySheet.getCell(r, 9).border = thinBorder;      // Signature (I)
    }
    summarySheet.views = [{ state: 'frozen', ySplit: 5 }];

    // ---------------- One worksheet per site (بدون أي تغيير) ----------------
    const usedNames = new Set(['Summary']);
    for (const [siteKey, { siteName, rows: siteRows }] of bySite.entries()) {
      let safeName = siteName.replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 28) || 'Site';
      let finalName = safeName;
      let counter = 1;
      while (usedNames.has(finalName)) {
        finalName = `${safeName} (${counter++})`;
      }
      usedNames.add(finalName);

      const sheet = workbook.addWorksheet(finalName);
      addLogo(sheet);

      sheet.columns = [
        { header: 'No.', key: 'number', width: 6 },
        { header: 'Worker ID', key: 'worker_id', width: 16 },
        { header: 'Worker Name', key: 'worker_name', width: 28 },
        { header: 'Payment Type', key: 'pay_type', width: 14 },
        { header: 'Days Worked', key: 'days_worked', width: 12 },
        { header: 'Daily Rate', key: 'daily_rate', width: 14 },
        { header: 'Regular Hours', key: 'regular_hours', width: 14 },
        { header: 'Overtime Hours', key: 'overtime_hours', width: 14 },
        { header: 'Regular Rate', key: 'regular_rate', width: 14 },
        { header: 'Overtime Rate', key: 'overtime_rate', width: 14 },
        { header: 'Base Salary', key: 'base_salary', width: 16 },
        { header: 'Overtime Pay', key: 'overtime_pay', width: 16 },
        { header: 'Site Total', key: 'site_total', width: 16 },
        { header: 'Signature', key: 'signature', width: 30 },
      ];

      const siteWorkerCount = workerCountBySite.get(siteKey)?.size || 0;

      sheet.mergeCells('A1:N1');
      sheet.getCell('A1').value = `Payroll Batch #${batchId} - Site: ${siteName}`;
      sheet.mergeCells('A2:N2');
      sheet.getCell('A2').value = `Period: ${dateOnly(batch.start_date)} - ${dateOnly(batch.end_date)}`;
      sheet.mergeCells('A3:N3');
      sheet.getCell('A3').value = `Currency: ${currencyLabel} — Overtime: flat company rate per hour (see the Overtime Rate column)`;

      sheet.mergeCells('A4:N4');
      sheet.getCell('A4').value = `Workers at this site: ${siteWorkerCount}`;
      sheet.getCell('A4').font = { bold: true };

      sheet.getRow(1).height = 25;
      sheet.getRow(2).height = 25;
      sheet.getRow(3).height = 25;
      sheet.getRow(4).height = 22;
      sheet.getRow(5).values = sheet.columns.map((c) => c.header);

      let siteTotalBase = 0, siteTotalOT = 0, siteTotalAll = 0;

      siteRows.forEach((item, index) => {
        const isDaily = item.pay_type === 'Daily';
        const rowTotal = Number(item.base_salary || 0) + Number(item.overtime_pay || 0);
        const rowData = {
          number: index + 1,
          worker_id: item.worker_unique_id,
          worker_name: item.worker_name,
          pay_type: item.pay_type,
          overtime_hours: Number(item.overtime_hours_worked || 0),
          overtime_rate: Number(item.overtime_hourly_rate_snapshot || 0),
          base_salary: Number(item.base_salary || 0),
          overtime_pay: Number(item.overtime_pay || 0),
          site_total: rowTotal,
          signature: '',
        };
        if (isDaily) {
          rowData.days_worked = item.days_worked;
          rowData.daily_rate = Number(item.daily_rate_snapshot || 0);
        } else {
          rowData.regular_hours = Number(item.regular_hours_worked || 0);
          rowData.regular_rate = Number(item.hourly_rate_snapshot || 0);
        }
        sheet.addRow(rowData);

        siteTotalBase += rowData.base_salary;
        siteTotalOT += rowData.overtime_pay;
        siteTotalAll += rowTotal;
      });

      const totalRow = sheet.addRow({
        worker_name: 'SITE TOTAL',
        base_salary: Math.round(siteTotalBase * 100) / 100,
        overtime_pay: Math.round(siteTotalOT * 100) / 100,
        site_total: Math.round(siteTotalAll * 100) / 100,
      });
      totalRow.font = { bold: true };

      sheet.getRow(5).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
      for (let r = 6; r <= sheet.rowCount; r += 1) {
        for (const col of [6, 9, 10, 11, 12, 13]) {
          sheet.getCell(r, col).numFmt = moneyFmt;
        }
      }
      sheet.views = [{ state: 'frozen', ySplit: 5 }];
    }

    // نبني الملف كامل بالذاكرة أولاً: إذا صار خطأ بيرجع JSON 500 نظيف بدل ملف مقطوع
    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `payroll_batch_${batchId}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.end(Buffer.from(buffer));
  } catch (error) {
    console.error('exportPayrollExcel:', error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Failed to export Excel payroll report.' });
    }
  }
}

// ============================================================
// GET /api/admin/payroll/batch/:batchId/export.pdf
// Formal PDF report for WORKERS payroll (distinct from staff PDF):
// - Grouped by SITE (workers of the same site listed together, sites never mixed)
// - Per-day breakdown: Regular hours / Overtime hours columns for every day
//   in the batch period
// - Different color scheme than the staff report (teal/amber instead of navy/red)
// ============================================================
// ============================================================
// REPLACEMENT for: controllers/adminPayrollController.js
// Function: exportPayrollPdf
//
// Paste this whole function in place of the existing
// `async function exportPayrollPdf(req, res) { ... }` block.
// Everything else in adminPayrollController.js stays as-is
// (module.exports already exports exportPayrollPdf).
//
// REQUIRED SETUP before this works correctly:
//   1) npm install arabic-reshaper
//   2) Download a Unicode Arabic font (e.g. "Noto Naskh Arabic"
//      from Google Fonts, or Cairo/Amiri) and place it at:
//        backend/assets/fonts/NotoNaskhArabic-Regular.ttf
//      (If the file isn't found, the code still runs — Arabic
//      text will fall back to plain Latin currency "SYP" and
//      Arabic names, but names will still render incorrectly
//      until the font file exists.)
// ============================================================

async function exportPayrollPdf(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  }

  try {
    const PDFDocument = require('pdfkit');
    const path = require('path');
    const fs = require('fs');
    let ArabicReshaper = null;
    try { ArabicReshaper = require('arabic-reshaper'); } catch (_) { ArabicReshaper = null; }

    const ARABIC_FONT_PATH = path.join(__dirname, '../assets/fonts/NotoNaskhArabic-Regular.ttf');
    const hasArabicFont = fs.existsSync(ARABIC_FONT_PATH);

    function isArabicText(str) {
      return /[\u0600-\u06FF]/.test(String(str || ''));
    }

    // Reshapes+reverses ONLY the Arabic-containing runs of a string,
    // e.g. in "1,500 ل.س" only "ل.س" gets touched — "1,500" stays as-is.
function shapeArabicAware(str) {
  const text = String(str ?? '');

  if (!isArabicText(text) || !hasArabicFont) return text;

  const tokens =
    text.match(/[\u0600-\u06FF\s.,،]+|[^\u0600-\u06FF]+/g) || [text];

  return tokens
    .map((tok) => {
      if (!isArabicText(tok)) return tok;
      if (!ArabicReshaper) return tok;

      try {
        const reordered = tok
          .trim()
          .split(/\s+/)
          .reverse()
          .join(' ');

        return ArabicReshaper.convertArabic(reordered);
      } catch (_) {
        return tok;
      }
    })
    .join('');
}

    function fontNameFor(str, bold) {
      if (hasArabicFont && isArabicText(str)) return 'Arabic';
      return bold ? 'Helvetica-Bold' : 'Helvetica';
    }

    const [batches] = await pool.execute(
      `SELECT pb.payroll_batch_id, pb.start_date, pb.end_date, pb.total_workers, pb.total_amount, pb.status,
              pb.version_number, pb.is_finalized, pb.currency,
              u.full_name AS generated_by, fu.full_name AS finalized_by
       FROM payrollbatches pb
       JOIN users u ON u.user_id = pb.generated_by_user_id
       LEFT JOIN users fu ON fu.user_id = pb.finalized_by_user_id
       WHERE pb.payroll_batch_id = ?`,
      [batchId]
    );
    if (!batches.length) return res.status(404).json({ success: false, message: 'Batch not found.' });
    const batch = batches[0];
    const CURRENCY_CODE = String(batch.currency || 'SYP').toUpperCase();
    const CURRENCY_LABEL = CURRENCY_CODE === 'SYP' ? 'ل.س' : CURRENCY_CODE;

    const [rows] = await pool.execute(
      `SELECT w.full_name AS worker_name, w.worker_unique_id, p.worker_id,
              s.site_id, s.site_name, pi.pay_type,
              pi.regular_hours_worked, pi.overtime_hours_worked,
              pi.hourly_rate_snapshot, pi.overtime_hourly_rate_snapshot,
              pi.daily_rate_snapshot, pi.days_worked,
              pi.base_salary, pi.overtime_pay, p.net_salary
       FROM payroll p
       JOIN workers w ON w.worker_id = p.worker_id
       JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
       LEFT JOIN sites s ON s.site_id = pi.site_id
       WHERE p.payroll_batch_id = ?
       ORDER BY s.site_name, w.full_name`,
      [batchId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'No payroll items found for this batch.' });

    const num = (v) => Number(v || 0);
    const fmt2 = (v) => num(v).toFixed(2);
    // Matches the app's formatSyp(): comma-grouped number + " ل.س"
    const money = (v) => `${Math.round(num(v)).toLocaleString('en-US')} ${CURRENCY_LABEL}`;

    // ---- Build the list of dates in the batch period ----
    const startDate = new Date(`${String(batch.start_date).slice(0, 10)}T00:00:00Z`);
    const endDate = new Date(`${String(batch.end_date).slice(0, 10)}T00:00:00Z`);
    const dateList = [];
    {
      const cursor = new Date(startDate.getTime());
      while (cursor <= endDate) {
        dateList.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }
    const MAX_DAYS = 62;
    const truncated = dateList.length > MAX_DAYS;
    const usedDates = truncated ? dateList.slice(0, MAX_DAYS) : dateList;

    // ---- Daily hours: the batch's own snapshot (C-07); older batches fall
    //      back to the attendance as recorded today (stated in the header). ----
    let [attRows] = await pool.execute(
      `SELECT worker_id, site_id, DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date,
              regular_hours AS total_working_hours, overtime_hours
       FROM payroll_attendance_snapshot WHERE payroll_batch_id = ?`,
      [batchId]
    );
    const hoursFromSnapshot = attRows.length > 0;
    if (!hoursFromSnapshot) {
      [attRows] = await pool.execute(
        `SELECT worker_id, site_id, DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date,
                total_working_hours, overtime_hours
         FROM attendance
         WHERE record_date BETWEEN ? AND ?
           AND status = 'Approved'`,
        [batch.start_date, batch.end_date]
      );
    }
const dailyMap = new Map();

for (const a of attRows) {
  const key = `${a.worker_id}|${a.site_id}|${a.record_date}`;
  const prior = dailyMap.get(key) || { reg: 0, ot: 0 };

  dailyMap.set(key, {
    reg: prior.reg + Number(a.total_working_hours || 0),
    ot: prior.ot + Number(a.overtime_hours || 0),
  });
}

    function getDaily(workerId, siteId, date) {
      return dailyMap.get(`${workerId}|${siteId}|${date}`) || { reg: 0, ot: 0 };
    }


    const sortedRows = [...rows].sort((a, b) => {
      const bySite = (a.site_name || 'Unassigned').localeCompare(b.site_name || 'Unassigned');
      if (bySite !== 0) return bySite;
      return (a.worker_name || '').localeCompare(b.worker_name || '');
    });

    const distinctWorkerIds = new Set(rows.map((r) => r.worker_id));
    const distinctSites = new Set(rows.map((r) => r.site_name || 'Unassigned'));
    let grandTotalNet = 0;
    const netByWorker = new Map();
    for (const r of rows) if (!netByWorker.has(r.worker_id)) netByWorker.set(r.worker_id, num(r.net_salary));
    for (const v of netByWorker.values()) grandTotalNet += v;

    const COLOR_HEADER_BG = '#0b5b52';
    const COLOR_HEADER_TEXT = '#ffffff';
    const COLOR_ACCENT = '#0b5b52';
    const COLOR_ZEBRA = '#f7faf9';
    const COLOR_OT_TEXT = '#b26a00';
    const COLOR_GRID = '#dfe3e8';
    const COLOR_SUMMARY_BG = '#fff4e0';

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
    if (hasArabicFont) doc.registerFont('Arabic', ARABIC_FONT_PATH);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payroll_batch_${batchId}.pdf"`);
    doc.pipe(res);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const logoPath = path.join(__dirname, '../assets/logo.png');
    const hasLogo = fs.existsSync(logoPath);

    const statusText = batch.status === 'Superseded' ? 'SUPERSEDED' : batch.status === 'Voided' ? 'VOIDED' : batch.status === 'Paid' ? 'PAID' : 'GENERATED';
    const isFinalized = batch.is_finalized === 1 || batch.is_finalized === true;

    function drawHeader() {
      let y = doc.page.margins.top;
      if (hasLogo) doc.image(logoPath, doc.page.margins.left, y, { width: 85, height: 38 });

      doc.font('Helvetica-Bold').fontSize(16).fillColor('black')
        .text('WORKERS PAYROLL REPORT', doc.page.margins.left, y + 2, { width: pageWidth, align: 'center' });
      doc.font('Helvetica').fontSize(9)
        .text('ASIK ENGINEERING CONSTRUCTION', doc.page.margins.left, y + 22, { width: pageWidth, align: 'center' });

      y += 48;
      doc.font('Helvetica-Bold').fontSize(10).fillColor('black');
      doc.text(`Batch #${batchId}  (Version ${batch.version_number || 1})`, doc.page.margins.left, y);
      doc.text(`Period: ${String(batch.start_date).slice(0, 10)}   to   ${String(batch.end_date).slice(0, 10)}`,
        doc.page.margins.left, y, { width: pageWidth, align: 'right' });
      y += 15;

      const payColor = statusText === 'PAID' ? '#1a7a3c' : statusText === 'SUPERSEDED' ? '#888888' : COLOR_OT_TEXT;
      doc.fillColor(isFinalized ? '#1a7a3c' : '#b21f1f').text(`Status: ${isFinalized ? 'FINALIZED' : 'NOT FINALIZED'}`, doc.page.margins.left, y);
      doc.fillColor(payColor).text(`Payment: ${statusText}`, doc.page.margins.left + 170, y);
      doc.fillColor('black');
      y += 18;

      if (truncated) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#b21f1f')
          .text(`Showing first ${MAX_DAYS} of ${dateList.length} days in this period.`, doc.page.margins.left, y);
        doc.fillColor('black');
        y += 12;
      }
      if (!hoursFromSnapshot) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#b21f1f')
          .text('Daily hours shown as currently recorded (this batch was generated before hour snapshots). Amounts are the stored batch amounts.', doc.page.margins.left, y);
        doc.fillColor('black');
        y += 12;
      }

      doc.rect(doc.page.margins.left, y, pageWidth, 20).fill(COLOR_SUMMARY_BG);
     doc.fillColor(COLOR_ACCENT).font('Helvetica-Bold').fontSize(9);

const summaryX = doc.page.margins.left + 8;
const summaryY = y + 5;

const summaryLabel =
  `Total Workers: ${distinctWorkerIds.size}    |    Total Sites: ${distinctSites.size}    |    TOTAL NET: `;

doc.font('Helvetica-Bold')
  .fontSize(9)
  .fillColor(COLOR_ACCENT)
  .text(summaryLabel, summaryX, summaryY, {
    lineBreak: false,
  });

let currentX = summaryX + doc.widthOfString(summaryLabel);

const amountOnly = Math.round(num(grandTotalNet)).toLocaleString('en-US');

doc.font('Helvetica-Bold')
  .fontSize(9)
  .fillColor(COLOR_ACCENT)
  .text(amountOnly, currentX, summaryY, {
    lineBreak: false,
  });

currentX += doc.widthOfString(amountOnly) + 3;

if (hasArabicFont && CURRENCY_CODE === 'SYP') {
  doc.font('Arabic')
    .fontSize(9)
    .fillColor(COLOR_ACCENT)
   .text(shapeArabicAware(CURRENCY_LABEL), currentX, summaryY - 4, {
  lineBreak: false,
});
} else {
  doc.font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(COLOR_ACCENT)
    .text(CURRENCY_CODE, currentX, summaryY, {
      lineBreak: false,
    });
}
      doc.fillColor('black');
      y += 30;
      return y;
    }

    // ---- Column layout ----
    const fixedCols = [
      { key: 'no', label: 'No.', width: 20 },
      { key: 'worker_id', label: 'ID', width: 40 },
      { key: 'full_name', label: 'Worker Name', width: 120 },
      { key: 'site_name', label: 'Site', width: 82 },
    ];
    const dayColWidth = 30;
    const totalsCols = [
      { key: 'total_reg', label: 'Tot.Reg', width: 40 },
      { key: 'total_ot', label: 'Tot.OT', width: 40 },
      { key: 'daily_wage', label: 'Rate', width: 66 },
      { key: 'net', label: 'Net Pay', width: 78 },
    ];

    const tableTotalWidth = fixedCols.reduce((s, c) => s + c.width, 0)
      + usedDates.length * dayColWidth
      + totalsCols.reduce((s, c) => s + c.width, 0);

    function drawTableHeader(y) {
      const rowH1 = 14, rowH2 = 16;
      let x = doc.page.margins.left;

      doc.rect(x, y, fixedCols.reduce((s, c) => s + c.width, 0), rowH1 + rowH2).fill(COLOR_HEADER_BG);
      doc.fillColor(COLOR_HEADER_TEXT).font('Helvetica-Bold').fontSize(7);
      let fx = x;
      for (const c of fixedCols) {
        doc.text(c.label, fx + 2, y + rowH1 / 2 + 3, { width: c.width - 4, align: 'center' });
        fx += c.width;
      }
      x = fx;

      doc.font('Helvetica-Bold').fontSize(6.3);
      let dx = x;
      for (const d of usedDates) {
        doc.rect(dx, y, dayColWidth, rowH1).fill(COLOR_HEADER_BG);
        doc.fillColor(COLOR_HEADER_TEXT).text(d.slice(5), dx, y + 3, { width: dayColWidth, align: 'center' });
        doc.rect(dx, y + rowH1, dayColWidth / 2, rowH2).fill('#0e7568');
        doc.rect(dx + dayColWidth / 2, y + rowH1, dayColWidth / 2, rowH2).fill('#b8792a');
        doc.fillColor(COLOR_HEADER_TEXT).fontSize(6)
          .text('R', dx, y + rowH1 + 4, { width: dayColWidth / 2, align: 'center' })
          .text('OT', dx + dayColWidth / 2, y + rowH1 + 4, { width: dayColWidth / 2, align: 'center' });
        dx += dayColWidth;
      }
      x = dx;

      doc.font('Helvetica-Bold').fontSize(7);
      for (const c of totalsCols) {
        doc.rect(x, y, c.width, rowH1 + rowH2).fill(COLOR_HEADER_BG);
        doc.fillColor(COLOR_HEADER_TEXT).text(c.label, x + 2, y + rowH1 / 2 + 3, { width: c.width - 4, align: 'center' });
        x += c.width;
      }

      doc.fillColor('black');
      return y + rowH1 + rowH2;
    }

    // Measures how tall a row needs to be so the text-heavy cells
    // (Name / Site / Rate / Net) NEVER get clipped — they wrap instead.
    function measureRowHeight(item) {
      doc.fontSize(6.6);

      doc.font(fontNameFor(item.full_name));
      const nameH = doc.heightOfString(shapeArabicAware(item.full_name), { width: fixedCols[2].width - 6 });

      doc.font(fontNameFor(item.site_name));
      const siteH = doc.heightOfString(shapeArabicAware(item.site_name), { width: fixedCols[3].width - 6 });

      doc.font(fontNameFor(item.daily_wage));
      const rateH = doc.heightOfString(item.daily_wage, { width: totalsCols[2].width - 6 });

      doc.font(fontNameFor(item.net));
      const netH = doc.heightOfString(item.net, { width: totalsCols[3].width - 6 });

      return Math.max(13, Math.ceil(Math.max(nameH, siteH, rateH, netH)) + 5);
    }

    function drawDataRow(y, item, opts = {}) {
      const rowH = opts.rowHeight || 13;
      let x = doc.page.margins.left;

      if (opts.zebra) {
        doc.rect(x, y, tableTotalWidth, rowH).fill(COLOR_ZEBRA);
        doc.fillColor('black');
      }

      // No. / ID — short, fixed, never wraps
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.6);
      for (const c of [fixedCols[0], fixedCols[1]]) {
        doc.rect(x, y, c.width, rowH).stroke(COLOR_GRID);
        doc.fillColor('black').text(String(item[c.key] ?? ''), x + 2, y + rowH / 2 - 4, {
          width: c.width - 4, align: 'center', lineBreak: false,
        });
        x += c.width;
      }

      // Worker Name — Arabic-aware, wraps instead of being cut off
      {
        const c = fixedCols[2];
        doc.rect(x, y, c.width, rowH).stroke(COLOR_GRID);
        const raw = item.full_name || '';
        doc.font(fontNameFor(raw, opts.bold));
        doc.fillColor('black').text(shapeArabicAware(raw), x + 3, y + 3, {
          width: c.width - 6,
          align: isArabicText(raw) ? 'right' : 'left',
          lineBreak: true,
        });
        x += c.width;
      }

      // Site — new column, same wrapping treatment
      {
        const c = fixedCols[3];
        doc.rect(x, y, c.width, rowH).stroke(COLOR_GRID);
        const raw = item.site_name || '';
        doc.font(fontNameFor(raw, opts.bold));
        doc.fillColor('black').text(shapeArabicAware(raw), x + 3, y + 3, {
          width: c.width - 6,
          align: isArabicText(raw) ? 'right' : 'left',
          lineBreak: true,
        });
        x += c.width;
      }

      // Day columns
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.5);
      for (const d of usedDates) {
        const daily = item.dailyByDate[d] || { reg: 0, ot: 0 };
        const half = dayColWidth / 2;
        doc.rect(x, y, half, rowH).stroke(COLOR_GRID);
        doc.fillColor('black').text(daily.reg > 0 ? daily.reg.toFixed(1) : '-', x, y + rowH / 2 - 4, { width: half, align: 'center', lineBreak: false });
        x += half;
        doc.rect(x, y, half, rowH).stroke(COLOR_GRID);
        doc.fillColor(daily.ot > 0 ? COLOR_OT_TEXT : 'black')
          .text(daily.ot > 0 ? daily.ot.toFixed(1) : '-', x, y + rowH / 2 - 4, { width: half, align: 'center', lineBreak: false });
        x += half;
      }

      // Totals — Tot.Reg / Tot.OT never wrap; Rate / Net Pay can
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.6);
      for (const c of [totalsCols[0], totalsCols[1]]) {
        doc.rect(x, y, c.width, rowH).stroke(COLOR_GRID);
        doc.fillColor(c.key === 'total_ot' ? COLOR_OT_TEXT : 'black')
          .text(String(item[c.key] ?? ''), x + 2, y + rowH / 2 - 4, { width: c.width - 4, align: 'center', lineBreak: false });
        x += c.width;
      }
      for (const c of [totalsCols[2], totalsCols[3]]) {
        doc.rect(x, y, c.width, rowH).stroke(COLOR_GRID);
        const raw = String(item[c.key] ?? '');
        doc.font(fontNameFor(raw, opts.bold));
        doc.fillColor(c.key === 'net' ? COLOR_ACCENT : 'black')
          .text(shapeArabicAware(raw), x + 3, y + 3, { width: c.width - 6, align: 'center', lineBreak: true });
        x += c.width;
      }
      doc.fillColor('black');

      return y + rowH;
    }

    let y = drawHeader();
    y = drawTableHeader(y);
    const bottomLimit = doc.page.height - doc.page.margins.bottom - 20;

    sortedRows.forEach((r, idx) => {
      const dailyByDate = {};
      let totalReg = 0, totalOt = 0;
      for (const d of usedDates) {
        const v = getDaily(r.worker_id, r.site_id, d);
        dailyByDate[d] = v;
        totalReg += v.reg;
        totalOt += v.ot;
      }
      const isDaily = r.pay_type === 'Daily';
      const dailyWageLabel = isDaily ? money(r.daily_rate_snapshot) : `${money(r.hourly_rate_snapshot)}/h`;

      const item = {
        no: idx + 1,
        worker_id: r.worker_unique_id,
        full_name: r.worker_name,
        site_name: r.site_name || 'Unassigned',
        total_reg: fmt2(totalReg),
        total_ot: fmt2(totalOt),
        daily_wage: dailyWageLabel,
        net: money(r.net_salary),
        dailyByDate,
      };

      const rowHeight = measureRowHeight(item);
      if (y + rowHeight > bottomLimit) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawTableHeader(y);
      }
      y = drawDataRow(y, item, { zebra: idx % 2 === 1, rowHeight });
    });

    if (y + 20 > bottomLimit) {
      doc.addPage();
      y = doc.page.margins.top;
      y = drawTableHeader(y);
    }
const grandTotalX = doc.page.margins.left;
const grandTotalY = y + 6;

const grandTotalLabel = 'GRAND TOTAL NET: ';

doc.font('Helvetica-Bold')
  .fontSize(8)
  .fillColor(COLOR_ACCENT)
  .text(grandTotalLabel, grandTotalX, grandTotalY, {
    lineBreak: false,
  });

let grandX = grandTotalX + doc.widthOfString(grandTotalLabel);

const grandAmount = Math.round(num(grandTotalNet)).toLocaleString('en-US');

doc.font('Helvetica-Bold')
  .fontSize(8)
  .fillColor(COLOR_ACCENT)
  .text(grandAmount, grandX, grandTotalY, {
    lineBreak: false,
  });

grandX += doc.widthOfString(grandAmount) + 3;

if (hasArabicFont && CURRENCY_CODE === 'SYP') {
  doc.font('Arabic')
    .fontSize(8)
    .fillColor(COLOR_ACCENT)
  .text(shapeArabicAware(CURRENCY_LABEL), grandX, grandTotalY - 4, {
  lineBreak: false,
});
} else {
  doc.font('Helvetica-Bold')
    .fontSize(8)
    .fillColor(COLOR_ACCENT)
    .text(CURRENCY_CODE, grandX, grandTotalY, {
      lineBreak: false,
    });
}

doc.fillColor('black');
    y += 26;

    // ---- Signature footer ----
    function drawSignaturesFooter(currentY) {
      const footerY = currentY + 15; // مسافة بسيطة بعد الجدول

      // تحقق إذا كانت التواقيع ستنزل خارج الصفحة، إذاً انقلها لصفحة جديدة
      if (footerY + 50 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        return doc.page.margins.top + 20;
      }

      doc.font('Helvetica').fontSize(8);
      const sectionWidth = pageWidth / 3;
      const signaturesData = [
        { title: 'Prepared by', name: batch.generated_by || '-' },
        { title: 'Verified by', name: '-' },
        { title: 'Approved by', name: batch.finalized_by || '-' },
      ];

      signaturesData.forEach((sig, index) => {
        const startXPos = doc.page.margins.left + index * sectionWidth;
        doc.font('Helvetica-Bold').text(`${sig.title}:`, startXPos, footerY, { width: sectionWidth - 20 });
        doc.font('Helvetica').text(`Name: ${sig.name}`, startXPos, footerY + 12, { width: sectionWidth - 20 });
        doc.text('Signature: ___________________', startXPos, footerY + 24, { width: sectionWidth - 20 });
        doc.text(`Date: ____ / ____ / ________`, startXPos, footerY + 36, { width: sectionWidth - 20 });
      });

      return footerY + 50;
    }

    drawSignaturesFooter(y);

    doc.end();
  } catch (error) {
    console.error('exportPayrollPdf:', error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Failed to export workers payroll PDF report.' });
    }
  }
}



async function exportDailyAttendanceExcel(req, res) {
  const { date, site_id } = req.query || {};

  if (!isValidDate(date)) {
    return res.status(400).json({
      success: false,
      message: 'A valid date in YYYY-MM-DD format is required.',
    });
  }

  try {
    const ExcelJS = require('exceljs');
    const path = require('path');

    const params = [date];
    let siteFilter = '';

    if (isSpecificSite(site_id)) {
      siteFilter = ' AND a.site_id = ?';
      params.push(site_id);
    }

 const [rows] = await pool.execute(
    `SELECT a.record_date, a.shift_type, w.worker_unique_id, w.full_name AS worker_name,
            s.site_name, a.attendance_status, a.status AS workflow_status,
            a.check_in_time, a.check_out_time, a.total_working_hours,
            a.overtime_hours, a.management_leave_hours, a.remarks,
            a.admin_rejection_notes
     FROM attendance a
     JOIN workers w ON w.worker_id = a.worker_id
     JOIN sites s ON s.site_id = a.site_id
     WHERE a.record_date = ?${siteFilter}
     ORDER BY s.site_name, a.shift_type, w.full_name`,
    params
);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Daily Attendance');

    const logoPath = path.join(__dirname, '../assets//logo.png');
    const logoId = workbook.addImage({ filename: logoPath, extension: 'png' });
    sheet.addImage(logoId, { tl: { col: 0.2, row: 0.15 }, ext: { width: 150, height: 60 } });

sheet.columns = [
    { header: 'No.', key: 'number', width: 8 },
    { header: 'Worker ID', key: 'worker_id', width: 16 },
    { header: 'Worker Name', key: 'worker_name', width: 28 },
    { header: 'Site', key: 'site_name', width: 22 },
    { header: 'Shift', key: 'shift_type', width: 10 },   // ← جديد
    { header: 'Attendance Status', key: 'attendance_status', width: 20 },
    { header: 'Workflow Status', key: 'workflow_status', width: 18 },
    { header: 'Check In', key: 'check_in', width: 22 },
    { header: 'Check Out', key: 'check_out', width: 22 },
    { header: 'Regular Hours', key: 'regular_hours', width: 16 },
    { header: 'Overtime Hours', key: 'overtime_hours', width: 16 },
    { header: 'Management Leave Hours', key: 'management_leave_hours', width: 24 },
    { header: 'Remarks', key: 'remarks', width: 36 },
];

    sheet.mergeCells('A1:L1');
    sheet.getCell('A1').value = `Daily Attendance Report - ${date}`;
    sheet.mergeCells('A2:L2');
    sheet.getCell('A2').value = 'Attendance and hours only — no salary or rate calculation';
    sheet.getRow(1).height = 48;
    sheet.getRow(2).height = 24;
    sheet.getRow(4).values = sheet.columns.map((column) => column.header);

rows.forEach((row, index) => {
    sheet.addRow({
        number: index + 1,
        worker_id: row.worker_unique_id,
        worker_name: row.worker_name,
        site_name: row.site_name,
        shift_type: row.shift_type,   // ← جديد
        attendance_status: row.attendance_status || 'Present',
        workflow_status: row.workflow_status,
        check_in: row.check_in_time || '',
        check_out: row.check_out_time || '',
        regular_hours: Number(row.total_working_hours || 0),
        overtime_hours: Number(row.overtime_hours || 0),
        management_leave_hours: Number(row.management_leave_hours || 0),
        remarks: row.remarks || '',
    });
});

    sheet.getRow(1).font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
    sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getRow(2).font = { italic: true, color: { argb: 'FF555555' } };
    sheet.getRow(2).alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getRow(4).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
    sheet.getRow(4).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

    for (let rowIndex = 5; rowIndex <= sheet.rowCount; rowIndex++) {
      sheet.getCell(`I${rowIndex}`).numFmt = '0.00';
      sheet.getCell(`J${rowIndex}`).numFmt = '0.00';
      sheet.getCell(`K${rowIndex}`).numFmt = '0.00';
    }

    sheet.views = [{ state: 'frozen', ySplit: 4 }];
    sheet.autoFilter = { from: 'A4', to: 'L4' };

    const fileName = `daily_attendance_${date}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('exportDailyAttendanceExcel:', error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Failed to export daily attendance report.' });
    }
  }
}

module.exports = {
  generatePayrollBatch,
  finalizePayrollBatch,
  voidPayrollBatch,
  supersedeFinalizedBatch,
  getPayrollVersionChain,
  getPayrollReport,
  getPayrollBatchDetails,
  markBatchAsPaid,
  getLastBatchEndDate,
  exportPayrollExcel,
  exportPayrollPdf,           // ← جديد
  exportDailyAttendanceExcel,
};