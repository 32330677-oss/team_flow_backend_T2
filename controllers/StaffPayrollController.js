const pool = require('../config/db');
const { countNonFridayDays, listNonFridayDates, isFriday, round2 } = require('../services/staffAttendanceService');
const { getActiveSpansOverlapping } = require('../services/staffEmploymentService');
const { buildStaffCompensationTimeline } = require('../services/staffCompensationService');
const settingsCache = require('../services/settingsCache');
function isValidDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}

function money(value) {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function getPaidLeaveTypes(staff) {
    const defaults = ['Sick', 'Vacation', 'Holiday'];
    if (!staff.paid_leave_types) return defaults;
    try {
        const parsed = typeof staff.paid_leave_types === 'string' ? JSON.parse(staff.paid_leave_types) : staff.paid_leave_types;
        return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaults;
    } catch (_) {
        return defaults;
    }
}

async function generateStaffPayrollBatch(req, res) {
    const { start_date, end_date, acknowledge_pending } = req.body || {};
    const acknowledgePending = acknowledge_pending === true;
    const userId = req.user?.user_id;
    // D-03: set only by staffPayrollVersioningController.createNewVersion —
    // the replacement is generated and verified BEFORE the old batch is
    // superseded, in the same transaction.
    const supersede = req._supersede || null;

    if (!userId) return res.status(401).json({ status: 'error', message: 'Unable to determine user identity' });
    if (!isValidDate(start_date) || !isValidDate(end_date)) {
        return res.status(400).json({ status: 'error', message: 'Please enter valid dates in YYYY-MM-DD format' });
    }
    if (end_date < start_date) {
        return res.status(400).json({ status: 'error', message: 'End date must be after or equal to start date' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [overlap] = await connection.execute(
            `SELECT staff_payroll_batch_id FROM staff_payroll_batches
             WHERE start_date <= ? AND end_date >= ? AND status IN ('Generated','Paid')
               AND staff_payroll_batch_id <> ? LIMIT 1 FOR UPDATE`,
            [end_date, start_date, supersede ? supersede.batchId : 0]
        );
        if (overlap.length) {
            await connection.rollback();
            return res.status(409).json({ status: 'error', message: 'A payroll batch overlapping with this period already exists' });
        }
        if (supersede) {
            const [[old]] = await connection.execute(
                'SELECT status, start_date, end_date FROM staff_payroll_batches WHERE staff_payroll_batch_id = ? FOR UPDATE', [supersede.batchId]);
            if (!old || old.status !== 'Generated') {
                await connection.rollback();
                return res.status(409).json({ status: 'error', message: 'The batch to supersede is no longer active (or is Paid).' });
            }
        }


        // Terminated حالياً ممكن يكون كان فعلاً Active خلال جزء من
        // [start_date, end_date] (مثال: توليد/إعادة توليد فترة قديمة
        // بعد ما صار الموظف Inactive اليوم). الأهلية تُحسم لاحقاً لكل
        // موظف من تاريخ توظيفه الحقيقي (getActiveSpansOverlapping).
        const [staffList] = await connection.execute(
            `SELECT staff_id, full_name, monthly_salary, paid_leave_types, standard_daily_hours,
                    hire_date, first_hire_date, termination_date, status
             FROM staff_members
             WHERE COALESCE(first_hire_date, hire_date) IS NOT NULL
               AND COALESCE(first_hire_date, hire_date) <= ?`,
            [end_date]
        );
        if (!staffList.length) {
            await connection.rollback();
            return res.status(404).json({ status: 'error', message: 'No active staff members found' });
        }

        const batchNonFridayDays = countNonFridayDays(start_date, end_date);
        if (batchNonFridayDays <= 0) {
            await connection.rollback();
            return res.status(400).json({ status: 'error', message: 'The selected period contains no working days' });
        }

        // payroll_month for the ledger: the period's start month (a payroll
        // period is expected to sit within a single calendar month; if it
        // spans months, the ledger is keyed to the start month).
        const payrollMonth = start_date.slice(0, 7);

const [prev] = await connection.execute(
  `SELECT staff_payroll_batch_id, version_number FROM staff_payroll_batches
   WHERE start_date = ? AND end_date = ?
   ORDER BY version_number DESC LIMIT 1`,
  [start_date, end_date]
);
const nextVersion = prev.length ? prev[0].version_number + 1 : 1;
const supersedesId = supersede ? supersede.batchId : (prev.length ? prev[0].staff_payroll_batch_id : null);
const staffCurrency = String(await settingsCache.getSetting('staff_payroll_currency', 'USD') || 'USD').toUpperCase();

const [batchResult] = await connection.execute(
  `INSERT INTO staff_payroll_batches
     (start_date, end_date, generated_by_user_id, status, version_number, supersedes_batch_id, currency, supersede_reason)
   VALUES (?, ?, ?, 'Generated', ?, ?, ?, ?)`,
  [start_date, end_date, userId, nextVersion, supersedesId, staffCurrency, supersede ? supersede.reason : null]
);
        const batchId = batchResult.insertId;
        let totalStaff = 0;
        let totalAmount = 0;
        const pendingAttendance = [];
        // D3: dates whose historical salary / hours / paid leave types cannot be
        // reconstructed reliably (never silently replaced by today's profile).
        const unresolvedCompensation = [];
        const segmentAudits = [];

        // Every calendar date of the batch period (used for compensation checks).
        const periodDates = [];
        for (let d = new Date(`${start_date}T00:00:00Z`); d <= new Date(`${end_date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
            periodDates.push(d.toISOString().slice(0, 10));
        }

        for (const staff of staffList) {
            // D3 / #12: salary, standard hours and paid leave types come from the
            // values that applied on each date (staff_compensation_history), not
            // from today's profile. Staff without history keep the profile values
            // (identical to the previous behavior).
            // D3 (final decision): history -> reliable snapshot -> current profile,
            // resolved per date (staffCompensationService.buildStaffCompensationTimeline).
            const resolveComp = await buildStaffCompensationTimeline(staff.staff_id, connection, { excludeBatchId: batchId });

// Clamp to this staff member's actual employment window, and never
// beyond "today" — future days have no attendance yet and must never
// be treated as unpaid absences.
// فترات التوظيف الفعلية المتقاطعة مع هذه الفترة تحديداً، مبنية من
// staff_status_history — تدعم أكثر من فترة (تعيين -> إنهاء -> إعادة
// تعيين) بدل الاعتماد على hire_date/termination_date كزوج وحيد.
            const employmentSpans = await getActiveSpansOverlapping(
                staff.staff_id, start_date, end_date, connection
            );
            if (employmentSpans.length === 0) continue; // غير موظف إطلاقاً خلال هذه الفترة
            const isDateInEmployment = (dateStr) => employmentSpans.some((span) =>
                dateStr >= span.start && (!span.end || dateStr <= span.end)
            );

            if (!acknowledgePending) {
                const [pendingRows] = await connection.execute(
                    `SELECT record_date, status
                     FROM staff_attendance
                     WHERE staff_id = ?
                       AND record_date BETWEEN ? AND ?
                       AND status IN ('Draft', 'Submitted', 'Rejected')
                     ORDER BY record_date ASC`,
                    [staff.staff_id, start_date, end_date]
                );
                for (const pending of pendingRows) {
                    const recordDate = String(pending.record_date).slice(0, 10);
                    if (isDateInEmployment(recordDate)) {
                        pendingAttendance.push({
                            staff_id: staff.staff_id,
                            full_name: staff.full_name,
                            record_date: recordDate,
                            status: pending.status,
                        });
                    }
                }
            }

const effectiveStart = employmentSpans[0].start;
const effectiveEnd = employmentSpans[employmentSpans.length - 1].end;

const calendarDates = employmentSpans
    .flatMap((span) => listNonFridayDates(span.start, span.end))
    .sort();
const calendarDateSet = new Set(calendarDates);
const requiredDays = calendarDates.length;
if (requiredDays <= 0) continue; // لا يوجد أي يوم عمل بهالفترة لهالموظف
const [records] = await connection.execute(
    `SELECT staff_attendance_id, record_date, attendance_status, is_paid,
            is_management_paid_absence, regular_hours, overtime_hours, is_friday_worked,
            standard_minutes_snapshot
     FROM staff_attendance
     WHERE staff_id = ? AND record_date BETWEEN ? AND ? AND status = 'Approved'`,
    [staff.staff_id, effectiveStart, effectiveEnd]
);

const relevantRecords = records.filter((record) =>
    calendarDateSet.has(String(record.record_date).slice(0, 10))
);

// إذا ما في ولا سجل حضور معتمد واحد لهذا الموظف بكامل الفترة،
// يعني ما كان متابَعًا بنظام الحضور إطلاقًا بهالفترة -> لا يُدرج بالراتب نهائيًا.
// (هذا لا يغيّر شيئًا لأي موظف عنده سجل واحد على الأقل: منطق
// "اليوم بدون سجل = غياب يُخصم" يبقى كما هو تمامًا لبقية الأيام الناقصة).
if (relevantRecords.length === 0) continue;

const recordsByDate = new Map();
for (const record of records) {
    recordsByDate.set(String(record.record_date).slice(0, 10), record);
}
// Each attendance row carries the required-hours rule used when it was
// recorded. This prevents a later profile edit from changing old payroll
// calculations. Missing/legacy rows safely fall back to the current profile.
//
// D3 (final decision): every employed date is resolved on its own:
//   dailyHours (h_d) = history -> that day's attendance snapshot -> baseline/profile
//   periodComp (S_d, H_d) = the salary/standard hours in effect on that date
//                           WITHOUT the attendance snapshot (used for proration),
//                           which equals the previous single standardDailyHours.
const standardHoursByDate = new Map();
const periodCompByDate = new Map();
const staffUnresolved = [];
for (const dateStr of calendarDates) {
    const record = recordsByDate.get(dateStr);
    const snapshotMinutes = Number(record?.standard_minutes_snapshot);
    const daily = resolveComp(dateStr, { hoursSnapshot: snapshotMinutes > 0 ? snapshotMinutes / 60 : null });
    const period = resolveComp(dateStr);
    for (const u of [...daily.unresolved, ...period.unresolved]) {
        if (!staffUnresolved.some((x) => x.date === dateStr && x.field === u.field)) {
            staffUnresolved.push({ date: dateStr, ...u });
        }
    }
    // Paid leave types are only needed when that day's record is a leave record.
    if (record && !['Present', 'Absent'].includes(record.attendance_status) && !daily.paid_leave_types) {
        staffUnresolved.push({ date: dateStr, field: 'paid_leave_types',
            reason: 'compensation history exists for this staff member but does not cover this date' });
    }
    standardHoursByDate.set(dateStr, daily.standard_daily_hours);
    periodCompByDate.set(dateStr, { ...period, paid_leave_types: daily.paid_leave_types });
}
if (staffUnresolved.length > 0) {
    unresolvedCompensation.push({ staff_id: staff.staff_id, full_name: staff.full_name, dates: staffUnresolved });
    continue;
}
const paidLeaveTypesFor = (dateStr) => periodCompByDate.get(dateStr)?.paid_leave_types || getPaidLeaveTypes(staff);

// Compensation segments: consecutive employed dates with the same salary and
// standard hours. One segment == the previous single-value calculation.
const segments = [];
for (const dateStr of calendarDates) {
    const c = periodCompByDate.get(dateStr);
    const last = segments[segments.length - 1];
    if (last && last.monthly_salary === c.monthly_salary && last.standard_daily_hours === c.standard_daily_hours) {
        last.dates.push(dateStr);
    } else {
        segments.push({
            monthly_salary: c.monthly_salary, standard_daily_hours: c.standard_daily_hours,
            salary_source: c.salary_source, hours_source: c.hours_source, dates: [dateStr],
        });
    }
}
const standardDailyHours = segments[segments.length - 1].standard_daily_hours;
staff.monthly_salary = segments[segments.length - 1].monthly_salary;

const requiredHours = round2(
    calendarDates.reduce((sum, dateStr) => sum + standardHoursByDate.get(dateStr), 0)
);
if (requiredHours <= 0) continue;

let actualRegularRaw = 0;        // ساعات محسوبة ضمن المطلوب (حضور فعلي + إجازات مدفوعة)
let workedDayShortfall = 0;      // نقص فقط بأيام حضر فيها الموظف فعليًا -> هاي وحدها تغطّى بالـ OT
let absenceShortfall = 0;        // نقص أيام غياب/بدون سجل/إجازة غير مدفوعة -> ما بتتغطى بالـ OT أبدًا
let dailyOtEarned = 0;
let presentDaysCount = 0;
let paidLeaveDays = 0;
let managementPaidDays = 0;
let unpaidAbsenceDays = 0;
const workedShortfallByDate = new Map();   // D3: date -> worked-day shortfall hours
const absenceShortfallByDate = new Map();  // D3: date -> absence shortfall hours
const addTo = (map, key, v) => map.set(key, (map.get(key) || 0) + v);

// الجمعة: خارج requiredDays/requiredHours تمامًا. تُحسب أوفر تايم كامل
// فقط إذا فيها سجل Present معتمد مع is_friday_worked = 1.
for (const record of relevantRecords) {
    const recordDateStr = String(record.record_date).slice(0, 10);
    if (isFriday(recordDateStr) && record.attendance_status === 'Present' && Number(record.is_friday_worked) === 1) {
        dailyOtEarned += Number(record.regular_hours || 0) + Number(record.overtime_hours || 0);
        presentDaysCount += 1;
    }
}

for (const dateStr of calendarDates) {
    const record = recordsByDate.get(dateStr);
    const dailyStandardHours = standardHoursByDate.get(dateStr) || standardDailyHours;

    if (!record) {
        // ما في ولا سجل معتمد لهالتاريخ (سواء ما انسجل أصلاً، أو لسا
        // Submitted/Rejected ومش Approved بعد) -> غياب غير مدفوع تلقائيًا.
        // لا يُغطى من الأوفر تايم إطلاقًا.
        absenceShortfall += dailyStandardHours;
        addTo(absenceShortfallByDate, dateStr, dailyStandardHours);
        unpaidAbsenceDays += 1;
        continue;
    }

    if (record.attendance_status === 'Present') {
        const regHours = Number(record.regular_hours || 0);
        workedDayShortfall += Math.max(0, dailyStandardHours - regHours);
        addTo(workedShortfallByDate, dateStr, Math.max(0, dailyStandardHours - regHours));
        actualRegularRaw += regHours;
        dailyOtEarned += Number(record.overtime_hours || 0);
        presentDaysCount += 1;
    } else if (record.attendance_status === 'Absent') {
        if (Number(record.is_management_paid_absence) === 1) {
            actualRegularRaw += dailyStandardHours;
            managementPaidDays += 1;
        } else {
            absenceShortfall += dailyStandardHours;   // ← لا يُغطى من الـ OT
            addTo(absenceShortfallByDate, dateStr, dailyStandardHours);
            unpaidAbsenceDays += 1;
        }
    } else if (paidLeaveTypesFor(dateStr).includes(record.attendance_status) && Number(record.is_paid) === 1) {
        actualRegularRaw += dailyStandardHours;
        paidLeaveDays += 1;
    } else {
        // إجازة من نوع غير مدرج بـ paid_leave_types، أو is_paid = 0
        absenceShortfall += dailyStandardHours;        // ← لا يُغطى من الـ OT
        addTo(absenceShortfallByDate, dateStr, dailyStandardHours);
        unpaidAbsenceDays += 1;
    }
}

            const actualRegularHours   = round2(Math.min(actualRegularRaw, requiredHours));
            const otEarnedHours        = round2(dailyOtEarned);
            const otUsedHours          = round2(Math.min(otEarnedHours, workedDayShortfall)); // ← القيد الأساسي المطلوب
            const otRemainingHours     = round2(otEarnedHours - otUsedHours);
            const uncoveredWorked      = round2(Math.max(0, workedDayShortfall - otUsedHours));
            const shortageHours        = round2(workedDayShortfall + absenceShortfall);       // للعرض فقط
            const uncoveredShortageHours = round2(uncoveredWorked + absenceShortfall);

let periodRequiredHours;
let proratedBaseSalary;
let hourlyRateRaw;
let salaryDeduction;
let segmentDetails = null;
if (segments.length === 1) {
    // Unchanged single-value calculation (no compensation change in the period).
    periodRequiredHours = round2(batchNonFridayDays * standardDailyHours);
    const prorationRatio = periodRequiredHours > 0
        ? Math.min(1, Math.max(0, requiredHours / periodRequiredHours))
        : 0;
    proratedBaseSalary = money(Number(staff.monthly_salary) * prorationRatio);
    hourlyRateRaw   = requiredHours > 0 ? proratedBaseSalary / requiredHours : 0;
    salaryDeduction = money(uncoveredShortageHours * hourlyRateRaw);
} else {
    // D3 (final decision): a mid-period change splits the calculation by
    // effective date. Each segment applies the exact single-value formula to
    // its own dates with its own salary and standard hours:
    //   segBase = S_seg * min(1, segRequired / (periodWorkingDays * H_seg))
    //   segRate = segBase / segRequired
    // Shortfall hours are charged at the rate of the date they occurred on.
    // OT coverage of worked-day shortfall is spread over those dates
    // proportionally (identical to the single-segment result when there is one).
    let baseSum = 0;
    let periodHoursSum = 0;
    const rateByDate = new Map();
    segmentDetails = segments.map((seg) => {
        const segRequired = seg.dates.reduce((sum, dt) => sum + standardHoursByDate.get(dt), 0);
        const segPeriodHours = batchNonFridayDays * seg.standard_daily_hours;
        const ratio = segPeriodHours > 0 ? Math.min(1, Math.max(0, segRequired / segPeriodHours)) : 0;
        const segBase = Number(seg.monthly_salary) * ratio;
        const segRate = segRequired > 0 ? segBase / segRequired : 0;
        seg.dates.forEach((dt) => rateByDate.set(dt, segRate));
        baseSum += segBase;
        periodHoursSum += segPeriodHours * (seg.dates.length / requiredDays);
        return {
            from: seg.dates[0], to: seg.dates[seg.dates.length - 1], working_days: seg.dates.length,
            monthly_salary: seg.monthly_salary, standard_daily_hours: seg.standard_daily_hours,
            salary_source: seg.salary_source, hours_source: seg.hours_source,
            required_hours: round2(segRequired), prorated_base_salary: money(segBase), hourly_rate: money(segRate),
        };
    });
    periodRequiredHours = round2(periodHoursSum);
    proratedBaseSalary = money(baseSum);
    hourlyRateRaw = requiredHours > 0 ? proratedBaseSalary / requiredHours : 0;
    let absenceAmount = 0;
    for (const [dt, h] of absenceShortfallByDate) absenceAmount += h * (rateByDate.get(dt) || 0);
    let workedAmount = 0;
    for (const [dt, h] of workedShortfallByDate) workedAmount += h * (rateByDate.get(dt) || 0);
    const uncoveredShare = workedDayShortfall > 0 ? uncoveredWorked / workedDayShortfall : 0;
    salaryDeduction = money(absenceAmount + workedAmount * uncoveredShare);
}
const netSalary        = money(proratedBaseSalary - salaryDeduction);
const hourlyRate       = money(hourlyRateRaw); // هاد بس للعرض/التخزين بالتقرير

            const [payrollResult] = await connection.execute(
                `INSERT INTO staff_payroll
                    (staff_payroll_batch_id, staff_id, monthly_salary_snapshot, working_days_in_period,
                     present_days, paid_leave_days, management_paid_days, unpaid_absence_days,
                     overtime_hours, daily_rate, net_salary,
                     required_hours, ot_earned_hours, ot_used_hours, ot_remaining_hours,
                     shortage_hours, salary_deduction_amount,
                     employed_from, employed_to, prorated_base_salary, period_required_hours)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                             [
                    batchId, staff.staff_id, staff.monthly_salary, requiredDays,
                    presentDaysCount, paidLeaveDays, managementPaidDays, unpaidAbsenceDays,
                    otEarnedHours, hourlyRate, netSalary,
                    requiredHours, otEarnedHours, otUsedHours, otRemainingHours,
                    shortageHours, salaryDeduction,
                    effectiveStart, effectiveEnd, proratedBaseSalary, periodRequiredHours,
                ]
            );
            if (!payrollResult.insertId) continue;
            if (segmentDetails) {
                // The row's single monthly_salary_snapshot (the last segment) cannot
                // describe every date; the full split is kept in the audit log and
                // this row is never reused as a salary snapshot (D3 fallback).
                segmentAudits.push({ staff_id: staff.staff_id, full_name: staff.full_name, segments: segmentDetails });
                await connection.execute(
                    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                     VALUES ('staff_payroll', ?, 'COMPENSATION_SEGMENTS', ?, NULL, ?)`,
                    [payrollResult.insertId, userId, JSON.stringify({ batch_id: batchId, staff_id: staff.staff_id, segments: segmentDetails })]
                );
            }

            // One ledger row per (staff, payroll_month). If a batch is
            // regenerated for the same month, this overwrites the prior
            // snapshot rather than duplicating (rule: monthly OT is not
            // day-by-day, and must not double count across regenerations).
            await connection.execute(
                `INSERT INTO staff_monthly_overtime_ledger
                    (staff_id, payroll_month, required_hours, actual_regular_hours,
                     ot_earned_hours, ot_used_hours, ot_remaining_hours,
                     shortage_hours, uncovered_shortage_hours,
                     hourly_rate_snapshot, salary_deduction_amount, staff_payroll_batch_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    required_hours = VALUES(required_hours),
                    actual_regular_hours = VALUES(actual_regular_hours),
                    ot_earned_hours = VALUES(ot_earned_hours),
                    ot_used_hours = VALUES(ot_used_hours),
                    ot_remaining_hours = VALUES(ot_remaining_hours),
                    shortage_hours = VALUES(shortage_hours),
                    uncovered_shortage_hours = VALUES(uncovered_shortage_hours),
                    hourly_rate_snapshot = VALUES(hourly_rate_snapshot),
                    salary_deduction_amount = VALUES(salary_deduction_amount),
                    staff_payroll_batch_id = VALUES(staff_payroll_batch_id)`,
                [
                    staff.staff_id, payrollMonth, requiredHours, actualRegularHours,
                    otEarnedHours, otUsedHours, otRemainingHours,
                    shortageHours, uncoveredShortageHours,
                    hourlyRate, salaryDeduction, batchId,
                ]
            );

            totalStaff += 1;
            totalAmount = money(totalAmount + netSalary);
        }

        if (unresolvedCompensation.length > 0) {
            await connection.rollback();
            return res.status(409).json({
                status: 'error',
                code: 'HISTORICAL_COMPENSATION_UNRESOLVED',
                message: 'The historical salary, standard hours or paid leave types for some dates cannot be reconstructed reliably ' +
                    '(conflicting payroll snapshots, or compensation history that does not cover the date). ' +
                    'No value was guessed. Record the correct compensation history for these dates, then generate again.',
                staff: unresolvedCompensation,
            });
        }

        if (pendingAttendance.length > 0 && !acknowledgePending) {
            await connection.rollback();
            return res.status(409).json({
                status: 'error',
                code: 'PENDING_ATTENDANCE',
                message: 'Payroll cannot be generated while unresolved attendance exists in the employment period.',
                pending_attendance: pendingAttendance,
            });
        }

        if (!totalStaff) {
            await connection.rollback();
            return res.status(400).json({ status: 'error', message: 'Could not calculate any salary for this period' });
        }

        await connection.execute(
            `UPDATE staff_payroll_batches SET total_staff = ?, total_amount = ? WHERE staff_payroll_batch_id = ?`,
            [totalStaff, totalAmount, batchId]
        );

        if (supersede) {
            // Verified replacement exists -> supersede the old batch (same transaction).
            const [[check]] = await connection.execute(
                'SELECT COUNT(*) AS cnt FROM staff_payroll WHERE staff_payroll_batch_id = ?', [batchId]);
            if (Number(check.cnt) !== totalStaff) throw new Error('Replacement verification failed.');
            await connection.execute(
                `UPDATE staff_payroll_batches SET status = 'Superseded' WHERE staff_payroll_batch_id = ? AND status = 'Generated'`,
                [supersede.batchId]);
            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('staff_payroll_batches', ?, 'SUPERSEDED', ?, ?, ?)`,
                [supersede.batchId, userId, JSON.stringify({ status: 'Generated' }),
                    JSON.stringify({ status: 'Superseded', replaced_by_batch_id: batchId, reason: supersede.reason })]);
        }

        await connection.commit();
        return res.status(201).json({
            status: 'success',
            message: supersede
                ? `Replacement batch #${batchId} (version ${nextVersion}) generated; batch #${supersede.batchId} is now Superseded.`
                : 'Staff payroll batch generated successfully',
            batch_id: batchId,
            currency: staffCurrency,
            ...(segmentAudits.length ? { compensation_segments: segmentAudits } : {}),
        });
    } catch (error) {
        await connection.rollback();
        console.error('generateStaffPayrollBatch:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to generate payroll batch. No batch was changed.' });
    } finally {
        connection.release();
    }
}

async function getStaffPayrollReport(req, res) {
    try {
        const [rows] = await pool.execute(
            `SELECT spb.staff_payroll_batch_id, spb.start_date, spb.end_date,
                    spb.total_staff, spb.total_amount, spb.status, spb.generated_at,
                    spb.version_number, spb.is_finalized, spb.finalized_at, spb.currency,
                    spb.supersedes_batch_id, spb.void_reason, spb.supersede_reason,
                    u.full_name AS generated_by
             FROM staff_payroll_batches spb
             JOIN users u ON u.user_id = spb.generated_by_user_id
             ORDER BY spb.generated_at DESC`
        );
        return res.json({ status: 'success', data: rows });
    } catch (error) {
        console.error('getStaffPayrollReport:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to load payroll reports' });
    }
}

async function getStaffPayrollBatchDetails(req, res) {
    const batchId = Number(req.params.batchId);
    if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ status: 'error', message: 'Invalid batch ID' });
    try {
        const [batches] = await pool.execute('SELECT * FROM staff_payroll_batches WHERE staff_payroll_batch_id = ?', [batchId]);
        if (!batches.length) return res.status(404).json({ status: 'error', message: 'Payroll batch not found' });

        const [items] = await pool.execute(
            `SELECT sp.*, sm.full_name, sm.staff_unique_id, sm.position, sm.standard_daily_hours
             FROM staff_payroll sp
             JOIN staff_members sm ON sm.staff_id = sp.staff_id
             WHERE sp.staff_payroll_batch_id = ?
             ORDER BY sm.full_name`,
            [batchId]
        );
        return res.json({ status: 'success', batch: batches[0], staff: items });
    } catch (error) {
        console.error('getStaffPayrollBatchDetails:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to load batch details' });
    }
}

