const biometricDeviceUserService = require('../services/biometricDeviceUserService');
const db = require('../config/db');
function getUserId(req) {
  const userId = Number(req.user?.user_id ?? req.user?.id);

  if (!Number.isInteger(userId) || userId <= 0) {
    const error = new Error('Authenticated user id is missing.');
    error.statusCode = 401;
    throw error;
  }

  return userId;
}

function sendError(res, error) {
  const statusCode = Number.isInteger(error.statusCode)
    ? error.statusCode
    : 500;

  return res.status(statusCode).json({
    success: false,
    message: error.message || 'Internal server error.',
  });
}

async function listDeviceUserMappings(req, res) {
  try {
    const result =
      await biometricDeviceUserService.listDeviceUserMappings({
        deviceEmployeeId: req.query.device_employee_id,
        entityType: req.query.entity_type,
        active: req.query.active,
      });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function resolveDeviceUser(req, res) {
  try {
    const result =
      await biometricDeviceUserService.resolveDeviceUser(
        req.query.device_employee_id,
        req.query.punched_at
      );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function createDeviceUserMapping(req, res) {
  try {
    const result =
      await biometricDeviceUserService.createDeviceUserMapping({
        deviceEmployeeId: req.body.device_employee_id,
        entityType: req.body.entity_type,
        staffId:
          req.body.staff_id !== undefined
            ? Number(req.body.staff_id)
            : undefined,
        workerId:
          req.body.worker_id !== undefined
            ? Number(req.body.worker_id)
            : undefined,
        effectiveFrom: req.body.effective_from,
        effectiveTo: req.body.effective_to ?? null,
        createdByUserId: getUserId(req),
      });

    return res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function endDeviceUserMapping(req, res) {
  try {
    const mappingId = Number(req.params.id);

    const result =
      await biometricDeviceUserService.endDeviceUserMapping({
        mappingId,
        effectiveTo: req.body.effective_to,
        reason: req.body.reason,
        userId: getUserId(req),
      });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function voidDeviceUserMapping(req, res) {
  try {
    const mappingId = Number(req.params.id);

    const result =
      await biometricDeviceUserService.voidDeviceUserMapping({
        mappingId,
        reason: req.body.reason,
        userId: getUserId(req),
      });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
async function listAvailableEntities(req, res) {
  try {
    const entityType = String(req.query.entity_type || '').trim();

    if (!['Worker', 'Staff'].includes(entityType)) {
      return res.status(400).json({
        success: false,
        message: 'entity_type must be Worker or Staff.',
      });
    }

    let rows;

    // D5: ?include_inactive=1 lists every person (any status, even if already
    // mapped) so an Admin can create a CLOSED historical mapping for someone who
    // is now inactive/terminated. The default list (open mappings) is unchanged.
    const includeInactive = ['1', 'true'].includes(String(req.query.include_inactive || '').toLowerCase());
    if (includeInactive) {
      if (entityType === 'Worker') {
        [rows] = await db.execute(
          `SELECT w.worker_id, w.worker_unique_id, w.full_name, w.hire_date AS start_date,
                  w.status, NULL AS termination_date
           FROM workers w
           ORDER BY w.status, w.full_name`
        );
      } else {
        [rows] = await db.execute(
          `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.position,
                  COALESCE(sm.first_hire_date, sm.hire_date) AS start_date,
                  sm.status, sm.termination_date
           FROM staff_members sm
           ORDER BY sm.status, sm.full_name`
        );
      }
      return res.status(200).json({ success: true, data: rows });
    }

    if (entityType === 'Worker') {
      [rows] = await db.execute(
        `SELECT w.worker_id, w.worker_unique_id, w.full_name, w.hire_date AS start_date 
         FROM workers w
         WHERE w.status = 'Active'
           AND NOT EXISTS (
             SELECT 1
             FROM attendance_device_users du
             WHERE du.worker_id = w.worker_id
               AND du.entity_type = 'Worker'
               AND du.active = 1
           )
         ORDER BY w.full_name`
      );
    } else {
      [rows] = await require('../config/db').execute(
       `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.position,
        COALESCE(sm.first_hire_date, sm.hire_date) AS start_date 
         FROM staff_members sm
         WHERE sm.status = 'Active'
           AND NOT EXISTS (
             SELECT 1
             FROM attendance_device_users du
             WHERE du.staff_id = sm.staff_id
               AND du.entity_type = 'Staff'
               AND du.active = 1
           )
         ORDER BY sm.full_name`
      );
    }

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
module.exports = {
  listDeviceUserMappings,
  resolveDeviceUser,
  createDeviceUserMapping,
  endDeviceUserMapping,
  voidDeviceUserMapping,
  listAvailableEntities,
};