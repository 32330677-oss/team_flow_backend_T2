// Read-only monthly STAFF hours & payroll report. Independent from the Worker report.
const ExcelJS = require('exceljs');
const pool = require('../config/db');
const { isFriday } = require('./staffAttendanceService');

const { parsePeriod, renderReport, badRequest } = require('./monthlyReportExcelLayout');
const { renderReportPdf } = require('./monthlyReportPdfLayout');

const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const STATUS_CODE = { Absent: 'A', Sick: 'S', Vacation: 'V', Holiday: 'H' };

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
        days: {}, dayOt: {}, normal: 0, ot: 0, contrib: [],
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
          r.dayOt[day] = reg + ot;
          r.ot += reg + ot;
          r.contrib.push({ date: a.record_date, ot: reg + ot });
        } else {
          r.flags.push(`${a.record_date}: Present on Friday without Friday confirmation — excluded (same as payroll)`);
        }
      } else {
        r.days[day] = reg + ot;
        r.dayOt[day] = ot;
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
      r.flags.push(`Batch #${b.staff_payroll_batch_id} (${b.start_date} → ${b.end_date}) extends outside the selected period; pay covers the whole batch`);
    }
    if (!b.is_finalized) r.flags.push(`Batch #${b.staff_payroll_batch_id} is not finalized`);
  }

  for (const r of rows.values()) {
    if (!r.hasPay && (r.normal + r.ot > 0 || Object.keys(r.days).length)) {
      r.flags.push('No staff payroll batch covers this employee in the selected period (pay left blank)');
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

function buildSpec(rows, batches, period) {

  const t = { days: {}, monthly: 0, normal: 0, ot: 0, basic: 0, deduction: 0, total: 0 };
  const flags = [];
  const outRows = rows.map((r, idx) => {
    const monthly = r.normal + r.ot;
    const days = {};
    period.days.forEach(({ d }) => {
      const v = r.days[d];
      if (v === undefined) return;
      if (typeof v === 'number') {
        days[d] = { value: round2(v), tone: r.dayOt[d] > 0 ? 'ot' : undefined };
        t.days[d] = round2((t.days[d] || 0) + v);
      } else {
        days[d] = { value: v, tone: v === '?' ? undefined : v };
      }
    });
    t.monthly += monthly; t.normal += r.normal; t.ot += r.ot;
    if (r.hasPay) { t.basic += r.basic; t.deduction += r.deduction; t.total += r.total; }
    r.flags.forEach((f) => flags.push({ id: r.uid, name: r.name, flag: f }));
    return {
      fixed: [idx + 1, r.name, r.position, r.site, r.uid],
      days,
      tail: [round2(monthly), round2(r.normal), round2(r.ot),
        r.hasPay ? round2(r.basic) : '', r.hasPay ? 0 : '',
        r.hasPay ? round2(r.deduction) : '', r.hasPay ? round2(r.total) : '',
        r.flags.length],
    };
  });

  const notes = [
    'Hours: approved staff attendance only. Confirmed-Friday hours count as OT. Pay: stored staff payroll batch values — not recalculated. Currency: US Dollar ($).',
    'OT PAY is 0 by design: existing Staff payroll does not pay overtime in cash; earned OT only offsets shortage hours (reflected in DEDUCTION). TOTAL = BASIC PAY − DEDUCTION.',
    batches.length
      ? 'Payroll batches: ' + batches.map((b) =>
          `#${b.staff_payroll_batch_id} (${b.start_date} → ${b.end_date}, ${b.status}${b.is_finalized ? ', finalized' : ', not finalized'})`).join(' • ')
      : 'No staff payroll batch overlaps this period — pay columns are left blank.',
  ];
  if (!period.isFullMonth) {
    notes.push('Custom date range: pay columns show the stored value of each overlapping payroll batch (a batch may cover days outside this range — see Flags).');
  }

  return {
    period,
    currency: 'USD',
    sheetName: 'Staff Hours & Payroll',
    title: `STAFF MONTHLY WORKING HOURS & PAYROLL — ${period.monthLabel.toUpperCase()}`,
    subtitle: `Period: ${period.periodLabel}   •   ${period.rangeStart} → ${period.rangeEnd}   •   Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    notes,
    kpis: [
      { label: 'Employees', value: rows.length, fmt: 'int' },
      { label: 'Monthly Hours', value: round2(t.monthly), fmt: 'hours' },
      { label: 'Normal Hours', value: round2(t.normal), fmt: 'hours' },
      { label: 'OT Hours', value: round2(t.ot), fmt: 'hours' },
      { label: 'Basic Pay', value: round2(t.basic), fmt: 'money' },
      { label: 'Deductions', value: round2(t.deduction), fmt: 'money' },
      { label: 'Total Payroll', value: round2(t.total), fmt: 'money' },
    ],
    fixedCols: [
      { header: 'S/N', width: 5 },
      { header: 'Staff Name', width: 28, align: 'left', fontSize: 11, bold: true },
      { header: 'Position', width: 16 },
      { header: 'Site (current)', width: 16 },
      { header: 'Staff ID', width: 13 },
    ],
    tailCols: [
      { header: 'Monthly\nHours', width: 11, kind: 'hoursStrong' },
      { header: 'NORMAL\nHOURS', width: 11, kind: 'hours' },
      { header: 'OT\nHOURS', width: 10, kind: 'hours' },
      { header: 'BASIC\nPAY', width: 17, kind: 'money' },
      { header: 'OT\nPAY', width: 12, kind: 'money' },
      { header: 'DEDUCTION', width: 15, kind: 'money' },
      { header: 'TOTAL', width: 18, kind: 'total' },
      { header: 'Flags', width: 8, kind: 'flags' },
    ],
    days: period.days,
    rows: outRows,
    totals: {
      days: t.days,
      tail: [round2(t.monthly), round2(t.normal), round2(t.ot), round2(t.basic), 0, round2(t.deduction), round2(t.total), ''],
    },
    legend: [
      { code: '8', tone: 'ot', label: 'Day includes OT hours' },
      { code: 'A', tone: 'A', label: 'Absent' },
      { code: 'A*', tone: 'A*', label: 'Management-paid absence' },
      { code: 'S', tone: 'S', label: 'Sick leave' },
      { code: 'V', tone: 'V', label: 'Vacation' },
      { code: 'H', tone: 'H', label: 'Holiday' },
      { code: 'Fri', tone: 'friday', label: 'Friday' },
    ],
    flags,
    entityLabel: 'employees',
    entityIdLabel: 'Staff ID',
    entityNameLabel: 'Staff Name',
  };
}

async function loadSpec(month, year, from, to) {
  const period = parsePeriod(month, year, from, to);
  const data = await loadData(period.rangeStart, period.rangeEnd);
  const rows = aggregate(data, period.rangeStart, period.rangeEnd);
  if (!rows.length) throw badRequest('No approved staff attendance or payroll data found for the selected period.');
  return buildSpec(rows, data.batches, period);
}

async function generateStaffMonthlyReport(month, year, from, to) {
  const spec = await loadSpec(month, year, from, to);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Team Flow';
  wb.created = new Date();
  renderReport(wb, spec);
  const buffer = await wb.xlsx.writeBuffer();
  return { buffer, fileName: `staff_hours_payroll_${spec.period.fileSuffix}.xlsx` };
}

async function generateStaffMonthlyReportPdf(month, year, from, to) {
  const spec = await loadSpec(month, year, from, to);
  const buffer = await renderReportPdf(spec);
  return { buffer, fileName: `staff_hours_payroll_${spec.period.fileSuffix}.pdf` };
}

module.exports = { generateStaffMonthlyReport, generateStaffMonthlyReportPdf };
