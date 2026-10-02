const db = require('../config/db');
const path = require('path');
const fs = require('fs');
const { generateTransferRequestDocx } = require('../services/transferDocumentService');
const { businessToday, isValidDateOnly, addDays } = require('../services/businessDate');
const { overlaps } = require('../services/assignmentDates');

class TransferError extends Error {
    constructor(message, statusCode = 400, extra = null) {
        super(message);
        this.statusCode = statusCode;
        this.extra = extra;
    }
}

function normalizeShift(value) {
    return ['Day', 'Night'].includes(value) ? value : 'Day';
}

async function verifySupervisorShiftScope(userId, siteId, shiftType) {
    const [rows] = await db.execute(
        `SELECT 1 FROM site_shifts WHERE site_id = ? AND shift_type = ? AND supervisor_id = ?
         UNION
         SELECT 1 FROM sites WHERE site_id = ? AND supervisor_id = ? AND supports_shifts = 0
         LIMIT 1`,
        [siteId, shiftType, userId, siteId, userId]
    );
    return rows.length > 0;
}

// 1. إنشاء طلب تحويل جديد
exports.createTransferRequest = async (req, res) => {
    const { worker_id, current_site_id, target_site_id, transfer_reason } = req.body;
    // B3: the business date the transfer takes effect (default: business today).
    const effective_date = req.body.effective_date || businessToday();
    if (!isValidDateOnly(effective_date)) {
        return res.status(400).json({ status: 'error', message: 'effective_date must be a valid date (YYYY-MM-DD).' });
    }
    const current_shift_type = normalizeShift(req.body.current_shift_type);
    const target_shift_type = normalizeShift(req.body.target_shift_type);
    const requested_by_user_id = req.user.user_id;

    if (!worker_id || !current_site_id || !target_site_id) {
        return res.status(400).json({ status: 'error', message: 'Please specify the worker, current site, and target site.' });
    }

    if (Number(current_site_id) === Number(target_site_id) && current_shift_type === target_shift_type) {
        return res.status(400).json({ status: 'error', message: 'The target site/shift cannot be the same as the current one.' });
    }
    const requestReason = String(transfer_reason || req.body.request_reason || '').trim();
    if (requestReason.length < 3) {
        return res.status(400).json({ status: 'error', message: 'A transfer reason is required.' });
    }

    try {
        if (req.user.role !== 'Admin') {
            const isAuthorized = await verifySupervisorShiftScope(requested_by_user_id, current_site_id, current_shift_type);
            if (!isAuthorized) {
                return res.status(403).json({ status: 'error', message: 'You are not authorized to transfer workers from this site/shift.' });
            }
        }

        // R-13: the target must be an Active site that supports the requested shift.
        const [[targetSiteCheck]] = await db.query(
            'SELECT site_status, supports_shifts, site_name FROM sites WHERE site_id = ? LIMIT 1', [target_site_id]);
        if (!targetSiteCheck) return res.status(404).json({ status: 'error', message: 'Target site not found.' });
        if (targetSiteCheck.site_status !== 'Active') {
            return res.status(409).json({ status: 'error', message: `Target site "${targetSiteCheck.site_name}" is ${targetSiteCheck.site_status}.` });
        }
        if (target_shift_type === 'Night' && Number(targetSiteCheck.supports_shifts) !== 1) {
            return res.status(409).json({ status: 'error', message: `Target site "${targetSiteCheck.site_name}" has no Night shift.` });
        }

        const [existing] = await db.query(
            `SELECT request_id FROM worker_transfer_requests WHERE worker_id = ? AND status = 'Pending'`,
            [worker_id]
        );
        if (existing.length > 0) {
            return res.status(400).json({ status: 'error', message: 'A pending transfer request already exists for this worker.' });
        }

        let result;
        try {
            [result] = await db.query(
                `INSERT INTO worker_transfer_requests
                 (worker_id, current_site_id, current_shift_type, target_site_id, target_shift_type,
                  requested_by_user_id, status, request_reason, effective_date, transfer_type, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?, ?, 'Request', NOW(), NOW())`,
                [worker_id, current_site_id, current_shift_type, target_site_id, target_shift_type,
                 requested_by_user_id, requestReason, effective_date]
            );
        } catch (insertError) {
            if (insertError.code === 'ER_DUP_ENTRY' || insertError.errno === 1062) {
                return res.status(409).json({
                    status: 'error',
                    message: 'A pending transfer request already exists for this worker (created by a concurrent request).'
                });
            }
            throw insertError;
        }
        const requestId = result.insertId;

        let documentPath = null;
        try {
            const [[workerRow]] = await db.query(
                `SELECT full_name, worker_unique_id, job_position, nationality, phone_number, hire_date
                 FROM workers WHERE worker_id = ? LIMIT 1`,
                [worker_id]
            );
            const [[currentSiteRow]] = await db.query(
                `SELECT s.site_name, c.contract_name
                 FROM sites s LEFT JOIN contracts c ON c.contract_id = s.contract_id
                 WHERE s.site_id = ? LIMIT 1`,
                [current_site_id]
            );
            const [[targetSiteRow]] = await db.query(
                `SELECT site_name FROM sites WHERE site_id = ? LIMIT 1`,
                [target_site_id]
            );
            const [[requesterRow]] = await db.query(
                `SELECT full_name, role FROM users WHERE user_id = ? LIMIT 1`,
                [requested_by_user_id]
            );

            documentPath = await generateTransferRequestDocx({
                requestId,
                companyName: process.env.COMPANY_NAME || null,
                companyInfo: process.env.COMPANY_INFO || null,
                requestDate: new Date().toISOString().slice(0, 10),
                worker: workerRow || {},
                currentSiteName: currentSiteRow?.site_name ? `${currentSiteRow.site_name} (${current_shift_type})` : null,
                targetSiteName: targetSiteRow?.site_name ? `${targetSiteRow.site_name} (${target_shift_type})` : null,
                contractName: currentSiteRow?.contract_name,
                requesterName: requesterRow?.full_name,
                requesterPosition: requesterRow?.role,
                transferReason: requestReason,
            });

            await db.query(
                `UPDATE worker_transfer_requests SET document_path = ? WHERE request_id = ?`,
                [documentPath, requestId]
            );
        } catch (docError) {
            console.error('TRANSFER DOCX GENERATION ERROR:', docError);
        }

        res.status(201).json({
            status: 'success',
            message: 'Transfer request submitted successfully for review.',
            request_id: requestId,
            document_available: Boolean(documentPath),
        });
    } catch (error) {
        console.error('CREATE TRANSFER ERROR:', error);
        res.status(500).json({ status: 'error', message: 'An error occurred while creating the transfer request.' });
    }
};

