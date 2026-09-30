// Presentation-only helpers shared by the Worker and Staff monthly reports.
// NO payroll / attendance logic lives here: each report service keeps its own
// data loading and aggregation. This file only validates the requested period
// and paints the Excel sheet (layout modelled on "LABORS HOURS AND PAYROLL - JULY-AIRPORT.xlsx").

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');

// Same accounting format as the reference workbook (Syrian pound).
const SYP_FMT = '_-* #,##0\\ [$ل.س.‏-2801]_-;\\-* #,##0\\ [$ل.س.‏-2801]_-;_-* "-"??\\ [$ل.س.‏-2801]_-;_-@_-';
const USD_FMT = '_-"$"* #,##0.00_-;-"$"* #,##0.00_-;_-"$"* "-"??_-;_-@_-';
const HOURS_FMT = '#,##0.00;-#,##0.00;"-"';

const C = {
  navy: 'FF1A2A6C', navy2: 'FF2E4190', ink: 'FF1F2937', muted: 'FF6B7280', white: 'FFFFFFFF',
  headLight: 'FFE8EEF7', zebra: 'FFF7F9FC', grid: 'FFC9D3E6', friday: 'FFEEF1F8',
  hoursHead: 'FFDCE6F5', moneyHead: 'FFE2F0D9', moneyInk: 'FF375623',
  totalCell: 'FFEEF3FB', totalsRow: 'FFD9EAF7',
  amber: 'FFFFF2CC', amberInk: 'FF7F6000', okInk: 'FF2E7D32',
};

// Day-cell tones (worker OT days + staff status codes).
const TONES = {
  ot: { fill: 'FFFFF2CC', font: 'FF9C5700', bold: true },
  A: { fill: 'FFFDE2E1', font: 'FF9C0006', bold: true },
  'A*': { fill: 'FFFCE4D6', font: 'FF843C0C', bold: true },
  S: { fill: 'FFE4DFEC', font: 'FF5B3E8A', bold: true },
  V: { fill: 'FFE2F0D9', font: 'FF375623', bold: true },
  H: { fill: 'FFDDEBF7', font: 'FF1F4E79', bold: true },
};

function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

/**
 * month/year are required. from/to (YYYY-MM-DD) are optional and must both lie
 * inside the selected month; when omitted the whole calendar month is used.
 */
function parsePeriod(month, year, from, to) {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw badRequest('month must be an integer between 1 and 12.');
  if (!Number.isInteger(y) || y < 2020 || y > 2100) throw badRequest('year must be between 2020 and 2100.');
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prefix = `${y}-${pad(m)}-`;

  const dayOf = (value, label) => {
    if (value === undefined || value === null || value === '') return null;
    const s = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest(`${label} must be in YYYY-MM-DD format.`);
    if (!s.startsWith(prefix)) throw badRequest(`${label} must be inside ${MONTH_NAMES[m - 1]} ${y}.`);
    const d = Number(s.slice(8, 10));
    if (d < 1 || d > daysInMonth) throw badRequest(`${label} is not a valid day of ${MONTH_NAMES[m - 1]} ${y}.`);
    return d;
  };

  const startDay = dayOf(from, 'from') ?? 1;
  const endDay = dayOf(to, 'to') ?? daysInMonth;
  if (startDay > endDay) throw badRequest('"from" date must be on or before the "to" date.');

  const days = [];
  for (let d = startDay; d <= endDay; d += 1) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    days.push({ d, dow: DOW[dow], isFriday: dow === 5 });
  }
  const isFullMonth = startDay === 1 && endDay === daysInMonth;
  const rangeStart = `${prefix}${pad(startDay)}`;
  const rangeEnd = `${prefix}${pad(endDay)}`;
  return {
    m, y, daysInMonth, startDay, endDay, days, isFullMonth, rangeStart, rangeEnd,
    // kept for backwards compatibility with existing callers
    monthStart: rangeStart, monthEnd: rangeEnd,
    monthLabel: `${MONTH_NAMES[m - 1]} ${y}`,
    periodLabel: isFullMonth
      ? `${MONTH_NAMES[m - 1]} ${y} (full month)`
      : `${pad(startDay)} – ${pad(endDay)} ${MONTH_NAMES[m - 1]} ${y}`,
    fileSuffix: isFullMonth ? `${y}-${pad(m)}` : `${rangeStart}_to_${rangeEnd}`,
  };
}

