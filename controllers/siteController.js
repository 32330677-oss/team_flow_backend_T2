const db = require('../config/db');
const { acquireCreateLock, releaseCreateLock } = require('../middleware/duplicateGuard');

// Get sites by contract ID
exports.getSitesByContract = async (req, res) => {
    const { contractId } = req.params;
    try {
        const query = `
            SELECT s.*, u.full_name AS supervisor_name 
            FROM sites s
            LEFT JOIN users u ON s.supervisor_id = u.user_id
            WHERE s.contract_id = ? 
            ORDER BY s.created_at DESC
        `;
        const [rows] = await db.query(query, [contractId]);
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("🚨 FETCH ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Failed to fetch contract sites' });
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
exports.updateSite = async (req, res) => {
    const { siteId } = req.params;
    const { site_name, location, supervisor_id } = req.body;

    try {
        const query = `
            UPDATE sites 
            SET site_name = ?, location = ?, supervisor_id = ?
            WHERE site_id = ?
        `;
        const [result] = await db.query(query, [site_name, location || null, supervisor_id || null, siteId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ status: 'error', message: 'Site not found' });
        }

        return res.status(200).json({ status: 'success', message: 'Site updated successfully' });
    } catch (error) {
        console.error("🚨 UPDATE ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Server error while updating site' });
    }
};

// Toggle site status (Active / Suspended / Completed)
exports.toggleSiteStatus = async (req, res) => {
    const { siteId } = req.params;
    const { status } = req.body;

    if (!['Active', 'Completed', 'Suspended'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'Invalid status value' });
    }

    try {
        const [result] = await db.query(
            'UPDATE sites SET site_status = ? WHERE site_id = ?',
            [status, siteId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ status: 'error', message: 'Site not found' });
        }

        return res.status(200).json({
            status: 'success',
            message: `Site status updated to ${status}`
        });
    } catch (error) {
        console.error("🚨 STATUS ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Server error while updating site status' });
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
        await db.query(
            `INSERT INTO site_shifts (site_id, shift_type, supervisor_id)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE supervisor_id = VALUES(supervisor_id)`,
            [siteId, shift_type, supervisor_id || null]
        );
        res.status(200).json({ status: 'success', message: 'Shift supervisor updated' });
    } catch (error) {
        console.error('🚨 UPSERT SITE SHIFT ERROR:', error);
        res.status(500).json({ status: 'error', message: 'Failed to update shift supervisor.' });
    }
};