-- =====================================================================
-- 2026-10 hardening migration — STEP 04: SCHEMA CHANGES (DDL)
--
-- Every change is guarded by an information_schema check through the small
-- helper procedures below, so the file is idempotent (a re-run is a no-op).
-- No table is dropped and no row is deleted. Column widenings are lossless.
-- =====================================================================

DROP PROCEDURE IF EXISTS mig_202610_add_column;
DROP PROCEDURE IF EXISTS mig_202610_add_index;
DROP PROCEDURE IF EXISTS mig_202610_exec_if;
DELIMITER $$
CREATE PROCEDURE mig_202610_add_column(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_definition TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column) THEN
    SET @mig_sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition);
    PREPARE mig_stmt FROM @mig_sql; EXECUTE mig_stmt; DEALLOCATE PREPARE mig_stmt;
  END IF;
END$$
CREATE PROCEDURE mig_202610_add_index(IN p_table VARCHAR(64), IN p_index VARCHAR(64), IN p_definition TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                 WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_index) THEN
    SET @mig_sql = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_definition);
    PREPARE mig_stmt FROM @mig_sql; EXECUTE mig_stmt; DEALLOCATE PREPARE mig_stmt;
  END IF;
END$$
-- Runs p_sql only when p_condition_sql returns a non-zero first column.
CREATE PROCEDURE mig_202610_exec_if(IN p_condition_sql TEXT, IN p_sql TEXT)
BEGIN
  SET @mig_cond = CONCAT('SELECT (', p_condition_sql, ') INTO @mig_ok');
  PREPARE mig_c FROM @mig_cond; EXECUTE mig_c; DEALLOCATE PREPARE mig_c;
  IF @mig_ok THEN
    SET @mig_sql = p_sql;
    PREPARE mig_stmt FROM @mig_sql; EXECUTE mig_stmt; DEALLOCATE PREPARE mig_stmt;
  END IF;
END$$
DELIMITER ;

-- ---------------------------------------------------------------------
-- 4.1 Worker attendance: overtime limit + anomaly flag (R-06 / D-09 / §13)
--     overtime_hours DECIMAL(4,2) capped values at 99.99 and the code clamped
--     to it silently. Widened (lossless) to DECIMAL(6,2).
-- ---------------------------------------------------------------------
CALL mig_202610_exec_if(
  "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'attendance' AND column_name = 'overtime_hours' AND numeric_precision < 6",
  "ALTER TABLE attendance MODIFY COLUMN overtime_hours DECIMAL(6,2) DEFAULT '0.00'");
CALL mig_202610_add_column('attendance', 'anomaly_code', "VARCHAR(50) NULL COMMENT 'Set by the system when a duration looks unreasonable (warning only, never decides the shift)'");
CALL mig_202610_add_column('attendance', 'anomaly_detail', "VARCHAR(255) NULL");
CALL mig_202610_add_column('attendance', 'anomaly_ack_by_user_id', "INT NULL");
CALL mig_202610_add_column('attendance', 'anomaly_ack_at', "DATETIME NULL");
CALL mig_202610_add_column('attendance', 'anomaly_ack_note', "VARCHAR(500) NULL");
CALL mig_202610_add_index('attendance', 'idx_attendance_anomaly', "INDEX idx_attendance_anomaly (anomaly_code)");

-- ---------------------------------------------------------------------
-- 4.2 Staff attendance: anomaly flag + paid decision trace (D-11)
-- ---------------------------------------------------------------------
CALL mig_202610_add_column('staff_attendance', 'anomaly_code', "VARCHAR(50) NULL");
CALL mig_202610_add_column('staff_attendance', 'anomaly_detail', "VARCHAR(255) NULL");
CALL mig_202610_add_column('staff_attendance', 'anomaly_ack_by_user_id', "INT NULL");
CALL mig_202610_add_column('staff_attendance', 'anomaly_ack_at', "DATETIME NULL");
CALL mig_202610_add_column('staff_attendance', 'anomaly_ack_note', "VARCHAR(500) NULL");
CALL mig_202610_add_column('staff_attendance', 'paid_decision_by_user_id', "INT NULL COMMENT 'Who last set is_paid explicitly (Mark as Paid / Unpaid)'");
CALL mig_202610_add_column('staff_attendance', 'paid_decision_at', "DATETIME NULL");

