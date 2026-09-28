const biometricDeviceUserService = require('../services/biometricDeviceUserService');

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

module.exports = {
  listDeviceUserMappings,
  resolveDeviceUser,
  createDeviceUserMapping,
  endDeviceUserMapping,
  voidDeviceUserMapping,
};