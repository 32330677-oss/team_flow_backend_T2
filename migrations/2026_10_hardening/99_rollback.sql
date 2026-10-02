-- =====================================================================
-- 2026-10 hardening migration — ROLLBACK / RECOVERY
--
-- Use ONLY together with the previous backend build (the new backend
-- refuses to start without the end-date marker, and the old backend must not
-- run on converted dates).
--
-- BEFORE running: export the tables that may now contain real business
-- decisions made after go-live, they are dropped in R6:
--   mysqldump <db> attendance_corrections_log site_status_history \
--     attendance_punch_processing_log payroll_attendance_snapshot > post_golive_history.sql
-- Rows created AFTER the migration (new attendance, new batches, new
-- assignments) are NOT deleted by this script; only the values changed by
-- steps 03-05 are restored.
-- =====================================================================

-- R1. Assignment end dates back to the exclusive meaning (only rows still
--     holding the converted value; rows changed later by users are reported).
SELECT 'R1 rows changed after migration (manual review)' AS info, l.table_name, l.pk_value, l.new_unassigned_date, w.unassigned_date AS live_value
FROM assignment_end_date_migration_log l
JOIN workersiteassignments w ON l.table_name = 'workersiteassignments' AND w.assignment_id = l.pk_value
WHERE NOT (w.unassigned_date <=> l.new_unassigned_date);

START TRANSACTION;
UPDATE workersiteassignments w
JOIN assignment_end_date_migration_log l ON l.table_name = 'workersiteassignments' AND l.pk_value = w.assignment_id
SET w.unassigned_date = l.old_unassigned_date
WHERE w.unassigned_date <=> l.new_unassigned_date;
UPDATE staff_site_assignments s
JOIN assignment_end_date_migration_log l ON l.table_name = 'staff_site_assignments' AND l.pk_value = s.staff_assignment_id
SET s.unassigned_date = l.old_unassigned_date
WHERE s.unassigned_date <=> l.new_unassigned_date;
UPDATE staff_supervisor_assignments s
JOIN assignment_end_date_migration_log l ON l.table_name = 'staff_supervisor_assignments' AND l.pk_value = s.staff_assignment_id
SET s.unassigned_date = l.old_unassigned_date
WHERE s.unassigned_date <=> l.new_unassigned_date;
-- Assignments CLOSED after go-live by the new code use the inclusive meaning;
-- convert them to the exclusive meaning too (+1 day) so the old code reads them correctly.
UPDATE workersiteassignments w
LEFT JOIN assignment_end_date_migration_log l ON l.table_name = 'workersiteassignments' AND l.pk_value = w.assignment_id
SET w.unassigned_date = DATE_ADD(w.unassigned_date, INTERVAL 1 DAY)
WHERE w.unassigned_date IS NOT NULL AND l.log_id IS NULL;
UPDATE staff_site_assignments s
LEFT JOIN assignment_end_date_migration_log l ON l.table_name = 'staff_site_assignments' AND l.pk_value = s.staff_assignment_id
SET s.unassigned_date = DATE_ADD(s.unassigned_date, INTERVAL 1 DAY)
WHERE s.unassigned_date IS NOT NULL AND l.log_id IS NULL;
UPDATE staff_supervisor_assignments s
LEFT JOIN assignment_end_date_migration_log l ON l.table_name = 'staff_supervisor_assignments' AND l.pk_value = s.staff_assignment_id
SET s.unassigned_date = DATE_ADD(s.unassigned_date, INTERVAL 1 DAY)
WHERE s.unassigned_date IS NOT NULL AND l.log_id IS NULL;
DELETE FROM system_settings WHERE setting_key = 'assignment_end_semantics';
COMMIT;

-- R2. Range checks
ALTER TABLE workersiteassignments DROP CHECK chk_wsa_range;
ALTER TABLE staff_site_assignments DROP CHECK chk_stsa_range;
ALTER TABLE staff_supervisor_assignments DROP CHECK chk_stsupa_range;