// 2. جلب الطلبات المعلقة
exports.getPendingTransfers = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT
                t.request_id, t.status, t.admin_notes, t.request_reason, t.created_at, t.document_path,
                t.current_shift_type, t.target_shift_type,
                DATE_FORMAT(t.effective_date, '%Y-%m-%d') AS effective_date,
                w.worker_id, w.full_name AS worker_name,
                cs.site_id AS current_site_id, cs.site_name AS current_site_name,
                ts.site_id AS target_site_id, ts.site_name AS target_site_name,
                u.full_name AS requested_by_name
             FROM worker_transfer_requests t
             JOIN workers w ON t.worker_id = w.worker_id
             JOIN sites cs ON t.current_site_id = cs.site_id
             JOIN sites ts ON t.target_site_id = ts.site_id
             JOIN users u ON t.requested_by_user_id = u.user_id
             WHERE t.status = 'Pending'
             ORDER BY t.created_at DESC`
        );
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error('FETCH PENDING TRANSFERS ERROR:', error);
        res.status(500).json({ status: 'error', message: 'An error occurred while fetching transfer requests.' });
    }
};

// 2b. Transfer history (Pending / Approved / Rejected, Request and Direct).
// GET /api/transfers?status=&type=&q=&limit=
exports.listTransfers = async (req, res) => {
    try {
        const where = [];
        const params = [];
        if (['Pending', 'Approved', 'Rejected'].includes(req.query.status)) { where.push('t.status = ?'); params.push(req.query.status); }
        if (['Request', 'Direct'].includes(req.query.type)) { where.push('t.transfer_type = ?'); params.push(req.query.type); }
        const q = String(req.query.q || '').trim();
        if (q) { where.push('(w.full_name LIKE ? OR w.worker_unique_id LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
        const [rows] = await db.query(
            `SELECT t.request_id, t.transfer_type, t.status, t.request_reason, t.admin_notes, t.created_at, t.reviewed_at,
                    DATE_FORMAT(t.effective_date, '%Y-%m-%d') AS effective_date,
                    t.current_shift_type, t.target_shift_type,
                    w.worker_id, w.full_name AS worker_name, w.worker_unique_id,
                    cs.site_name AS current_site_name, ts.site_name AS target_site_name,
                    u.full_name AS requested_by_name, ru.full_name AS reviewed_by_name
             FROM worker_transfer_requests t
             JOIN workers w ON t.worker_id = w.worker_id
             JOIN sites cs ON t.current_site_id = cs.site_id
             JOIN sites ts ON t.target_site_id = ts.site_id
             JOIN users u ON t.requested_by_user_id = u.user_id
             LEFT JOIN users ru ON ru.user_id = t.reviewed_by_user_id
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY t.created_at DESC LIMIT ${limit}`,
            params
        );
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error('LIST TRANSFERS ERROR:', error);
        res.status(500).json({ status: 'error', message: 'An error occurred while fetching transfers.' });
    }
};

// 3. مراجعة الطلب
exports.reviewTransferRequest = async (req, res) => {
    const { id } = req.params;
    const { status, admin_notes } = req.body;
    const adminId = req.user.user_id;

    if (!['Approved', 'Rejected'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'Invalid status provided.' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            `SELECT * FROM worker_transfer_requests WHERE request_id = ? FOR UPDATE`,
            [id]
        );
        if (rows.length === 0) throw new Error('Transfer request not found.');

        const request = rows[0];
        if (request.status !== 'Pending') {
            throw new Error('This request cannot be reviewed because it has already been processed.');
        }

        let effectiveDate = null;
        if (status === 'Approved') {
            // B3: the assignment history uses the explicit business effective date,
            // never the approval moment (NOW()/CURDATE()).
            //   old assignment: unassigned_date = effective_date - 1 (inclusive LAST assigned day)
            //   new assignment: assigned_date   = effective_date (FIRST day at the new site)
            effectiveDate = req.body.effective_date || (request.effective_date ? String(request.effective_date).slice(0, 10) : null);
            if (!effectiveDate || !isValidDateOnly(effectiveDate)) {
                throw new TransferError('An effective_date (YYYY-MM-DD) is required to approve this transfer.');
            }
            // B3 (final decision): future-dated transfers are allowed. The open
            // (unassigned_date IS NULL) current assignment is closed at the future
            // effective date (exclusive end) and the new one starts on that date.

            const [openAssignments] = await connection.execute(
                `SELECT assignment_id, DATE_FORMAT(assigned_date, '%Y-%m-%d') AS assigned_date
                 FROM workersiteassignments
                 WHERE worker_id = ? AND site_id = ? AND shift_type = ? AND unassigned_date IS NULL
                 FOR UPDATE`,
                [request.worker_id, request.current_site_id, request.current_shift_type]
            );
            if (openAssignments.length !== 1) {
                throw new TransferError(openAssignments.length === 0
                    ? 'The worker has no open assignment at the current site/shift.'
                    : 'The worker has more than one open assignment at the current site/shift.', 409);
            }
            const oldAssignment = openAssignments[0];
            if (effectiveDate <= oldAssignment.assigned_date) {
                throw new TransferError(`effective_date must be after the current assignment start (${oldAssignment.assigned_date}).`, 409);
            }

            // A retroactive transfer must not leave attendance at the old site
            // after the transfer took effect (that would be a conflicting history).
            const [conflicts] = await connection.execute(
                `SELECT attendance_id, DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date, status, source
                 FROM attendance
                 WHERE worker_id = ? AND site_id = ? AND shift_type = ? AND record_date >= ?
                 ORDER BY record_date`,
                [request.worker_id, request.current_site_id, request.current_shift_type, effectiveDate]
            );
            if (conflicts.length > 0) {
                throw new TransferError(
                    `The worker already has ${conflicts.length} attendance record(s) at the current site/shift on or after ${effectiveDate}. ` +
                    'Choose a later effective date or correct those records first.', 409, { conflicts });
            }

            // Conflicting assignment history at the target: an open assignment, or a
            // closed one that is still in effect on/after effective_date (exclusive end).
            const [targetOpen] = await connection.execute(
                `SELECT assignment_id,
                        DATE_FORMAT(assigned_date, '%Y-%m-%d') AS assigned_date,
                        DATE_FORMAT(unassigned_date, '%Y-%m-%d') AS unassigned_date
                 FROM workersiteassignments
                 WHERE worker_id = ? AND assignment_id <> ?
                   AND ${overlaps('workersiteassignments', '?', 'NULL')}`,
                [request.worker_id, oldAssignment.assignment_id, effectiveDate]
            );
            const [[targetSite0]] = await connection.execute(
                'SELECT site_status, supports_shifts, site_name FROM sites WHERE site_id = ? LIMIT 1', [request.target_site_id]);
            if (!targetSite0 || targetSite0.site_status !== 'Active') {
                throw new TransferError('The target site is not Active.', 409);
            }
            if (request.target_shift_type === 'Night' && Number(targetSite0.supports_shifts) !== 1) {
                throw new TransferError('The target site has no Night shift.', 409);
            }
            if (targetOpen.length > 0) {
                const hasOpen = targetOpen.some((a) => a.unassigned_date === null);
                throw new TransferError(hasOpen
                    ? 'The worker already has another open assignment.'
                    : `The worker already has another assignment that overlaps ${effectiveDate}.`,
                    409, { assignment_conflicts: targetOpen });
            }

            await connection.execute(
                `UPDATE workersiteassignments
                 SET unassigned_date = ?, ended_by_user_id = ?, ended_at = NOW(),
                     end_reason = ?, updated_at = NOW()
                 WHERE assignment_id = ? AND unassigned_date IS NULL`,
                [addDays(effectiveDate, -1), adminId, `Transfer request #${request.request_id}`, oldAssignment.assignment_id]
            );

            const [targetSite] = await connection.execute(
                `SELECT contract_id FROM sites WHERE site_id = ? LIMIT 1`,
                [request.target_site_id]
            );
            if (targetSite.length === 0) throw new TransferError('Target site does not exist.');
            const contract_id = targetSite[0].contract_id;

            await connection.execute(
                `INSERT INTO workersiteassignments 
                 (worker_id, site_id, contract_id, assigned_by_user_id, assigned_date, shift_type, created_at, updated_at) 
                 VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                [request.worker_id, request.target_site_id, contract_id, adminId, effectiveDate, request.target_shift_type]
            );

            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('worker_transfer_requests', ?, 'TRANSFER_APPROVED', ?, ?, ?)`,
                [request.request_id, adminId,
                    JSON.stringify({ assignment_id: oldAssignment.assignment_id, site_id: request.current_site_id, shift_type: request.current_shift_type }),
                    JSON.stringify({ site_id: request.target_site_id, shift_type: request.target_shift_type, effective_date: effectiveDate, approved_on: businessToday() })]
            );
        }

        if (status === 'Rejected') {
            if (!admin_notes || !String(admin_notes).trim()) {
                throw new TransferError('A rejection reason (admin_notes) is required.');
            }
            // C-10: rejections are audited like approvals.
            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('worker_transfer_requests', ?, 'TRANSFER_REJECTED', ?, ?, ?)`,
                [request.request_id, adminId, JSON.stringify({ status: 'Pending' }),
                    JSON.stringify({ status: 'Rejected', admin_notes, rejected_on: businessToday() })]
            );
        }

        // C-10: admin_notes holds ONLY the reviewer's note; request_reason is never overwritten.
        await connection.execute(
            `UPDATE worker_transfer_requests 
             SET status = ?, admin_notes = ?, effective_date = COALESCE(?, effective_date),
                 reviewed_by_user_id = ?, reviewed_at = NOW(), updated_at = NOW() 
             WHERE request_id = ?`,
            [status, admin_notes || null, effectiveDate, adminId, id]
        );

        await connection.commit();
        res.status(200).json({
            status: 'success',
            message: status === 'Approved' ? 'Request approved and worker transferred successfully.' : 'Transfer request rejected.'
        });
    } catch (error) {
        await connection.rollback();
        console.error('REVIEW TRANSFER ERROR:', error);
        res.status(error.statusCode || 400).json({
            status: 'error',
            message: error.message || 'An error occurred while processing the request.',
            ...(error.extra || {}),
        });
    } finally {
        connection.release();
    }
};

// 4. تحميل مستند التحويل — بدون تغيير جوهري (فقط أسماء الحقول بالتوليد أعلاه)
exports.downloadTransferDocument = async (req, res) => {
    const { id } = req.params;
    try {
        const [[row]] = await db.query(
            `SELECT 
                t.document_path, t.requested_by_user_id, t.created_at, t.admin_notes, t.request_reason,
                t.current_shift_type, t.target_shift_type,
                w.full_name, w.worker_unique_id, w.job_position, w.nationality, w.phone_number, w.hire_date,
                cs.site_name AS current_site_name, c.contract_name,
                ts.site_name AS target_site_name,
                u.full_name AS requester_name, u.role AS requester_role
             FROM worker_transfer_requests t
             JOIN workers w ON t.worker_id = w.worker_id
             JOIN sites cs ON t.current_site_id = cs.site_id
             JOIN sites ts ON t.target_site_id = ts.site_id
             LEFT JOIN contracts c ON c.contract_id = cs.contract_id
             JOIN users u ON t.requested_by_user_id = u.user_id
             WHERE t.request_id = ? LIMIT 1`,
            [id]
        );

        if (!row) {
            return res.status(404).json({ status: 'error', message: 'Transfer request not found.' });
        }

        const isOwner = req.user.role === 'Supervisor' && req.user.user_id === row.requested_by_user_id;
        if (req.user.role !== 'Admin' && !isOwner) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to download this document.' });
        }

        let absolutePath = row.document_path ? path.join(__dirname, '..', row.document_path) : null;

        if (!absolutePath || !fs.existsSync(absolutePath)) {
            try {
                const generatedPath = await generateTransferRequestDocx({
                    requestId: id,
                    companyName: process.env.COMPANY_NAME || null,
                    companyInfo: process.env.COMPANY_INFO || null,
                    requestDate: row.created_at ? String(row.created_at).slice(0, 10) : new Date().toISOString().slice(0, 10),
                    worker: {
                        full_name: row.full_name,
                        worker_unique_id: row.worker_unique_id,
                        job_position: row.job_position,
                        nationality: row.nationality,
                        phone_number: row.phone_number,
                        hire_date: row.hire_date,
                    },
                    currentSiteName: `${row.current_site_name} (${row.current_shift_type})`,
                    targetSiteName: `${row.target_site_name} (${row.target_shift_type})`,
                    contractName: row.contract_name,
                    requesterName: row.requester_name,
                    requesterPosition: row.requester_role,
                    // C-10: the document prints the requester's reason, never the admin note.
                    transferReason: row.request_reason || null,
                });

                await db.query(
                    `UPDATE worker_transfer_requests SET document_path = ? WHERE request_id = ?`,
                    [generatedPath, id]
                );

                absolutePath = path.join(__dirname, '..', generatedPath);
            } catch (genError) {
                console.error('ON-THE-FLY DOCX GENERATION ERROR:', genError);
                return res.status(500).json({ status: 'error', message: 'Failed to generate document on the fly.' });
            }
        }

        return res.download(absolutePath);
    } catch (error) {
        console.error('DOWNLOAD TRANSFER DOCUMENT ERROR:', error);
        res.status(500).json({ status: 'error', message: 'An error occurred while downloading the document.' });
    }
};