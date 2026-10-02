const db = require('../config/db');
const settingsCache = require('./settingsCache');
const anomalyService = require('./anomalyService');

function parseWallClockDateTime(value) {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value));
    if (!match) return null;

    const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00'] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;

    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (Number.isNaN(date.getTime())) return null;
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day || date.getUTCHours() !== hour ||
        date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
    return date;
}

exports.calculateWorkingHours = async (attendance_id, executor = db) => {
    const [rows] = await executor.execute(
        `SELECT check_in_time,
                check_out_time,
                record_date,
                management_leave_hours,
                standard_minutes_snapshot
         FROM attendance
         WHERE attendance_id = ?`,
        [attendance_id]
    );
    if (rows.length === 0) throw new Error('Attendance record not found.');

    const { check_in_time, check_out_time, record_date, management_leave_hours, standard_minutes_snapshot } = rows[0];
    const start = parseWallClockDateTime(check_in_time);
    const end = parseWallClockDateTime(check_out_time);
    if (!start || !end) throw new Error('Cannot calculate hours without valid check-in and check-out times.');
    if (end <= start) throw new Error('Check-out must be after check-in.');

    let totalMinutes = (end.getTime() - start.getTime()) / 60000;
    // D3: the value that applied on the record's own date (not today's value).
    const recordDateStr = String(record_date).slice(0, 10);
    const isLunchPaid = String(await settingsCache.getSettingForDate('is_lunch_paid', recordDateStr, 'false')).toLowerCase() === 'true';
    const [leaves] = await executor.execute(
        `SELECT leave_start_time, leave_end_time, leave_type
         FROM attendanceleaveperiods
         WHERE attendance_id = ? AND leave_end_time IS NOT NULL`,
        [attendance_id]
    );

    for (const leave of leaves) {
        const leaveStart = parseWallClockDateTime(leave.leave_start_time);
        const leaveEnd = parseWallClockDateTime(leave.leave_end_time);
        if (!leaveStart || !leaveEnd || leaveEnd <= leaveStart) throw new Error(`Invalid leave period for attendance ${attendance_id}.`);
        if (leaveStart < start || leaveEnd > end) throw new Error(`Leave period is outside attendance shift ${attendance_id}.`);
        const duration = (leaveEnd.getTime() - leaveStart.getTime()) / 60000;
        if (leave.leave_type === 'Rest' || (leave.leave_type === 'Lunch' && !isLunchPaid)) totalMinutes -= duration;
    }

    const managementHours = Number(management_leave_hours || 0);
    if (!Number.isFinite(managementHours) || managementHours < 0) throw new Error('Invalid management leave hours.');
    totalMinutes = Math.max(0, totalMinutes + managementHours * 60);

    // تحديد الـ standardMinutes باستخدام الـ Snapshot أو جلبها وحفظها إن لم تكن موجودة
let standardMinutes;
if (standard_minutes_snapshot !== null) {
    standardMinutes = Number(standard_minutes_snapshot);
} else {
    // استخدام JOIN لتحسين الأداء بدل الـ Subquery
    const [[workerRow]] = await executor.execute(
        `SELECT w.standard_daily_minutes 
         FROM attendance a
         JOIN workers w ON w.worker_id = a.worker_id
         WHERE a.attendance_id = ?
         LIMIT 1`,
        [attendance_id]
    );
    const workerCustomMinutes = workerRow?.standard_daily_minutes;

    const configuredStandardMinutes = Number(await settingsCache.getSettingForDate('standard_work_minutes', recordDateStr, '600'));

    standardMinutes = (Number.isFinite(Number(workerCustomMinutes)) && Number(workerCustomMinutes) > 0)
        ? Number(workerCustomMinutes)
        : (Number.isFinite(configuredStandardMinutes) && configuredStandardMinutes > 0
            ? configuredStandardMinutes
            : 600);

    // حفظ الـ snapshot مرة واحدة فقط هنا دون تكرار
    await executor.execute(
        `UPDATE attendance
         SET standard_minutes_snapshot = ?
         WHERE attendance_id = ?
           AND standard_minutes_snapshot IS NULL`,
        [standardMinutes, attendance_id]
    );
}

// §13: overtime is no longer clamped to 99.99 (the column is DECIMAL(6,2) after
// the 2026-10 migration). An unreasonable duration is NOT hidden or truncated:
// it is stored as calculated and flagged for review (anomaly_code) below.
const regularHours = Math.min(totalMinutes, standardMinutes) / 60;
const overtimeHours = Math.max(0, totalMinutes - standardMinutes) / 60;
if (regularHours > 9999.99 || overtimeHours > 9999.99) {
    throw new Error('Calculated hours exceed the storable range; check the check-in/check-out times.');
}

await executor.execute(
    `UPDATE attendance SET total_working_hours = ?, overtime_hours = ? WHERE attendance_id = ?`,
    [regularHours.toFixed(2), overtimeHours.toFixed(2), attendance_id]
);

// D-09: duration is a warning signal only (never decides the shift).
const anomaly = await anomalyService.evaluateSession(check_in_time, check_out_time, recordDateStr);
await anomalyService.applyAnomalyFlag(executor, 'attendance', 'attendance_id', attendance_id, anomaly);
return { regularHours, overtimeHours, anomaly };
};

exports.parseWallClockDateTime = parseWallClockDateTime;