-- ---------------------------------------------------------------------
-- 4.3 Worker payroll: Voided state, currency, paid/void/supersede trace (D-03, D-10, C-09)
-- ---------------------------------------------------------------------
CALL mig_202610_exec_if(
  "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payrollbatches' AND column_name = 'status' AND column_type NOT LIKE '%Voided%'",
  "ALTER TABLE payrollbatches MODIFY COLUMN status ENUM('Generated','Paid','Superseded','Voided') NOT NULL DEFAULT 'Generated'");
CALL mig_202610_add_column('payrollbatches', 'currency', "CHAR(3) NOT NULL DEFAULT 'SYP' COMMENT 'Every batch has exactly one currency (D-10)'");
CALL mig_202610_add_column('payrollbatches', 'paid_by_user_id', "INT NULL");
CALL mig_202610_add_column('payrollbatches', 'paid_at', "DATETIME NULL");
CALL mig_202610_add_column('payrollbatches', 'voided_by_user_id', "INT NULL");
CALL mig_202610_add_column('payrollbatches', 'voided_at', "DATETIME NULL");
CALL mig_202610_add_column('payrollbatches', 'void_reason', "VARCHAR(500) NULL");
CALL mig_202610_add_column('payrollbatches', 'supersede_reason', "VARCHAR(500) NULL COMMENT 'Reason given when THIS batch replaced the previous version'");
-- Aggregated overtime per payroll item could exceed 99.99 hours in a long
-- period and make generation fail; widened losslessly.
CALL mig_202610_exec_if(
  "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payrollitems' AND column_name = 'overtime_hours_worked' AND numeric_precision < 7",
  "ALTER TABLE payrollitems MODIFY COLUMN overtime_hours_worked DECIMAL(7,2) DEFAULT NULL");
CALL mig_202610_exec_if(
  "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'payrollitems' AND column_name = 'regular_hours_worked' AND numeric_precision < 7",
  "ALTER TABLE payrollitems MODIFY COLUMN regular_hours_worked DECIMAL(7,2) DEFAULT NULL");

-- ---------------------------------------------------------------------
-- 4.4 Staff payroll: same states/trace, currency USD (D-03, D-10, C-09)
-- ---------------------------------------------------------------------
CALL mig_202610_exec_if(
  "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'staff_payroll_batches' AND column_name = 'status' AND column_type NOT LIKE '%Voided%'",
  "ALTER TABLE staff_payroll_batches MODIFY COLUMN status ENUM('Generated','Paid','Superseded','Voided') NOT NULL DEFAULT 'Generated'");
CALL mig_202610_add_column('staff_payroll_batches', 'currency', "CHAR(3) NOT NULL DEFAULT 'USD'");
CALL mig_202610_add_column('staff_payroll_batches', 'paid_by_user_id', "INT NULL");
CALL mig_202610_add_column('staff_payroll_batches', 'paid_at', "DATETIME NULL");
CALL mig_202610_add_column('staff_payroll_batches', 'voided_by_user_id', "INT NULL");
CALL mig_202610_add_column('staff_payroll_batches', 'voided_at', "DATETIME NULL");
CALL mig_202610_add_column('staff_payroll_batches', 'void_reason', "VARCHAR(500) NULL");
CALL mig_202610_add_column('staff_payroll_batches', 'supersede_reason', "VARCHAR(500) NULL");

