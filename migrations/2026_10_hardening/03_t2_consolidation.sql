-- =====================================================================
-- 2026-10 hardening migration — STEP 03: T2 DAY/NIGHT CONSOLIDATION
--
-- Target:
--   Site 8  = "T2", supports_shifts = 1, site_shifts: Day -> supervisor of
--             old site 8 (11), Night -> supervisor of old site 9 (13)
--   Site 9  = "T2-night shift (legacy, merged into T2)", Suspended, kept for
--             history (never deleted)
--   Site 10 = Bridges, NOT touched
--
-- Every row moved from site 9 to site 8 is written to t2_merge_log with its
-- old and new values (table, primary key, column), so the historical meaning
-- stays inspectable and 99_rollback.sql can restore it exactly.
--
-- Idempotent: every step works on "rows still on site 9" or on values not yet
-- in the target state, so a re-run does nothing. Each step is its own
-- transaction. A failed precondition stops the procedure with SIGNAL before
-- any write.
--
-- Run 01_precheck_readonly.sql first: the P4 conflict queries must return
-- 0 rows (the procedure re-checks them and refuses to continue otherwise).
-- =====================================================================

CREATE TABLE IF NOT EXISTS t2_merge_log (
  log_id        INT NOT NULL AUTO_INCREMENT,
  step          VARCHAR(40)  NOT NULL,
  table_name    VARCHAR(64)  NOT NULL,
  pk_value      BIGINT       NOT NULL,
  column_name   VARCHAR(64)  NOT NULL,
  old_value     VARCHAR(255) NULL,
  new_value     VARCHAR(255) NULL,
  migrated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (log_id),
  KEY idx_t2ml_table_pk (table_name, pk_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP PROCEDURE IF EXISTS mig_202610_t2_consolidate;
DELIMITER $$
CREATE PROCEDURE mig_202610_t2_consolidate()
BEGIN
  DECLARE v_t2 INT DEFAULT 8;
  DECLARE v_legacy INT DEFAULT 9;
  DECLARE v_c8 INT; DECLARE v_c9 INT;
  DECLARE v_sup8 INT; DECLARE v_sup9 INT;
  DECLARE v_shifts8 TINYINT;
  DECLARE v_conflicts INT;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  -- ---------------- preconditions (read-only) ----------------
  SELECT contract_id, supervisor_id, supports_shifts INTO v_c8, v_sup8, v_shifts8 FROM sites WHERE site_id = v_t2;
  SELECT contract_id, supervisor_id INTO v_c9, v_sup9 FROM sites WHERE site_id = v_legacy;
  IF v_c8 IS NULL OR v_c9 IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'T2: site 8 or site 9 does not exist. Nothing changed.';
  END IF;
  IF v_c8 <> v_c9 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'T2: sites 8 and 9 belong to different contracts. Nothing changed.';
  END IF;

  SELECT COUNT(*) INTO v_conflicts
  FROM attendance a9
  JOIN attendance a8 ON a8.worker_id = a9.worker_id AND a8.site_id = v_t2 AND a8.shift_type = 'Night' AND a8.record_date = a9.record_date
  WHERE a9.site_id = v_legacy;
  IF v_conflicts > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'T2: attendance conflicts site9 -> site8/Night exist (see precheck P4). Nothing changed.';
  END IF;

  SELECT COUNT(*) INTO v_conflicts
  FROM workersiteassignments x
  JOIN workersiteassignments y ON y.worker_id = x.worker_id AND y.site_id = v_t2 AND y.shift_type = 'Night'
   AND x.assigned_date <= COALESCE(y.unassigned_date, '9999-12-31')
   AND y.assigned_date <= COALESCE(x.unassigned_date, '9999-12-31')
  WHERE x.site_id = v_legacy;
  IF v_conflicts > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'T2: assignment overlaps site9 -> site8/Night exist (see precheck P4). Nothing changed.';
  END IF;

  -- ---------------- step 3.1: site 8 becomes "T2" with shifts ----------------
  START TRANSACTION;
    -- Keep the old site-level supervisor of site 8 as the Day supervisor and
    -- the old supervisor of site 9 as the Night supervisor (only when those
    -- shift rows do not exist yet; an existing site_shifts row is kept).
    INSERT INTO t2_merge_log (step, table_name, pk_value, column_name, old_value, new_value)
    SELECT '3.1', 'sites', site_id, 'site_name', site_name, 'T2' FROM sites WHERE site_id = v_t2 AND site_name <> 'T2';
    INSERT INTO t2_merge_log (step, table_name, pk_value, column_name, old_value, new_value)
    SELECT '3.1', 'sites', site_id, 'supports_shifts', supports_shifts, '1' FROM sites WHERE site_id = v_t2 AND supports_shifts <> 1;
    INSERT INTO t2_merge_log (step, table_name, pk_value, column_name, old_value, new_value)
    SELECT '3.1', 'sites', site_id, 'supervisor_id', supervisor_id, NULL FROM sites WHERE site_id = v_t2 AND supervisor_id IS NOT NULL AND supports_shifts = 0;

    INSERT INTO site_shifts (site_id, shift_type, supervisor_id)
    SELECT v_t2, 'Day', v_sup8 FROM DUAL
    WHERE v_shifts8 = 0 AND NOT EXISTS (SELECT 1 FROM site_shifts WHERE site_id = v_t2 AND shift_type = 'Day');
    INSERT INTO site_shifts (site_id, shift_type, supervisor_id)
    SELECT v_t2, 'Night', v_sup9 FROM DUAL
    WHERE NOT EXISTS (SELECT 1 FROM site_shifts WHERE site_id = v_t2 AND shift_type = 'Night');

    -- (MySQL evaluates SET assignments left to right: supervisor_id first.)
    UPDATE sites SET supervisor_id = CASE WHEN supports_shifts = 0 THEN NULL ELSE supervisor_id END,
                     site_name = 'T2', supports_shifts = 1
    WHERE site_id = v_t2 AND (site_name <> 'T2' OR supports_shifts <> 1);
  COMMIT;

  -- ---------------- step 3.2: assignments site 9 -> site 8 / Night ----------------
  START TRANSACTION;
    INSERT INTO t2_merge_log (step, table_name, pk_value, column_name, old_value, new_value)
    SELECT '3.2', 'workersiteassignments', assignment_id, 'site_id|shift_type', CONCAT(site_id, '|', shift_type), CONCAT(v_t2, '|Night')
    FROM workersiteassignments WHERE site_id = v_legacy;
    UPDATE workersiteassignments SET site_id = v_t2, shift_type = 'Night' WHERE site_id = v_legacy;
  COMMIT;

  -- ---------------- step 3.3: attendance site 9 -> site 8 / Night ----------------
  START TRANSACTION;
    INSERT INTO t2_merge_log (step, table_name, pk_value, column_name, old_value, new_value)
    SELECT '3.3', 'attendance', attendance_id, 'site_id|shift_type', CONCAT(site_id, '|', shift_type), CONCAT(v_t2, '|Night')
    FROM attendance WHERE site_id = v_legacy;
    UPDATE attendance SET site_id = v_t2, shift_type = 'Night' WHERE site_id = v_legacy;
  COMMIT;

  -- ---------------- step 3.4: payroll items (site-level) site 9 -> site 8 ----------------
  -- Payroll stays site-level: no shift is invented on payroll items. Amounts
  -- and every snapshot column are unchanged; only site_id moves, and the
  -- original site is kept in t2_merge_log.
  START TRANSACTION;
    INSERT INTO t2_merge_log (step, table_name, pk_value, column_name, old_value, new_value)
    SELECT '3.4', 'payrollitems', payroll_item_id, 'site_id', site_id, v_t2 FROM payrollitems WHERE site_id = v_legacy;
    UPDATE payrollitems SET site_id = v_t2 WHERE site_id = v_legacy;
  COMMIT;
  -- payrollbatches.scope_site_id = 9 (a historical batch generated for the old
  -- site) is intentionally NOT changed: the batch keeps describing what was
  -- generated at that time.

  -- ---------------- step 3.5: transfer requests ----------------
  START TRANSACTION;
    INSERT INTO t2_merge_log (step, table_name, pk_value, column_name, old_value, new_value)
    SELECT '3.5', 'worker_transfer_requests', request_id, 'current_site_id|current_shift_type', CONCAT(current_site_id, '|', current_shift_type), CONCAT(v_t2, '|Night')
    FROM worker_transfer_requests WHERE current_site_id = v_legacy;
    UPDATE worker_transfer_requests SET current_site_id = v_t2, current_shift_type = 'Night' WHERE current_site_id = v_legacy;
    INSERT INTO t2_merge_log (step, table_name, pk_value, column_name, old_value, new_value)
    SELECT '3.5', 'worker_transfer_requests', request_id, 'target_site_id|target_shift_type', CONCAT(target_site_id, '|', target_shift_type), CONCAT(v_t2, '|Night')
    FROM worker_transfer_requests WHERE target_site_id = v_legacy;
    UPDATE worker_transfer_requests SET target_site_id = v_t2, target_shift_type = 'Night' WHERE target_site_id = v_legacy;
  COMMIT;

  -- ---------------- step 3.6: staff site pointers (staff has no shifts) ----------------
  START TRANSACTION;
    INSERT INTO t2_merge_log (step, table_name, pk_value, column_name, old_value, new_value)
    SELECT '3.6', 'staff_site_assignments', staff_assignment_id, 'site_id', site_id, v_t2 FROM staff_site_assignments WHERE site_id = v_legacy;
    UPDATE staff_site_assignments SET site_id = v_t2 WHERE site_id = v_legacy;
    INSERT INTO t2_merge_log (step, table_name, pk_value, column_name, old_value, new_value)
    SELECT '3.6', 'staff_members', staff_id, 'site_id', site_id, v_t2 FROM staff_members WHERE site_id = v_legacy;
    UPDATE staff_members SET site_id = v_t2 WHERE site_id = v_legacy;
  COMMIT;

  -- ---------------- step 3.7: site 9 becomes legacy / Suspended ----------------
  START TRANSACTION;
    INSERT INTO t2_merge_log (step, table_name, pk_value, column_name, old_value, new_value)
    SELECT '3.7', 'sites', site_id, 'site_name|site_status', CONCAT(site_name, '|', site_status), 'T2-night shift (legacy, merged into T2)|Suspended'
    FROM sites WHERE site_id = v_legacy AND (site_status <> 'Suspended' OR site_name <> 'T2-night shift (legacy, merged into T2)');
    UPDATE sites SET site_name = 'T2-night shift (legacy, merged into T2)', site_status = 'Suspended'
    WHERE site_id = v_legacy AND (site_status <> 'Suspended' OR site_name <> 'T2-night shift (legacy, merged into T2)');
  COMMIT;
END$$
DELIMITER ;

CALL mig_202610_t2_consolidate();
DROP PROCEDURE IF EXISTS mig_202610_t2_consolidate;

-- Post-step verification (expected values in comments).
SELECT 'T2 sites' AS section, site_id, site_name, site_status, supports_shifts, supervisor_id FROM sites WHERE site_id IN (8, 9, 10) ORDER BY site_id;
-- 8 = T2 / Active / 1 / NULL ; 9 = legacy name / Suspended ; 10 unchanged
SELECT 'T2 site_shifts' AS section, site_id, shift_type, supervisor_id FROM site_shifts WHERE site_id = 8 ORDER BY shift_type;
-- 2 rows: Day, Night
SELECT 'T2 rows left on site 9' AS section,
  (SELECT COUNT(*) FROM workersiteassignments WHERE site_id = 9) AS assignments,
  (SELECT COUNT(*) FROM attendance WHERE site_id = 9) AS attendance,
  (SELECT COUNT(*) FROM payrollitems WHERE site_id = 9) AS payroll_items;
-- all 0
SELECT 'T2 merge log' AS section, step, table_name, COUNT(*) AS rows_moved FROM t2_merge_log GROUP BY step, table_name ORDER BY step;
