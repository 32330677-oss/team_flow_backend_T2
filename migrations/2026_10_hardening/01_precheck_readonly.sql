-- =====================================================================
-- 2026-10 hardening migration — STEP 01: READ-ONLY DIAGNOSTICS
--
-- Every statement in this file is a SELECT. Nothing is written.
-- Run it on production BEFORE any other step and keep the full output
-- (e.g. mysql ... < 01_precheck_readonly.sql > precheck_output.txt).
-- Each section says what result is expected and what to do otherwise.
-- =====================================================================

SELECT 'P0 server / schema' AS section, VERSION() AS mysql_version, DATABASE() AS db, @@global.time_zone AS global_tz, @@session.time_zone AS session_tz, NOW() AS server_now;

-- ---------------------------------------------------------------------
-- P1. Phase 2 objects must already exist (this migration builds on them).
--     Expected: 6 rows in the first result, 3 rows in the second.
-- ---------------------------------------------------------------------
SELECT 'P1 phase2 columns' AS section, table_name, column_name
FROM information_schema.columns
WHERE table_schema = DATABASE() AND (
  (table_name = 'attendance' AND column_name = 'source') OR
  (table_name = 'staff_attendance' AND column_name = 'source') OR
  (table_name = 'worker_transfer_requests' AND column_name = 'effective_date') OR
  (table_name = 'attendance_punch_processing' AND column_name IN ('mapping_id','target_table','resolved_at')))
ORDER BY table_name, column_name;

SELECT 'P1 phase2 tables' AS section, table_name
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN ('worker_status_history','system_settings_history','staff_compensation_history');

-- ---------------------------------------------------------------------
-- P2. Objects this migration creates must NOT exist yet (or the step is a
--     re-run). Expected on a first run: 0 rows.
-- ---------------------------------------------------------------------
SELECT 'P2 new tables already present' AS section, table_name
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN ('payroll_attendance_snapshot','attendance_corrections_log','site_status_history',
                     'attendance_punch_processing_log','t2_merge_log','assignment_end_date_migration_log');

SELECT 'P2 semantics marker' AS section, setting_key, setting_value
FROM system_settings WHERE setting_key = 'assignment_end_semantics';
-- Expected: 0 rows. If the row exists with 'inclusive_last_day', the end-date
-- conversion was ALREADY applied: step 05 detects it and does nothing.

-- ---------------------------------------------------------------------
-- P3. Row counts (keep these numbers; step 06 compares against them).
-- ---------------------------------------------------------------------
SELECT 'P3 row counts' AS section,
  (SELECT COUNT(*) FROM workers) AS workers,
  (SELECT COUNT(*) FROM workersiteassignments) AS worker_assignments,
  (SELECT COUNT(*) FROM workersiteassignments WHERE unassigned_date IS NOT NULL) AS worker_assignments_closed,
  (SELECT COUNT(*) FROM attendance) AS attendance,
  (SELECT COUNT(*) FROM payrollbatches) AS payroll_batches,
  (SELECT COUNT(*) FROM payroll) AS payroll,
  (SELECT COUNT(*) FROM payrollitems) AS payroll_items,
  (SELECT COUNT(*) FROM staff_members) AS staff,
  (SELECT COUNT(*) FROM staff_attendance) AS staff_attendance,
  (SELECT COUNT(*) FROM staff_payroll_batches) AS staff_payroll_batches,
  (SELECT COUNT(*) FROM staff_site_assignments) AS staff_site_assignments,
  (SELECT COUNT(*) FROM staff_supervisor_assignments) AS staff_supervisor_assignments,
  (SELECT COUNT(*) FROM worker_transfer_requests) AS transfer_requests,
  (SELECT COUNT(*) FROM attendance_punches) AS raw_punches,
  (SELECT COUNT(*) FROM attendance_punch_processing) AS punch_queue,
  (SELECT COUNT(*) FROM auditlogs) AS auditlogs;

