// backend/controllers/adminAttendanceController.js
const db = require('../config/db');
const settingsCache = require('../services/settingsCache');
const { businessToday } = require('../services/businessDate');

// Defaults used when a key was never stored (unchanged values).
const DEFAULT_SETTING_VALUES = {
    is_lunch_paid: 'false',
    standard_work_minutes: '600',
    overtime_flat_rate_syp: '150',
};

exports.getPendingRecords = async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT a.attendance_id, a.worker_id, a.site_id, a.shift_type,
                    a.source,
                    a.check_in_time, a.check_out_time,
                    a.total_working_hours, a.overtime_hours,
                    a.management_leave_hours, a.status, a.attendance_status,
                    a.remarks, a.admin_rejection_notes,
                    a.approved_by_user_id, a.approval_date,
                    DATE_FORMAT(a.record_date, '%Y-%m-%d') AS record_date,
                    w.full_name, s.site_name 
             FROM attendance a
             JOIN workers w ON a.worker_id = w.worker_id
             JOIN sites s ON a.site_id = s.site_id
             WHERE a.status IN ('Submitted', 'Rejected')`
        );
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};

// 2. Review record (Approve or Reject) with strict pre-validation & audit logging
exports.reviewRecord = async (req, res) => {
    const { attendance_id, status, admin_note } = req.body;
    const adminId = req.user?.user_id;
    if (!['Approved', 'Rejected'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'Status must be Approved or Rejected.' });
    }
    if (status === 'Rejected' && (!admin_note || !String(admin_note).trim())) {
        return res.status(400).json({ status: 'error', message: 'A rejection reason is required.' });
    } 
    
    if (!adminId) {
        return res.status(401).json({ status: 'error', message: 'Admin identification not found' });
    }

    try {
        // SAFE PRE-VALIDATION CHECK: Verify the admin exists in the users table to prevent FK crashes
        const [userExists] = await db.query(
            'SELECT user_id FROM users WHERE user_id = ? AND role = ?',
            [adminId, 'Admin']
        );
        if (userExists.length === 0) {
            return res.status(403).json({ status: 'error', message: 'Unauthorized: Invalid admin account or insufficient permissions' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // #9: lock the row so two concurrent reviews cannot both succeed.
            const [oldRows] = await connection.execute(
                'SELECT * FROM attendance WHERE attendance_id = ? FOR UPDATE',
                [attendance_id]
            );
            
            if (oldRows.length === 0) throw new Error('Record does not exist');
            const oldRecord = oldRows[0];

            if (oldRecord.status === 'Rejected') {
                throw new Error('Rejected records must be resubmitted by the supervisor first.');
            }

            if (oldRecord.status !== 'Submitted') {
                 throw new Error('Record cannot be reviewed as it is not in pending status.');
            }
            // B6: biometric worker records can be rejected like manual ones (and like
            // staff records). The supervisor resubmits them (#4 in resubmitAttendance).
            const [reviewed] = await connection.execute(
                `UPDATE attendance 
                 SET status = ?, admin_rejection_notes = ?, approved_by_user_id = ?, approval_date = NOW() 
                 WHERE attendance_id = ? AND status = 'Submitted'`,
                [status, (status === 'Rejected' ? admin_note : null), adminId, attendance_id]
            );
            if (reviewed.affectedRows !== 1) {
                throw new Error('Record cannot be reviewed as it is not in pending status.');
            }

            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    'attendance', 
                    attendance_id, 
                    status.toUpperCase(), 
                    adminId, 
                    JSON.stringify(oldRecord), 
                    JSON.stringify({ status, admin_note })
                ]
            );

            await connection.commit();
            res.status(200).json({ status: 'success', message: 'Operation completed successfully' });
        } catch (error) {
            await connection.rollback();
            console.error("Review Transaction Error:", error);
            res.status(error.message.includes('record') || error.message.includes('Record') || error.message.includes('Status') || error.message.includes('pending') || error.message.includes('Rejected') ? 400 : 500).json({ status: 'error', message: error.message });
        } finally {
            connection.release();
        }
    } catch (dbError) {
        console.error("Pre-validation DB Error:", dbError);
        res.status(500).json({ status: 'error', message: 'Internal server error during pre-validation checks' });
    }
};

// 3. Get records by specific date
exports.getRecordsByDate = async (req, res) => {
    const { date } = req.query;
    try {
        const [rows] = await db.execute(
           `SELECT a.*, DATE_FORMAT(a.record_date, '%Y-%m-%d') as record_date, w.full_name, s.site_name 
            FROM attendance a
            JOIN workers w ON a.worker_id = w.worker_id
            JOIN sites s ON a.site_id = s.site_id
            WHERE DATE(a.record_date) = ? AND (a.status IN ('Submitted', 'Rejected'))`,
            [date]
        );
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};

// 4. Get break & work hours settings
exports.getBreakSettings = async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT setting_key, setting_value FROM system_settings
             WHERE setting_key IN ('is_lunch_paid','standard_work_minutes','overtime_flat_rate_syp')`
        );
        const data = { ...DEFAULT_SETTING_VALUES };
        rows.forEach(r => data[r.setting_key] = r.setting_value);
        res.status(200).json({ status: 'success', data });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};

