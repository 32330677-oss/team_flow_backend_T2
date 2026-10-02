const express = require('express');
const cors = require('cors');
const contractRoutes = require('./routes/contractRoutes');
const siteRoutes = require('./routes/siteRoutes');
const workerRoutes = require('./routes/workerRoutes');
const assignmentRoutes = require('./routes/assignmentRoutes');
const supervisorRouter = require('./routes/supervisorRoutes');
const attendanceImportRoutes = require('./routes/attendanceImportRoutes');
const biometricProcessingRoutes = require('./routes/biometricProcessingRoutes');
const deviceUserRoutes = require('./routes/deviceUserRoutes');
const adminAttendanceRoutes = require('./routes/adminAttendanceRoutes');
const transferRoutes = require('./routes/transferRoutes');
const adminPayrollRoutes = require('./routes/adminPayrollRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const path = require('path');
const staffRoutes = require('./routes/staffRoutes');
const staffAttendanceRoutes = require('./routes/staffAttendanceRoutes');
const staffPayrollRoutes = require('./routes/StaffPayrollRoutes');
const staffOvertimeRoutes = require('./routes/staffOvertimeRoutes');
const mainDashboardRoutes = require('./routes/mainDashboardRoutes');
const biometricAttendanceAdminRoutes = require('./routes/biometricAttendanceAdminRoutes');

require('dotenv').config();
if (!process.env.JWT_SECRET) {
    console.error("FATAL ERROR: JWT_SECRET environment variable is not defined.");
    process.exit(1);
}
// استيراد المسارات (Routes)
const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes'); 

const app = express();

// Middlewares
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.set('trust proxy', 1); // أو true
// ربط المسارات بالسيرفر
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes); 
app.use('/api/contracts', contractRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/workers', workerRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/users/supervisors', supervisorRouter);
app.use('/api/biometric', attendanceImportRoutes);
app.use('/api/biometric/device-users', deviceUserRoutes);
app.use('/api/biometric/processing', biometricProcessingRoutes);
app.use('/api/attendance', require('./routes/attendanceRoutes'));
app.use('/api/admin/attendance', adminAttendanceRoutes);
app.use('/api/admin/payroll', adminPayrollRoutes);
app.use('/api/transfers', transferRoutes);
// C-18: uploads/ is no longer public. Worker photos: GET /api/workers/:id/files/:type (Admin);
// transfer documents: GET /api/transfers/:id/document (authorized).
app.use('/api/biometric/attendance', biometricAttendanceAdminRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/staff-attendance', staffAttendanceRoutes);
app.use('/api/staff-payroll', staffPayrollRoutes);
app.use('/api/staff-overtime', staffOvertimeRoutes);
app.use('/api/main-dashboard', mainDashboardRoutes);
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 5000;

// Assignment end-date semantics interlock (requirements §5): the database must
// carry the 'inclusive_last_day' marker written by
// migrations/2026_10_hardening/05_data.sql, otherwise every assignment query
// would be off by one day. Refuse to start instead of computing wrong dates.
async function start() {
    const db = require('./config/db');
    const { assertSemanticsMarker } = require('./services/assignmentDates');
    try {
        await assertSemanticsMarker(db);
    } catch (error) {
        console.error(`FATAL: ${error.message}`);
        process.exit(1);
    }
    return app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

if (require.main === module) {
    start();
}

module.exports = { app, start };
