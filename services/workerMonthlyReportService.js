// Read-only monthly Worker hours & payroll report. Never writes to the DB.
const ExcelJS = require('exceljs');
const pool = require('../config/db');

const MONTH_NAMES = ['January','February','March','April','May','June','July',
  'August','September','October','November','December'];
const SYP_FMT = '#,##0 "ل.س"';
const pad = (n) => String(n).padStart(2, '0');
const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

function parseMonthYear(month, year) {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw badRequest('month must be an integer between 1 and 12.');
  if (!Number.isInteger(y) || y < 2020 || y > 2100) throw badRequest('year must be between 2020 and 2100.');
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    m, y, daysInMonth,
    monthStart: `${y}-${pad(m)}-01`,
    monthEnd: `${y}-${pad(m)}-${pad(daysInMonth)}`,
  };
}

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
        days: {}, normal: 0, ot: 0,
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
      r.flags.push(`Batch #${b.payroll_batch_id} (${b.start_date} → ${b.end_date}) extends outside the selected month; pay covers the whole batch`);
    }
    if (!b.is_finalized) r.flags.push(`Batch #${b.payroll_batch_id} is not finalized`);
  }

  for (const r of rows.values()) {
    if (!r.hasPay && r.normal + r.ot > 0) r.flags.push('No payroll batch covers this worker in the selected month (pay left blank)');
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

function buildWorkbook(rows, batches, { m, y, daysInMonth }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Labor Hours & Payroll');

  const fixed = ['No.', 'Worker Name', 'Worker ID', 'Trade / Position', 'Site', 'Shift'];
  const tail = ['Monthly Hours', 'NORMAL HOURS', 'OT HOURS', 'BASIC PAY', 'OT PAY', 'TOTAL', 'Notes'];
  const dayHeaders = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const lastCol = fixed.length + daysInMonth + tail.length;
  const c0 = fixed.length + daysInMonth; // 1-based index just before "Monthly Hours"

  ws.mergeCells(1, 1, 1, lastCol);
  ws.getCell(1, 1).value = `Monthly Labor Hours & Payroll Report — ${MONTH_NAMES[m - 1]} ${y}`;
  ws.getCell(1, 1).font = { bold: true, size: 15 };
  ws.mergeCells(2, 1, 2, lastCol);
  ws.getCell(2, 1).value =
    'Currency: Syrian Pound (ل.س). Hours: approved attendance only. Pay: stored values from payroll batches (not recalculated).';
  ws.mergeCells(3, 1, 3, lastCol);
  ws.getCell(3, 1).value = batches.length
    ? 'Payroll batches used: ' + batches.map((b) =>
        `#${b.payroll_batch_id} (${b.start_date} → ${b.end_date}, ${b.status}${b.is_finalized ? ', finalized' : ', not finalized'})`).join('; ')
    : 'No payroll batch overlaps this month — pay columns are blank.';
  ws.getRow(1).height = 26;

  const header = ws.getRow(5);
  header.values = [...fixed, ...dayHeaders, ...tail];
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.height = 30;

  const totals = { days: Array(daysInMonth).fill(0), monthly: 0, normal: 0, ot: 0, basic: 0, otPay: 0, total: 0 };

  rows.forEach((r, idx) => {
    const monthly = r.normal + r.ot;
    const dayCells = dayHeaders.map((d) => (r.days[d] ? round2(r.days[d]) : ''));
    dayHeaders.forEach((d) => { totals.days[d - 1] += r.days[d] || 0; });
    totals.monthly += monthly; totals.normal += r.normal; totals.ot += r.ot;
    if (r.hasPay) { totals.basic += r.basic; totals.otPay += r.otPay; totals.total += r.total; }

    ws.addRow([
      idx + 1, r.name, r.uid, r.trade, [...r.sites].join(', '), [...r.shifts].join(', '),
      ...dayCells,
      round2(monthly), round2(r.normal), round2(r.ot),
      r.hasPay ? round2(r.basic) : '', r.hasPay ? round2(r.otPay) : '', r.hasPay ? round2(r.total) : '',
      r.flags.join(' | '),
    ]);
  });

  const tr = ws.addRow([
    '', 'GRAND TOTAL', '', '', '', '',
    ...totals.days.map((v) => (v ? round2(v) : '')),
    round2(totals.monthly), round2(totals.normal), round2(totals.ot),
    round2(totals.basic), round2(totals.otPay), round2(totals.total), '',
  ]);
  tr.font = { bold: true };
  tr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4FA' } };

  // widths + formats
  [6, 26, 12, 18, 22, 10].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  dayHeaders.forEach((_, i) => { ws.getColumn(fixed.length + 1 + i).width = 5.5; });
  [12, 13, 11, 15, 13, 16, 60].forEach((w, i) => { ws.getColumn(c0 + 1 + i).width = w; });
  for (let r = 6; r <= ws.rowCount; r += 1) {
    for (let c = fixed.length + 1; c <= c0 + 3; c += 1) {
      ws.getCell(r, c).numFmt = '0.00';
      ws.getCell(r, c).alignment = { horizontal: 'center' };
    }
    [c0 + 4, c0 + 5, c0 + 6].forEach((c) => { ws.getCell(r, c).numFmt = SYP_FMT; });
  }
  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 5 }];

  const fs = wb.addWorksheet('Flags');
  fs.columns = [
    { header: 'Worker ID', key: 'uid', width: 14 },
    { header: 'Worker Name', key: 'name', width: 28 },
    { header: 'Flag', key: 'flag', width: 110 },
  ];
  fs.getRow(1).font = { bold: true };
  rows.forEach((r) => r.flags.forEach((f) => fs.addRow({ uid: r.uid, name: r.name, flag: f })));
  if (fs.rowCount === 1) fs.addRow({ uid: '', name: '', flag: 'No flags — all checks passed.' });

  return wb;
}

async function generateWorkerMonthlyReport(month, year) {
  const period = parseMonthYear(month, year);
  const data = await loadData(period.monthStart, period.monthEnd);
  const rows = aggregate(data, period.monthStart, period.monthEnd);
  if (!rows.length) throw badRequest('No approved attendance or payroll data found for the selected month.');
  const wb = buildWorkbook(rows, data.batches, period);
  const buffer = await wb.xlsx.writeBuffer();
  return { buffer, fileName: `labor_hours_payroll_${period.y}-${pad(period.m)}.xlsx` };
}

module.exports = { generateWorkerMonthlyReport };