-- =====================================================================
-- 2026-10 hardening migration — STEP 05: DATA MIGRATION
--
-- 5.1  Assignment end-date semantics (§5 of the requirements):
--      unassigned_date changes meaning from "first day OUTSIDE the
--      assignment" (exclusive, old code) to "LAST day assigned" (inclusive,
--      new code). Every closed row is shifted by exactly one day, so the set
--      of covered days is IDENTICAL before and after. The old value of every
--      row is kept in assignment_end_date_migration_log.
--      Tables: workersiteassignments, staff_site_assignments,
--              staff_supervisor_assignments.
--      A marker row in system_settings (assignment_end_semantics =
--      'inclusive_last_day') makes the step run exactly once. The new backend
--      REFUSES TO START without this marker (and the old backend must not be
--      run after it), so code and data can never disagree.
-- 5.2  Settings rows required by the new code (only inserted when missing).
-- 5.3  Range CHECK constraints (valid for every converted row).
--
-- Deploy order: stop the backend -> 02 -> 03 -> 04 -> 05 -> 06 -> deploy the
-- new backend. Do not run the old backend after this step.
-- =====================================================================

DROP PROCEDURE IF EXISTS mig_202610_convert_end_dates;
DELIMITER $$
CREATE PROCEDURE mig_202610_convert_end_dates()
BEGIN
  DECLARE v_marker VARCHAR(255);
  DECLARE v_expected INT; DECLARE v_logged INT;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SELECT setting_value INTO v_marker FROM system_settings WHERE setting_key = 'assignment_end_semantics';
  IF v_marker = 'inclusive_last_day' THEN
    SELECT '5.1 skipped: end dates already converted (marker present)' AS info;
  ELSE
    START TRANSACTION;
      SELECT COUNT(*) INTO v_expected FROM (
        SELECT assignment_id FROM workersiteassignments WHERE unassigned_date IS NOT NULL
        UNION ALL SELECT staff_assignment_id FROM staff_site_assignments WHERE unassigned_date IS NOT NULL
        UNION ALL SELECT staff_assignment_id FROM staff_supervisor_assignments WHERE unassigned_date IS NOT NULL) x;

      INSERT INTO assignment_end_date_migration_log (table_name, pk_value, old_unassigned_date, new_unassigned_date)
      SELECT 'workersiteassignments', assignment_id, unassigned_date, DATE_SUB(unassigned_date, INTERVAL 1 DAY)
      FROM workersiteassignments WHERE unassigned_date IS NOT NULL;
      INSERT INTO assignment_end_date_migration_log (table_name, pk_value, old_unassigned_date, new_unassigned_date)
      SELECT 'staff_site_assignments', staff_assignment_id, unassigned_date, DATE_SUB(unassigned_date, INTERVAL 1 DAY)
      FROM staff_site_assignments WHERE unassigned_date IS NOT NULL;
      INSERT INTO assignment_end_date_migration_log (table_name, pk_value, old_unassigned_date, new_unassigned_date)
      SELECT 'staff_supervisor_assignments', staff_assignment_id, unassigned_date, DATE_SUB(unassigned_date, INTERVAL 1 DAY)
      FROM staff_supervisor_assignments WHERE unassigned_date IS NOT NULL;

      SELECT COUNT(*) INTO v_logged FROM assignment_end_date_migration_log;
      IF v_logged <> v_expected THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '5.1: log row count does not match closed assignments. Rolled back.';
      END IF;

      UPDATE workersiteassignments w
      JOIN assignment_end_date_migration_log l ON l.table_name = 'workersiteassignments' AND l.pk_value = w.assignment_id
      SET w.unassigned_date = l.new_unassigned_date
      WHERE w.unassigned_date = l.old_unassigned_date;
      UPDATE staff_site_assignments s
      JOIN assignment_end_date_migration_log l ON l.table_name = 'staff_site_assignments' AND l.pk_value = s.staff_assignment_id
      SET s.unassigned_date = l.new_unassigned_date
      WHERE s.unassigned_date = l.old_unassigned_date;
      UPDATE staff_supervisor_assignments s
      JOIN assignment_end_date_migration_log l ON l.table_name = 'staff_supervisor_assignments' AND l.pk_value = s.staff_assignment_id
      SET s.unassigned_date = l.new_unassigned_date
      WHERE s.unassigned_date = l.old_unassigned_date;

      INSERT INTO system_settings (setting_key, setting_value) VALUES ('assignment_end_semantics', 'inclusive_last_day')
      ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);
    COMMIT;
    SELECT '5.1 done' AS info, v_logged AS rows_converted;
  END IF;