async function markStaffBatchAsPaid(req, res) {
    const batchId = Number(req.params.batchId);
    if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ status: 'error', message: 'Invalid batch ID' });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [batches] = await connection.execute(
    'SELECT status, is_finalized FROM staff_payroll_batches WHERE staff_payroll_batch_id = ? FOR UPDATE',
    [batchId]
);
if (!batches.length) {
    await connection.rollback();
    return res.status(404).json({ status: 'error', message: 'Payroll batch not found' });
}
if (batches[0].status === 'Superseded' || batches[0].status === 'Voided') {
    await connection.rollback();
    return res.status(409).json({ status: 'error', message: `A ${batches[0].status.toLowerCase()} batch cannot be marked as paid` });
}
if (batches[0].status === 'Paid') {
    await connection.rollback();
    return res.status(409).json({ status: 'error', message: 'Payroll batch is already paid' });
}
if (!batches[0].is_finalized) {
    await connection.rollback();
    return res.status(409).json({ status: 'error', message: 'Finalize this payroll batch before marking it as paid.' });
}
// C-09: who marked it paid and when.
await connection.execute(`UPDATE staff_payroll_batches SET status = 'Paid', paid_by_user_id = ?, paid_at = NOW() WHERE staff_payroll_batch_id = ?`, [req.user?.user_id, batchId]);
await connection.execute(
    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
     VALUES ('staff_payroll_batches', ?, 'MARKED_PAID', ?, ?, ?)`,
    [batchId, req.user?.user_id, JSON.stringify({ status: batches[0].status }), JSON.stringify({ status: 'Paid' })]
);
        await connection.commit();
        return res.json({ status: 'success', message: 'Payroll batch marked as paid successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('markStaffBatchAsPaid:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to update payment status' });
    } finally {
        connection.release();
    }
}
// ============================================================
// GET /api/staff-payroll/batch/:batchId/export.xlsx
// Streams a formatted Excel report for one staff payroll batch:
// company logo, period, finalized/paid status, and full breakdown.
// ============================================================
async function exportStaffPayrollExcel(req, res) {
    const batchId = Number(req.params.batchId);
    if (!Number.isInteger(batchId) || batchId <= 0) {
        return res.status(400).json({ status: 'error', message: 'Invalid batch id.' });
    }

    try {
        const ExcelJS = require('exceljs');
        const path = require('path');

        const [batches] = await pool.execute(
            `SELECT spb.*, u.full_name AS generated_by, fu.full_name AS finalized_by
             FROM staff_payroll_batches spb
             JOIN users u ON u.user_id = spb.generated_by_user_id
             LEFT JOIN users fu ON fu.user_id = spb.finalized_by_user_id
             WHERE spb.staff_payroll_batch_id = ?`,
            [batchId]
        );
        if (!batches.length) return res.status(404).json({ status: 'error', message: 'Payroll batch not found.' });
        const batch = batches[0];

        const [rows] = await pool.execute(
            `SELECT sp.*, sm.full_name, sm.staff_unique_id, sm.position, sm.standard_daily_hours
             FROM staff_payroll sp
             JOIN staff_members sm ON sm.staff_id = sp.staff_id
             WHERE sp.staff_payroll_batch_id = ?
             ORDER BY sm.full_name`,
            [batchId]
        );
        if (!rows.length) return res.status(404).json({ status: 'error', message: 'No staff found in this batch.' });

        const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
        const logoPath = path.join(__dirname, '../assets/logo.png');

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Staff Payroll');

        try {
            const logoId = workbook.addImage({ filename: logoPath, extension: 'png' });
            sheet.addImage(logoId, { tl: { col: 0.1, row: 0.1 }, ext: { width: 130, height: 45 } });
        } catch (e) {
            console.warn('Logo not added:', e.message);
        }
sheet.columns = [
    { header: 'No.', key: 'number', width: 5 },
    { header: 'Staff ID', key: 'staff_id', width: 10 },
    { header: 'Full Name', key: 'full_name', width: 20 },       
    { header: 'Position', key: 'position', width: 14 },          
    { header: 'Monthly Salary', key: 'monthly_salary', width: 13 },
    { header: 'Working Days', key: 'working_days', width: 11 },
    { header: 'Present Days', key: 'present_days', width: 12 },
    { header: 'Paid Leave Days', key: 'paid_leave_days', width: 13 },
    { header: 'Mgmt-Paid Absence', key: 'management_paid_days', width: 16 },
    { header: 'Unpaid Absence', key: 'unpaid_absence_days', width: 15 },
    { header: 'Required Hrs', key: 'required_hours', width: 13 },
    { header: 'OT Earned', key: 'ot_earned_hours', width: 12 },
    { header: 'OT Used', key: 'ot_used_hours', width: 13 },
    { header: 'OT Remaining', key: 'ot_remaining_hours', width: 13 },
    { header: 'Shortage Hrs', key: 'shortage_hours', width: 13 },
    { header: 'Deduction', key: 'salary_deduction_amount', width: 11 },
    { header: 'Net Salary', key: 'net_salary', width: 15 },
    { header: 'Signature', key: 'signature', width: 16 },
];

        const statusLabel = batch.status === 'Superseded' ? 'Superseded'
            : batch.status === 'Paid' ? 'Paid' : 'Generated';
        const finalizedLabel = (batch.is_finalized === 1 || batch.is_finalized === true)
            ? 'Finalized ✅' : 'Not Finalized ⚠️';

        sheet.mergeCells('A1:R1');
        sheet.getCell('A1').value =
            `Staff Payroll Batch #${batchId} (v${batch.version_number || 1}) — ${finalizedLabel}`;
        sheet.mergeCells('A2:R2');
        sheet.getCell('A2').value = `Period: ${dateOnly(batch.start_date)}  →  ${dateOnly(batch.end_date)}   |   Currency: ${batch.currency || 'USD'}`;
        sheet.mergeCells('A3:R3');
        sheet.getCell('A3').value =
            `Status: ${statusLabel}   |   Generated By: ${batch.generated_by || '-'}` +
            (batch.finalized_by ? `   |   Finalized By: ${batch.finalized_by}` : '');
        sheet.mergeCells('A4:R4');
        sheet.getCell('A4').value = `Total Staff Paid: ${batch.total_staff || rows.length}`;
        sheet.getCell('A4').font = { bold: true };

        sheet.getRow(1).height = 26;
        sheet.getRow(1).font = { bold: true, size: 15 };
        sheet.getRow(2).height = 22;
        sheet.getRow(3).height = 22;
        sheet.getRow(4).height = 20;
        sheet.getRow(5).values = sheet.columns.map((c) => c.header);

        let grandTotalNet = 0;
        rows.forEach((r, index) => {
            sheet.addRow({
                number: index + 1,
                staff_id: r.staff_unique_id,
                full_name: r.full_name,
                position: r.position || '-',
                monthly_salary: Number(r.prorated_base_salary ?? r.monthly_salary_snapshot ?? 0),
                working_days: r.working_days_in_period,
                present_days: Number(r.present_days || 0),
                paid_leave_days: Number(r.paid_leave_days || 0),
                management_paid_days: Number(r.management_paid_days || 0),
                unpaid_absence_days: Number(r.unpaid_absence_days || 0),
                required_hours: Number(r.required_hours || 0),
                ot_earned_hours: Number(r.ot_earned_hours || 0),
                ot_used_hours: Number(r.ot_used_hours || 0),
                ot_remaining_hours: Number(r.ot_remaining_hours || 0),
                shortage_hours: Number(r.shortage_hours || 0),
                salary_deduction_amount: Number(r.salary_deduction_amount || 0),
                net_salary: Number(r.net_salary || 0),
                signature: '',
            });
            grandTotalNet += Number(r.net_salary || 0);
        });

        const totalRow = sheet.addRow({
            full_name: 'GRAND TOTAL',
            net_salary: Math.round(grandTotalNet * 100) / 100,
        });
        totalRow.font = { bold: true };

        sheet.getRow(5).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.getRow(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
        sheet.getRow(5).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

        for (let r = 6; r <= sheet.rowCount; r += 1) {
            sheet.getCell(r, 5).numFmt = '#,##0.00';   // monthly_salary
            sheet.getCell(r, 16).numFmt = '#,##0.00';  // deduction
            sheet.getCell(r, 17).numFmt = '#,##0.00';  // net_salary
        }
              sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: 5 }];
        sheet.autoFilter = { from: 'A5', to: 'R5' };

        const fileName = `staff_payroll_batch_${batchId}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('exportStaffPayrollExcel:', error);
        if (!res.headersSent) {
            return res.status(500).json({ status: 'error', message: 'Failed to export staff payroll Excel report.' });
        }
    }
}


function drawSignaturesFooter() {
    // تحديد ارتفاع وموقع قسم التوقيعات قبل الهامش السفلي بقليل
    const footerY = doc.page.height - doc.page.margins.bottom - 45;
    
    doc.font('Helvetica').fontSize(8);
    
    // تقسيم عرض الصفحة الأفقية على 3 أقسام متساوية للتوقيعات الثلاثة
    const sectionWidth = pageWidth / 3;
    
    const signaturesData = [
        { title: 'Prepared by', name: batch.generated_by || '-' },
        { title: 'Verified by', name: '-' }, // يمكنك استبدالها ببيانات من الـ batch إذا توفرت
        { title: 'Approved by', name: batch.finalized_by || '-' }
    ];

    signaturesData.forEach((sig, index) => {
        const startXPos = doc.page.margins.left + (index * sectionWidth);
        
        doc.font('Helvetica-Bold').text(`${sig.title}:`, startXPos, footerY, { width: sectionWidth - 20 });
        doc.font('Helvetica').text(`Name: ${sig.name}`, startXPos, footerY + 12, { width: sectionWidth - 20 });
        doc.text('Signature: ___________________', startXPos, footerY + 24, { width: sectionWidth - 20 });
        doc.text(`Date: ____ / ____ / ________`, startXPos, footerY + 36, { width: sectionWidth - 20 });
    });
}

// ============================================================
// GET /api/staff-payroll/batch/:batchId/export.pdf
// Formal one-document PDF report: company logo, period, status
// (Finalized/Paid), full per-staff breakdown, and grand totals.
// Meant to be handed directly to management.
// ============================================================
// ============================================================
// GET /api/staff-payroll/batch/:batchId/export.pdf
// Formal one-document PDF report: company logo, period, status
// (Finalized/Paid), full per-staff breakdown, and grand totals.
// Meant to be handed directly to management.
// ============================================================
async function exportStaffPayrollPdf(req, res) {
    const batchId = Number(req.params.batchId);
    if (!Number.isInteger(batchId) || batchId <= 0) {
        return res.status(400).json({ status: 'error', message: 'Invalid batch id.' });
    }

    try {
        const PDFDocument = require('pdfkit');
        const path = require('path');
        const fs = require('fs');

        const [batches] = await pool.execute(
            `SELECT spb.*, u.full_name AS generated_by, fu.full_name AS finalized_by
             FROM staff_payroll_batches spb
             JOIN users u ON u.user_id = spb.generated_by_user_id
             LEFT JOIN users fu ON fu.user_id = spb.finalized_by_user_id
             WHERE spb.staff_payroll_batch_id = ?`,
            [batchId]
        );
        if (!batches.length) return res.status(404).json({ status: 'error', message: 'Payroll batch not found.' });
        const batch = batches[0];

        const [rows] = await pool.execute(
            `SELECT sp.*, sm.full_name, sm.staff_unique_id, sm.position
             FROM staff_payroll sp
             JOIN staff_members sm ON sm.staff_id = sp.staff_id
             WHERE sp.staff_payroll_batch_id = ?
             ORDER BY sm.full_name`,
            [batchId]
        );
        if (!rows.length) return res.status(404).json({ status: 'error', message: 'No staff found in this batch.' });

        const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
        const num = (v) => Number(v || 0);
        const fmt = (v, digits = 2) => num(v).toFixed(digits);
        const money = (v) => `$${num(v).toFixed(2)}`;

        const isFinalized = batch.is_finalized === 1 || batch.is_finalized === true;
        const statusText = batch.status === 'Superseded' ? 'SUPERSEDED'
            : batch.status === 'Paid' ? 'PAID' : 'GENERATED';
        const finalizedText = isFinalized ? 'FINALIZED' : 'NOT FINALIZED';

        // ---- Totals ----
        let totalRegularHours = 0;
        let totalOtEarned = 0;
        let totalNet = 0;
        let totalDeduction = 0;
        rows.forEach((r) => {
            totalRegularHours += num(r.present_days) > 0 ? num(r.required_hours) - num(r.shortage_hours) : num(r.actual_regular_hours || 0);
            totalOtEarned += num(r.ot_earned_hours);
            totalNet += num(r.net_salary);
            totalDeduction += num(r.salary_deduction_amount);
        });

        const logoPath = path.join(__dirname, '../assets/logo.png');
        const hasLogo = fs.existsSync(logoPath);

        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="staff_payroll_batch_${batchId}.pdf"`);
        doc.pipe(res);

        const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

        // ==================== Column layout ====================
        const columns = [
            { key: 'no', label: 'No.', width: 25 },
            { key: 'staff_id', label: 'Staff ID', width: 52 },
            { key: 'full_name', label: 'Full Name', width: 115 },
            { key: 'position', label: 'Position', width: 82 },
            { key: 'monthly_salary', label: 'Monthly Salary', width: 62 },
            { key: 'present_days', label: 'Present Days', width: 53 },
            { key: 'paid_leave_days', label: 'Paid Leave', width: 45 },
            { key: 'mgmt_paid_days', label: 'Mgmt-Paid Absence', width: 58 },
            { key: 'unpaid_absence_days', label: 'Unpaid Absence', width: 55 },
            { key: 'required_hours', label: 'Required Hrs', width: 55 },
            { key: 'ot_earned_hours', label: 'OT Earned', width: 45 },
            { key: 'ot_used_hours', label: 'OT Used', width: 42 },
            { key: 'shortage_hours', label: 'Shortage Hrs', width: 53 },
            { key: 'net_salary', label: 'Net Salary', width: 52 },
        ];
        const tableWidth = columns.reduce((s, c) => s + c.width, 0);
        const startX = doc.page.margins.left + (pageWidth - tableWidth) / 2;

        function drawHeader() {
            let cursorY = doc.page.margins.top;

            if (hasLogo) {
                doc.image(logoPath, doc.page.margins.left, cursorY, { width: 90, height: 40 });
            }

            doc.font('Helvetica-Bold').fontSize(16)
                .text('STAFF PAYROLL REPORT', doc.page.margins.left, cursorY + 4, {
                    width: pageWidth, align: 'center',
                });

            doc.font('Helvetica').fontSize(9)
                .text('ASIK ENGINEERING CONSTRUCTION', doc.page.margins.left, cursorY + 24, {
                    width: pageWidth, align: 'center',
                });

            cursorY += 52;

            doc.font('Helvetica-Bold').fontSize(10);
            doc.text(`Batch #${batchId}  (Version ${batch.version_number || 1})`, doc.page.margins.left, cursorY);
            doc.text(
                `Period: ${dateOnly(batch.start_date)}   to   ${dateOnly(batch.end_date)}   |   Currency: ${batch.currency || 'USD'}`,
                doc.page.margins.left, cursorY, { width: pageWidth, align: 'right' }
            );
            cursorY += 16;

            // Status badges
            doc.font('Helvetica-Bold').fontSize(10);
            const finColor = isFinalized ? '#1a7a3c' : '#b21f1f';
            const payColor = statusText === 'PAID' ? '#1a7a3c' : (statusText === 'SUPERSEDED' ? '#888888' : '#a06a00');

            doc.fillColor(finColor).text(`Status: ${finalizedText}`, doc.page.margins.left, cursorY);
            doc.fillColor(payColor).text(`Payment: ${statusText}`, doc.page.margins.left + 160, cursorY);
            doc.fillColor('black');

            doc.font('Helvetica').fontSize(9).text(
                `Generated by: ${batch.generated_by || '-'}` +
                (batch.finalized_by ? `   |   Finalized by: ${batch.finalized_by}` : ''),
                doc.page.margins.left, cursorY, { width: pageWidth, align: 'right' }
            );
            cursorY += 20;

            // Summary strip
            doc.rect(doc.page.margins.left, cursorY, pageWidth, 22).fill('#f2f4fa');
            doc.fillColor('#1a2a6c').font('Helvetica-Bold').fontSize(9);
            const summaryText =
                `Total Staff: ${rows.length}    |    ` +
                `Total OT Earned: ${fmt(totalOtEarned)}h    |    ` +
                `TOTAL NET SALARY: ${money(totalNet)}`;
            doc.text(summaryText, doc.page.margins.left + 10, cursorY + 6, { width: pageWidth - 20 });
            doc.fillColor('black');
            cursorY += 34;

            return cursorY;
        }

        function drawTableHeaderRow(y) {
            const rowHeight = 24;
            let x = startX;
            doc.rect(startX, y, tableWidth, rowHeight).fill('#1a2a6c');
            doc.fillColor('white').font('Helvetica-Bold').fontSize(7.2);

            columns.forEach((col) => {
                doc.rect(x, y, col.width, rowHeight).stroke('#1a2a6c');
                doc.text(col.label, x + 2, y + 6, {
                    width: col.width - 4,
                    align: 'center',
                    lineBreak: false,
                });
                x += col.width;
            });

            doc.fillColor('black');
            return y + rowHeight;
        }

        function drawRow(y, values, opts = {}) {
            const rowHeight = 24;
            let x = startX;

            if (opts.zebra) {
                doc.rect(startX, y, tableWidth, rowHeight).fill('#f7f9fc');
                doc.fillColor('black');
            }

            doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.2);

            columns.forEach((col) => {
                doc.rect(x, y, col.width, rowHeight).stroke('#dfe3e8');

                doc.text(String(values[col.key] ?? ''), x + 3, y + 6, {
                    width: col.width - 6,
                    align: col.key === 'full_name' || col.key === 'position'
                        ? 'left'
                        : 'center',
                    lineBreak: false,
                });

                x += col.width;
            });

            return y + rowHeight;
        }

        // دالة التوقيعات الثلاثية داخل النطاق الصحيح
