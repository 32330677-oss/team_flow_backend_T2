-- =====================================================================
-- 2026-10 hardening migration — STEP 06: POST-MIGRATION VALIDATION
-- Read-only. Every check states the expected result.
-- =====================================================================

-- V-01 Semantics marker present. Expected: 1 row 'inclusive_last_day'.
SELECT 'V-01 marker' AS chk, setting_value FROM system_settings WHERE setting_key = 'assignment_end_semantics';

-- V-02 Every closed assignment was converted exactly once.
--      Expected: diff = 0 for each table.
SELECT 'V-02 conversion coverage' AS chk, t.table_name, t.closed_rows, COALESCE(l.logged, 0) AS logged, t.closed_rows - COALESCE(l.logged, 0) AS diff
FROM (
  SELECT 'workersiteassignments' AS table_name, COUNT(*) AS closed_rows FROM workersiteassignments WHERE unassigned_date IS NOT NULL
  UNION ALL SELECT 'staff_site_assignments', COUNT(*) FROM staff_site_assignments WHERE unassigned_date IS NOT NULL
  UNION ALL SELECT 'staff_supervisor_assignments', COUNT(*) FROM staff_supervisor_assignments WHERE unassigned_date IS NOT NULL
) t LEFT JOIN (SELECT table_name, COUNT(*) AS logged FROM assignment_end_date_migration_log GROUP BY table_name) l
  ON l.table_name = t.table_name;

-- V-03 Every converted value is exactly old - 1 day. Expected: 0 rows.
SELECT 'V-03 wrong conversion' AS chk, l.table_name, l.pk_value, l.old_unassigned_date, l.new_unassigned_date
FROM assignment_end_date_migration_log l
WHERE l.new_unassigned_date <> DATE_SUB(l.old_unassigned_date, INTERVAL 1 DAY);
SELECT 'V-03b live value differs from log' AS chk, w.assignment_id, w.unassigned_date, l.new_unassigned_date
FROM workersiteassignments w JOIN assignment_end_date_migration_log l
  ON l.table_name = 'workersiteassignments' AND l.pk_value = w.assignment_id
WHERE NOT (w.unassigned_date <=> l.new_unassigned_date);

-- V-04 Covered days unchanged: approved attendance without a covering
--      assignment, NEW inclusive predicate. Expected: same rows as precheck
--      P5 (V1) — the conversion must not add or remove any.
SELECT 'V-04 approved attendance without assignment (inclusive)' AS chk, a.attendance_id, a.worker_id, a.site_id, a.shift_type, a.record_date
FROM attendance a
WHERE a.status = 'Approved'
  AND NOT EXISTS (SELECT 1 FROM workersiteassignments w
                  WHERE w.worker_id = a.worker_id AND w.site_id = a.site_id AND w.shift_type = a.shift_type
                    AND w.assigned_date <= a.record_date
                    AND (w.unassigned_date IS NULL OR w.unassigned_date >= a.record_date));

-- V-05 No overlapping worker assignments (inclusive predicate). Expected: 0 rows
--      (or exactly the rows already reported by precheck P5/V2).
SELECT 'V-05 overlapping assignments (inclusive)' AS chk, x.worker_id, x.assignment_id, y.assignment_id
FROM workersiteassignments x
JOIN workersiteassignments y ON y.worker_id = x.worker_id AND y.assignment_id > x.assignment_id
 AND x.assigned_date <= COALESCE(y.unassigned_date, '9999-12-31')
 AND y.assigned_date <= COALESCE(x.unassigned_date, '9999-12-31')
 AND (x.unassigned_date IS NULL OR x.unassigned_date >= x.assigned_date)
 AND (y.unassigned_date IS NULL OR y.unassigned_date >= y.assigned_date);

-- V-06 Day-by-day equivalence spot check on the backup (whole history):
--      number of (assignment, day) pairs covered before and after.
--      Expected: before_days = after_days.
SELECT 'V-06 covered day count' AS chk,
  (SELECT COALESCE(SUM(DATEDIFF(COALESCE(b.unassigned_date, CURDATE() + INTERVAL 1 DAY), b.assigned_date)), 0)
     FROM bak_202610_workersiteassignments b) AS before_days,
  (SELECT COALESCE(SUM(DATEDIFF(COALESCE(w.unassigned_date, CURDATE()), w.assigned_date) + 1), 0)
     FROM workersiteassignments w) AS after_days;

-- V-07 Row counts unchanged by the migration (compare with precheck P3).
SELECT 'V-07 row counts' AS chk,
  (SELECT COUNT(*) FROM workersiteassignments) AS worker_assignments,
  (SELECT COUNT(*) FROM bak_202610_workersiteassignments) AS worker_assignments_backup,
  (SELECT COUNT(*) FROM attendance) AS attendance,
  (SELECT COUNT(*) FROM bak_202610_attendance) AS attendance_backup,
  (SELECT COUNT(*) FROM payrollitems) AS payroll_items,
  (SELECT COUNT(*) FROM bak_202610_payrollitems) AS payroll_items_backup,
  (SELECT COUNT(*) FROM payrollbatches) AS payroll_batches,
  (SELECT COUNT(*) FROM bak_202610_payrollbatches) AS payroll_batches_backup;

