// services/biometricDeviceUserService.js
//
// Section 2A: Biometric device employee ID -> Worker/Staff mapping.
//
// This service owns ONLY the mapping layer.
// It does NOT create attendance, calculate hours, handle payroll,
// or modify manual Worker/Staff attendance logic.
//
// Mapping validity on punch date D:
//   active = 1
//   effective_from <= D
//   AND (effective_to IS NULL OR D <= effective_to)
//
// device_employee_id is matched exactly as a string.
// Therefore "1" and "01" are different device IDs.

const db = require('../config/db');
const { businessToday } = require('./businessDate');
const {
  acquireCreateLock,
  releaseCreateLock,
} = require('../middleware/duplicateGuard');

const DEVICE_ID_RE = /^\d{1,20}$/;
const OPEN_END = '9999-12-31';

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    return false;
  }

  const [y, m, d] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));

  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function isValidDeviceEmployeeId(value) {
  return DEVICE_ID_RE.test(String(value ?? ''));
}

// B10: business date (Asia/Beirut), not the UTC date.
function todayDateOnly() {
  return businessToday();
}

// Accepts:
//   YYYY-MM-DD
//   YYYY-MM-DD HH:mm:ss
//   YYYY-MM-DDTHH:mm:ss
// Returns only the date part.
function toPunchDate(punchedAt) {
  const text = String(punchedAt ?? '').trim();

  const match =
    /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.exec(text);

  return match && isValidDateOnly(match[1]) ? match[1] : null;
}

function createServiceError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.isOperational = true;
  return error;
}

function requireReason(reason, fieldName = 'reason') {
  if (!reason || !String(reason).trim()) {
    throw createServiceError(`${fieldName} is required.`);
  }

  return String(reason).trim();
}

function normalizeEntityType(value) {
  if (value !== 'Worker' && value !== 'Staff') {
    throw createServiceError('entity_type must be either "Worker" or "Staff".');
  }

  return value;
}

/**
 * Resolve a device employee ID to its mapping on a punch date.
 *
 * This is the single shared resolution rule that Section 2B should use.
 *
 * @returns {Promise<null | {
 *   mapping_id:number,
 *   device_employee_id:string,
 *   entity_type:'Staff'|'Worker',
 *   staff_id:number|null,
 *   worker_id:number|null
 * }>}
 */
async function resolveDeviceUser(deviceEmployeeId, punchedAt, executor = db) {
  if (!isValidDeviceEmployeeId(deviceEmployeeId)) {
    return null;
  }

  const punchDate = toPunchDate(punchedAt);

  if (!punchDate) {
    return null;
  }

  const [rows] = await executor.execute(
    `SELECT
       id,
       device_employee_id,
       entity_type,
       staff_id,
       worker_id
     FROM attendance_device_users
     WHERE device_employee_id = ?
       AND active = 1
       AND effective_from <= ?
       AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY effective_from DESC, id DESC
     LIMIT 1`,
    [String(deviceEmployeeId), punchDate, punchDate]
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];

  return {
    mapping_id: row.id,
    device_employee_id: row.device_employee_id,
    entity_type: row.entity_type,
    staff_id: row.staff_id ?? null,
    worker_id: row.worker_id ?? null,
  };
}

/**
 * True when another ACTIVE mapping of the SAME device ID overlaps
 * [from, to].
 *
 * effective_to is inclusive.
 *
 * Must be called:
 *   1. inside a transaction
 *   2. after acquiring the per-device GET_LOCK
 */
async function hasOverlappingMapping(
  executor,
  deviceEmployeeId,
  from,
  to,
  excludeId = null
) {
  const [rows] = await executor.execute(
    `SELECT id
     FROM attendance_device_users
     WHERE device_employee_id = ?
       AND active = 1
       AND id <> ?
       AND effective_from <= ?
       AND COALESCE(effective_to, '${OPEN_END}') >= ?
     LIMIT 1
     FOR UPDATE`,
    [
      String(deviceEmployeeId),
      excludeId ?? 0,
      to || OPEN_END,
      from,
    ]
  );

  return rows.length > 0;
}

