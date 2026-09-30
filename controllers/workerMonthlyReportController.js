const { generateWorkerMonthlyReport } = require('../services/workerMonthlyReportService');

exports.exportWorkerMonthlyReport = async (req, res) => {
  try {
    const { buffer, fileName } = await generateWorkerMonthlyReport(req.query.month, req.query.year);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.end(Buffer.from(buffer));
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error('exportWorkerMonthlyReport:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate the monthly labor report.' });
  }
};