const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: C.grid } };
const gridBorder = { top: thin, left: thin, bottom: thin, right: thin };

// Split [1..lastCol] into n groups of roughly equal visual width.
function splitColumns(widths, n) {
  const total = widths.reduce((s, w) => s + w, 0);
  const groups = [];
  let start = 1;
  let acc = 0;
  for (let g = 1; g <= n; g += 1) {
    const target = (total * g) / n;
    let end = start;
    acc += widths[end - 1];
    while (end < widths.length && acc + widths[end] / 2 < target && widths.length - end > n - g) {
      end += 1;
      acc += widths[end - 1];
    }
    if (g === n) end = widths.length;
    groups.push([start, end]);
    start = end + 1;
  }
  return groups;
}

/**
 * spec = {
 *   sheetName, title, subtitle, notes: [string],
 *   kpis: [{ label, value, fmt: 'int'|'hours'|'money' }],
 *   fixedCols: [{ header, width, align }],
 *   tailCols:  [{ header, width, kind: 'hours'|'hoursStrong'|'money'|'total'|'flags' }],
 *   days: period.days,
 *   rows: [{ fixed: [...], days: { [d]: { value, tone } }, tail: [...] }],
 *   totals: { days: { [d]: number }, tail: [...] },
 *   legend: [{ tone, label }],
 *   flags: [{ id, name, flag }], entityLabel,
 * }
 */
