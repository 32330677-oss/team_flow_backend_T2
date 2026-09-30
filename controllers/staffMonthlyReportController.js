const { generateStaffMonthlyReport } = require('../services/staffMonthlyReportService');

exports.exportStaffMonthlyReport = async (req, res) => {
  try {
    const { buffer, fileName } = await generateStaffMonthlyReport(req.query.month, req.query.year);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.end(Buffer.from(buffer));
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    console.error('exportStaffMonthlyReport:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to generate the monthly staff report.' });
  }
};