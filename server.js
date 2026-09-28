const express = require('express');
const cors = require('cors');
const contractRoutes = require('./routes/contractRoutes');
const siteRoutes = require('./routes/siteRoutes');
const workerRoutes = require('./routes/workerRoutes');
const assignmentRoutes = require('./routes/assignmentRoutes');
const supervisorRouter = require('./routes/supervisorRoutes');
const attendanceImportRoutes = require('./routes/attendanceImportRoutes');
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
app.use(express.json());
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
app.use('/api/attendance', require('./routes/attendanceRoutes'));
app.use('/api/admin/attendance', adminAttendanceRoutes);
app.use('/api/admin/payroll', adminPayrollRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
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

// تشغيل السيرفر على جميع الواجهات ليستقبل الاتصالات من أي جهاز في الشبكة
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running beautifully on Port: ${PORT}`);
    console.log(`👉 Local: http://localhost:${PORT}`);
    console.log(`👉 Network check: check your local computer IP to connect your Infinix phone.`);
});