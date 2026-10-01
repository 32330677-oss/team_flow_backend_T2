const db = require('../config/db');
const { acquireCreateLock, releaseCreateLock } = require('../middleware/duplicateGuard');
const { businessToday, isValidDateOnly: isValidBusinessDate } = require('../services/businessDate');
const { recordStaffCompensationChange } = require('../services/staffCompensationService');

const DEFAULT_DAILY_HOURS = 8.00;

function isValidDateOnly(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const [year, month, day] = String(value).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

function parsePaidLeaveTypes(value) {
    if (value === undefined || value === null || value === '') return null;
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? JSON.stringify(parsed) : null;
        } catch (_) {
            return null;
        }
    }
    return null;
}

// 1. Get all staff members
exports.getAllStaff = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.phone_number, sm.position,
                    sm.site_id, s.site_name, sm.hire_date, sm.first_hire_date, sm.termination_date,
                    sm.monthly_salary, sm.standard_daily_hours, sm.paid_leave_types, sm.status, sm.created_at
             FROM staff_members sm
             LEFT JOIN sites s ON s.site_id = sm.site_id
             ORDER BY sm.created_at DESC`
        );
        return res.status(200).json({ status: 'success', results: rows.length, data: rows });
    } catch (error) {
        console.error('GET ALL STAFF ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'An error occurred while fetching staff data' });
    }
};


exports.createStaff = async (req, res) => {
    const {
        full_name, phone_number, position,
        site_id, hire_date, monthly_salary, standard_daily_hours, paid_leave_types
    } = req.body;

    if (!full_name || monthly_salary === undefined || monthly_salary === null) {
        return res.status(400).json({ status: 'error', message: 'Please provide the full name and monthly salary' });
    }
    if (!isValidDateOnly(hire_date)) {
        return res.status(400).json({ status: 'error', message: 'A valid hire_date (YYYY-MM-DD) is required' });
    }

    const numericSalary = Number(monthly_salary);
    if (!Number.isFinite(numericSalary) || numericSalary < 0) {
        return res.status(400).json({ status: 'error', message: 'Invalid monthly salary' });
    }

    const numericDailyHours = (standard_daily_hours !== undefined && standard_daily_hours !== null && standard_daily_hours !== '')
        ? Number(standard_daily_hours)
        : DEFAULT_DAILY_HOURS;
    if (!Number.isFinite(numericDailyHours) || numericDailyHours <= 0 || numericDailyHours > 24) {
        return res.status(400).json({ status: 'error', message: 'Invalid daily hours' });
    }

    const connection = await db.getConnection();
    const lockKey = `create_staff:${full_name}:${phone_number || ''}`;

    try {
        const locked = await acquireCreateLock(connection, lockKey, 5);
        if (!locked) {
            return res.status(409).json({
                status: 'error',
                message: 'A similar request is already being processed. Please check the staff list before retrying.'
            });
        }

        await connection.beginTransaction();

        if (site_id) {
            const [siteRows] = await connection.query('SELECT site_id FROM sites WHERE site_id = ? LIMIT 1', [site_id]);
            if (siteRows.length === 0) {
                throw Object.assign(new Error('The specified site does not exist'), { isOperational: true });
            }
        }

        const [dupRows] = await connection.execute(
            `SELECT staff_id FROM staff_members
             WHERE full_name = ? AND phone_number <=> ?
               AND created_at >= (NOW() - INTERVAL 15 SECOND)
             LIMIT 1`,
            [full_name, phone_number || null]
        );
        if (dupRows.length > 0) {
            throw Object.assign(
                new Error('This staff member appears to have just been added. Check the staff list before retrying.'),
                { isOperational: true, statusCode: 409 }
            );
        }

        const effectiveHireDate = hire_date;

        const [staffResult] = await connection.query(
            `INSERT INTO staff_members
                (staff_unique_id, full_name, phone_number, position, site_id,
                 hire_date, first_hire_date, monthly_salary, standard_daily_hours, paid_leave_types, status)
             VALUES ('TEMP', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active')`,
            [
                full_name, phone_number || null, position || null, site_id || null,
                effectiveHireDate, effectiveHireDate, numericSalary, numericDailyHours, parsePaidLeaveTypes(paid_leave_types)
            ]
        );
        const newStaffId = staffResult.insertId;
        const staffUniqueId = `STF-${10000 + newStaffId}`;
        await connection.query('UPDATE staff_members SET staff_unique_id = ? WHERE staff_id = ?', [staffUniqueId, newStaffId]);

        await connection.commit();

        return res.status(201).json({
            status: 'success',
            message: 'Staff member created successfully',
            data: { staff_id: newStaffId, staff_unique_id: staffUniqueId }
        });
    } catch (error) {
        await connection.rollback();
        console.error('CREATE STAFF ERROR:', error);
        const status = error.statusCode || (error.isOperational ? 400 : 500);
        return res.status(status).json({
            status: 'error',
            message: error.isOperational ? error.message : 'Server error while adding the staff member'
        });
    } finally {
        await releaseCreateLock(connection, lockKey);
        connection.release();
    }
};

