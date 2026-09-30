// Read-only monthly Worker hours & payroll report. Never writes to the DB.
const ExcelJS = require('exceljs');
const pool = require('../config/db');

const { parsePeriod, renderReport, badRequest } = require('./monthlyReportExcelLayout');
const { renderReportPdf } = require('./monthlyReportPdfLayout');

const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

async function loadData(monthStart, monthEnd) {
  const [attendance] = await pool.execute(
    `SELECT a.worker_id, a.site_id, a.shift_type, a.status,
            DATE_FORMAT(a.record_date, '%Y-%m-%d') AS record_date,
            a.total_working_hours, a.overtime_hours,
            s.site_name, s.supports_shifts
     FROM attendance a
     LEFT JOIN sites s ON s.site_id = a.site_id
     WHERE a.record_date BETWEEN ? AND ?`,
    [monthStart, monthEnd]
  );

  const [batches] = await pool.execute(
    `SELECT payroll_batch_id,
            DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date,
            scope_site_id, status, is_finalized, version_number
     FROM payrollbatches
     WHERE status <> 'Superseded' AND start_date <= ? AND end_date >= ?`,
    [monthEnd, monthStart]
  );

  let payrolls = [];
  let items = [];
  if (batches.length) {
    const r1 = await pool.query(
      `SELECT payroll_id, payroll_batch_id, worker_id, net_salary
       FROM payroll WHERE payroll_batch_id IN (?)`,
      [batches.map((b) => b.payroll_batch_id)]
    );
    payrolls = r1[0];
    if (payrolls.length) {
      const r2 = await pool.query(
        `SELECT payroll_id, base_salary, overtime_pay, overtime_hours_worked
         FROM payrollitems WHERE payroll_id IN (?)`,
        [payrolls.map((p) => p.payroll_id)]
      );
      items = r2[0];
    }
  }

  const workerIds = [...new Set([...attendance.map((a) => a.worker_id), ...payrolls.map((p) => p.worker_id)])];
  let workers = [];
  if (workerIds.length) {
    const r3 = await pool.query(
      `SELECT worker_id, worker_unique_id, full_name, job_position
       FROM workers WHERE worker_id IN (?)`,
      [workerIds]
    );
    workers = r3[0];
  }
  return { attendance, batches, payrolls, items, workers };
}