// تعديل دالة التواقيع لتبدأ مباشرة تحت الجدول بناءً على مؤشر الـ y الحالي
        function drawSignaturesFooter(currentY) {
            const footerY = currentY + 15; // مسافة بسيطة بعد الجدول
            
            // تحقق إذا كانت التواقيع ستنزل خارج الصفحة، إذاً انقلها لصفحة جديدة
            if (footerY + 50 > doc.page.height - doc.page.margins.bottom) {
                doc.addPage();
                return doc.page.margins.top + 20;
            }

            doc.font('Helvetica').fontSize(8);
            const sectionWidth = pageWidth / 3;
            const signaturesData = [
                { title: 'Prepared by', name: batch.generated_by || '-' },
                { title: 'Verified by', name: '-' },
                { title: 'Approved by', name: batch.finalized_by || '-' }
            ];

            signaturesData.forEach((sig, index) => {
                const startXPos = doc.page.margins.left + (index * sectionWidth);
                doc.font('Helvetica-Bold').text(`${sig.title}:`, startXPos, footerY, { width: sectionWidth - 20 });
                doc.font('Helvetica').text(`Name: ${sig.name}`, startXPos, footerY + 12, { width: sectionWidth - 20 });
                doc.text('Signature: ___________________', startXPos, footerY + 24, { width: sectionWidth - 20 });
                doc.text(`Date: ____ / ____ / ________`, startXPos, footerY + 36, { width: sectionWidth - 20 });
            });

            return footerY + 50;
        }

        let y = drawHeader();
        y = drawTableHeaderRow(y);

        const bottomLimit = doc.page.height - doc.page.margins.bottom - 75;

        rows.forEach((r, index) => {
            if (y > bottomLimit) {
                doc.addPage();
                y = doc.page.margins.top;
                y = drawTableHeaderRow(y);
            }
            y = drawRow(y, {
                no: index + 1,
                staff_id: r.staff_unique_id,
                full_name: r.full_name,
                position: r.position || '-',
                monthly_salary: money(r.prorated_base_salary ?? r.monthly_salary_snapshot),
                present_days: fmt(r.present_days, 1),
                paid_leave_days: fmt(r.paid_leave_days, 1),
                mgmt_paid_days: fmt(r.management_paid_days || 0, 1),
                unpaid_absence_days: fmt(r.unpaid_absence_days, 1),
                required_hours: fmt(r.required_hours),
                ot_earned_hours: fmt(r.ot_earned_hours),
                ot_used_hours: fmt(r.ot_used_hours),
                shortage_hours: fmt(r.shortage_hours),
                net_salary: money(r.net_salary),
            }, { zebra: index % 2 === 1 });
        });

        // Grand total row
