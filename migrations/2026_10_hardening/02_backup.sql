-- =====================================================================
-- 2026-10 hardening migration — STEP 02: MIGRATION-LEVEL BACKUP
--
-- 1) FIRST take a full logical dump (the existing
--    team_flow_before_T2_migration.sql is older and does NOT replace it):
--      mysqldump --single-transaction --routines --triggers --set-gtid-purged=OFF \
--        -h <host> -P <port> -u <user> -p <db> > team_flow_before_2026_10_hardening.sql
-- 2) Then run this file. It copies every table that steps 03-05 modify into
--    bak_202610_* tables inside the same schema, so 99_rollback.sql can
--    restore exact original values without the dump.
--
-- Re-running is safe: an existing backup table is never overwritten
-- (CREATE TABLE IF NOT EXISTS ... SELECT keeps the FIRST snapshot).
-- =====================================================================

CREATE TABLE IF NOT EXISTS bak_202610_sites                         AS SELECT * FROM sites;
CREATE TABLE IF NOT EXISTS bak_202610_site_shifts                   AS SELECT * FROM site_shifts;
CREATE TABLE IF NOT EXISTS bak_202610_workersiteassignments         AS SELECT * FROM workersiteassignments;
CREATE TABLE IF NOT EXISTS bak_202610_staff_site_assignments        AS SELECT staff_assignment_id, staff_id, site_id, assigned_by_user_id, assigned_date, unassigned_date, notes, created_at FROM staff_site_assignments;
CREATE TABLE IF NOT EXISTS bak_202610_staff_supervisor_assignments  AS SELECT * FROM staff_supervisor_assignments;
CREATE TABLE IF NOT EXISTS bak_202610_staff_members_site            AS SELECT staff_id, site_id FROM staff_members;
CREATE TABLE IF NOT EXISTS bak_202610_attendance                    AS SELECT * FROM attendance;
CREATE TABLE IF NOT EXISTS bak_202610_payrollbatches                AS SELECT * FROM payrollbatches;
CREATE TABLE IF NOT EXISTS bak_202610_payrollitems                  AS SELECT * FROM payrollitems;
CREATE TABLE IF NOT EXISTS bak_202610_staff_payroll_batches         AS SELECT * FROM staff_payroll_batches;
CREATE TABLE IF NOT EXISTS bak_202610_staff_attendance              AS SELECT * FROM staff_attendance;
CREATE TABLE IF NOT EXISTS bak_202610_worker_transfer_requests      AS SELECT * FROM worker_transfer_requests;
CREATE TABLE IF NOT EXISTS bak_202610_system_settings               AS SELECT * FROM system_settings;
CREATE TABLE IF NOT EXISTS bak_202610_attendance_punch_processing   AS SELECT * FROM attendance_punch_processing;

-- Verification: every backup row count must equal the live row count.
SELECT 'backup check' AS section,
  (SELECT COUNT(*) FROM sites) = (SELECT COUNT(*) FROM bak_202610_sites) AS sites_ok,
  (SELECT COUNT(*) FROM workersiteassignments) = (SELECT COUNT(*) FROM bak_202610_workersiteassignments) AS wsa_ok,
  (SELECT COUNT(*) FROM staff_site_assignments) = (SELECT COUNT(*) FROM bak_202610_staff_site_assignments) AS ssa_ok,
  (SELECT COUNT(*) FROM staff_supervisor_assignments) = (SELECT COUNT(*) FROM bak_202610_staff_supervisor_assignments) AS ssupa_ok,
  (SELECT COUNT(*) FROM attendance) = (SELECT COUNT(*) FROM bak_202610_attendance) AS attendance_ok,
  (SELECT COUNT(*) FROM payrollitems) = (SELECT COUNT(*) FROM bak_202610_payrollitems) AS payrollitems_ok,
  (SELECT COUNT(*) FROM payrollbatches) = (SELECT COUNT(*) FROM bak_202610_payrollbatches) AS payrollbatches_ok,
  (SELECT COUNT(*) FROM staff_payroll_batches) = (SELECT COUNT(*) FROM bak_202610_staff_payroll_batches) AS staff_batches_ok,
  (SELECT COUNT(*) FROM worker_transfer_requests) = (SELECT COUNT(*) FROM bak_202610_worker_transfer_requests) AS transfers_ok,
  (SELECT COUNT(*) FROM attendance_punch_processing) = (SELECT COUNT(*) FROM bak_202610_attendance_punch_processing) AS queue_ok;
-- Expected: every *_ok column = 1. Stop if any is 0.