END$$
DELIMITER ;
CALL mig_202610_convert_end_dates();
DROP PROCEDURE IF EXISTS mig_202610_convert_end_dates;

-- ---------------------------------------------------------------------
-- 5.2 Settings rows (INSERT only when the key is missing; existing values are
--     never changed). Each one is also editable later with an effective date.
-- ---------------------------------------------------------------------
-- Worker overtime flat rate. The previous code used OVERTIME_FLAT_RATE_SYP =
-- 150 as a hard-coded fallback whenever this key was missing, so 150 is the
-- value that was actually applied in that case (evidence: the code). If the
-- key already exists, nothing changes. The new code has NO fallback: payroll
-- with overtime refuses to generate if no rate is configured for a date.
INSERT INTO system_settings (setting_key, setting_value)
SELECT 'overtime_flat_rate_syp', '150' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'overtime_flat_rate_syp');

-- Long-shift review threshold in hours (warning / Needs Review only; never
-- used to decide a shift). 16 is a starting value: confirm or change it in
-- Attendance Settings (business decision BD-1 in the report).
INSERT INTO system_settings (setting_key, setting_value)
SELECT 'long_shift_review_hours', '16' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'long_shift_review_hours');

-- Payroll currencies (D-10): current operating model.
INSERT INTO system_settings (setting_key, setting_value)
SELECT 'worker_payroll_currency', 'SYP' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'worker_payroll_currency');
INSERT INTO system_settings (setting_key, setting_value)
SELECT 'staff_payroll_currency', 'USD' FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE setting_key = 'staff_payroll_currency');

-- Existing batches got their currency from the column DEFAULT in step 04
-- (workers SYP, staff USD), which is the historical operating model. Nothing
-- else is rewritten.

-- ---------------------------------------------------------------------
-- 5.3 Range checks (inclusive end: end >= start - 1 day; start - 1 means an
--     explicitly empty / cancelled range, used only for converted zero-day rows).
-- ---------------------------------------------------------------------
CALL mig_202610_exec_if(
  "SELECT COUNT(*) = 0 FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = 'workersiteassignments' AND constraint_name = 'chk_wsa_range'",
  "ALTER TABLE workersiteassignments ADD CONSTRAINT chk_wsa_range CHECK (unassigned_date IS NULL OR unassigned_date >= DATE_SUB(assigned_date, INTERVAL 1 DAY))");
CALL mig_202610_exec_if(
  "SELECT COUNT(*) = 0 FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = 'staff_site_assignments' AND constraint_name = 'chk_stsa_range'",
  "ALTER TABLE staff_site_assignments ADD CONSTRAINT chk_stsa_range CHECK (unassigned_date IS NULL OR unassigned_date >= DATE_SUB(assigned_date, INTERVAL 1 DAY))");
CALL mig_202610_exec_if(
  "SELECT COUNT(*) = 0 FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = 'staff_supervisor_assignments' AND constraint_name = 'chk_stsupa_range'",
  "ALTER TABLE staff_supervisor_assignments ADD CONSTRAINT chk_stsupa_range CHECK (unassigned_date IS NULL OR unassigned_date >= DATE_SUB(assigned_date, INTERVAL 1 DAY))");

DROP PROCEDURE IF EXISTS mig_202610_exec_if;