// Grand total row
        if (y > bottomLimit) {
            doc.addPage();
            y = doc.page.margins.top;
            y = drawTableHeaderRow(y);
        }
        y = drawRow(y, {
            no: '', staff_id: '', full_name: 'GRAND TOTAL', position: '',
            monthly_salary: '', present_days: '', paid_leave_days: '', mgmt_paid_days: '',
            unpaid_absence_days: '', required_hours: '', ot_earned_hours: fmt(totalOtEarned),
            ot_used_hours: '', shortage_hours: '', net_salary: money(totalNet),
        }, { bold: true });

        // Signature footer section
        y += 40;
        if (y > doc.page.height - doc.page.margins.bottom - 20) {
            doc.addPage();
            y = doc.page.margins.top + 20;
        }
        
       drawSignaturesFooter(y);

        doc.end();
    } catch (error) {
        console.error('exportStaffPayrollPdf:', error);
        if (!res.headersSent) {
            return res.status(500).json({ status: 'error', message: 'Failed to export staff payroll PDF report.' });
        }
    }
}
module.exports = {
    generateStaffPayrollBatch,
    getStaffPayrollReport,
    getStaffPayrollBatchDetails,
    markStaffBatchAsPaid,
    exportStaffPayrollExcel,
    exportStaffPayrollPdf, // ← جديد
};