// 5. Update break & work hours settings with Cache refresh, Audit Log, and Pending Records validation
exports.updateBreakSettings = async (req, res) => {
    const { is_lunch_paid, standard_work_minutes, overtime_flat_rate_syp } = req.body;
    const adminId = req.user.user_id;
    const numericMinutes = Number(standard_work_minutes);
    const numericOtRate = Number(overtime_flat_rate_syp);
    if (overtime_flat_rate_syp !== undefined && (!Number.isFinite(numericOtRate) || numericOtRate < 0)) {
        return res.status(400).json({ status: 'error', message: 'overtime_flat_rate_syp must be a non-negative number.' });
    }
    if (standard_work_minutes !== undefined && (!Number.isFinite(numericMinutes) || numericMinutes <= 0 || numericMinutes > 1440)) {
        return res.status(400).json({ status: 'error', message: 'standard_work_minutes must be between 1 and 1440.' });
    }
    if (is_lunch_paid !== undefined && !['true', 'false', true, false].includes(is_lunch_paid)) {
        return res.status(400).json({ status: 'error', message: 'is_lunch_paid must be true or false.' });
    }
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [pending] = await connection.execute(
            `SELECT COUNT(*) as count FROM attendance WHERE status IN ('Submitted', 'Draft')`
        );

        if (pending[0].count > 0) {
            await connection.rollback();
            return res.status(400).json({ 
                status: 'error', 
                message: 'Please approve or process all pending attendance records before updating break settings.' 
            });
        }

        const updates = {
            is_lunch_paid: is_lunch_paid === undefined ? undefined : String(is_lunch_paid),
            standard_work_minutes: standard_work_minutes === undefined ? undefined : String(numericMinutes),
            overtime_flat_rate_syp: overtime_flat_rate_syp === undefined ? undefined : String(numericOtRate),
        };

        // D3: every change is also stored with the date it takes effect, so
        // older attendance/payroll keeps the value that applied on its own date.
        // Retroactive changes are not supported (effective date = business today).
        const effectiveFrom = businessToday();

        for (const [key, value] of Object.entries(updates)) {
            if (value === undefined) continue;
            const [[currentRow]] = await connection.execute(
                'SELECT setting_value FROM system_settings WHERE setting_key = ? FOR UPDATE', [key]);
            const oldValue = currentRow ? currentRow.setting_value : DEFAULT_SETTING_VALUES[key];
            await connection.execute(
                `INSERT INTO system_settings (setting_key, setting_value)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
                [key, String(value)]
            );
            await settingsCache.recordSettingChange(connection, {
                key, oldValue, newValue: value, effectiveFrom,
                reason: req.body?.reason || null, userId: adminId,
            });
            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('system_settings', 0, 'UPDATE_SETTING', ?, ?, ?)`,
                [adminId, JSON.stringify({ [key]: oldValue }), JSON.stringify({ [key]: value, effective_from: effectiveFrom })]
            );
        }

        await connection.commit();
        await settingsCache.refresh();

        res.status(200).json({ status: 'success', message: 'Settings updated successfully' });
    } catch (error) {
        await connection.rollback();
        res.status(error.isOperational ? 400 : 500).json({ status: 'error', message: error.isOperational ? error.message : 'Internal server error while updating settings.' });
    } finally {
        connection.release();
    }
};