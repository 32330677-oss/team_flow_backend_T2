const db = require('../config/db');
const { businessToday, isValidDateOnly } = require('../services/businessDate');
const { recordSiteStatusChange } = require('../services/siteStatusService');
const { acquireCreateLock, releaseCreateLock } = require('../middleware/duplicateGuard');

exports.getSitesByContract = async (req, res) => {
    const { contractId } = req.params;

    try {
        const query = `
            SELECT
                s.*,
                u.full_name AS supervisor_name,

                (
                    SELECT u_day.full_name
                    FROM site_shifts ss_day
                    LEFT JOIN users u_day
                        ON ss_day.supervisor_id = u_day.user_id
                    WHERE ss_day.site_id = s.site_id
                      AND ss_day.shift_type = 'Day'
                    LIMIT 1
                ) AS day_supervisor_name,

                (
                    SELECT u_night.full_name
                    FROM site_shifts ss_night
                    LEFT JOIN users u_night
                        ON ss_night.supervisor_id = u_night.user_id
                    WHERE ss_night.site_id = s.site_id
                      AND ss_night.shift_type = 'Night'
                    LIMIT 1
                ) AS night_supervisor_name

            FROM sites s
            LEFT JOIN users u
                ON s.supervisor_id = u.user_id
            WHERE s.contract_id = ?
            ORDER BY s.created_at DESC
        `;

        const [rows] = await db.query(query, [contractId]);

        return res.status(200).json({
            status: 'success',
            data: rows
        });
    } catch (error) {
        console.error("🚨 FETCH ERROR:", error);

        return res.status(500).json({
            status: 'error',
            message: 'Failed to fetch contract sites'
        });
    }
};


exports.createSite = async (req, res) => {
    const {
        site_name,
        location,
        contract_id,
        supervisor_id
    } = req.body;

    const supportsShifts =
        req.body.supports_shifts === 1 ||
        req.body.supports_shifts === true ||
        req.body.supports_shifts === '1';

    if (!site_name || !contract_id) {
        return res.status(400).json({
            status: 'error',
            message: 'Please provide site name and contract ID'
        });
    }

    const connection = await db.getConnection();
    const lockKey = `create_site:${contract_id}:${site_name}`;

    try {
        const locked = await acquireCreateLock(connection, lockKey, 5);
        if (!locked) {
            return res.status(409).json({
                status: 'error',
                message: 'A similar request is already being processed.'
            });
        }

        const [dupRows] = await connection.query(
            `SELECT site_id FROM sites
             WHERE contract_id = ? AND site_name = ?
               AND created_at >= (NOW() - INTERVAL 10 SECOND)
             LIMIT 1`,
            [contract_id, site_name]
        );

        if (dupRows.length > 0) {
            return res.status(409).json({
                status: 'error',
                message: 'This site appears to have just been created.'
            });
        }
const [result] = await connection.query(
    `INSERT INTO sites (
        site_name,
        location,
        contract_id,
        supervisor_id,
        supports_shifts,
        site_status
     )
     VALUES (?, ?, ?, ?, ?, 'Active')`,
    [
        site_name,
        location || null,
        contract_id,
        supportsShifts ? null : (supervisor_id || null),
        supportsShifts ? 1 : 0
    ]
);

        return res.status(201).json({
            status: 'success',
            message: 'Site created successfully',
            site_id: result.insertId
        });
    } catch (error) {
        console.error("🚨 DATABASE ERROR:", error);

        return res.status(500).json({
            status: 'error',
            message: 'Server error while creating site'
        });
    } finally {
        await releaseCreateLock(connection, lockKey);
        connection.release();
    }
};