-- ---------------------------------------------------------------------
-- P4. T2 consolidation state (sites 8, 9, 10)
-- ---------------------------------------------------------------------
SELECT 'P4 sites' AS section, site_id, site_name, site_status, supports_shifts, supervisor_id, contract_id
FROM sites WHERE site_id IN (8, 9, 10) ORDER BY site_id;
SELECT 'P4 site_shifts' AS section, site_shift_id, site_id, shift_type, supervisor_id FROM site_shifts ORDER BY site_id, shift_type;
SELECT 'P4 rows still on site 9' AS section,
  (SELECT COUNT(*) FROM workersiteassignments WHERE site_id = 9) AS assignments,
  (SELECT COUNT(*) FROM workersiteassignments WHERE site_id = 9 AND unassigned_date IS NULL) AS open_assignments,
  (SELECT COUNT(*) FROM attendance WHERE site_id = 9) AS attendance,
  (SELECT COUNT(*) FROM payrollitems WHERE site_id = 9) AS payroll_items,
  (SELECT COUNT(*) FROM payrollbatches WHERE scope_site_id = 9) AS scoped_batches,
  (SELECT COUNT(*) FROM worker_transfer_requests WHERE current_site_id = 9 OR target_site_id = 9) AS transfers,
  (SELECT COUNT(*) FROM staff_members WHERE site_id = 9) AS staff_members,
  (SELECT COUNT(*) FROM staff_site_assignments WHERE site_id = 9) AS staff_site_assignments;
-- If every count is 0 and site 8 already supports shifts, T2 was already
-- consolidated and step 03 is a no-op.

-- Conflicts that would block repointing site 9 -> site 8 / Night.
-- Expected: 0 rows each. Any row must be resolved by a person first.
SELECT 'P4 attendance conflicts (site9 -> 8/Night)' AS section, a9.attendance_id AS site9_attendance_id,
       a8.attendance_id AS existing_site8_night_id, a9.worker_id, a9.record_date
FROM attendance a9
JOIN attendance a8 ON a8.worker_id = a9.worker_id AND a8.site_id = 8 AND a8.shift_type = 'Night'
                  AND a8.record_date = a9.record_date
WHERE a9.site_id = 9;

SELECT 'P4 site9 attendance not on Day shift' AS section, attendance_id, worker_id, record_date, shift_type
FROM attendance WHERE site_id = 9 AND shift_type <> 'Day';

SELECT 'P4 assignment overlap conflicts (site9 -> 8/Night)' AS section,
       x.assignment_id AS site9_assignment, y.assignment_id AS site8_night_assignment, x.worker_id
FROM workersiteassignments x
JOIN workersiteassignments y ON y.worker_id = x.worker_id AND y.site_id = 8 AND y.shift_type = 'Night'
 AND x.assigned_date <= COALESCE(y.unassigned_date, '9999-12-31')
 AND y.assigned_date <= COALESCE(x.unassigned_date, '9999-12-31')
WHERE x.site_id = 9;

-- ---------------------------------------------------------------------
-- P5. Assignment end-date conversion (exclusive -> inclusive last day)
-- ---------------------------------------------------------------------
-- Closed assignments that covered ZERO days under the old exclusive rule
-- (assigned_date = unassigned_date). After conversion they are stored as
-- unassigned_date = assigned_date - 1 (an explicitly empty range), which
-- every query treats as "never active". Listed for information.
SELECT 'P5 zero-day worker assignments' AS section, assignment_id, worker_id, site_id, shift_type, assigned_date, unassigned_date
FROM workersiteassignments WHERE unassigned_date IS NOT NULL AND unassigned_date <= assigned_date;
SELECT 'P5 zero-day staff site assignments' AS section, staff_assignment_id, staff_id, site_id, assigned_date, unassigned_date
FROM staff_site_assignments WHERE unassigned_date IS NOT NULL AND unassigned_date <= assigned_date;
SELECT 'P5 zero-day staff supervisor assignments' AS section, staff_assignment_id, staff_id, supervisor_user_id, assigned_date, unassigned_date
FROM staff_supervisor_assignments WHERE unassigned_date IS NOT NULL AND unassigned_date <= assigned_date;
-- Ends BEFORE start (data error, not produced by the code). Expected 0 rows.
SELECT 'P5 invalid ranges (end < start)' AS section, assignment_id, worker_id, assigned_date, unassigned_date
FROM workersiteassignments WHERE unassigned_date IS NOT NULL AND unassigned_date < assigned_date;

-- V2: overlapping worker assignments under the CURRENT (exclusive) meaning.
-- Expected: 0 rows.
SELECT 'P5 overlapping worker assignments (V2)' AS section, x.worker_id, x.assignment_id AS a1, y.assignment_id AS a2,
       x.site_id AS s1, x.shift_type AS sh1, y.site_id AS s2, y.shift_type AS sh2,
       x.assigned_date AS from1, x.unassigned_date AS to1_excl, y.assigned_date AS from2, y.unassigned_date AS to2_excl