// 3. Update staff member data
exports.updateStaff = async (req, res) => {
    const { id } = req.params; // staff_id
    const {
        full_name, phone_number, position, site_id, hire_date,
        monthly_salary, standard_daily_hours, paid_leave_types
    } = req.body;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [existing] = await connection.query('SELECT * FROM staff_members WHERE staff_id = ? LIMIT 1 FOR UPDATE', [id]);
        if (existing.length === 0) {
            throw Object.assign(new Error('Staff member not found'), { isOperational: true });
        }
        const current = existing[0];

        let effectiveHireDate = current.hire_date;
        if (hire_date !== undefined) {
            if (!isValidDateOnly(hire_date)) {
                throw Object.assign(new Error('A valid hire_date (YYYY-MM-DD) is required'), { isOperational: true });
            }
            effectiveHireDate = hire_date;
        }

        const currentHireDate = current.hire_date
            ? String(current.hire_date).slice(0, 10)
            : null;
        if (effectiveHireDate !== currentHireDate) {
            const [payrollRows] = await connection.execute(
                `SELECT sp.staff_payroll_id
                 FROM staff_payroll sp
                 JOIN staff_payroll_batches spb
                   ON spb.staff_payroll_batch_id = sp.staff_payroll_batch_id
                 WHERE sp.staff_id = ? AND spb.status <> 'Superseded'
                 LIMIT 1`,
                [id]
            );
            if (payrollRows.length > 0) {
                throw Object.assign(
                    new Error('Hire date cannot be changed while this staff member has payroll in a non-superseded batch.'),
                    { isOperational: true, statusCode: 409 }
                );
            }
        }

        if (site_id !== undefined && site_id !== null && site_id !== '') {
            const [siteRows] = await connection.query('SELECT site_id FROM sites WHERE site_id = ? LIMIT 1', [site_id]);
            if (siteRows.length === 0) {
                throw Object.assign(new Error('The specified site does not exist'), { isOperational: true });
            }
        }

        let numericSalary = current.monthly_salary;
        if (monthly_salary !== undefined && monthly_salary !== null && monthly_salary !== '') {
            numericSalary = Number(monthly_salary);
            if (!Number.isFinite(numericSalary) || numericSalary < 0) {
                throw Object.assign(new Error('Invalid monthly salary'), { isOperational: true });
            }
        }

        let numericDailyHours = current.standard_daily_hours;
        if (standard_daily_hours !== undefined && standard_daily_hours !== null && standard_daily_hours !== '') {
            numericDailyHours = Number(standard_daily_hours);
            if (!Number.isFinite(numericDailyHours) || numericDailyHours <= 0 || numericDailyHours > 24) {
                throw Object.assign(new Error('Invalid daily hours'), { isOperational: true });
            }
        }

        // D3 / #12: salary, standard hours and paid leave types are versioned with
        // the date they take effect, so payroll for earlier dates keeps the values
        // that applied then. Default effective date = business today (same as
        // the previous "applies now" behavior). Retroactive/future dates must be
        // explicit and are limited to <= today.
        const nextPaidLeave = paid_leave_types !== undefined ? parsePaidLeaveTypes(paid_leave_types) : current.paid_leave_types;
        const normalizeJson = (v) => {
            if (v === null || v === undefined || v === '') return null;
            try { return JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v); } catch (_) { return String(v); }
        };
        const compensationChanged =
            Number(numericSalary) !== Number(current.monthly_salary) ||
            Number(numericDailyHours) !== Number(current.standard_daily_hours) ||
            normalizeJson(nextPaidLeave) !== normalizeJson(current.paid_leave_types);

        if (compensationChanged) {
            const compEffectiveFrom = req.body.compensation_effective_from || businessToday();
            if (!isValidBusinessDate(compEffectiveFrom)) {
                throw Object.assign(new Error('compensation_effective_from must be a valid date (YYYY-MM-DD).'), { isOperational: true });
            }
            if (compEffectiveFrom > businessToday()) {
                throw Object.assign(new Error('A compensation change cannot take effect in the future.'), { isOperational: true });
            }
            await recordStaffCompensationChange(connection, {
                current,
                next: {
                    monthly_salary: numericSalary,
                    standard_daily_hours: numericDailyHours,
                    paid_leave_types: normalizeJson(nextPaidLeave),
                },
                effectiveFrom: compEffectiveFrom,
                reason: req.body.compensation_reason ? String(req.body.compensation_reason).trim().slice(0, 500) : null,
                userId: req.user?.user_id,
            });
            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('staff_members', ?, 'COMPENSATION_CHANGED', ?, ?, ?)`,
                [current.staff_id, req.user?.user_id || null,
                    JSON.stringify({ monthly_salary: current.monthly_salary, standard_daily_hours: current.standard_daily_hours, paid_leave_types: current.paid_leave_types }),
                    JSON.stringify({ monthly_salary: numericSalary, standard_daily_hours: numericDailyHours, paid_leave_types: normalizeJson(nextPaidLeave), effective_from: compEffectiveFrom, reason: req.body.compensation_reason || null })]
            );
        }

        await connection.query(
            `UPDATE staff_members
             SET full_name = ?, phone_number = ?, position = ?, site_id = ?,
                 hire_date = ?, monthly_salary = ?, standard_daily_hours = ?, paid_leave_types = ?
             WHERE staff_id = ?`,
            [
                full_name || current.full_name,
                phone_number !== undefined ? phone_number : current.phone_number,
                position !== undefined ? position : current.position,
                site_id !== undefined ? (site_id || null) : current.site_id,
                effectiveHireDate,
                numericSalary,
                numericDailyHours,
                nextPaidLeave,
                id
            ]
        );

        await connection.commit();
        return res.status(200).json({ status: 'success', message: 'Staff member updated successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('UPDATE STAFF ERROR:', error);
        const status = error.statusCode || (error.isOperational ? 400 : 500);
        return res.status(status).json({
            status: 'error',
            message: error.isOperational ? error.message : 'An error occurred while updating the staff member'
        });
    } finally {
        connection.release();
    }
};


// D3: GET /api/staff/:id/compensation-history
exports.getCompensationHistory = async (req, res) => {
    try {
        const staffId = Number(req.params.id);
        if (!Number.isInteger(staffId) || staffId <= 0) {
            return res.status(400).json({ status: 'error', message: 'Invalid staff id.' });
        }
        const [rows] = await db.execute(
            `SELECT sch.staff_compensation_id, sch.monthly_salary, sch.standard_daily_hours, sch.paid_leave_types,
                    DATE_FORMAT(sch.effective_from, '%Y-%m-%d') AS effective_from,
                    DATE_FORMAT(sch.effective_to, '%Y-%m-%d') AS effective_to,
                    sch.reason, sch.created_at, u.full_name AS changed_by_name
             FROM staff_compensation_history sch
             LEFT JOIN users u ON u.user_id = sch.changed_by_user_id
             WHERE sch.staff_id = ?
             ORDER BY sch.effective_from DESC, sch.staff_compensation_id DESC`,
            [staffId]
        );
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error('GET STAFF COMPENSATION HISTORY ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to load compensation history.' });
    }
};