// Update site details
// H-03: supervisor / name changes are audited with old and new values.
exports.updateSite = async (req, res) => {
    const { siteId } = req.params;
    const { site_name, location, supervisor_id } = req.body;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [[old]] = await connection.execute('SELECT site_id, site_name, location, supervisor_id FROM sites WHERE site_id = ? FOR UPDATE', [siteId]);
        if (!old) {
            await connection.rollback();
            return res.status(404).json({ status: 'error', message: 'Site not found' });
        }
        await connection.execute(
            'UPDATE sites SET site_name = ?, location = ?, supervisor_id = ? WHERE site_id = ?',
            [site_name, location || null, supervisor_id || null, siteId]
        );
        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('sites', ?, 'SITE_UPDATED', ?, ?, ?)`,
            [siteId, req.user.user_id, JSON.stringify(old),
                JSON.stringify({ site_name, location: location || null, supervisor_id: supervisor_id || null })]
        );
        await connection.commit();
        return res.status(200).json({ status: 'success', message: 'Site updated successfully' });
    } catch (error) {
        await connection.rollback();
        console.error("UPDATE SITE ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Server error while updating site' });
    } finally {
        connection.release();
    }
};

// Toggle site status (Active / Suspended / Completed)
// D-05: every change is stored in site_status_history with the date it takes
// effect (default: business today), so historical processing uses the status
// that applied on each date.
exports.toggleSiteStatus = async (req, res) => {
    const { siteId } = req.params;
    const { status } = req.body;
    const effectiveDate = req.body.effective_date || businessToday();
    const reason = req.body.reason ? String(req.body.reason).trim().slice(0, 500) : null;

    if (!['Active', 'Completed', 'Suspended'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'Invalid status value' });
    }
    if (!isValidDateOnly(effectiveDate) || effectiveDate > businessToday()) {
        return res.status(400).json({ status: 'error', message: 'effective_date must be a valid date that is not in the future.' });
    }
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [[site]] = await connection.execute('SELECT site_id, site_status FROM sites WHERE site_id = ? FOR UPDATE', [siteId]);
        if (!site) {
            await connection.rollback();
            return res.status(404).json({ status: 'error', message: 'Site not found' });
        }
        if (site.site_status === status) {
            await connection.rollback();
            return res.status(400).json({ status: 'error', message: `Site is already ${status}.` });
        }
        const [[last]] = await connection.execute(
            `SELECT DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date FROM site_status_history
             WHERE site_id = ? ORDER BY effective_date DESC, site_status_history_id DESC LIMIT 1`, [siteId]);
        if (last && effectiveDate < last.effective_date) {
            await connection.rollback();
            return res.status(400).json({ status: 'error', message: `effective_date cannot be before the last status change (${last.effective_date}).` });
        }
        await connection.execute('UPDATE sites SET site_status = ? WHERE site_id = ?', [status, siteId]);
        await recordSiteStatusChange(connection, {
            siteId, oldStatus: site.site_status, newStatus: status, effectiveDate, reason, userId: req.user.user_id,
        });
        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('sites', ?, 'SITE_STATUS_CHANGED', ?, ?, ?)`,
            [siteId, req.user.user_id, JSON.stringify({ site_status: site.site_status }),
                JSON.stringify({ site_status: status, effective_date: effectiveDate, reason })]
        );
        await connection.commit();
        return res.status(200).json({ status: 'success', message: `Site status updated to ${status} (effective ${effectiveDate})` });
    } catch (error) {
        await connection.rollback();
        console.error("SITE STATUS ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Server error while updating site status' });
    } finally {
        connection.release();
    }
};

// أضف بعد getAllSites الموجودة — استبدل getAllSites بهذا:
exports.getAllSites = async (req, res) => {
    try {
        const query = `
            SELECT site_id, site_name, supports_shifts
            FROM sites 
            WHERE site_status = 'Active'
            ORDER BY site_name ASC
        `;
        const [rows] = await db.query(query);
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("🚨 FETCH ALL SITES ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Failed to fetch sites list' });
    }
};

// استبدل getMySites الموجودة بهذا:
exports.getMySites = async (req, res) => {
    const supervisorId = req.user.user_id;
    try {
        const query = `
            SELECT DISTINCT s.*, c.contract_name, p.project_name,
                   COALESCE(ss.shift_type, 'Day') AS my_shift_type
            FROM sites s
            LEFT JOIN contracts c ON s.contract_id = c.contract_id
            LEFT JOIN projects p ON c.project_id = p.project_id
            LEFT JOIN site_shifts ss ON ss.site_id = s.site_id AND ss.supervisor_id = ?
            WHERE s.site_status = 'Active'
              AND (
                    (s.supports_shifts = 0 AND s.supervisor_id = ?)
                    OR (s.supports_shifts = 1 AND ss.supervisor_id = ?)
                  )
            ORDER BY s.created_at DESC
        `;
        const [rows] = await db.query(query, [supervisorId, supervisorId, supervisorId]);
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("🚨 FETCH MY SITES ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Failed to fetch your sites' });
    }
};

// NEW: إدارة مشرفي الورديات
exports.getSiteShifts = async (req, res) => {
    const { siteId } = req.params;
    try {
        const [rows] = await db.query(
            `SELECT ss.site_shift_id, ss.shift_type, ss.supervisor_id, u.full_name AS supervisor_name
             FROM site_shifts ss LEFT JOIN users u ON u.user_id = ss.supervisor_id
             WHERE ss.site_id = ? ORDER BY ss.shift_type`,
            [siteId]
        );
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error('🚨 GET SITE SHIFTS ERROR:', error);
        res.status(500).json({ status: 'error', message: 'Failed to fetch site shifts.' });
    }
};

exports.upsertSiteShiftSupervisor = async (req, res) => {
    const { siteId } = req.params;
    const { shift_type, supervisor_id } = req.body;
    if (!['Day', 'Night'].includes(shift_type)) {
        return res.status(400).json({ status: 'error', message: 'shift_type must be Day or Night' });
    }
    try {
        const [[old]] = await db.query('SELECT supervisor_id FROM site_shifts WHERE site_id = ? AND shift_type = ?', [siteId, shift_type]);
        await db.query(
            `INSERT INTO site_shifts (site_id, shift_type, supervisor_id)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE supervisor_id = VALUES(supervisor_id)`,
            [siteId, shift_type, supervisor_id || null]
        );
        await db.query(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('site_shifts', ?, 'SHIFT_SUPERVISOR_CHANGED', ?, ?, ?)`,
            [siteId, req.user.user_id, JSON.stringify({ shift_type, supervisor_id: old ? old.supervisor_id : null }),
                JSON.stringify({ shift_type, supervisor_id: supervisor_id || null })]
        );
        res.status(200).json({ status: 'success', message: 'Shift supervisor updated' });
    } catch (error) {
        console.error('🚨 UPSERT SITE SHIFT ERROR:', error);
        res.status(500).json({ status: 'error', message: 'Failed to update shift supervisor.' });
    }
};