FROM workersiteassignments x
JOIN workersiteassignments y ON y.worker_id = x.worker_id AND y.assignment_id > x.assignment_id
 AND x.assigned_date < COALESCE(y.unassigned_date, '9999-12-31')
 AND y.assigned_date < COALESCE(x.unassigned_date, '9999-12-31');

-- V1 / H-07: approved attendance with no covering assignment (exclusive meaning).
-- These block worker payroll generation (422). Expected: 0 rows.
SELECT 'P5 approved attendance without assignment (V1)' AS section, a.attendance_id, a.worker_id, a.site_id, a.shift_type, a.record_date
FROM attendance a
WHERE a.status = 'Approved'
  AND NOT EXISTS (SELECT 1 FROM workersiteassignments w
                  WHERE w.worker_id = a.worker_id AND w.site_id = a.site_id AND w.shift_type = a.shift_type
                    AND w.assigned_date <= a.record_date
                    AND (w.unassigned_date IS NULL OR w.unassigned_date > a.record_date));

-- Attendance recorded ON the old exclusive end date (the day C-01 "End
-- Assignment" made orphan). After conversion the same rows are still outside
-- the assignment (meaning is preserved exactly); listed so a person can decide
-- whether the assignment really ended the day before.
SELECT 'P5 attendance on the exclusive end date' AS section, a.attendance_id, a.worker_id, a.site_id, a.record_date, a.status, w.assignment_id
FROM attendance a
JOIN workersiteassignments w ON w.worker_id = a.worker_id AND w.site_id = a.site_id AND w.shift_type = a.shift_type
 AND w.unassigned_date = a.record_date;

-- V3 / R-14: inactive workers with an open assignment (information only:
-- inactive status no longer closes assignments automatically).
SELECT 'P5 inactive workers with open assignment (V3)' AS section, w.worker_id, w.full_name, wsa.assignment_id, wsa.site_id, wsa.shift_type
FROM workers w JOIN workersiteassignments wsa ON wsa.worker_id = w.worker_id AND wsa.unassigned_date IS NULL
WHERE w.status <> 'Active';

-- V4 / H-01: inactive workers with no status history.
SELECT 'P5 inactive workers without status history (V4)' AS section, w.worker_id, w.full_name
FROM workers w
WHERE w.status = 'Inactive' AND NOT EXISTS (SELECT 1 FROM worker_status_history h WHERE h.worker_id = w.worker_id);

-- ---------------------------------------------------------------------
-- P6. Overtime Rate — Pre-Migration Database Audit
-- ---------------------------------------------------------------------
-- 1-2. Relevant tables / columns.
SELECT 'P6.1 overtime columns' AS section, table_name, column_name, column_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = DATABASE()
  AND (column_name LIKE '%overtime%' OR column_name LIKE 'ot\_%')
ORDER BY table_name, column_name;
-- 3. Current configured value(s).
SELECT 'P6.3 current OT setting' AS section, setting_key, setting_value
FROM system_settings WHERE setting_key LIKE '%overtime%';
-- 4. Dated history of the OT setting (historical snapshots of configuration).
SELECT 'P6.4 OT setting history' AS section, setting_history_id, setting_value, effective_from, effective_to, reason, changed_by_user_id, created_at
FROM system_settings_history WHERE setting_key = 'overtime_flat_rate_syp' ORDER BY effective_from;
-- 8/9. Overlapping or duplicate dated rows. Expected: 0 rows.
SELECT 'P6.9 overlapping OT history rows' AS section, x.setting_history_id AS h1, y.setting_history_id AS h2,
       x.effective_from, x.effective_to, y.effective_from, y.effective_to
FROM system_settings_history x
JOIN system_settings_history y ON y.setting_key = x.setting_key AND y.setting_history_id > x.setting_history_id
 AND x.effective_from <= COALESCE(y.effective_to, '9999-12-31')
 AND y.effective_from <= COALESCE(x.effective_to, '9999-12-31')
WHERE x.setting_key = 'overtime_flat_rate_syp';
-- 4/8. Rates actually snapshotted into payroll items (per batch status).
SELECT 'P6.8 OT rate snapshots in payroll' AS section, pb.status, pb.is_finalized,
       pi.overtime_hourly_rate_snapshot, COUNT(*) AS items, SUM(pi.overtime_hours_worked) AS ot_hours, SUM(pi.overtime_pay) AS ot_pay
FROM payrollitems pi JOIN payroll p ON p.payroll_id = pi.payroll_id
JOIN payrollbatches pb ON pb.payroll_batch_id = p.payroll_batch_id
GROUP BY pb.status, pb.is_finalized, pi.overtime_hourly_rate_snapshot
ORDER BY pb.status, pi.overtime_hourly_rate_snapshot;
-- 5/6. Finalized/paid items with overtime but NULL/zero rate snapshot. Expected: 0 rows.
SELECT 'P6.6 OT pay without rate snapshot' AS section, pb.payroll_batch_id, pb.status, pb.is_finalized, pi.payroll_item_id,
       pi.overtime_hours_worked, pi.overtime_hourly_rate_snapshot, pi.overtime_pay
FROM payrollitems pi JOIN payroll p ON p.payroll_id = pi.payroll_id
JOIN payrollbatches pb ON pb.payroll_batch_id = p.payroll_batch_id
WHERE COALESCE(pi.overtime_hours_worked, 0) > 0 AND COALESCE(pi.overtime_hourly_rate_snapshot, 0) = 0;
-- 7. Inconsistent amounts: overtime_pay <> hours x snapshot rate (> 1 unit). Expected: 0 rows.
SELECT 'P6.7 inconsistent OT amounts' AS section, pb.payroll_batch_id, pb.status, pi.payroll_item_id,
       pi.overtime_hours_worked, pi.overtime_hourly_rate_snapshot, pi.overtime_pay,
       ROUND(pi.overtime_hours_worked * pi.overtime_hourly_rate_snapshot, 2) AS expected
FROM payrollitems pi JOIN payroll p ON p.payroll_id = pi.payroll_id
JOIN payrollbatches pb ON pb.payroll_batch_id = p.payroll_batch_id
WHERE pi.overtime_hourly_rate_snapshot IS NOT NULL
  AND ABS(pi.overtime_pay - ROUND(pi.overtime_hours_worked * pi.overtime_hourly_rate_snapshot, 2)) > 1;
-- 8. More than one OT rate inside the same batch (legitimate only when the
--    dated setting changed inside the period).
SELECT 'P6.8 batches with several OT rates' AS section, p.payroll_batch_id, COUNT(DISTINCT pi.overtime_hourly_rate_snapshot) AS rates,
       GROUP_CONCAT(DISTINCT pi.overtime_hourly_rate_snapshot) AS rate_values
FROM payrollitems pi JOIN payroll p ON p.payroll_id = pi.payroll_id
WHERE pi.overtime_hourly_rate_snapshot IS NOT NULL
GROUP BY p.payroll_batch_id HAVING COUNT(DISTINCT pi.overtime_hourly_rate_snapshot) > 1;
-- 6. Overtime hours that hit the old DECIMAL(4,2) cap (99.99) — possible
--    silently truncated values. Expected: 0 rows.
SELECT 'P6.6 attendance OT at cap 99.99' AS section, attendance_id, worker_id, record_date, overtime_hours, status
FROM attendance WHERE overtime_hours >= 99.99;
SELECT 'P6.6 payroll item OT at cap 99.99' AS section, payroll_item_id, payroll_id, overtime_hours_worked
FROM payrollitems WHERE overtime_hours_worked >= 99.99;
-- Worker-level overtime_hourly_rate (kept for history; NOT used for pay since
-- the unified overtime policy).
SELECT 'P6 worker-level OT rates (informational)' AS section, COUNT(*) AS workers_with_rate,
       COUNT(DISTINCT overtime_hourly_rate) AS distinct_rates, MIN(overtime_hourly_rate), MAX(overtime_hourly_rate)
FROM workers WHERE overtime_hourly_rate IS NOT NULL;
-- 12. Hard-coded application value: the backend code contained
--     OVERTIME_FLAT_RATE_SYP = 150 as a FALLBACK when no setting existed.
--     13. Old payroll is NOT recalculated: amounts are stored in payrollitems.

-- ---------------------------------------------------------------------
-- P7. Payroll integrity (V6 - V8)
-- ---------------------------------------------------------------------
SELECT 'P7 approved after batch generation (V6)' AS section, a.attendance_id, a.worker_id, a.site_id, a.record_date, a.approval_date,
       pb.payroll_batch_id, pb.generated_at, pb.is_finalized, pb.status
FROM attendance a
JOIN payrollbatches pb ON pb.status <> 'Superseded'
 AND a.record_date BETWEEN pb.start_date AND pb.end_date
 AND (pb.scope_site_id IS NULL OR pb.scope_site_id = a.site_id)
WHERE a.status = 'Approved' AND a.approval_date > pb.generated_at;

SELECT 'P7 batch totals mismatch (V7a)' AS section, pb.payroll_batch_id, pb.total_amount, SUM(p.net_salary) AS sum_net, pb.total_workers, COUNT(*) AS cnt
FROM payrollbatches pb JOIN payroll p ON p.payroll_batch_id = pb.payroll_batch_id
GROUP BY pb.payroll_batch_id, pb.total_amount, pb.total_workers
HAVING ABS(pb.total_amount - SUM(p.net_salary)) > 0.01 OR pb.total_workers <> COUNT(*);

SELECT 'P7 payroll vs items mismatch (V7b)' AS section, p.payroll_id, p.gross_salary, SUM(pi.base_salary + pi.overtime_pay) AS items
FROM payroll p LEFT JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
GROUP BY p.payroll_id, p.gross_salary
HAVING items IS NULL OR ABS(p.gross_salary - items) > 0.01;

SELECT 'P7 overlapping active batches (V8)' AS section, x.payroll_batch_id, y.payroll_batch_id
FROM payrollbatches x JOIN payrollbatches y ON y.payroll_batch_id > x.payroll_batch_id
 AND x.status <> 'Superseded' AND y.status <> 'Superseded'
 AND x.start_date <= y.end_date AND y.start_date <= x.end_date
 AND (x.scope_site_id <=> y.scope_site_id OR x.scope_site_id IS NULL OR y.scope_site_id IS NULL);

SELECT 'P7 staff payroll batches' AS section, staff_payroll_batch_id, start_date, end_date, status, is_finalized, version_number
FROM staff_payroll_batches ORDER BY start_date;
-- Staff payroll data boundary (no pre-August fabrication).
SELECT 'P7 earliest staff payroll' AS section, MIN(start_date) AS earliest_staff_batch FROM staff_payroll_batches;

-- ---------------------------------------------------------------------
-- P8. Biometric
-- ---------------------------------------------------------------------
SELECT 'P8 overlapping active mappings (V5)' AS section, x.device_employee_id, x.id, y.id
FROM attendance_device_users x
JOIN attendance_device_users y ON y.device_employee_id = x.device_employee_id AND y.id > x.id
 AND x.active = 1 AND y.active = 1
 AND x.effective_from <= COALESCE(y.effective_to, '9999-12-31')
 AND y.effective_from <= COALESCE(x.effective_to, '9999-12-31');

SELECT 'P8 invalid / dismissed punches (V12)' AS section, pr.processing_status, pr.processing_result,
       SUM(pr.mapping_id IS NULL) AS without_mapping, COUNT(*) AS total
FROM attendance_punch_processing pr
WHERE pr.processing_status IN ('Invalid','Dismissed') GROUP BY pr.processing_status, pr.processing_result;

SELECT 'P8 open biometric sessions longer than 16h' AS section, a.attendance_id, a.worker_id, a.record_date, a.check_in_time, a.check_out_time,
       TIMESTAMPDIFF(MINUTE, a.check_in_time, a.check_out_time) / 60 AS hours
FROM attendance a WHERE a.check_out_time IS NOT NULL AND TIMESTAMPDIFF(MINUTE, a.check_in_time, a.check_out_time) > 16 * 60;

-- ---------------------------------------------------------------------
-- P9. Security
-- ---------------------------------------------------------------------
SELECT 'P9 non-bcrypt passwords (V11)' AS section, user_id, username
FROM users WHERE password_hash NOT LIKE '$2a$%' AND password_hash NOT LIKE '$2b$%';
SELECT 'P9 transfer FK delete rules' AS section, constraint_name, delete_rule
FROM information_schema.referential_constraints
WHERE constraint_schema = DATABASE() AND table_name = 'worker_transfer_requests';

-- ---------------------------------------------------------------------
-- P10. Staff Sick records that are currently marked paid by default
-- ---------------------------------------------------------------------
SELECT 'P10 staff Sick by status/is_paid' AS section, status, is_paid, COUNT(*) AS cnt
FROM staff_attendance WHERE attendance_status = 'Sick' GROUP BY status, is_paid;