-- ---------------------------------------------------------------------
-- 4.5 Payroll attendance snapshot (C-07): the exact attendance rows and hours
--     used by each payroll item, so exports never read live attendance.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payroll_attendance_snapshot (
  snapshot_id      BIGINT NOT NULL AUTO_INCREMENT,
  payroll_batch_id INT NOT NULL,
  payroll_item_id  INT NOT NULL,
  attendance_id    INT NOT NULL,
  worker_id        INT NOT NULL,
  site_id          INT NOT NULL,
  shift_type       ENUM('Day','Night') NOT NULL,
  record_date      DATE NOT NULL,
  attendance_status ENUM('Present','Absent','Sick','Vacation','Holiday') NULL,
  regular_hours    DECIMAL(6,2) NOT NULL DEFAULT 0,
  overtime_hours   DECIMAL(6,2) NOT NULL DEFAULT 0,
  day_fraction     DECIMAL(6,4) NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (snapshot_id),
  UNIQUE KEY uq_pas_batch_attendance (payroll_batch_id, attendance_id),
  KEY idx_pas_item (payroll_item_id),
  KEY idx_pas_attendance (attendance_id),
  CONSTRAINT fk_pas_batch FOREIGN KEY (payroll_batch_id) REFERENCES payrollbatches (payroll_batch_id),
  CONSTRAINT fk_pas_item FOREIGN KEY (payroll_item_id) REFERENCES payrollitems (payroll_item_id),
  CONSTRAINT fk_pas_attendance FOREIGN KEY (attendance_id) REFERENCES attendance (attendance_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------
-- 4.6 Explicit correction workflow for finalized/paid periods (D-02)
--     Original and corrected values are kept; finalized payroll is never
--     modified. A correction with a possible financial effect is recorded as
--     an open adjustment item; no amount is calculated automatically.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_corrections_log (
  correction_id        INT NOT NULL AUTO_INCREMENT,
  record_table         ENUM('attendance','staff_attendance') NOT NULL,
  record_id            INT NOT NULL,
  person_id            INT NOT NULL COMMENT 'worker_id or staff_id',
  record_date          DATE NOT NULL,
  original_values      JSON NOT NULL,
  corrected_values     JSON NOT NULL,
  reason               VARCHAR(1000) NOT NULL,
  corrected_by_user_id INT NOT NULL,
  corrected_at         DATETIME NOT NULL,
  locked_batch_table   ENUM('payrollbatches','staff_payroll_batches') NULL,
  locked_batch_id      INT NULL COMMENT 'Finalized/Paid batch covering the date when corrected',
  payroll_effect       ENUM('None','AdjustmentRequired') NOT NULL DEFAULT 'None',
  adjustment_status    ENUM('NotApplicable','Open','Resolved') NOT NULL DEFAULT 'NotApplicable',
  resolved_by_user_id  INT NULL,
  resolved_at          DATETIME NULL,
  resolution_note      VARCHAR(1000) NULL,
  PRIMARY KEY (correction_id),
  KEY idx_acl_record (record_table, record_id),
  KEY idx_acl_adjustment (adjustment_status),
  CONSTRAINT fk_acl_user FOREIGN KEY (corrected_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_acl_resolved_by FOREIGN KEY (resolved_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------
-- 4.7 Site status history (D-05): biometric uses the status on the punch date.
--     No backfill is invented: a site without history and currently Active is
--     treated as Active; a site without history and NOT Active resolves as
--     "unknown" for past dates and goes to review.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_status_history (
  site_status_history_id INT NOT NULL AUTO_INCREMENT,
  site_id            INT NOT NULL,
  old_status         ENUM('Active','Completed','Suspended') NULL,
  new_status         ENUM('Active','Completed','Suspended') NOT NULL,
  effective_date     DATE NOT NULL COMMENT 'Inclusive: the new status applies from this date',
  reason             VARCHAR(500) NULL,
  changed_by_user_id INT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (site_status_history_id),
  KEY idx_ssth_site_date (site_id, effective_date),
  CONSTRAINT fk_ssth_site FOREIGN KEY (site_id) REFERENCES sites (site_id),
  CONSTRAINT fk_ssth_user FOREIGN KEY (changed_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------
-- 4.8 Biometric processing history (H-06) + restore of Invalid punches (D-04)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_punch_processing_log (
  log_id            BIGINT NOT NULL AUTO_INCREMENT,
  punch_id          BIGINT NOT NULL,
  event             VARCHAR(40) NOT NULL COMMENT 'processed | admin action name',
  processing_status VARCHAR(20) NOT NULL,
  processing_result VARCHAR(100) NULL,
  processing_error  TEXT NULL,
  mapping_id        INT NULL,
  target_table      VARCHAR(20) NULL,
  target_record_id  INT NULL,
  reason            VARCHAR(500) NULL,
  user_id           INT NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (log_id),
  KEY idx_appl_punch (punch_id, log_id),
  CONSTRAINT fk_appl_punch FOREIGN KEY (punch_id) REFERENCES attendance_punches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CALL mig_202610_add_column('attendance_punch_processing', 'window_override', "TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Admin restored an Invalid punch for processing outside the window'");
CALL mig_202610_add_column('attendance_punch_processing', 'window_override_reason', "VARCHAR(500) NULL");
CALL mig_202610_add_column('attendance_punch_processing', 'window_override_by_user_id', "INT NULL");
CALL mig_202610_add_column('attendance_punch_processing', 'window_override_at', "DATETIME NULL");

-- ---------------------------------------------------------------------
-- 4.9 Assignments: who ended it and why (C-01 / C-16); valid range check
-- ---------------------------------------------------------------------
CALL mig_202610_add_column('workersiteassignments', 'ended_by_user_id', "INT NULL");
CALL mig_202610_add_column('workersiteassignments', 'ended_at', "DATETIME NULL");
CALL mig_202610_add_column('workersiteassignments', 'end_reason', "VARCHAR(500) NULL");

-- ---------------------------------------------------------------------
-- 4.10 Transfers: request reason separate from admin notes (C-10),
--      reviewer trace, direct transfers recorded in the same history (D-01),
--      and history-preserving foreign keys (H-08: CASCADE -> RESTRICT).
-- ---------------------------------------------------------------------
CALL mig_202610_add_column('worker_transfer_requests', 'request_reason', "TEXT NULL");
CALL mig_202610_add_column('worker_transfer_requests', 'transfer_type', "ENUM('Request','Direct') NOT NULL DEFAULT 'Request'");
CALL mig_202610_add_column('worker_transfer_requests', 'reviewed_by_user_id', "INT NULL");
CALL mig_202610_add_column('worker_transfer_requests', 'reviewed_at', "DATETIME NULL");

CALL mig_202610_exec_if(
  "SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND constraint_name = 'worker_transfer_requests_ibfk_1' AND delete_rule = 'CASCADE'",
  "ALTER TABLE worker_transfer_requests DROP FOREIGN KEY worker_transfer_requests_ibfk_1");
CALL mig_202610_exec_if(
  "SELECT COUNT(*) = 0 FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND constraint_name = 'worker_transfer_requests_ibfk_1'",
  "ALTER TABLE worker_transfer_requests ADD CONSTRAINT worker_transfer_requests_ibfk_1 FOREIGN KEY (worker_id) REFERENCES workers (worker_id) ON DELETE RESTRICT");
CALL mig_202610_exec_if(
  "SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND constraint_name = 'worker_transfer_requests_ibfk_2' AND delete_rule = 'CASCADE'",
  "ALTER TABLE worker_transfer_requests DROP FOREIGN KEY worker_transfer_requests_ibfk_2");
CALL mig_202610_exec_if(
  "SELECT COUNT(*) = 0 FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND constraint_name = 'worker_transfer_requests_ibfk_2'",
  "ALTER TABLE worker_transfer_requests ADD CONSTRAINT worker_transfer_requests_ibfk_2 FOREIGN KEY (current_site_id) REFERENCES sites (site_id) ON DELETE RESTRICT");
CALL mig_202610_exec_if(
  "SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND constraint_name = 'worker_transfer_requests_ibfk_3' AND delete_rule = 'CASCADE'",
  "ALTER TABLE worker_transfer_requests DROP FOREIGN KEY worker_transfer_requests_ibfk_3");
CALL mig_202610_exec_if(
  "SELECT COUNT(*) = 0 FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND constraint_name = 'worker_transfer_requests_ibfk_3'",
  "ALTER TABLE worker_transfer_requests ADD CONSTRAINT worker_transfer_requests_ibfk_3 FOREIGN KEY (target_site_id) REFERENCES sites (site_id) ON DELETE RESTRICT");
CALL mig_202610_exec_if(
  "SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND constraint_name = 'worker_transfer_requests_ibfk_4' AND delete_rule = 'CASCADE'",
  "ALTER TABLE worker_transfer_requests DROP FOREIGN KEY worker_transfer_requests_ibfk_4");
CALL mig_202610_exec_if(
  "SELECT COUNT(*) = 0 FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND constraint_name = 'worker_transfer_requests_ibfk_4'",
  "ALTER TABLE worker_transfer_requests ADD CONSTRAINT worker_transfer_requests_ibfk_4 FOREIGN KEY (requested_by_user_id) REFERENCES users (user_id) ON DELETE RESTRICT");

-- ---------------------------------------------------------------------
-- 4.11 Assignment end-date conversion log (used by step 05 and rollback)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assignment_end_date_migration_log (
  log_id               INT NOT NULL AUTO_INCREMENT,
  table_name           VARCHAR(64) NOT NULL,
  pk_value             INT NOT NULL,
  old_unassigned_date  DATE NOT NULL COMMENT 'Exclusive meaning: first day outside the assignment',
  new_unassigned_date  DATE NOT NULL COMMENT 'Inclusive meaning: last assigned day',
  migrated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (log_id),
  UNIQUE KEY uq_aedml (table_name, pk_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP PROCEDURE IF EXISTS mig_202610_add_column;
DROP PROCEDURE IF EXISTS mig_202610_add_index;
-- mig_202610_exec_if is kept until step 05 finishes (step 05 drops it).
