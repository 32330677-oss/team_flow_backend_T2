// Read-only monthly STAFF hours & payroll report. Independent from the Worker report.
const ExcelJS = require('exceljs');
const pool = require('../config/db');
const { isFriday } = require('./staffAttendanceService');

const MONTH_NAMES = ['January','February','March','April','May','June','July',
  'August','September','October','November','December'];
const SYP_FMT = '#,##0.00';
const pad = (n) => String(n).padStart(2, '0');
const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const STATUS_CODE = { Absent: 'A', Sick: 'S', Vacation: 'V', Holiday: 'H' };

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
    `SELECT staff_id, DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date,
            attendance_status, status, regular_hours, overtime_hours,
            is_friday_worked, is_management_paid_absence
     FROM staff_attendance
     WHERE record_date BETWEEN ? AND ?`,
    [monthStart, monthEnd]
  );

  const [batches] = await pool.execute(
    `SELECT staff_payroll_batch_id,
            DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date,
            status, is_finalized, version_number
     FROM staff_payroll_batches
     WHERE status <> 'Superseded' AND start_date <= ? AND end_date >= ?`,
    [monthEnd, monthStart]
  );

  let payrolls = [];
  if (batches.length) {
    const r = await pool.query(
      `SELECT staff_payroll_batch_id, staff_id, prorated_base_salary, monthly_salary_snapshot,
              salary_deduction_amount, net_salary, ot_earned_hours
       FROM staff_payroll WHERE staff_payroll_batch_id IN (?)`,
      [batches.map((b) => b.staff_payroll_batch_id)]
    );
    payrolls = r[0];
  }

  const ids = [...new Set([...attendance.map((a) => a.staff_id), ...payrolls.map((p) => p.staff_id)])];
  let staff = [];
  if (ids.length) {
    const r = await pool.query(
      `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.position, s.site_name
       FROM staff_members sm
       LEFT JOIN sites s ON s.site_id = sm.site_id
       WHERE sm.staff_id IN (?)`,
      [ids]
    );
    staff = r[0];
  }
  return { attendance, batches, payrolls, staff };
}

