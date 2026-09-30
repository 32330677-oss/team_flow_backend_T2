const {
  generateWorkerMonthlyReport,
  generateWorkerMonthlyReportPdf,
} = require('../services/workerMonthlyReportService');

function send(res, contentType, { buffer, fileName }) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', buffer.length);
  return res.end(Buffer.from(buffer));
}

function fail(res, error, where) {
  if (error.statusCode === 400) {
    return res.status(400).json({ success: false, message: error.message });
  }
  console.error(`${where}:`, error);
  return res.status(500).json({ success: false, message: 'Failed to generate the monthly labor report.' });
}

// GET /api/admin/payroll/monthly-report.xlsx?month=&year=&from=&to=
exports.exportWorkerMonthlyReport = async (req, res) => {
  try {
    const out = await generateWorkerMonthlyReport(req.query.month, req.query.year, req.query.from, req.query.to);
    return send(res, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', out);
  } catch (error) {
    return fail(res, error, 'exportWorkerMonthlyReport');
  }
};

// GET /api/admin/payroll/monthly-report.pdf?month=&year=&from=&to=
exports.exportWorkerMonthlyReportPdf = async (req, res) => {
  try {
    const out = await generateWorkerMonthlyReportPdf(req.query.month, req.query.year, req.query.from, req.query.to);
    return send(res, 'application/pdf', out);
  } catch (error) {
    return fail(res, error, 'exportWorkerMonthlyReportPdf');
  }
};