function renderReport(wb, spec) {
  const MONEY_FMT = spec.currency === 'USD' ? USD_FMT : SYP_FMT;
  const ws = wb.addWorksheet(spec.sheetName, {
    properties: { tabColor: { argb: C.navy } },
    views: [{ showGridLines: false }],
  });

  const F = spec.fixedCols.length;
  const D = spec.days.length;
  const T = spec.tailCols.length;
  const lastCol = F + D + T;
  const dayCol = (i) => F + 1 + i;
  const tailCol = (i) => F + D + 1 + i;

  const widths = [
    ...spec.fixedCols.map((c) => c.width),
    ...spec.days.map(() => 4.6),
    ...spec.tailCols.map((c) => c.width),
  ];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // ---- Title band -------------------------------------------------------
  let r = 1;
  const band = (text, { bg, color, size, bold, height, italic, align = 'center' }) => {
    ws.mergeCells(r, 1, r, lastCol);
    const cell = ws.getCell(r, 1);
    cell.value = text;
    cell.fill = fill(bg);
    cell.font = { name: 'Calibri', size, bold, italic, color: { argb: color } };
    cell.alignment = { horizontal: align, vertical: 'middle', wrapText: true, indent: align === 'left' ? 1 : 0 };
    ws.getRow(r).height = height;
    r += 1;
  };
  band(spec.title, { bg: C.navy, color: C.white, size: 18, bold: true, height: 36 });
  band(spec.subtitle, { bg: C.navy2, color: C.white, size: 11, bold: true, height: 22 });
  spec.notes.forEach((n) => band(n, { bg: C.headLight, color: C.navy, size: 9, italic: true, height: 18, align: 'left' }));
  ws.getRow(r).height = 8; r += 1;

  // ---- KPI cards --------------------------------------------------------
  if (spec.kpis && spec.kpis.length) {
    const groups = splitColumns(widths, spec.kpis.length);
    const fmtOf = { int: '#,##0', hours: '#,##0.00', money: MONEY_FMT };
    spec.kpis.forEach((k, i) => {
      const [a, b] = groups[i];
      const side = { style: 'medium', color: { argb: C.white } };
      ws.mergeCells(r, a, r, b);
      const lc = ws.getCell(r, a);
      lc.value = k.label.toUpperCase();
      lc.fill = fill(C.headLight);
      lc.font = { size: 8.5, bold: true, color: { argb: C.muted } };
      lc.alignment = { horizontal: 'center', vertical: 'middle' };
      lc.border = { left: side, right: side };
      ws.mergeCells(r + 1, a, r + 1, b);
      const vc = ws.getCell(r + 1, a);
      vc.value = k.value;
      vc.numFmt = fmtOf[k.fmt] || 'General';
      vc.fill = fill(C.headLight);
      vc.font = { size: 14, bold: true, color: { argb: C.navy } };
      vc.alignment = { horizontal: 'center', vertical: 'middle' };
      vc.border = { left: side, right: side, bottom: { style: 'thick', color: { argb: C.navy } } };
    });
    ws.getRow(r).height = 16;
    ws.getRow(r + 1).height = 26;
    r += 2;
    ws.getRow(r).height = 10; r += 1;
  }

  // ---- Two-row header (weekday / day number) ----------------------------
  const h1 = r;
  const h2 = r + 1;
  const headStyle = (cell, bg, color) => {
    cell.fill = fill(bg);
    cell.font = { size: 9, bold: true, color: { argb: color } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'medium', color: { argb: C.navy } }, left: thin, right: thin,
      bottom: { style: 'medium', color: { argb: C.navy } },
    };
  };
  spec.fixedCols.forEach((c, i) => {
    ws.mergeCells(h1, i + 1, h2, i + 1);
    const cell = ws.getCell(h1, i + 1);
    cell.value = c.header;
    headStyle(cell, C.headLight, C.navy);
  });
  spec.days.forEach((d, i) => {
    const bg = d.isFriday ? C.navy : C.headLight;
    const fg = d.isFriday ? C.white : C.navy;
    const top = ws.getCell(h1, dayCol(i));
    top.value = d.dow;
    headStyle(top, bg, fg);
    top.font = { size: 8, bold: true, color: { argb: fg } };
    const num = ws.getCell(h2, dayCol(i));
    num.value = d.d;
    headStyle(num, bg, fg);
  });
  const tailHead = {
    hours: [C.hoursHead, C.navy], hoursStrong: [C.hoursHead, C.navy],
    money: [C.moneyHead, C.moneyInk], total: [C.navy, C.white], flags: [C.amber, C.amberInk],
  };
  spec.tailCols.forEach((c, i) => {
    ws.mergeCells(h1, tailCol(i), h2, tailCol(i));
    const cell = ws.getCell(h1, tailCol(i));
    cell.value = c.header;
    const [bg, fg] = tailHead[c.kind];
    headStyle(cell, bg, fg);
  });
  ws.getRow(h1).height = 20;
  ws.getRow(h2).height = 20;
  r = h2 + 1;

  // ---- Body -------------------------------------------------------------
  const firstBody = r;
  spec.rows.forEach((row, idx) => {
    const zebra = idx % 2 === 1 ? C.zebra : C.white;
    const xr = ws.getRow(r);
    xr.height = 19;

    spec.fixedCols.forEach((c, i) => {
      const cell = ws.getCell(r, i + 1);
      cell.value = row.fixed[i] ?? '';
      cell.fill = fill(zebra);
      cell.border = gridBorder;
      cell.font = { size: c.fontSize || 10, bold: !!c.bold, color: { argb: C.ink } };
      cell.alignment = { horizontal: c.align || 'center', vertical: 'middle', indent: c.align === 'left' ? 1 : 0 };
    });

    spec.days.forEach((d, i) => {
      const cell = ws.getCell(r, dayCol(i));
      const entry = row.days[d.d];
      const tone = entry && entry.tone ? TONES[entry.tone] : null;
      cell.value = entry ? entry.value : '';
      cell.fill = fill(tone ? tone.fill : d.isFriday ? C.friday : zebra);
      cell.font = { size: 9, bold: tone ? tone.bold : false, color: { argb: tone ? tone.font : C.ink } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = gridBorder;
    });

    spec.tailCols.forEach((c, i) => {
      const cell = ws.getCell(r, tailCol(i));
      const v = row.tail[i];
      cell.border = gridBorder;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.fill = fill(zebra);
      cell.font = { size: 10, color: { argb: C.ink } };
      if (c.kind === 'flags') {
        const n = Number(v || 0);
        cell.value = n > 0 ? `⚠ ${n}` : '✓';
        cell.font = { size: 10, bold: true, color: { argb: n > 0 ? C.amberInk : C.okInk } };
        if (n > 0) cell.fill = fill(C.amber);
        return;
      }
      cell.value = v === undefined ? '' : v;
      if (c.kind === 'hours' || c.kind === 'hoursStrong') {
        cell.numFmt = HOURS_FMT;
        if (c.kind === 'hoursStrong') cell.font = { size: 10, bold: true, color: { argb: C.navy } };
      } else {
        cell.numFmt = MONEY_FMT;
        if (c.kind === 'total') {
          cell.fill = fill(C.totalCell);
          cell.font = { size: 10, bold: true, color: { argb: C.navy } };
        }
      }
    });
    r += 1;
  });

  // ---- Grand total row --------------------------------------------------
  const tr = r;
  ws.mergeCells(tr, 1, tr, F);
  const totalBorder = {
    top: { style: 'medium', color: { argb: C.navy } }, bottom: { style: 'double', color: { argb: C.navy } },
    left: thin, right: thin,
  };
  const paintTotal = (cell) => {
    cell.fill = fill(C.totalsRow);
    cell.font = { size: 10, bold: true, color: { argb: C.navy } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = totalBorder;
  };
  ws.getCell(tr, 1).value = `GRAND TOTAL  (${spec.rows.length} ${spec.entityLabel})`;
  for (let c = 1; c <= F; c += 1) paintTotal(ws.getCell(tr, c));
  spec.days.forEach((d, i) => {
    const cell = ws.getCell(tr, dayCol(i));
    const v = spec.totals.days[d.d];
    cell.value = v ? v : '';
    paintTotal(cell);
    cell.font = { size: 8, bold: true, color: { argb: C.navy } };
  });
  spec.tailCols.forEach((c, i) => {
    const cell = ws.getCell(tr, tailCol(i));
    paintTotal(cell);
    const v = spec.totals.tail[i];
    cell.value = v === undefined ? '' : v;
    if (c.kind === 'hours' || c.kind === 'hoursStrong') cell.numFmt = HOURS_FMT;
    if (c.kind === 'money' || c.kind === 'total') cell.numFmt = MONEY_FMT;
    if (c.kind === 'total') { cell.fill = fill(C.navy); cell.font = { size: 10.5, bold: true, color: { argb: C.white } }; }
  });
  ws.getRow(tr).height = 24;
  r = tr + 2;

  // ---- Legend (vertical: chip in col 1, label in col 2) ---------------
  if (spec.legend && spec.legend.length) {
    const lab = ws.getCell(r, 1);
    ws.mergeCells(r, 1, r, 2);
    lab.value = 'LEGEND';
    lab.font = { size: 9, bold: true, color: { argb: C.navy } };
    lab.alignment = { horizontal: 'left', vertical: 'middle' };
    lab.border = { bottom: { style: 'thin', color: { argb: C.navy } } };
    ws.getCell(r, 2).border = { bottom: { style: 'thin', color: { argb: C.navy } } };
    r += 1;
    spec.legend.forEach((l) => {
      const t = l.tone === 'friday' ? { fill: C.friday, font: C.navy, bold: true } : TONES[l.tone];
      const chip = ws.getCell(r, 1);
      chip.value = l.code;
      chip.fill = fill(t.fill);
      chip.font = { size: 9, bold: true, color: { argb: t.font } };
      chip.alignment = { horizontal: 'center', vertical: 'middle' };
      chip.border = gridBorder;
      const txt = ws.getCell(r, 2);
      txt.value = l.label;
      txt.font = { size: 9, color: { argb: C.muted } };
      txt.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      ws.getRow(r).height = 16;
      r += 1;
    });
    r += 1;
  }

  // ---- Signatures -------------------------------------------------------
  const sig = splitColumns(widths, 3);
  ['Prepared by', 'Reviewed by', 'Approved by'].forEach((label, i) => {
    const [a, b] = sig[i];
    const b2 = Math.max(a, b - 1);
    ws.mergeCells(r, a, r, b2);
    const lc = ws.getCell(r, a);
    lc.value = label;
    lc.font = { size: 9, bold: true, color: { argb: C.muted } };
    lc.alignment = { horizontal: 'left', vertical: 'bottom', indent: 1 };
    ws.mergeCells(r + 1, a, r + 1, b2);
    const line = ws.getCell(r + 1, a);
    line.border = { bottom: { style: 'thin', color: { argb: C.navy } } };
    for (let c = a; c <= b2; c += 1) ws.getCell(r + 1, c).border = { bottom: { style: 'thin', color: { argb: C.navy } } };
  });
  ws.getRow(r + 1).height = 28;

  // ---- Sheet settings ---------------------------------------------------
  ws.views = [{ showGridLines: false, zoomScale: 90 }]; // no frozen panes — the sheet scrolls normally
  ws.pageSetup = {
    paperSize: 8, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.5, header: 0.2, footer: 0.25 },
    printTitlesRow: `${h1}:${h2}`,
  };
  ws.headerFooter.oddFooter = `&L&8Team Flow — ${spec.sheetName}&C&8Page &P of &N&R&8Printed &D`;
  if (firstBody > tr) ws.getRow(firstBody).height = 19;

  renderFlags(wb, spec);
  return ws;
}