function aggregate({ attendance, batches, payrolls, staff }, monthStart, monthEnd) {
  const staffById = new Map(staff.map((s) => [s.staff_id, s]));
  const batchById = new Map(batches.map((b) => [b.staff_payroll_batch_id, b]));
  const rows = new Map();

  const get = (id) => {
    if (!rows.has(id)) {
      const s = staffById.get(id) || {};
      rows.set(id, {
        staff_id: id,
        uid: s.staff_unique_id || `#${id}`,
        name: s.full_name || `Staff #${id}`,
        position: s.position || '',
        site: s.site_name || '',
        days: {}, normal: 0, ot: 0, contrib: [],
        payrolls: [], hasPay: false, basic: 0, deduction: 0, total: 0,
        nonApproved: 0, flags: [],
      });
    }
    return rows.get(id);
  };

  for (const a of attendance) {
    const r = get(a.staff_id);
    if (a.status !== 'Approved') { r.nonApproved += 1; continue; } // payroll uses Approved only
    const day = Number(a.record_date.slice(8, 10));

    if (a.attendance_status === 'Present') {
      const reg = Number(a.regular_hours || 0);
      const ot = Number(a.overtime_hours || 0);
      if (isFriday(a.record_date)) {
        if (Number(a.is_friday_worked) === 1) {
          // Existing payroll: confirmed Friday hours are entirely overtime.
          r.days[day] = reg + ot;
          r.ot += reg + ot;
          r.contrib.push({ date: a.record_date, ot: reg + ot });
        } else {
          r.flags.push(`${a.record_date}: Present on Friday without Friday confirmation — excluded (same as payroll)`);
        }
      } else {
        r.days[day] = reg + ot;
        r.normal += reg;
        r.ot += ot;
        r.contrib.push({ date: a.record_date, ot });
      }
    } else {
      let code = STATUS_CODE[a.attendance_status] || '?';
      if (a.attendance_status === 'Absent' && Number(a.is_management_paid_absence) === 1) code = 'A*';
      r.days[day] = code;
    }
  }

  for (const p of payrolls) {
    const r = get(p.staff_id);
    const b = batchById.get(p.staff_payroll_batch_id);
    r.hasPay = true;
    r.payrolls.push({ p, b });
    r.basic += Number(p.prorated_base_salary ?? p.monthly_salary_snapshot ?? 0);
    r.deduction += Number(p.salary_deduction_amount || 0);
    r.total += Number(p.net_salary || 0);
    if (b.start_date < monthStart || b.end_date > monthEnd) {
      r.flags.push(`Batch #${b.staff_payroll_batch_id} (${b.start_date} → ${b.end_date}) extends outside the selected month; pay covers the whole batch`);
    }
    if (!b.is_finalized) r.flags.push(`Batch #${b.staff_payroll_batch_id} is not finalized`);
  }

  for (const r of rows.values()) {
    if (!r.hasPay && (r.normal + r.ot > 0 || Object.keys(r.days).length)) {
      r.flags.push('No staff payroll batch covers this employee in the selected month (pay left blank)');
    }
    if (r.nonApproved > 0) r.flags.push(`${r.nonApproved} non-approved attendance record(s) excluded (Draft/Submitted/Rejected)`);
    if (r.payrolls.length === 1) {
      const { p, b } = r.payrolls[0];
      if (b.start_date >= monthStart && b.end_date <= monthEnd) {
        const otInBatch = r.contrib
          .filter((c) => c.date >= b.start_date && c.date <= b.end_date)
          .reduce((s, c) => s + c.ot, 0);
        if (Math.abs(otInBatch - Number(p.ot_earned_hours || 0)) > 0.01) {
          r.flags.push(`OT hours in attendance (${round2(otInBatch)}) differ from payroll ot_earned_hours (${round2(p.ot_earned_hours)}) — review (payroll also limits hours to employment spans)`);
        }
      }
    }
  }

  return [...rows.values()]
    .filter((r) => r.hasPay || r.normal + r.ot > 0 || Object.keys(r.days).length)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildWorkbook(rows, batches, { m, y, daysInMonth }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Staff Hours & Payroll');

  const fixed = ['No.', 'Staff Name', 'Staff ID', 'Position', 'Site (current)'];
  const tail = ['Monthly Hours', 'NORMAL HOURS', 'OT HOURS', 'BASIC PAY', 'OT PAY', 'DEDUCTION', 'TOTAL', 'Notes'];
  const dayHeaders = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const lastCol = fixed.length + daysInMonth + tail.length;
  const c0 = fixed.length + daysInMonth;

  const merged = (row, text, opts = {}) => {
    ws.mergeCells(row, 1, row, lastCol);
    ws.getCell(row, 1).value = text;
    if (opts.font) ws.getCell(row, 1).font = opts.font;
  };
  merged(1, `Monthly Staff Hours & Payroll Report — ${MONTH_NAMES[m - 1]} ${y}`, { font: { bold: true, size: 15 } });
  merged(2, batches.length
    ? 'Payroll batches used: ' + batches.map((b) =>
        `#${b.staff_payroll_batch_id} (${b.start_date} → ${b.end_date}, ${b.status}${b.is_finalized ? ', finalized' : ', not finalized'})`).join('; ')
    : 'No staff payroll batch overlaps this month — pay columns are blank.');
  merged(3, 'OT PAY is 0 by design: existing Staff payroll does not pay overtime in cash; earned OT only offsets shortage hours (reflected in DEDUCTION). TOTAL = BASIC PAY − DEDUCTION.');
  merged(4, 'Day legend: number = hours worked; A = Absent, A* = management-paid absence, S = Sick, V = Vacation, H = Holiday. Confirmed-Friday hours count as OT.');
  ws.getRow(1).height = 26;

  const header = ws.getRow(6);
  header.values = [...fixed, ...dayHeaders, ...tail];
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.height = 30;

  const t = { days: Array(daysInMonth).fill(0), monthly: 0, normal: 0, ot: 0, basic: 0, deduction: 0, total: 0 };

  rows.forEach((r, idx) => {
    const monthly = r.normal + r.ot;
    const dayCells = dayHeaders.map((d) => {
      const v = r.days[d];
      if (v === undefined) return '';
      return typeof v === 'number' ? round2(v) : v;
    });
    dayHeaders.forEach((d) => { if (typeof r.days[d] === 'number') t.days[d - 1] += r.days[d]; });
    t.monthly += monthly; t.normal += r.normal; t.ot += r.ot;
    if (r.hasPay) { t.basic += r.basic; t.deduction += r.deduction; t.total += r.total; }

    ws.addRow([
      idx + 1, r.name, r.uid, r.position, r.site,
      ...dayCells,
      round2(monthly), round2(r.normal), round2(r.ot),
      r.hasPay ? round2(r.basic) : '', r.hasPay ? 0 : '',
      r.hasPay ? round2(r.deduction) : '', r.hasPay ? round2(r.total) : '',
      r.flags.join(' | '),
    ]);
  });

  const tr = ws.addRow([
    '', 'GRAND TOTAL', '', '', '',
    ...t.days.map((v) => (v ? round2(v) : '')),
    round2(t.monthly), round2(t.normal), round2(t.ot),
    round2(t.basic), 0, round2(t.deduction), round2(t.total), '',
  ]);
  tr.font = { bold: true };
  tr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4FA' } };

  [6, 26, 12, 20, 20].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  dayHeaders.forEach((_, i) => { ws.getColumn(fixed.length + 1 + i).width = 5.5; });
  [12, 13, 11, 15, 11, 14, 15, 60].forEach((w, i) => { ws.getColumn(c0 + 1 + i).width = w; });
  for (let r = 7; r <= ws.rowCount; r += 1) {
    for (let c = fixed.length + 1; c <= c0 + 3; c += 1) {
      ws.getCell(r, c).numFmt = '0.00';
      ws.getCell(r, c).alignment = { horizontal: 'center' };
    }
    [c0 + 4, c0 + 5, c0 + 6, c0 + 7].forEach((c) => { ws.getCell(r, c).numFmt = SYP_FMT; });
  }
  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 6 }];

  const fl = wb.addWorksheet('Flags');
  fl.columns = [
    { header: 'Staff ID', key: 'uid', width: 14 },
    { header: 'Staff Name', key: 'name', width: 28 },
    { header: 'Flag', key: 'flag', width: 110 },
  ];
  fl.getRow(1).font = { bold: true };
  rows.forEach((r) => r.flags.forEach((f) => fl.addRow({ uid: r.uid, name: r.name, flag: f })));
  if (fl.rowCount === 1) fl.addRow({ uid: '', name: '', flag: 'No flags — all checks passed.' });

  return wb;
}

async function generateStaffMonthlyReport(month, year) {
  const period = parseMonthYear(month, year);
  const data = await loadData(period.monthStart, period.monthEnd);
  const rows = aggregate(data, period.monthStart, period.monthEnd);
  if (!rows.length) throw badRequest('No approved staff attendance or payroll data found for the selected month.');
  const wb = buildWorkbook(rows, data.batches, period);
  const buffer = await wb.xlsx.writeBuffer();
  return { buffer, fileName: `staff_hours_payroll_${period.y}-${pad(period.m)}.xlsx` };
}

module.exports = { generateStaffMonthlyReport };