// D5: an OPEN-ended mapping (effective_to = NULL) requires the person to be
// Active now. A CLOSED historical mapping (effective_to given) is allowed for
// inactive workers and inactive/terminated staff, so their historical punches
// can be mapped and processed. For a terminated staff member effective_to must
// not exceed the termination date.
async function getEntityForMapping(connection, entityType, entityId, effectiveTo = null) {
  const isClosed = effectiveTo !== null && effectiveTo !== undefined && effectiveTo !== '';
  if (!Number.isInteger(entityId) || entityId <= 0) {
    throw createServiceError(
      `${entityType === 'Worker' ? 'worker_id' : 'staff_id'} must be a valid positive integer.`
    );
  }

  if (entityType === 'Worker') {
    const [rows] = await connection.execute(
      `SELECT
         worker_id,
         status,
         hire_date
       FROM workers
       WHERE worker_id = ?
       FOR UPDATE`,
      [entityId]
    );

    if (rows.length === 0) {
      throw createServiceError('Worker not found.', 404);
    }

    const worker = rows[0];

    if (worker.status !== 'Active' && !isClosed) {
      throw createServiceError(
        'An open-ended biometric mapping requires an Active Worker. For an inactive Worker, provide effective_to (a closed historical mapping).'
      );
    }

    const hireDate = worker.hire_date
      ? String(worker.hire_date).slice(0, 10)
      : null;

    if (!hireDate) {
      throw createServiceError(
        'Worker does not have a valid hire_date.'
      );
    }

    return {
      worker_id: worker.worker_id,
      staff_id: null,
      start_date: hireDate,
      status: worker.status,
    };
  }

  const [rows] = await connection.execute(
    `SELECT
       staff_id,
       status,
       hire_date,
       first_hire_date,
       termination_date
     FROM staff_members
     WHERE staff_id = ?
     FOR UPDATE`,
    [entityId]
  );

  if (rows.length === 0) {
    throw createServiceError('Staff member not found.', 404);
  }

  const staff = rows[0];

  if (staff.status !== 'Active' && !isClosed) {
    throw createServiceError(
      `An open-ended biometric mapping requires an Active Staff member (current status: ${staff.status}). Provide effective_to for a closed historical mapping.`
    );
  }

  if (staff.status === 'Terminated' && isClosed && staff.termination_date) {
    const terminationDate = String(staff.termination_date).slice(0, 10);
    if (effectiveTo > terminationDate) {
      throw createServiceError(
        `effective_to cannot be after the staff member's termination date (${terminationDate}).`
      );
    }
  }

  const startDate = staff.first_hire_date
    ? String(staff.first_hire_date).slice(0, 10)
    : staff.hire_date
      ? String(staff.hire_date).slice(0, 10)
      : null;

  if (!startDate) {
    throw createServiceError(
      'Staff member does not have a valid hire/start date.'
    );
  }

  return {
    worker_id: null,
    staff_id: staff.staff_id,
    start_date: startDate,
    status: staff.status,
  };
}

/**
 * Create a new biometric device-user mapping.
 *
 * Multiple different device IDs may belong to the same person.
 * The uniqueness rule is only:
 *   SAME device ID + overlapping ACTIVE date range = rejected.
 */
