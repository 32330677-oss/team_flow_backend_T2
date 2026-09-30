const {
  generateStaffMonthlyReport,
  generateStaffMonthlyReportPdf,
} = require('../services/staffMonthlyReportService');

function send(res, contentType, { buffer, fileName }) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', buffer.length);
  return res.end(Buffer.from(buffer));
}

function fail(res, error, where) {
  if (error.statusCode === 400) {
    return res.status(400).json({ status: 'error', message: error.message });
  }
  console.error(`${where}:`, error);
  return res.status(500).json({ status: 'error', message: 'Failed to generate the monthly staff report.' });
}

// GET /api/staff-payroll/monthly-report.xlsx?month=&year=&from=&to=
exports.exportStaffMonthlyReport = async (req, res) => {
  try {
    const out = await generateStaffMonthlyReport(req.query.month, req.query.year, req.query.from, req.query.to);
    return send(res, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', out);
  } catch (error) {
    return fail(res, error, 'exportStaffMonthlyReport');
  }
};

// GET /api/staff-payroll/monthly-report.pdf?month=&year=&from=&to=
exports.exportStaffMonthlyReportPdf = async (req, res) => {
  try {
    const out = await generateStaffMonthlyReportPdf(req.query.month, req.query.year, req.query.from, req.query.to);
    return send(res, 'application/pdf', out);
  } catch (error) {
    return fail(res, error, 'exportStaffMonthlyReportPdf');
  }
};