-- V-08 Payroll money unchanged. Expected: 0 rows.
SELECT 'V-08 payroll item amounts changed' AS chk, p.payroll_item_id
FROM payrollitems p JOIN bak_202610_payrollitems b ON b.payroll_item_id = p.payroll_item_id
WHERE p.base_salary <> b.base_salary OR p.overtime_pay <> b.overtime_pay
   OR NOT (p.overtime_hours_worked <=> b.overtime_hours_worked)
   OR NOT (p.overtime_hourly_rate_snapshot <=> b.overtime_hourly_rate_snapshot);
SELECT 'V-08b batch totals changed' AS chk, p.payroll_batch_id
FROM payrollbatches p JOIN bak_202610_payrollbatches b ON b.payroll_batch_id = p.payroll_batch_id
WHERE NOT (p.total_amount <=> b.total_amount) OR p.status <> b.status OR p.is_finalized <> b.is_finalized;

-- V-09 Currency: workers SYP, staff USD for all existing batches.
SELECT 'V-09 worker batch currency' AS chk, currency, COUNT(*) FROM payrollbatches GROUP BY currency;
SELECT 'V-09 staff batch currency' AS chk, currency, COUNT(*) FROM staff_payroll_batches GROUP BY currency;

-- V-10 T2. Expected: site 8 'T2' Active supports_shifts=1 supervisor NULL;
--      site 9 Suspended legacy; site 10 identical to the backup; no rows left on site 9.
SELECT 'V-10 sites' AS chk, s.site_id, s.site_name, s.site_status, s.supports_shifts, s.supervisor_id FROM sites s WHERE s.site_id IN (8, 9, 10);
SELECT 'V-10 site 10 untouched' AS chk,
  (SELECT COUNT(*) FROM sites s JOIN bak_202610_sites b ON b.site_id = s.site_id
    WHERE s.site_id = 10 AND s.site_name = b.site_name AND s.site_status <=> b.site_status
      AND s.supports_shifts = b.supports_shifts AND s.supervisor_id <=> b.supervisor_id) AS site10_identical;
SELECT 'V-10 site_shifts T2' AS chk, shift_type, supervisor_id FROM site_shifts WHERE site_id = 8;
SELECT 'V-10 rows on site 9' AS chk,
  (SELECT COUNT(*) FROM workersiteassignments WHERE site_id = 9) +
  (SELECT COUNT(*) FROM attendance WHERE site_id = 9) +
  (SELECT COUNT(*) FROM payrollitems WHERE site_id = 9) AS should_be_0;
SELECT 'V-10 attendance uniqueness' AS chk, worker_id, site_id, shift_type, record_date, COUNT(*)
FROM attendance GROUP BY worker_id, site_id, shift_type, record_date HAVING COUNT(*) > 1;

-- V-11 New tables / columns exist.
SELECT 'V-11 new tables' AS chk, table_name FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name IN ('payroll_attendance_snapshot','attendance_corrections_log','site_status_history',
  'attendance_punch_processing_log','t2_merge_log','assignment_end_date_migration_log') ORDER BY table_name;
-- Expected: 6 rows
SELECT 'V-11 widened columns' AS chk, table_name, column_name, column_type FROM information_schema.columns
WHERE table_schema = DATABASE() AND ((table_name = 'attendance' AND column_name = 'overtime_hours')
  OR (table_name = 'payrollitems' AND column_name IN ('overtime_hours_worked','regular_hours_worked')));
-- Expected: decimal(6,2), decimal(7,2), decimal(7,2)
SELECT 'V-11 transfer FKs' AS chk, constraint_name, delete_rule FROM information_schema.referential_constraints
WHERE constraint_schema = DATABASE() AND table_name = 'worker_transfer_requests';
-- Expected: RESTRICT (or NO ACTION) for all 4

-- V-12 Settings required by the new code. Expected: 5 rows.
SELECT 'V-12 settings' AS chk, setting_key, setting_value FROM system_settings
WHERE setting_key IN ('assignment_end_semantics','overtime_flat_rate_syp','long_shift_review_hours','worker_payroll_currency','staff_payroll_currency');

-- V-13 Raw biometric data untouched. Expected: identical counts.
SELECT 'V-13 raw punches' AS chk, (SELECT COUNT(*) FROM attendance_punches) AS punches,
       (SELECT COUNT(*) FROM attendance_punch_processing) AS queue,
       (SELECT COUNT(*) FROM bak_202610_attendance_punch_processing) AS queue_backup;