function aggregate({ attendance, batches, payrolls, items, workers }, monthStart, monthEnd) {
  const workerById = new Map(workers.map((w) => [w.worker_id, w]));
  const batchById = new Map(batches.map((b) => [b.payroll_batch_id, b]));
  const rows = new Map();

  const get = (id) => {
    if (!rows.has(id)) {
      const w = workerById.get(id) || {};
      rows.set(id, {
        worker_id: id,
        uid: w.worker_unique_id || `#${id}`,
        name: w.full_name || `Worker #${id}`,
        trade: w.job_position || '',
        sites: new Set(), shifts: new Set(),
        days: {}, dayOt: {}, normal: 0, ot: 0,
        hasPay: false, basic: 0, otPay: 0, total: 0,
        payOt: 0, covOt: 0, uncovered: 0, nonApproved: 0, partialBatch: false,
        flags: [],
      });
    }
    return rows.get(id);
  };

  const covering = (date, siteId) => batches.filter((b) =>
    b.start_date <= date && date <= b.end_date &&
    (b.scope_site_id == null || Number(b.scope_site_id) === Number(siteId)));

  for (const a of attendance) {
    const r = get(a.worker_id);
    if (a.status !== 'Approved') { r.nonApproved += 1; continue; } // payroll uses Approved only
    const reg = Number(a.total_working_hours || 0);
    const ot = Number(a.overtime_hours || 0);
    const day = Number(a.record_date.slice(8, 10));
    r.days[day] = (r.days[day] || 0) + reg + ot;
    r.dayOt[day] = (r.dayOt[day] || 0) + ot;
    r.normal += reg;
    r.ot += ot;
    if (a.site_name) r.sites.add(a.site_name);
    if (Number(a.supports_shifts) === 1) r.shifts.add(a.shift_type);

    const cov = covering(a.record_date, a.site_id);
    if (cov.length === 0) r.uncovered += 1;
    else {
      r.covOt += ot;
      if (cov.length > 1) r.flags.push(`${a.record_date}: covered by more than one payroll batch`);
    }
  }

  const itemsByPayroll = new Map();
  for (const it of items) {
    if (!itemsByPayroll.has(it.payroll_id)) itemsByPayroll.set(it.payroll_id, []);
    itemsByPayroll.get(it.payroll_id).push(it);
  }

  for (const p of payrolls) {
    const r = get(p.worker_id);
    const b = batchById.get(p.payroll_batch_id);
    const its = itemsByPayroll.get(p.payroll_id) || [];
    const base = its.reduce((s, i) => s + Number(i.base_salary || 0), 0);
    const otPay = its.reduce((s, i) => s + Number(i.overtime_pay || 0), 0);
    r.hasPay = true;
    r.basic += base;
    r.otPay += otPay;
    r.total += Number(p.net_salary || 0);
    r.payOt += its.reduce((s, i) => s + Number(i.overtime_hours_worked || 0), 0);

    if (Math.abs(Number(p.net_salary || 0) - (base + otPay)) > 0.01) {
      r.flags.push(`Batch #${b.payroll_batch_id}: net salary differs from base + OT pay (bonus/penalty/deduction present)`);
    }
    if (b.start_date < monthStart || b.end_date > monthEnd) {
      r.partialBatch = true;
      r.flags.push(`Batch #${b.payroll_batch_id} (${b.start_date} → ${b.end_date}) extends outside the selected period; pay covers the whole batch`);
    }
    if (!b.is_finalized) r.flags.push(`Batch #${b.payroll_batch_id} is not finalized`);
  }

  for (const r of rows.values()) {
    if (!r.hasPay && r.normal + r.ot > 0) r.flags.push('No payroll batch covers this worker in the selected period (pay left blank)');
    if (r.hasPay && r.uncovered > 0) r.flags.push(`${r.uncovered} approved attendance record(s) not covered by any payroll batch`);
    if (r.nonApproved > 0) r.flags.push(`${r.nonApproved} non-approved attendance record(s) excluded (Draft/Submitted/Rejected)`);
    if (r.hasPay && !r.partialBatch && Math.abs(r.covOt - r.payOt) > 0.01) {
      r.flags.push(`OT hours in attendance (${round2(r.covOt)}) differ from payroll items (${round2(r.payOt)})`);
    }
  }

  return [...rows.values()]
    .filter((r) => r.normal + r.ot > 0 || r.hasPay)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildSpec(rows, batches, period) {

  const t = { days: {}, monthly: 0, normal: 0, ot: 0, basic: 0, otPay: 0, total: 0 };
  const flags = [];
  const outRows = rows.map((r, idx) => {
    const monthly = r.normal + r.ot;
    const days = {};
    period.days.forEach(({ d }) => {
      if (!r.days[d]) return;
      days[d] = { value: round2(r.days[d]), tone: r.dayOt[d] > 0 ? 'ot' : undefined };
      t.days[d] = round2((t.days[d] || 0) + r.days[d]);
    });
    t.monthly += monthly; t.normal += r.normal; t.ot += r.ot;
    if (r.hasPay) { t.basic += r.basic; t.otPay += r.otPay; t.total += r.total; }
    r.flags.forEach((f) => flags.push({ id: r.uid, name: r.name, flag: f }));
    return {
      fixed: [idx + 1, r.name, r.trade, [...r.shifts].map((x) => String(x).toUpperCase()).join(' / '),
        r.uid, [...r.sites].join(', ')],
      days,
      tail: [round2(monthly), round2(r.normal), round2(r.ot),
        r.hasPay ? round2(r.basic) : '', r.hasPay ? round2(r.otPay) : '', r.hasPay ? round2(r.total) : '',
        r.flags.length],
    };
  });

  const notes = [
    'Hours: approved attendance only (manual & biometric final records). Pay: stored payroll batch values — not recalculated. Currency: Syrian Pound (ل.س).',
    batches.length
      ? 'Payroll batches: ' + batches.map((b) =>
          `#${b.payroll_batch_id} (${b.start_date} → ${b.end_date}, ${b.status}${b.is_finalized ? ', finalized' : ', not finalized'})`).join(' • ')
      : 'No payroll batch overlaps this period — pay columns are left blank.',
  ];
  if (!period.isFullMonth) {
    notes.push('Custom date range: pay columns show the stored value of each overlapping payroll batch (a batch may cover days outside this range — see Flags).');
  }

  return {
    period,
    currency: 'SYP',
    sheetName: 'Labor Hours & Payroll',
    title: `LABORS MONTHLY WORKING HOURS & PAYROLL — ${period.monthLabel.toUpperCase()}`,
    subtitle: `Period: ${period.periodLabel}   •   ${period.rangeStart} → ${period.rangeEnd}   •   Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    notes,
    kpis: [
      { label: 'Workers', value: rows.length, fmt: 'int' },
      { label: 'Monthly Hours', value: round2(t.monthly), fmt: 'hours' },
      { label: 'Normal Hours', value: round2(t.normal), fmt: 'hours' },
      { label: 'OT Hours', value: round2(t.ot), fmt: 'hours' },
      { label: 'Basic Pay', value: round2(t.basic), fmt: 'money' },
      { label: 'OT Pay', value: round2(t.otPay), fmt: 'money' },
      { label: 'Total Payroll', value: round2(t.total), fmt: 'money' },
    ],
    fixedCols: [
      { header: 'S/N', width: 5 },
      { header: 'Worker Name', width: 28, align: 'left', fontSize: 11, bold: true },
      { header: 'TRADE', width: 14 },
      { header: 'Shift', width: 9 },
      { header: 'Worker ID', width: 13 },
      { header: 'Site', width: 18 },
    ],
    tailCols: [
      { header: 'Monthly\nHours', width: 11, kind: 'hoursStrong' },
      { header: 'NORMAL\nHOURS', width: 11, kind: 'hours' },
      { header: 'OT\nHOURS', width: 10, kind: 'hours' },
      { header: 'BASIC\nPAY', width: 17, kind: 'money' },
      { header: 'OT\nPAY', width: 16, kind: 'money' },
      { header: 'TOTAL', width: 18, kind: 'total' },
      { header: 'Flags', width: 8, kind: 'flags' },
    ],
    days: period.days,
    rows: outRows,
    totals: {
      days: t.days,
      tail: [round2(t.monthly), round2(t.normal), round2(t.ot), round2(t.basic), round2(t.otPay), round2(t.total), ''],
    },
    legend: [
      { code: '11', tone: 'ot', label: 'Day includes overtime hours' },
      { code: 'Fri', tone: 'friday', label: 'Friday' },
    ],
    flags,
    entityLabel: 'workers',
    entityIdLabel: 'Worker ID',
    entityNameLabel: 'Worker Name',
  };
}

async function loadSpec(month, year, from, to) {
  const period = parsePeriod(month, year, from, to);
  const data = await loadData(period.rangeStart, period.rangeEnd);
  const rows = aggregate(data, period.rangeStart, period.rangeEnd);
  if (!rows.length) throw badRequest('No approved attendance or payroll data found for the selected period.');
  return buildSpec(rows, data.batches, period);
}

async function generateWorkerMonthlyReport(month, year, from, to) {
  const spec = await loadSpec(month, year, from, to);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Team Flow';
  wb.created = new Date();
  renderReport(wb, spec);
  const buffer = await wb.xlsx.writeBuffer();
  return { buffer, fileName: `labor_hours_payroll_${spec.period.fileSuffix}.xlsx` };
}

async function generateWorkerMonthlyReportPdf(month, year, from, to) {
  const spec = await loadSpec(month, year, from, to);
  const buffer = await renderReportPdf(spec);
  return { buffer, fileName: `labor_hours_payroll_${spec.period.fileSuffix}.pdf` };
}

module.exports = { generateWorkerMonthlyReport, generateWorkerMonthlyReportPdf };