-- R3. T2 consolidation: restore every moved value from t2_merge_log.
START TRANSACTION;
UPDATE workersiteassignments w JOIN t2_merge_log m ON m.table_name = 'workersiteassignments' AND m.pk_value = w.assignment_id
SET w.site_id = SUBSTRING_INDEX(m.old_value, '|', 1), w.shift_type = SUBSTRING_INDEX(m.old_value, '|', -1);
UPDATE attendance a JOIN t2_merge_log m ON m.table_name = 'attendance' AND m.pk_value = a.attendance_id
SET a.site_id = SUBSTRING_INDEX(m.old_value, '|', 1), a.shift_type = SUBSTRING_INDEX(m.old_value, '|', -1);
UPDATE payrollitems p JOIN t2_merge_log m ON m.table_name = 'payrollitems' AND m.pk_value = p.payroll_item_id
SET p.site_id = m.old_value;
UPDATE worker_transfer_requests t JOIN t2_merge_log m ON m.table_name = 'worker_transfer_requests' AND m.pk_value = t.request_id AND m.column_name = 'current_site_id|current_shift_type'
SET t.current_site_id = SUBSTRING_INDEX(m.old_value, '|', 1), t.current_shift_type = SUBSTRING_INDEX(m.old_value, '|', -1);
UPDATE worker_transfer_requests t JOIN t2_merge_log m ON m.table_name = 'worker_transfer_requests' AND m.pk_value = t.request_id AND m.column_name = 'target_site_id|target_shift_type'
SET t.target_site_id = SUBSTRING_INDEX(m.old_value, '|', 1), t.target_shift_type = SUBSTRING_INDEX(m.old_value, '|', -1);
UPDATE staff_site_assignments s JOIN t2_merge_log m ON m.table_name = 'staff_site_assignments' AND m.pk_value = s.staff_assignment_id
SET s.site_id = m.old_value;
UPDATE staff_members s JOIN t2_merge_log m ON m.table_name = 'staff_members' AND m.pk_value = s.staff_id
SET s.site_id = m.old_value;
-- Sites 8 / 9 and site_shifts: restore from the backup snapshot.
UPDATE sites s JOIN bak_202610_sites b ON b.site_id = s.site_id
SET s.site_name = b.site_name, s.site_status = b.site_status, s.supports_shifts = b.supports_shifts, s.supervisor_id = b.supervisor_id
WHERE s.site_id IN (8, 9);
DELETE ss FROM site_shifts ss
LEFT JOIN bak_202610_site_shifts b ON b.site_shift_id = ss.site_shift_id
WHERE ss.site_id = 8 AND b.site_shift_id IS NULL;
COMMIT;

-- R4. Payroll / staff payroll states and columns. A batch VOIDED after
--     go-live becomes 'Superseded' (the closest old state) before the enum is
--     reduced; its void reason is kept in auditlogs.
UPDATE payrollbatches SET status = 'Superseded' WHERE status = 'Voided';
UPDATE staff_payroll_batches SET status = 'Superseded' WHERE status = 'Voided';
ALTER TABLE payrollbatches MODIFY COLUMN status ENUM('Generated','Paid','Superseded') NOT NULL DEFAULT 'Generated',
  DROP COLUMN currency, DROP COLUMN paid_by_user_id, DROP COLUMN paid_at, DROP COLUMN voided_by_user_id,
  DROP COLUMN voided_at, DROP COLUMN void_reason, DROP COLUMN supersede_reason;
ALTER TABLE staff_payroll_batches MODIFY COLUMN status ENUM('Generated','Paid','Superseded') NOT NULL DEFAULT 'Generated',
  DROP COLUMN currency, DROP COLUMN paid_by_user_id, DROP COLUMN paid_at, DROP COLUMN voided_by_user_id,
  DROP COLUMN voided_at, DROP COLUMN void_reason, DROP COLUMN supersede_reason;
-- Column widenings (attendance.overtime_hours, payrollitems hours) are kept:
-- narrowing could truncate values written after go-live.

-- R5. Added columns on attendance / staff / queue / assignments / transfers
ALTER TABLE attendance DROP INDEX idx_attendance_anomaly, DROP COLUMN anomaly_code, DROP COLUMN anomaly_detail,
  DROP COLUMN anomaly_ack_by_user_id, DROP COLUMN anomaly_ack_at, DROP COLUMN anomaly_ack_note;
ALTER TABLE staff_attendance DROP COLUMN anomaly_code, DROP COLUMN anomaly_detail, DROP COLUMN anomaly_ack_by_user_id,
  DROP COLUMN anomaly_ack_at, DROP COLUMN anomaly_ack_note, DROP COLUMN paid_decision_by_user_id, DROP COLUMN paid_decision_at;
ALTER TABLE attendance_punch_processing DROP COLUMN window_override, DROP COLUMN window_override_reason,
  DROP COLUMN window_override_by_user_id, DROP COLUMN window_override_at;
ALTER TABLE workersiteassignments DROP COLUMN ended_by_user_id, DROP COLUMN ended_at, DROP COLUMN end_reason;
-- Request reasons written after go-live are copied into admin_notes when empty, so they are not lost.
UPDATE worker_transfer_requests SET admin_notes = request_reason WHERE (admin_notes IS NULL OR admin_notes = '') AND request_reason IS NOT NULL;
ALTER TABLE worker_transfer_requests DROP COLUMN request_reason, DROP COLUMN transfer_type,
  DROP COLUMN reviewed_by_user_id, DROP COLUMN reviewed_at;
-- Transfer FKs stay RESTRICT (stricter, harmless for the old code).

-- R6. New tables (export them first, see header)
DROP TABLE IF EXISTS payroll_attendance_snapshot;
DROP TABLE IF EXISTS attendance_corrections_log;
DROP TABLE IF EXISTS site_status_history;
DROP TABLE IF EXISTS attendance_punch_processing_log;

-- R7. Settings added by step 05 (values only inserted when missing).
DELETE FROM system_settings WHERE setting_key IN ('long_shift_review_hours','worker_payroll_currency','staff_payroll_currency')
  AND setting_key NOT IN (SELECT setting_key FROM bak_202610_system_settings);
DELETE FROM system_settings WHERE setting_key = 'overtime_flat_rate_syp'
  AND setting_key NOT IN (SELECT setting_key FROM bak_202610_system_settings);

-- R8. Logs are kept until the rollback is verified; drop them afterwards:
-- DROP TABLE assignment_end_date_migration_log; DROP TABLE t2_merge_log;
-- DROP TABLE bak_202610_*;  (only after the full verification)
