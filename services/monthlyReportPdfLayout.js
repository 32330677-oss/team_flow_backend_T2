// Presentation-only PDF renderer shared by the Worker and Staff monthly reports.
// It receives the SAME spec the Excel renderer receives (built separately by
// workerMonthlyReportService / staffMonthlyReportService) and only draws it.
// No payroll / attendance logic lives here.
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { TONES, C } = require('./monthlyReportExcelLayout');

const COMPANY_NAME = 'ASIK ENGINEERING CONSTRUCTION';
const LOGO_PATH = path.join(__dirname, '../assets/logo.png');
const ARABIC_FONT_PATH = path.join(__dirname, '../assets/fonts/NotoNaskhArabic-Regular.ttf');

const hex = (argb) => `#${String(argb).slice(-6)}`;
const P = {
  navy: hex(C.navy), navy2: hex(C.navy2), ink: hex(C.ink), muted: hex(C.muted), white: '#FFFFFF',
  headLight: hex(C.headLight), zebra: hex(C.zebra), grid: hex(C.grid), friday: hex(C.friday),
  hoursHead: hex(C.hoursHead), moneyHead: hex(C.moneyHead), moneyInk: hex(C.moneyInk),
  totalCell: hex(C.totalCell), totalsRow: hex(C.totalsRow), amber: hex(C.amber), amberInk: hex(C.amberInk),
  okInk: hex(C.okInk),
};

const isArabic = (s) => /[؀-ۿ]/.test(String(s || ''));

// Arabic: reverse word order and let fontkit shape the letters with the
// 'rtla' feature (keeps spaces and joins letters correctly).
function shape(str, hasArabicFont) {
  const text = String(str ?? '');
  if (!isArabic(text) || !hasArabicFont) return clean(text);
  return text.trim().split(/\s+/).reverse().join(' ');
}

// Helvetica (WinAnsi) cannot draw some Unicode symbols — swap them for safe equivalents.
function clean(str) {
  return String(str ?? '')
    .replace(/\s*→\s*/g, ' to ')
    .replace(/−/g, '-')
    .replace(/\(ل\.س\)/g, '(SYP)')
    .replace(/ل\.س\.?/g, 'SYP');
}

