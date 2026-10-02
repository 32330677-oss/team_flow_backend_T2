-- =====================================================================
-- tests/schema/base_schema.sql
--
-- RECONSTRUCTED schema of the CURRENT production database (after the
-- Phase 2 biometric migration and the T2 shift structure), used ONLY to run
-- the integration tests and to dry-run the 2026-10 migration locally.
--
-- Sources: the "DATABASE tables and info" project document (exact DDL for
-- attendance, workersiteassignments, sites, payroll*, users, site_shifts,
-- worker_transfer_requests, attendance_device_users, attendance_import_batches,
-- attendance_punches, attendance_punch_processing) + the Phase 2 report +
-- every column referenced by the backend code. Tables whose DDL is not in the
-- project document are reconstructed from the code and may differ in minor
-- details (column order, lengths) from production. It is NOT a production
-- script.
-- =====================================================================
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE users (
  user_id int NOT NULL AUTO_INCREMENT,
  username varchar(255) NOT NULL,
  password_hash varchar(255) NOT NULL,
  email varchar(255) DEFAULT NULL,
  full_name varchar(255) NOT NULL,
  role enum('Admin','Supervisor','StaffSupervisor') NOT NULL,
  status enum('Active','Inactive') NOT NULL DEFAULT 'Active',
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  last_login timestamp NULL DEFAULT NULL,
  failed_login_attempts int DEFAULT '0',
  password_reset_token varchar(255) DEFAULT NULL,
  password_reset_expires datetime DEFAULT NULL,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY username (username),
  UNIQUE KEY email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE loginhistory (
  login_id int NOT NULL AUTO_INCREMENT,
  user_id int NOT NULL,
  login_time timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  device_id varchar(255) DEFAULT NULL,
  user_agent text,
  success tinyint(1) DEFAULT '1',
  PRIMARY KEY (login_id),
  KEY user_id (user_id),
  CONSTRAINT loginhistory_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE projects (
  project_id int NOT NULL AUTO_INCREMENT,
  project_name varchar(255) NOT NULL,
  client_name varchar(255) DEFAULT NULL,
  location varchar(255) DEFAULT NULL,
  status enum('Active','Completed','Suspended') DEFAULT 'Active',
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE contracts (
  contract_id int NOT NULL AUTO_INCREMENT,
  contract_name varchar(255) NOT NULL,
  description text,
  start_date date DEFAULT NULL,
  end_date date DEFAULT NULL,
  project_id int NOT NULL,
  hourly_rate decimal(10,2) DEFAULT NULL,
  overtime_hourly_rate decimal(10,2) DEFAULT NULL,
  admin_id int DEFAULT NULL,
  status enum('Active','Completed','Suspended') DEFAULT 'Active',
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (contract_id),
  KEY admin_id (admin_id),
  KEY idx_contracts_project_id (project_id),
  CONSTRAINT contracts_ibfk_1 FOREIGN KEY (project_id) REFERENCES projects (project_id),
  CONSTRAINT contracts_ibfk_2 FOREIGN KEY (admin_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE sites (
  site_id int NOT NULL AUTO_INCREMENT,
  site_name varchar(255) NOT NULL,
  location varchar(255) DEFAULT NULL,
  site_status enum('Active','Completed','Suspended') DEFAULT 'Active',
  contract_id int NOT NULL,
  supervisor_id int DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  supports_shifts tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (site_id),
  KEY supervisor_id (supervisor_id),
  KEY idx_sites_contract_id (contract_id),
  CONSTRAINT sites_ibfk_1 FOREIGN KEY (contract_id) REFERENCES contracts (contract_id),
  CONSTRAINT sites_ibfk_2 FOREIGN KEY (supervisor_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE site_shifts (
  site_shift_id int NOT NULL AUTO_INCREMENT,
  site_id int NOT NULL,
  shift_type enum('Day','Night') NOT NULL,
  supervisor_id int DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (site_shift_id),
  UNIQUE KEY uq_site_shift (site_id,shift_type),
  KEY idx_site_shifts_supervisor (supervisor_id),
  CONSTRAINT fk_site_shifts_site FOREIGN KEY (site_id) REFERENCES sites (site_id),
  CONSTRAINT fk_site_shifts_supervisor FOREIGN KEY (supervisor_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE workers (
  worker_id int NOT NULL AUTO_INCREMENT,
  worker_unique_id varchar(50) NOT NULL,
  full_name varchar(255) NOT NULL,
  phone_number varchar(50) DEFAULT NULL,
  nationality varchar(100) DEFAULT NULL,
  job_position varchar(100) DEFAULT NULL,
  hire_date date DEFAULT NULL,
  notes text,
  status enum('Active','Inactive') DEFAULT 'Active',
  mothers_name varchar(255) DEFAULT NULL,
  birth_date date DEFAULT NULL,
  birth_place varchar(255) DEFAULT NULL,
  location varchar(255) DEFAULT NULL,
  personal_photo varchar(500) DEFAULT NULL,
  id_photo varchar(500) DEFAULT NULL,
  payment_type enum('Hourly','Daily') DEFAULT 'Hourly',
  daily_rate decimal(10,2) DEFAULT NULL,
  regular_hourly_rate decimal(10,2) DEFAULT NULL,
  overtime_hourly_rate decimal(10,2) DEFAULT NULL,
  standard_daily_minutes int DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (worker_id),
  UNIQUE KEY worker_unique_id (worker_unique_id),
  KEY idx_workers_full_name (full_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE workercompensationhistory (
  compensation_id int NOT NULL AUTO_INCREMENT,
  worker_id int NOT NULL,
  payment_type enum('Hourly','Daily') NOT NULL,
  daily_rate decimal(10,2) DEFAULT NULL,
  regular_hourly_rate decimal(10,2) DEFAULT NULL,
  overtime_hourly_rate decimal(10,2) DEFAULT NULL,
  job_position varchar(100) DEFAULT NULL,
  effective_from date NOT NULL,
  effective_to date DEFAULT NULL,
  reason text,
  changed_by_user_id int DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (compensation_id),
  KEY fk_wch_user (changed_by_user_id),
  KEY idx_wch_worker_period (worker_id,effective_from,effective_to),
  CONSTRAINT fk_wch_user FOREIGN KEY (changed_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_wch_worker FOREIGN KEY (worker_id) REFERENCES workers (worker_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE worker_status_history (
  status_history_id int NOT NULL AUTO_INCREMENT,
  worker_id int NOT NULL,
  old_status enum('Active','Inactive') DEFAULT NULL,
  new_status enum('Active','Inactive') NOT NULL,
  effective_date date NOT NULL,
  reason varchar(500) DEFAULT NULL,
  changed_by_user_id int DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (status_history_id),
  KEY idx_wsh_worker_date (worker_id,effective_date),
  CONSTRAINT fk_wsh_worker FOREIGN KEY (worker_id) REFERENCES workers (worker_id),
  CONSTRAINT fk_wsh_user FOREIGN KEY (changed_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE workersiteassignments (
  assignment_id int NOT NULL AUTO_INCREMENT,
  worker_id int NOT NULL,
  site_id int NOT NULL,
  contract_id int NOT NULL,
  assigned_by_user_id int DEFAULT NULL,
  assigned_date date NOT NULL,
  unassigned_date date DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  shift_type enum('Day','Night') NOT NULL DEFAULT 'Day',
  PRIMARY KEY (assignment_id),
  KEY contract_id (contract_id),
  KEY assigned_by_user_id (assigned_by_user_id),
  KEY idx_worker_assignments_worker_id (worker_id),
  KEY idx_worker_assignments_site_id (site_id),
  KEY idx_wsa_site_shift (site_id,shift_type),
  CONSTRAINT workersiteassignments_ibfk_1 FOREIGN KEY (worker_id) REFERENCES workers (worker_id),
  CONSTRAINT workersiteassignments_ibfk_2 FOREIGN KEY (site_id) REFERENCES sites (site_id),
  CONSTRAINT workersiteassignments_ibfk_3 FOREIGN KEY (contract_id) REFERENCES contracts (contract_id),
  CONSTRAINT workersiteassignments_ibfk_4 FOREIGN KEY (assigned_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE attendance (
  attendance_id int NOT NULL AUTO_INCREMENT,
  worker_id int NOT NULL,
  site_id int NOT NULL,
  record_date date NOT NULL,
  check_in_time datetime DEFAULT NULL,
  check_out_time datetime DEFAULT NULL,
  attendance_status enum('Present','Absent','Sick','Vacation','Holiday') DEFAULT 'Present',
  remarks text,
  overtime_hours decimal(4,2) DEFAULT '0.00',
  total_working_hours decimal(6,2) DEFAULT NULL,
  recorded_by_user_id int NOT NULL,
  status enum('Draft','Submitted','Approved','Rejected') DEFAULT 'Draft',
  admin_rejection_notes text,
  approved_by_user_id int DEFAULT NULL,
  approval_date datetime DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  management_leave_hours decimal(4,2) DEFAULT '0.00',
  standard_minutes_snapshot int DEFAULT NULL,
  shift_type enum('Day','Night') NOT NULL DEFAULT 'Day',
  source enum('Manual','Biometric') NOT NULL DEFAULT 'Manual',
  PRIMARY KEY (attendance_id),
  UNIQUE KEY uq_worker_site_shift_date (worker_id,site_id,shift_type,record_date),
  KEY recorded_by_user_id (recorded_by_user_id),
  KEY approved_by_user_id (approved_by_user_id),
  KEY idx_attendance_record_date (record_date),
  KEY idx_attendance_site_shift_date (site_id,shift_type,record_date),
  CONSTRAINT attendance_ibfk_1 FOREIGN KEY (worker_id) REFERENCES workers (worker_id),
  CONSTRAINT attendance_ibfk_2 FOREIGN KEY (site_id) REFERENCES sites (site_id),
  CONSTRAINT attendance_ibfk_3 FOREIGN KEY (recorded_by_user_id) REFERENCES users (user_id),
  CONSTRAINT attendance_ibfk_4 FOREIGN KEY (approved_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE attendanceleaveperiods (
  leave_id int NOT NULL AUTO_INCREMENT,
  attendance_id int NOT NULL,
  leave_start_time datetime NOT NULL,
  leave_end_time datetime DEFAULT NULL,
  leave_type enum('Rest','Lunch','Management') NOT NULL DEFAULT 'Rest',
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (leave_id),
  KEY attendance_id (attendance_id),
  CONSTRAINT attendanceleaveperiods_ibfk_1 FOREIGN KEY (attendance_id) REFERENCES attendance (attendance_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE attendancecorrections (
  correction_id int NOT NULL AUTO_INCREMENT,
  attendance_id int NOT NULL,
  requested_by_user_id int NOT NULL,
  approved_by_user_id int DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (correction_id),
  KEY attendance_id (attendance_id),
  CONSTRAINT attendancecorrections_ibfk_1 FOREIGN KEY (attendance_id) REFERENCES attendance (attendance_id),
  CONSTRAINT attendancecorrections_ibfk_2 FOREIGN KEY (requested_by_user_id) REFERENCES users (user_id),
  CONSTRAINT attendancecorrections_ibfk_3 FOREIGN KEY (approved_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auditlogs (
  log_id int NOT NULL AUTO_INCREMENT,
  table_name varchar(100) NOT NULL,
  record_id int NOT NULL,
  action_type varchar(100) NOT NULL,
  user_id int DEFAULT NULL,
  old_values json DEFAULT NULL,
  new_values json DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (log_id),
  KEY user_id (user_id),
  KEY idx_auditlogs_table_record (table_name,record_id),
  CONSTRAINT auditlogs_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE notifications (
  notification_id int NOT NULL AUTO_INCREMENT,
  user_id int NOT NULL,
  message text,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notification_id),
  CONSTRAINT notifications_ibfk_1 FOREIGN KEY (user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE system_settings (
  setting_key varchar(100) NOT NULL,
  setting_value varchar(255) DEFAULT NULL,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE system_settings_history (
  setting_history_id int NOT NULL AUTO_INCREMENT,
  setting_key varchar(100) NOT NULL,
  setting_value varchar(255) DEFAULT NULL,
  effective_from date NOT NULL,
  effective_to date DEFAULT NULL,
  reason varchar(500) DEFAULT NULL,
  changed_by_user_id int DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_history_id),
  KEY idx_ssh_key_from (setting_key,effective_from),
  CONSTRAINT fk_sysh_user FOREIGN KEY (changed_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE worker_transfer_requests (
  request_id int NOT NULL AUTO_INCREMENT,
  worker_id int NOT NULL,
  current_site_id int NOT NULL,
  current_shift_type enum('Day','Night') NOT NULL DEFAULT 'Day',
  target_site_id int NOT NULL,
  target_shift_type enum('Day','Night') NOT NULL DEFAULT 'Day',
  requested_by_user_id int NOT NULL,
  status enum('Pending','Approved','Rejected') DEFAULT 'Pending',
  admin_notes text,
  document_path varchar(500) DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  effective_date date DEFAULT NULL,
  PRIMARY KEY (request_id),
  KEY worker_id (worker_id),
  KEY current_site_id (current_site_id),
  KEY target_site_id (target_site_id),
  KEY requested_by_user_id (requested_by_user_id),
  CONSTRAINT worker_transfer_requests_ibfk_1 FOREIGN KEY (worker_id) REFERENCES workers (worker_id) ON DELETE CASCADE,
  CONSTRAINT worker_transfer_requests_ibfk_2 FOREIGN KEY (current_site_id) REFERENCES sites (site_id) ON DELETE CASCADE,
  CONSTRAINT worker_transfer_requests_ibfk_3 FOREIGN KEY (target_site_id) REFERENCES sites (site_id) ON DELETE CASCADE,
  CONSTRAINT worker_transfer_requests_ibfk_4 FOREIGN KEY (requested_by_user_id) REFERENCES users (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE payrollbatches (
  payroll_batch_id int NOT NULL AUTO_INCREMENT,
  start_date date NOT NULL,
  end_date date NOT NULL,
  scope_site_id int DEFAULT NULL,
  version_number int NOT NULL DEFAULT '1',
  supersedes_batch_id int DEFAULT NULL,
  is_finalized tinyint(1) NOT NULL DEFAULT '0',
  finalized_by_user_id int DEFAULT NULL,
  finalized_at datetime DEFAULT NULL,
  generated_by_user_id int NOT NULL,
  generated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  total_workers int DEFAULT NULL,
  total_amount decimal(12,2) DEFAULT NULL,
  status enum('Generated','Paid','Superseded') NOT NULL DEFAULT 'Generated',
  PRIMARY KEY (payroll_batch_id),
  KEY generated_by_user_id (generated_by_user_id),
  KEY fk_payrollbatches_scope_site (scope_site_id),
  KEY fk_payrollbatches_finalized_by (finalized_by_user_id),
  KEY fk_payrollbatches_supersedes (supersedes_batch_id),
  CONSTRAINT fk_payrollbatches_finalized_by FOREIGN KEY (finalized_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_payrollbatches_scope_site FOREIGN KEY (scope_site_id) REFERENCES sites (site_id),
  CONSTRAINT fk_payrollbatches_supersedes FOREIGN KEY (supersedes_batch_id) REFERENCES payrollbatches (payroll_batch_id),
  CONSTRAINT payrollbatches_ibfk_1 FOREIGN KEY (generated_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE payroll (
  payroll_id int NOT NULL AUTO_INCREMENT,
  payroll_batch_id int NOT NULL,
  worker_id int NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  bonus_amount decimal(10,2) DEFAULT '0.00',
  penalty_amount decimal(10,2) DEFAULT '0.00',
  deductions_amount decimal(10,2) DEFAULT '0.00',
  gross_salary decimal(10,2) NOT NULL,
  net_salary decimal(10,2) NOT NULL,
  status enum('Generated','Paid') DEFAULT 'Generated',
  generated_by_user_id int NOT NULL,
  generated_date timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  paid_date date DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (payroll_id),
  UNIQUE KEY uk_worker_batch (payroll_batch_id,worker_id),
  KEY generated_by_user_id (generated_by_user_id),
  KEY idx_payroll_worker_id (worker_id),
  CONSTRAINT payroll_ibfk_1 FOREIGN KEY (payroll_batch_id) REFERENCES payrollbatches (payroll_batch_id),
  CONSTRAINT payroll_ibfk_2 FOREIGN KEY (worker_id) REFERENCES workers (worker_id),
  CONSTRAINT payroll_ibfk_3 FOREIGN KEY (generated_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE payrollitems (
  payroll_item_id int NOT NULL AUTO_INCREMENT,
  payroll_id int NOT NULL,
  contract_id int NOT NULL,
  site_id int NOT NULL,
  pay_type enum('Hourly','Daily') NOT NULL DEFAULT 'Hourly',
  hourly_rate_snapshot decimal(10,2) DEFAULT NULL,
  overtime_hourly_rate_snapshot decimal(10,2) DEFAULT NULL,
  daily_rate_snapshot decimal(10,2) DEFAULT NULL,
  days_worked decimal(5,2) DEFAULT NULL,
  regular_hours_worked decimal(6,2) DEFAULT NULL,
  overtime_hours_worked decimal(4,2) DEFAULT NULL,
  base_salary decimal(10,2) NOT NULL,
  overtime_pay decimal(10,2) NOT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (payroll_item_id),
  KEY contract_id (contract_id),
  KEY idx_payroll_items_payroll_id (payroll_id),
  KEY idx_payroll_items_site_id (site_id),
  CONSTRAINT payrollitems_ibfk_1 FOREIGN KEY (payroll_id) REFERENCES payroll (payroll_id) ON DELETE CASCADE,
  CONSTRAINT payrollitems_ibfk_2 FOREIGN KEY (contract_id) REFERENCES contracts (contract_id),
  CONSTRAINT payrollitems_ibfk_3 FOREIGN KEY (site_id) REFERENCES sites (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_members (
  staff_id int NOT NULL AUTO_INCREMENT,
  staff_unique_id varchar(50) NOT NULL,
  full_name varchar(255) NOT NULL,
  phone_number varchar(50) DEFAULT NULL,
  position varchar(100) DEFAULT NULL,
  site_id int DEFAULT NULL,
  hire_date date DEFAULT NULL,
  first_hire_date date DEFAULT NULL,
  termination_date date DEFAULT NULL,
  monthly_salary decimal(10,2) DEFAULT NULL,
  standard_daily_hours decimal(4,2) DEFAULT '8.00',
  paid_leave_types json DEFAULT NULL,
  status enum('Active','Inactive','Terminated') NOT NULL DEFAULT 'Active',
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (staff_id),
  UNIQUE KEY uniq_staff_unique_id (staff_unique_id),
  KEY fk_staff_site (site_id),
  CONSTRAINT fk_staff_site FOREIGN KEY (site_id) REFERENCES sites (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_status_history (
  status_history_id int NOT NULL AUTO_INCREMENT,
  staff_id int NOT NULL,
  old_status enum('Active','Inactive','Terminated') DEFAULT NULL,
  new_status enum('Active','Inactive','Terminated') NOT NULL,
  effective_date date NOT NULL,
  reason text,
  changed_by_user_id int DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (status_history_id),
  KEY idx_ssh_staff_id (staff_id),
  CONSTRAINT fk_ssh_staff FOREIGN KEY (staff_id) REFERENCES staff_members (staff_id),
  CONSTRAINT fk_ssh_user FOREIGN KEY (changed_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_compensation_history (
  staff_compensation_id int NOT NULL AUTO_INCREMENT,
  staff_id int NOT NULL,
  monthly_salary decimal(10,2) DEFAULT NULL,
  standard_daily_hours decimal(4,2) DEFAULT NULL,
  paid_leave_types json DEFAULT NULL,
  effective_from date NOT NULL,
  effective_to date DEFAULT NULL,
  reason varchar(500) DEFAULT NULL,
  changed_by_user_id int DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (staff_compensation_id),
  KEY idx_sch_staff_from (staff_id,effective_from),
  CONSTRAINT fk_sch_staff FOREIGN KEY (staff_id) REFERENCES staff_members (staff_id),
  CONSTRAINT fk_sch_user FOREIGN KEY (changed_by_user_id) REFERENCES users (user_id),
  CONSTRAINT chk_sch_dates CHECK ((effective_to IS NULL) OR (effective_to >= effective_from))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_site_assignments (
  staff_assignment_id int NOT NULL AUTO_INCREMENT,
  staff_id int NOT NULL,
  site_id int NOT NULL,
  assigned_by_user_id int DEFAULT NULL,
  assigned_date date NOT NULL,
  unassigned_date date DEFAULT NULL,
  notes text,
  open_flag tinyint GENERATED ALWAYS AS ((CASE WHEN (unassigned_date IS NULL) THEN 1 ELSE NULL END)) STORED,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (staff_assignment_id),
  UNIQUE KEY uniq_staff_open_assignment (staff_id,open_flag),
  KEY idx_ssa_site_id (site_id),
  KEY fk_ssa_user (assigned_by_user_id),
  CONSTRAINT fk_ssa_site FOREIGN KEY (site_id) REFERENCES sites (site_id),
  CONSTRAINT fk_ssa_user FOREIGN KEY (assigned_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_supervisor_assignments (
  staff_assignment_id int NOT NULL AUTO_INCREMENT,
  staff_id int NOT NULL,
  supervisor_user_id int NOT NULL,
  assigned_by_user_id int DEFAULT NULL,
  assigned_date date NOT NULL,
  unassigned_date date DEFAULT NULL,
  notes text,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (staff_assignment_id),
  KEY idx_ssa_staff_open (staff_id,unassigned_date),
  KEY idx_ssa_supervisor_open (supervisor_user_id,unassigned_date),
  CONSTRAINT fk_ssa_assigned_by FOREIGN KEY (assigned_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_ssa_staff FOREIGN KEY (staff_id) REFERENCES staff_members (staff_id),
  CONSTRAINT fk_ssa_supervisor FOREIGN KEY (supervisor_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_attendance (
  staff_attendance_id int NOT NULL AUTO_INCREMENT,
  staff_id int NOT NULL,
  record_date date NOT NULL,
  attendance_status enum('Present','Absent','Sick','Vacation','Holiday') NOT NULL DEFAULT 'Present',
  check_in_time datetime DEFAULT NULL,
  check_out_time datetime DEFAULT NULL,
  lunch_start_time datetime DEFAULT NULL,
  lunch_end_time datetime DEFAULT NULL,
  regular_hours decimal(5,2) DEFAULT '0.00',
  overtime_hours decimal(5,2) DEFAULT '0.00',
  lunch_deducted_hours decimal(4,2) DEFAULT '0.00',
  is_friday_worked tinyint(1) NOT NULL DEFAULT '0',
  friday_confirmed_by_user_id int DEFAULT NULL,
  is_paid tinyint(1) NOT NULL DEFAULT '1',
  is_management_paid_absence tinyint(1) NOT NULL DEFAULT '0',
  management_paid_reason varchar(500) DEFAULT NULL,
  management_paid_by_user_id int DEFAULT NULL,
  management_paid_at datetime DEFAULT NULL,
  standard_minutes_snapshot int DEFAULT NULL,
  remarks text,
  recorded_by_user_id int DEFAULT NULL,
  status enum('Draft','Submitted','Approved','Rejected') NOT NULL DEFAULT 'Draft',
  admin_rejection_notes text,
  approved_by_user_id int DEFAULT NULL,
  approval_date datetime DEFAULT NULL,
  source enum('Manual','Biometric') NOT NULL DEFAULT 'Manual',
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (staff_attendance_id),
  UNIQUE KEY uniq_staff_date (staff_id,record_date),
  KEY fk_sa_recorder (recorded_by_user_id),
  CONSTRAINT fk_sa_staff FOREIGN KEY (staff_id) REFERENCES staff_members (staff_id),
  CONSTRAINT fk_sa_recorder FOREIGN KEY (recorded_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_sa_approver FOREIGN KEY (approved_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_sa_friday_confirmed_by FOREIGN KEY (friday_confirmed_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_staff_attendance_mgmt_paid_by FOREIGN KEY (management_paid_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_payroll_batches (
  staff_payroll_batch_id int NOT NULL AUTO_INCREMENT,
  start_date date NOT NULL,
  end_date date NOT NULL,
  generated_by_user_id int NOT NULL,
  generated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  total_staff int DEFAULT NULL,
  total_amount decimal(12,2) DEFAULT NULL,
  status enum('Generated','Paid','Superseded') NOT NULL DEFAULT 'Generated',
  version_number int NOT NULL DEFAULT '1',
  supersedes_batch_id int DEFAULT NULL,
  is_finalized tinyint(1) NOT NULL DEFAULT '0',
  finalized_by_user_id int DEFAULT NULL,
  finalized_at datetime DEFAULT NULL,
  PRIMARY KEY (staff_payroll_batch_id),
  KEY fk_spb_user (generated_by_user_id),
  KEY fk_spb_supersedes (supersedes_batch_id),
  CONSTRAINT fk_spb_user FOREIGN KEY (generated_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_spb_supersedes FOREIGN KEY (supersedes_batch_id) REFERENCES staff_payroll_batches (staff_payroll_batch_id),
  CONSTRAINT fk_spb_finalized_by FOREIGN KEY (finalized_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_payroll (
  staff_payroll_id int NOT NULL AUTO_INCREMENT,
  staff_payroll_batch_id int NOT NULL,
  staff_id int NOT NULL,
  monthly_salary_snapshot decimal(10,2) DEFAULT NULL,
  working_days_in_period int DEFAULT NULL,
  present_days int DEFAULT NULL,
  paid_leave_days int DEFAULT NULL,
  management_paid_days int DEFAULT NULL,
  unpaid_absence_days int DEFAULT NULL,
  overtime_hours decimal(7,2) DEFAULT NULL,
  daily_rate decimal(10,2) DEFAULT NULL,
  net_salary decimal(10,2) DEFAULT NULL,
  required_hours decimal(7,2) DEFAULT NULL,
  ot_earned_hours decimal(7,2) DEFAULT NULL,
  ot_used_hours decimal(7,2) DEFAULT NULL,
  ot_remaining_hours decimal(7,2) DEFAULT NULL,
  shortage_hours decimal(7,2) DEFAULT NULL,
  salary_deduction_amount decimal(10,2) DEFAULT NULL,
  employed_from date DEFAULT NULL,
  employed_to date DEFAULT NULL,
  prorated_base_salary decimal(10,2) DEFAULT NULL,
  period_required_hours decimal(7,2) DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (staff_payroll_id),
  KEY fk_sp_batch (staff_payroll_batch_id),
  KEY fk_sp_staff (staff_id),
  CONSTRAINT fk_sp_batch FOREIGN KEY (staff_payroll_batch_id) REFERENCES staff_payroll_batches (staff_payroll_batch_id),
  CONSTRAINT fk_sp_staff FOREIGN KEY (staff_id) REFERENCES staff_members (staff_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_monthly_overtime_ledger (
  ledger_id int NOT NULL AUTO_INCREMENT,
  staff_id int NOT NULL,
  payroll_month char(7) NOT NULL,
  required_hours decimal(7,2) DEFAULT NULL,
  actual_regular_hours decimal(7,2) DEFAULT NULL,
  ot_earned_hours decimal(7,2) DEFAULT NULL,
  ot_used_hours decimal(7,2) DEFAULT NULL,
  ot_remaining_hours decimal(7,2) DEFAULT NULL,
  shortage_hours decimal(7,2) DEFAULT NULL,
  uncovered_shortage_hours decimal(7,2) DEFAULT NULL,
  hourly_rate_snapshot decimal(10,2) DEFAULT NULL,
  salary_deduction_amount decimal(10,2) DEFAULT NULL,
  staff_payroll_batch_id int DEFAULT NULL,
  PRIMARY KEY (ledger_id),
  UNIQUE KEY uq_staff_month (staff_id,payroll_month),
  CONSTRAINT fk_smol_staff FOREIGN KEY (staff_id) REFERENCES staff_members (staff_id),
  CONSTRAINT fk_smol_batch FOREIGN KEY (staff_payroll_batch_id) REFERENCES staff_payroll_batches (staff_payroll_batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_overtime_compensations (
  compensation_id int NOT NULL AUTO_INCREMENT,
  staff_id int NOT NULL,
  target_attendance_id int DEFAULT NULL,
  payroll_month char(7) DEFAULT NULL,
  shortfall_hours_snapshot decimal(5,2) DEFAULT NULL,
  hours_used decimal(5,2) DEFAULT NULL,
  reason varchar(500) DEFAULT NULL,
  created_by_user_id int DEFAULT NULL,
  reversed_by_user_id int DEFAULT NULL,
  reversed_at datetime DEFAULT NULL,
  reversal_reason varchar(500) DEFAULT NULL,
  is_reversed tinyint(1) NOT NULL DEFAULT '0',
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (compensation_id),
  CONSTRAINT fk_soc_staff FOREIGN KEY (staff_id) REFERENCES staff_members (staff_id),
  CONSTRAINT fk_soc_attendance FOREIGN KEY (target_attendance_id) REFERENCES staff_attendance (staff_attendance_id),
  CONSTRAINT fk_soc_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_soc_reversed_by FOREIGN KEY (reversed_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE attendance_device_users (
  id int NOT NULL AUTO_INCREMENT,
  device_employee_id varchar(20) NOT NULL,
  entity_type enum('Staff','Worker') NOT NULL,
  staff_id int DEFAULT NULL,
  worker_id int DEFAULT NULL,
  effective_from date NOT NULL,
  effective_to date DEFAULT NULL,
  active tinyint(1) NOT NULL DEFAULT '1',
  created_by_user_id int DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_adu_lookup (device_employee_id,effective_from),
  KEY idx_adu_staff (staff_id),
  KEY idx_adu_worker (worker_id),
  CONSTRAINT fk_adu_staff FOREIGN KEY (staff_id) REFERENCES staff_members (staff_id),
  CONSTRAINT fk_adu_worker FOREIGN KEY (worker_id) REFERENCES workers (worker_id),
  CONSTRAINT chk_adu_dates CHECK (((effective_to IS NULL) OR (effective_to >= effective_from))),
  CONSTRAINT chk_adu_entity CHECK ((((entity_type = _utf8mb4'Staff') AND (staff_id IS NOT NULL) AND (worker_id IS NULL)) OR ((entity_type = _utf8mb4'Worker') AND (worker_id IS NOT NULL) AND (staff_id IS NULL))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE attendance_import_batches (
  id int NOT NULL AUTO_INCREMENT,
  source_file varchar(255) NOT NULL,
  checksum char(64) NOT NULL,
  status enum('Pending','Completed','CompletedWithErrors','Failed') NOT NULL DEFAULT 'Pending',
  total_rows int NOT NULL DEFAULT '0',
  inserted_rows int NOT NULL DEFAULT '0',
  duplicate_rows int NOT NULL DEFAULT '0',
  error_rows int NOT NULL DEFAULT '0',
  error_details json DEFAULT NULL,
  imported_at datetime DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_aib_checksum (checksum)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE attendance_punches (
  id bigint NOT NULL AUTO_INCREMENT,
  batch_id int NOT NULL,
  device_employee_id varchar(20) NOT NULL,
  punched_at datetime NOT NULL,
  raw_punch_code varchar(10) NOT NULL,
  punch_type enum('IN','OUT') NOT NULL,
  raw_line varchar(500) NOT NULL,
  line_number int DEFAULT NULL,
  dedupe_key char(64) NOT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_punch_dedupe (dedupe_key),
  KEY idx_punch_emp_time (device_employee_id,punched_at),
  KEY idx_punch_batch (batch_id),
  CONSTRAINT fk_punch_batch FOREIGN KEY (batch_id) REFERENCES attendance_import_batches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE attendance_punch_processing (
  id bigint NOT NULL AUTO_INCREMENT,
  punch_id bigint NOT NULL,
  processing_status enum('Pending','Processed','Skipped','Failed','NeedsReview','Invalid','Dismissed') NOT NULL DEFAULT 'Pending',
  processing_result varchar(100) DEFAULT NULL,
  processing_error text,
  attempts int NOT NULL DEFAULT '0',
  processed_at datetime DEFAULT NULL,
  processed_by_user_id int DEFAULT NULL,
  mapping_id int DEFAULT NULL,
  target_table enum('attendance','staff_attendance') DEFAULT NULL,
  target_record_id int DEFAULT NULL,
  resolved_at datetime DEFAULT NULL,
  resolved_by_user_id int DEFAULT NULL,
  resolution_note varchar(500) DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_app_punch_id (punch_id),
  KEY idx_app_status (processing_status),
  KEY idx_app_processed_by (processed_by_user_id),
  KEY idx_app_target (target_table,target_record_id),
  KEY idx_app_mapping (mapping_id),
  CONSTRAINT fk_app_processed_by FOREIGN KEY (processed_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_app_punch FOREIGN KEY (punch_id) REFERENCES attendance_punches (id),
  CONSTRAINT fk_app_mapping FOREIGN KEY (mapping_id) REFERENCES attendance_device_users (id),
  CONSTRAINT fk_app_resolved_by FOREIGN KEY (resolved_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

SET FOREIGN_KEY_CHECKS = 1;