async function createDeviceUserMapping({
  deviceEmployeeId,
  entityType,
  workerId = null,
  staffId = null,
  effectiveFrom,
  effectiveTo = null,
  createdByUserId,
}) {
  if (!isValidDeviceEmployeeId(deviceEmployeeId)) {
    throw createServiceError(
      'device_employee_id must contain only digits and be 1 to 20 characters long.'
    );
  }

  const normalizedDeviceId = String(deviceEmployeeId);

  const normalizedEntityType = normalizeEntityType(entityType);

  if (!isValidDateOnly(effectiveFrom)) {
    throw createServiceError(
      'effective_from must be a valid date in YYYY-MM-DD format.'
    );
  }

  if (effectiveTo !== null && effectiveTo !== undefined) {
    if (!isValidDateOnly(effectiveTo)) {
      throw createServiceError(
        'effective_to must be a valid date in YYYY-MM-DD format or null.'
      );
    }

    if (effectiveTo < effectiveFrom) {
      throw createServiceError(
        'effective_to cannot be before effective_from.'
      );
    }
  }

  if (effectiveFrom > todayDateOnly()) {
    throw createServiceError(
      'effective_from cannot be in the future.'
    );
  }

  if (!Number.isInteger(createdByUserId) || createdByUserId <= 0) {
    throw createServiceError('A valid created_by_user_id is required.');
  }

  if (normalizedEntityType === 'Worker') {
    if (!Number.isInteger(workerId) || workerId <= 0) {
      throw createServiceError('worker_id is required for Worker mappings.');
    }

    if (staffId !== null && staffId !== undefined) {
      throw createServiceError(
        'staff_id must not be provided for Worker mappings.'
      );
    }
  } else {
    if (!Number.isInteger(staffId) || staffId <= 0) {
      throw createServiceError('staff_id is required for Staff mappings.');
    }

    if (workerId !== null && workerId !== undefined) {
      throw createServiceError(
        'worker_id must not be provided for Staff mappings.'
      );
    }
  }

  const connection = await db.getConnection();
  const lockKey = `attendance_device_user:${normalizedDeviceId}`;
  let lockAcquired = false;
  let transactionStarted = false;

  try {
    lockAcquired = await acquireCreateLock(
      connection,
      lockKey,
      5
    );

    if (!lockAcquired) {
      throw createServiceError(
        'Could not obtain the device mapping lock. Please try again.',
        409
      );
    }

    await connection.beginTransaction();
    transactionStarted = true;

    const entityId =
      normalizedEntityType === 'Worker' ? workerId : staffId;

    const entity = await getEntityForMapping(
      connection,
      normalizedEntityType,
      entityId,
      effectiveTo || null
    );

    if (effectiveFrom < entity.start_date) {
      throw createServiceError(
        `effective_from cannot be before the person's start date (${entity.start_date}).`
      );
    }

    const overlap = await hasOverlappingMapping(
      connection,
      normalizedDeviceId,
      effectiveFrom,
      effectiveTo
    );

    if (overlap) {
      throw createServiceError(
        'An active mapping already exists for this device employee ID during the requested date range.',
        409
      );
    }

    const [result] = await connection.execute(
      `INSERT INTO attendance_device_users
         (
           device_employee_id,
           entity_type,
           staff_id,
           worker_id,
           effective_from,
           effective_to,
           active,
           created_by_user_id
         )
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        normalizedDeviceId,
        normalizedEntityType,
        entity.staff_id,
        entity.worker_id,
        effectiveFrom,
        effectiveTo || null,
        createdByUserId,
      ]
    );

    const mappingId = result.insertId;

    await connection.execute(
      `INSERT INTO auditlogs
         (
           table_name,
           record_id,
           action_type,
           user_id,
           old_values,
           new_values
         )
       VALUES ('attendance_device_users', ?, 'DEVICE_USER_MAPPED', ?, NULL, ?)`,
      [
        mappingId,
        createdByUserId,
        JSON.stringify({
          device_employee_id: normalizedDeviceId,
          entity_type: normalizedEntityType,
          staff_id: entity.staff_id,
          worker_id: entity.worker_id,
          effective_from: effectiveFrom,
          effective_to: effectiveTo || null,
          active: 1,
        }),
      ]
    );

    await connection.commit();
    transactionStarted = false;

    return {
      id: mappingId,
      device_employee_id: normalizedDeviceId,
      entity_type: normalizedEntityType,
      staff_id: entity.staff_id,
      worker_id: entity.worker_id,
      effective_from: effectiveFrom,
      effective_to: effectiveTo || null,
      active: 1,
    };
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
    }

    throw error;
  } finally {
    if (lockAcquired) {
      await releaseCreateLock(connection, lockKey);
    }

    connection.release();
  }
}

/**
 * List mappings.
 *
 * Optional filters:
 *   deviceEmployeeId
 *   entityType
 *   active
 */
async function listDeviceUserMappings({
  deviceEmployeeId = null,
  entityType = null,
  active = null,
}) {
  const conditions = [];
  const params = [];

  if (deviceEmployeeId !== null && deviceEmployeeId !== undefined) {
    if (!isValidDeviceEmployeeId(deviceEmployeeId)) {
      throw createServiceError(
        'device_employee_id must contain only digits and be 1 to 20 characters long.'
      );
    }

    conditions.push('adu.device_employee_id = ?');
    params.push(String(deviceEmployeeId));
  }

  if (entityType !== null && entityType !== undefined) {
    normalizeEntityType(entityType);
    conditions.push('adu.entity_type = ?');
    params.push(entityType);
  }

  if (active !== null && active !== undefined) {
    if (!['0', '1', 0, 1, true, false].includes(active)) {
      throw createServiceError('active must be 0 or 1.');
    }

    const activeValue =
      active === true || active === 1 || active === '1' ? 1 : 0;

    conditions.push('adu.active = ?');
    params.push(activeValue);
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  const [rows] = await db.execute(
    `SELECT
       adu.id,
       adu.device_employee_id,
       adu.entity_type,
       adu.staff_id,
       sm.full_name AS staff_name,
       adu.worker_id,
       w.full_name AS worker_name,
       adu.effective_from,
       adu.effective_to,
       adu.active,
       adu.created_by_user_id,
       adu.created_at,
       adu.updated_at
     FROM attendance_device_users adu
     LEFT JOIN staff_members sm
       ON sm.staff_id = adu.staff_id
     LEFT JOIN workers w
       ON w.worker_id = adu.worker_id
     ${where}
     ORDER BY
       adu.device_employee_id ASC,
       adu.effective_from DESC,
       adu.id DESC`,
    params
  );

  return rows;
}

/**
 * End an active mapping by setting effective_to.
 *
 * effective_to is inclusive.
 * The mapping itself remains active historically, but no longer resolves
 * after effective_to.
 */
async function endDeviceUserMapping({
  mappingId,
  effectiveTo,
  reason,
  userId,
}) {
  if (!Number.isInteger(mappingId) || mappingId <= 0) {
    throw createServiceError('Invalid mapping id.');
  }

  if (!isValidDateOnly(effectiveTo)) {
    throw createServiceError(
      'effective_to must be a valid date in YYYY-MM-DD format.'
    );
  }

  const normalizedReason = requireReason(reason);

  if (!Number.isInteger(userId) || userId <= 0) {
    throw createServiceError('A valid user_id is required.');
  }

  const connection = await db.getConnection();
  let lockAcquired = false;
  let transactionStarted = false;
  let lockKey = null;

  try {
    // First read the device ID so we can acquire the same per-device
    // GET_LOCK used by createDeviceUserMapping.
    const [mappingRows] = await connection.execute(
      `SELECT device_employee_id
       FROM attendance_device_users
       WHERE id = ?`,
      [mappingId]
    );

    if (mappingRows.length === 0) {
      throw createServiceError('Biometric device mapping not found.', 404);
    }

    lockKey = `attendance_device_user:${mappingRows[0].device_employee_id}`;

    lockAcquired = await acquireCreateLock(
      connection,
      lockKey,
      5
    );

    if (!lockAcquired) {
      throw createServiceError(
        'Could not obtain the device mapping lock. Please try again.',
        409
      );
    }

    await connection.beginTransaction();
    transactionStarted = true;

    const [rows] = await connection.execute(
      `SELECT
         id,
         device_employee_id,
         entity_type,
         staff_id,
         worker_id,
         effective_from,
         effective_to,
         active
       FROM attendance_device_users
       WHERE id = ?
       FOR UPDATE`,
      [mappingId]
    );

    if (rows.length === 0) {
      throw createServiceError('Biometric device mapping not found.', 404);
    }

    const mapping = rows[0];

    if (mapping.active !== 1) {
      throw createServiceError(
        'This mapping is already inactive.'
      );
    }

    const effectiveFrom = String(mapping.effective_from).slice(0, 10);

    if (effectiveTo < effectiveFrom) {
      throw createServiceError(
        'effective_to cannot be before effective_from.'
      );
    }

    // C-15: ending (or extending) a mapping may never make it overlap another
    // active mapping of the same device ID.
    if (await hasOverlappingMapping(connection, mapping.device_employee_id, effectiveFrom, effectiveTo, mappingId)) {
      throw createServiceError(
        'This end date would overlap another active mapping of the same device ID.',
        409
      );
    }

    const oldValues = {
      device_employee_id: mapping.device_employee_id,
      entity_type: mapping.entity_type,
      staff_id: mapping.staff_id,
      worker_id: mapping.worker_id,
      effective_from: effectiveFrom,
      effective_to: mapping.effective_to
        ? String(mapping.effective_to).slice(0, 10)
        : null,
      active: mapping.active,
    };

    await connection.execute(
      `UPDATE attendance_device_users
       SET effective_to = ?
       WHERE id = ?`,
      [effectiveTo, mappingId]
    );

    await connection.execute(
      `INSERT INTO auditlogs
         (
           table_name,
           record_id,
           action_type,
           user_id,
           old_values,
           new_values
         )
       VALUES ('attendance_device_users', ?, 'DEVICE_USER_MAPPING_ENDED', ?, ?, ?)`,
      [
        mappingId,
        userId,
        JSON.stringify(oldValues),
        JSON.stringify({
          ...oldValues,
          effective_to: effectiveTo,
          reason: normalizedReason,
        }),
      ]
    );

    await connection.commit();
    transactionStarted = false;

    return {
      ...oldValues,
      effective_to: effectiveTo,
      active: 1,
    };
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
    }

    throw error;
  } finally {
    if (lockAcquired && lockKey) {
      await releaseCreateLock(connection, lockKey);
    }

    connection.release();
  }
}

/**
 * Void an active mapping.
 *
 * No deletion. The historical row remains.
 */
async function voidDeviceUserMapping({
  mappingId,
  reason,
  userId,
}) {
  if (!Number.isInteger(mappingId) || mappingId <= 0) {
    throw createServiceError('Invalid mapping id.');
  }

  const normalizedReason = requireReason(reason);

  if (!Number.isInteger(userId) || userId <= 0) {
    throw createServiceError('A valid user_id is required.');
  }

  const connection = await db.getConnection();
  let lockAcquired = false;
  let transactionStarted = false;
  let lockKey = null;

  try {
    // First read the device ID so we can acquire the same per-device
    // GET_LOCK used by createDeviceUserMapping.
    const [mappingRows] = await connection.execute(
      `SELECT device_employee_id
       FROM attendance_device_users
       WHERE id = ?`,
      [mappingId]
    );

    if (mappingRows.length === 0) {
      throw createServiceError('Biometric device mapping not found.', 404);
    }

    lockKey = `attendance_device_user:${mappingRows[0].device_employee_id}`;

    lockAcquired = await acquireCreateLock(
      connection,
      lockKey,
      5
    );

    if (!lockAcquired) {
      throw createServiceError(
        'Could not obtain the device mapping lock. Please try again.',
        409
      );
    }

    await connection.beginTransaction();
    transactionStarted = true;

    const [rows] = await connection.execute(
      `SELECT
         id,
         device_employee_id,
         entity_type,
         staff_id,
         worker_id,
         effective_from,
         effective_to,
         active
       FROM attendance_device_users
       WHERE id = ?
       FOR UPDATE`,
      [mappingId]
    );

    if (rows.length === 0) {
      throw createServiceError('Biometric device mapping not found.', 404);
    }

    const mapping = rows[0];

    if (mapping.active !== 1) {
      throw createServiceError(
        'This mapping is already inactive.'
      );
    }

    const oldValues = {
      device_employee_id: mapping.device_employee_id,
      entity_type: mapping.entity_type,
      staff_id: mapping.staff_id,
      worker_id: mapping.worker_id,
      effective_from: String(mapping.effective_from).slice(0, 10),
      effective_to: mapping.effective_to
        ? String(mapping.effective_to).slice(0, 10)
        : null,
      active: mapping.active,
    };

    await connection.execute(
      `UPDATE attendance_device_users
       SET active = 0
       WHERE id = ?`,
      [mappingId]
    );

    await connection.execute(
      `INSERT INTO auditlogs
         (
           table_name,
           record_id,
           action_type,
           user_id,
           old_values,
           new_values
         )
       VALUES ('attendance_device_users', ?, 'DEVICE_USER_MAPPING_VOIDED', ?, ?, ?)`,
      [
        mappingId,
        userId,
        JSON.stringify(oldValues),
        JSON.stringify({
          ...oldValues,
          active: 0,
          reason: normalizedReason,
        }),
      ]
    );

    await connection.commit();
    transactionStarted = false;

    return {
      ...oldValues,
      active: 0,
    };
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
    }

    throw error;
  } finally {
    if (lockAcquired && lockKey) {
      await releaseCreateLock(connection, lockKey);
    }

    connection.release();
  }
}

module.exports = {
  DEVICE_ID_RE,
  isValidDateOnly,
  isValidDeviceEmployeeId,
  toPunchDate,
  resolveDeviceUser,
  hasOverlappingMapping,
  createDeviceUserMapping,
  listDeviceUserMappings,
  endDeviceUserMapping,
  voidDeviceUserMapping,
};