const groupInt = (n) => Math.round(Number(n || 0)).toLocaleString('en-US');
const fmtHours = (v) => {
  if (v === '' || v === undefined || v === null) return '';
  const n = Number(v);
  if (!n) return '-';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtDay = (v) => {
  if (typeof v !== 'number') return String(v ?? '');
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};

function renderReportPdf(spec) {
  const usd = spec.currency === 'USD';
  const fmtMoney = (v) => {
    if (v === '' || v === undefined || v === null) return '';
    const n = Number(v);
    if (usd) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return n ? groupInt(n) : '-';
  };
  const moneyKpi = (v) => (usd ? fmtMoney(v) : `${groupInt(v)} SYP`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A3', layout: 'landscape', margin: 28, bufferPages: true,
      info: { Title: spec.title, Author: 'Team Flow', Subject: spec.subtitle } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const hasArabicFont = fs.existsSync(ARABIC_FONT_PATH);
    if (hasArabicFont) doc.registerFont('Arabic', ARABIC_FONT_PATH);
    const hasLogo = fs.existsSync(LOGO_PATH);

    const L = doc.page.margins.left;
    const pageW = doc.page.width - L - doc.page.margins.right;
    const bottomLimit = () => doc.page.height - 40; // leave room for footer

    const fontFor = (s, bold) => (hasArabicFont && isArabic(s) ? 'Arabic' : bold ? 'Helvetica-Bold' : 'Helvetica');

    const rect = (x, y, w, h, color) => { doc.save().rect(x, y, w, h).fill(color).restore(); };
    const strokeRect = (x, y, w, h, color = P.grid, lw = 0.5) => {
      doc.save().lineWidth(lw).rect(x, y, w, h).stroke(color).restore();
    };
    const line = (x1, y1, x2, y2, color, lw = 1) => {
      doc.save().lineWidth(lw).moveTo(x1, y1).lineTo(x2, y2).stroke(color).restore();
    };
    const text = (str, x, y, w, h, o = {}) => {
      const raw = String(str ?? '');
      if (!raw) return;
      const s = shape(raw, hasArabicFont);
      const size = o.size || 7;
      const lines = raw.split('\n').length;
      const ty = y + (h - size * 1.15 * lines) / 2 + 0.5;
      doc.font(o.font || fontFor(raw, o.bold)).fontSize(size).fillColor(o.color || P.ink)
        .text(s, x + 2, ty, {
          width: w - 4, align: o.align || 'center', lineGap: 0, height: h, ellipsis: lines === 1,
          features: isArabic(raw) && hasArabicFont ? ['rtla'] : undefined,
        });
    };

    // ---- column geometry (scaled from the Excel widths) -----------------
    const cols = [
      ...spec.fixedCols.map((c) => ({ ...c, type: 'fixed' })),
      ...spec.days.map((d) => ({ width: 4.6, type: 'day', day: d })),
      ...spec.tailCols.map((c) => ({ ...c, type: 'tail' })),
    ];
    const scale = pageW / cols.reduce((s, c) => s + c.width, 0);
    let cx = L;
    cols.forEach((c) => { c.x = cx; c.w = c.width * scale; cx += c.w; });
    const F = spec.fixedCols.length;
    const fixedW = cols.slice(0, F).reduce((s, c) => s + c.w, 0);

    // ---- page header ----------------------------------------------------
    function drawPageHeader(first) {
      let y = doc.page.margins.top;
      const logoH = first ? 46 : 30;
      if (hasLogo) {
        try { doc.image(LOGO_PATH, L, y, { fit: [first ? 120 : 80, logoH] }); } catch (_) { /* ignore bad logo */ }
      }
      doc.font('Helvetica-Bold').fontSize(first ? 17 : 12).fillColor(P.navy)
        .text(clean(spec.title), L, y + (first ? 2 : 4), { width: pageW, align: 'center' });
      doc.font('Helvetica').fontSize(first ? 9 : 8).fillColor(P.muted)
        .text(first ? COMPANY_NAME : `${COMPANY_NAME}  •  ${spec.period.periodLabel}  (continued)`,
          L, y + (first ? 24 : 20), { width: pageW, align: 'center' });
      doc.font('Helvetica').fontSize(8).fillColor(P.muted)
        .text(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, L, y + 2, { width: pageW, align: 'right' });
      y += logoH + 6;
      line(L, y, L + pageW, y, P.navy, 2);
      y += 6;
      if (!first) return y;

      // Period band
      rect(L, y, pageW, 20, P.navy2);
      text(spec.subtitle, L, y, pageW, 20, { size: 9.5, bold: true, color: P.white });
      y += 26;

      // KPI cards
      const gap = 8;
      const n = spec.kpis.length;
      const kw = (pageW - gap * (n - 1)) / n;
      spec.kpis.forEach((k, i) => {
        const x = L + i * (kw + gap);
        rect(x, y, kw, 42, P.headLight);
        rect(x, y + 40, kw, 2, P.navy);
        text(k.label.toUpperCase(), x, y + 3, kw, 12, { size: 7, bold: true, color: P.muted });
        const v = k.fmt === 'money' ? moneyKpi(k.value) : k.fmt === 'hours' ? fmtHours(k.value) : groupInt(k.value);
        text(v, x, y + 15, kw, 22, { size: 13, bold: true, color: P.navy });
      });
      y += 50;

      // Notes
      spec.notes.forEach((nt) => {
        doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(P.navy);
        const t = clean(nt);
        const h = doc.heightOfString(t, { width: pageW - 12 }) + 4;
        rect(L, y, pageW, h, P.headLight);
        doc.text(t, L + 6, y + 2, { width: pageW - 12 });
        y += h;
      });
      return y + 8;
    }

    // ---- table header ---------------------------------------------------
    const H1 = 13; const H2 = 13;
    const tailHead = {
      hours: [P.hoursHead, P.navy], hoursStrong: [P.hoursHead, P.navy],
      money: [P.moneyHead, P.moneyInk], total: [P.navy, P.white], flags: [P.amber, P.amberInk],
    };
    const headerLabel = (c) => {
      if (!usd && (c.kind === 'money' || c.kind === 'total')) return `${c.header}\n(SYP)`.replace('TOTAL\n', 'TOTAL ');
      return c.header;
    };
    function drawTableHeader(y) {
      cols.forEach((c) => {
        if (c.type === 'day') {
          const bg = c.day.isFriday ? P.navy : P.headLight;
          const fg = c.day.isFriday ? P.white : P.navy;
          rect(c.x, y, c.w, H1 + H2, bg);
          strokeRect(c.x, y, c.w, H1);
          strokeRect(c.x, y + H1, c.w, H2);
          text(c.day.dow, c.x - 1, y, c.w + 2, H1, { size: 5.8, bold: true, color: fg });
          text(String(c.day.d), c.x, y + H1, c.w, H2, { size: 7, bold: true, color: fg });
          return;
        }
        const [bg, fg] = c.type === 'fixed' ? [P.headLight, P.navy] : tailHead[c.kind];
        rect(c.x, y, c.w, H1 + H2, bg);
        strokeRect(c.x, y, c.w, H1 + H2);
        text(c.type === 'fixed' ? c.header : headerLabel(c), c.x, y, c.w, H1 + H2, { size: 6.8, bold: true, color: fg });
      });
      line(L, y, L + pageW, y, P.navy, 1.2);
      line(L, y + H1 + H2, L + pageW, y + H1 + H2, P.navy, 1.2);
      return y + H1 + H2;
    }

    // ---- body -----------------------------------------------------------
    const RH = 15;
    let y = drawPageHeader(true);
    y = drawTableHeader(y);

    const newPage = () => {
      doc.addPage();
      y = drawPageHeader(false);
      y = drawTableHeader(y);
    };

    spec.rows.forEach((row, idx) => {
      if (y + RH > bottomLimit()) newPage();
      const zebra = idx % 2 ? P.zebra : P.white;
      cols.forEach((c, ci) => {
        if (c.type === 'fixed') {
          const v = row.fixed[ci];
          rect(c.x, y, c.w, RH, zebra);
          strokeRect(c.x, y, c.w, RH);
          text(v, c.x + (c.align === 'left' ? 2 : 0), y, c.w - (c.align === 'left' ? 2 : 0), RH, {
            size: c.bold ? 7.8 : 7, bold: c.bold, align: c.align === 'left' ? (isArabic(v) ? 'right' : 'left') : 'center',
          });
          return;
        }
        if (c.type === 'day') {
          const e = row.days[c.day.d];
          const tone = e && e.tone ? TONES[e.tone] : null;
          rect(c.x, y, c.w, RH, tone ? hex(tone.fill) : c.day.isFriday ? P.friday : zebra);
          strokeRect(c.x, y, c.w, RH);
          if (e) text(fmtDay(e.value), c.x - 1, y, c.w + 2, RH, { size: 6.5, bold: !!tone, color: tone ? hex(tone.font) : P.ink });
          return;
        }
        const ti = ci - F - spec.days.length;
        const v = row.tail[ti];
        let bg = zebra; let color = P.ink; let bold = false; let s;
        if (c.kind === 'flags') {
          const n = Number(v || 0);
          s = n > 0 ? `! ${n}` : 'OK';
          color = n > 0 ? P.amberInk : P.okInk; bold = true;
          if (n > 0) bg = P.amber;
        } else if (c.kind === 'hours' || c.kind === 'hoursStrong') {
          s = fmtHours(v);
          if (c.kind === 'hoursStrong') { bold = true; color = P.navy; }
        } else {
          s = fmtMoney(v);
          if (c.kind === 'total') { bg = P.totalCell; bold = true; color = P.navy; }
        }
        rect(c.x, y, c.w, RH, bg);
        strokeRect(c.x, y, c.w, RH);
        text(s, c.x, y, c.w, RH, { size: 7, bold, color, align: c.kind === 'money' || c.kind === 'total' ? 'right' : 'center' });
      });
      y += RH;
    });

    // ---- grand total ----------------------------------------------------
    if (y + RH + 4 > bottomLimit()) newPage();
    const TH = 17;
    rect(L, y, pageW, TH, P.totalsRow);
    text(`GRAND TOTAL  (${spec.rows.length} ${spec.entityLabel})`, L, y, fixedW, TH, { size: 8, bold: true, color: P.navy });
    cols.forEach((c, ci) => {
      if (c.type === 'fixed') return;
      strokeRect(c.x, y, c.w, TH);
      if (c.type === 'day') {
        const v = spec.totals.days[c.day.d];
        if (v) text(fmtDay(v), c.x - 2, y, c.w + 4, TH, { size: 5.8, bold: true, color: P.navy });
        return;
      }
      const v = spec.totals.tail[ci - F - spec.days.length];
      if (c.kind === 'flags') return;
      if (c.kind === 'total') rect(c.x, y, c.w, TH, P.navy);
      const s = c.kind === 'money' || c.kind === 'total' ? fmtMoney(v) : fmtHours(v);
      text(s, c.x, y, c.w, TH, {
        size: 7.2, bold: true, color: c.kind === 'total' ? P.white : P.navy,
        align: c.kind === 'money' || c.kind === 'total' ? 'right' : 'center',
      });
    });
    strokeRect(L, y, fixedW, TH);
    line(L, y, L + pageW, y, P.navy, 1.2);
    line(L, y + TH, L + pageW, y + TH, P.navy, 1.2);
    line(L, y + TH + 2, L + pageW, y + TH + 2, P.navy, 0.8);
    y += TH + 14;

    // ---- legend (horizontal) ------------------------------------------
    if (spec.legend && spec.legend.length) {
      if (y + 20 > bottomLimit()) { doc.addPage(); y = drawPageHeader(false); }
      doc.font('Helvetica-Bold').fontSize(8).fillColor(P.navy).text('LEGEND', L, y + 3);
      let lx = L + 50;
      spec.legend.forEach((l) => {
        const t = l.tone === 'friday' ? { fill: C.friday, font: C.navy } : TONES[l.tone];
        rect(lx, y, 22, 13, hex(t.fill));
        strokeRect(lx, y, 22, 13);
        text(l.code, lx, y, 22, 13, { size: 7, bold: true, color: hex(t.font) });
        doc.font('Helvetica').fontSize(7.5).fillColor(P.muted).text(l.label, lx + 26, y + 3, { lineBreak: false });
        lx += 30 + doc.widthOfString(l.label) + 18;
      });
      y += 30;
    }

    // ---- signatures -----------------------------------------------------
    if (y + 50 > bottomLimit()) { doc.addPage(); y = drawPageHeader(false); }
    const sw = (pageW - 60) / 3;
    ['Prepared by', 'Reviewed by', 'Approved by'].forEach((lab, i) => {
      const x = L + i * (sw + 30);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(P.muted).text(lab, x, y);
      line(x, y + 36, x + sw, y + 36, P.navy, 0.8);
      doc.font('Helvetica').fontSize(7).fillColor(P.muted).text('Name / Signature / Date', x, y + 40);
    });
    y += 60;

    // ---- data flags -----------------------------------------------------
    if (spec.flags.length) {
      if (y + 60 > bottomLimit()) { doc.addPage(); y = drawPageHeader(false); }
      rect(L, y, pageW, 18, P.navy);
      text(`DATA FLAGS (${spec.flags.length}) — detected while reading existing records; nothing was guessed or changed`,
        L + 4, y, pageW - 8, 18, { size: 8.5, bold: true, color: P.white, align: 'left' });
      y += 18;
      const fc = [{ w: 30, k: 'n' }, { w: 90, k: 'id' }, { w: 190, k: 'name' }, { w: pageW - 310, k: 'flag' }];
      spec.flags.forEach((f, i) => {
        doc.font('Helvetica').fontSize(7.2);
        const flagText = clean(f.flag);
        const h = Math.max(14, doc.heightOfString(flagText, { width: fc[3].w - 10 }) + 5);
        if (y + h > bottomLimit()) { doc.addPage(); y = drawPageHeader(false); }
        const vals = { n: String(i + 1), id: f.id, name: f.name, flag: flagText };
        let x = L;
        fc.forEach((c) => {
          rect(x, y, c.w, h, i % 2 ? P.zebra : P.white);
          strokeRect(x, y, c.w, h);
          if (c.k === 'flag') {
            doc.font('Helvetica').fontSize(7.2).fillColor(P.ink).text(vals.flag, x + 5, y + 3, { width: c.w - 10 });
          } else {
            text(vals[c.k], x, y, c.w, h, { size: 7.2, align: c.k === 'name' ? (isArabic(vals.name) ? 'right' : 'left') : 'center' });
          }
          x += c.w;
        });
        y += h;
      });
    }

    // ---- footer on every page ------------------------------------------
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - 26;
      line(L, fy - 4, L + pageW, fy - 4, P.grid, 0.6);
      doc.font('Helvetica').fontSize(7.5).fillColor(P.muted);
      doc.text(`Team Flow — ${spec.sheetName}  •  ${spec.period.periodLabel}`, L, fy, { width: pageW / 2, lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, L + pageW / 2, fy, { width: pageW / 2, align: 'right', lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}

module.exports = { renderReportPdf };