function renderFlags(wb, spec) {
  const fs = wb.addWorksheet('Flags', { properties: { tabColor: { argb: 'FFFFC000' } }, views: [{ showGridLines: false }] });
  [6, 14, 30, 110].forEach((w, i) => { fs.getColumn(i + 1).width = w; });
  fs.mergeCells(1, 1, 1, 4);
  const t = fs.getCell(1, 1);
  t.value = `Data Flags — ${spec.subtitle}`;
  t.fill = fill(C.navy);
  t.font = { size: 13, bold: true, color: { argb: C.white } };
  t.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  fs.getRow(1).height = 26;
  fs.mergeCells(2, 1, 2, 4);
  const s = fs.getCell(2, 1);
  s.value = 'Items below were detected while reading existing data. Nothing was guessed or changed — please review the source records.';
  s.fill = fill(C.headLight);
  s.font = { size: 9, italic: true, color: { argb: C.navy } };
  s.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

  const header = fs.getRow(4);
  header.values = ['#', `${spec.entityIdLabel}`, `${spec.entityNameLabel}`, 'Flag'];
  header.height = 20;
  for (let c = 1; c <= 4; c += 1) {
    const cell = header.getCell(c);
    cell.fill = fill(C.navy2);
    cell.font = { size: 10, bold: true, color: { argb: C.white } };
    cell.alignment = { horizontal: c === 4 ? 'left' : 'center', vertical: 'middle', indent: c === 4 ? 1 : 0 };
    cell.border = gridBorder;
  }
  const flags = spec.flags.length ? spec.flags : [{ id: '', name: '', flag: '✓ No flags — all checks passed.' }];
  flags.forEach((f, i) => {
    const row = fs.getRow(5 + i);
    row.values = [spec.flags.length ? i + 1 : '', f.id, f.name, f.flag];
    for (let c = 1; c <= 4; c += 1) {
      const cell = row.getCell(c);
      cell.fill = fill(i % 2 ? C.zebra : C.white);
      cell.border = gridBorder;
      cell.font = { size: 10, color: { argb: spec.flags.length ? C.ink : C.okInk } };
      cell.alignment = { horizontal: c === 4 || c === 3 ? 'left' : 'center', vertical: 'middle', wrapText: c === 4, indent: c >= 3 ? 1 : 0 };
    }
  });
  fs.views = [{ showGridLines: false }];
}

module.exports = { parsePeriod, renderReport, badRequest, pad, MONTH_NAMES, TONES, C };
