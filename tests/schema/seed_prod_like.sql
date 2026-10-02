-- Synthetic data shaped like production BEFORE the 2026-10 migration
-- (sites 8 / 9 / 10 as described in the requirements). Test use only.
SET FOREIGN_KEY_CHECKS = 0;
INSERT INTO users (user_id, username, password_hash, email, full_name, role, status) VALUES
 (1, 'admin', '$2b$10$abcdefghijklmnopqrstuuG0Jx2c6xH8y8K5m0n6Q4uXgk1Gm3e7W', 'admin@x.test', 'Admin', 'Admin', 'Active'),
 (11, 'sup_day', 'x', 'd@x.test', 'Day Supervisor', 'Supervisor', 'Active'),
 (12, 'sup_bridges', 'x', 'b@x.test', 'Bridges Supervisor', 'Supervisor', 'Active'),
 (13, 'sup_night', 'x', 'n@x.test', 'Night Supervisor', 'Supervisor', 'Active'),
 (14, 'staff_sup', 'x', 's@x.test', 'Staff Supervisor', 'StaffSupervisor', 'Active');
INSERT INTO projects (project_id, project_name) VALUES (1, 'Airport');
INSERT INTO contracts (contract_id, contract_name, project_id, hourly_rate, overtime_hourly_rate, admin_id) VALUES (7, 'Contract 7', 1, 10, 15, 1);
INSERT INTO sites (site_id, site_name, site_status, contract_id, supervisor_id, supports_shifts) VALUES
 (8, 'T2-day shift', 'Active', 7, 11, 0),
 (9, 'T2-night shift', 'Active', 7, 13, 0),
 (10, 'Bridges', 'Active', 7, 12, 0);
INSERT INTO workers (worker_id, worker_unique_id, full_name, status, payment_type, daily_rate, hire_date, mothers_name, birth_date, id_photo) VALUES
 (1, 'W-1', 'Day Worker', 'Active', 'Daily', 100000, '2026-01-01', 'Mother A', '1990-01-01', 'uploads/id_photo-1.png'),
 (2, 'W-2', 'Night Worker', 'Active', 'Daily', 100000, '2026-01-01', 'Mother B', '1991-01-01', NULL),
 (3, 'W-3', 'Bridges Worker', 'Active', 'Daily', 90000, '2026-01-01', NULL, NULL, NULL),
 (4, 'W-4', 'Moved Worker', 'Active', 'Daily', 90000, '2026-01-01', NULL, NULL, NULL);
INSERT INTO workercompensationhistory (worker_id, payment_type, daily_rate, effective_from, reason) VALUES
 (1, 'Daily', 100000, '2026-01-01', 'hire'), (2, 'Daily', 100000, '2026-01-01', 'hire'),
 (3, 'Daily', 90000, '2026-01-01', 'hire'), (4, 'Daily', 90000, '2026-01-01', 'hire');
-- Assignments (exclusive end meaning, as stored today)
INSERT INTO workersiteassignments (assignment_id, worker_id, site_id, contract_id, assigned_date, unassigned_date, shift_type) VALUES
 (1, 1, 8, 7, '2026-08-01', NULL, 'Day'),
 (2, 2, 9, 7, '2026-08-01', NULL, 'Day'),
 (3, 3, 10, 7, '2026-08-01', NULL, 'Day'),
 (4, 4, 10, 7, '2026-08-01', '2026-09-10', 'Day'),   -- last day 2026-09-09
 (5, 4, 8, 7, '2026-09-10', NULL, 'Day'),
 (6, 3, 8, 7, '2026-07-01', '2026-07-01', 'Day');    -- zero-day assignment (cancelled)
INSERT INTO attendance (attendance_id, worker_id, site_id, shift_type, record_date, check_in_time, check_out_time, attendance_status, total_working_hours, overtime_hours, recorded_by_user_id, status, standard_minutes_snapshot) VALUES
 (1, 2, 9, 'Day', '2026-09-01', '2026-09-01 19:00:00', '2026-09-02 05:00:00', 'Present', 10, 0, 13, 'Approved', 600),
 (2, 2, 9, 'Day', '2026-09-02', '2026-09-02 19:00:00', '2026-09-03 06:00:00', 'Present', 10, 1, 13, 'Approved', 600),
 (3, 1, 8, 'Day', '2026-09-01', '2026-09-01 07:00:00', '2026-09-01 17:00:00', 'Present', 10, 0, 11, 'Approved', 600);
INSERT INTO payrollbatches (payroll_batch_id, start_date, end_date, generated_by_user_id, total_workers, total_amount, status, is_finalized) VALUES
 (1, '2026-09-01', '2026-09-02', 1, 2, 300150, 'Paid', 1);
INSERT INTO payroll (payroll_id, payroll_batch_id, worker_id, start_date, end_date, gross_salary, net_salary, status, generated_by_user_id) VALUES
 (1, 1, 2, '2026-09-01', '2026-09-02', 200150, 200150, 'Paid', 1),
 (2, 1, 1, '2026-09-01', '2026-09-02', 100000, 100000, 'Paid', 1);
INSERT INTO payrollitems (payroll_item_id, payroll_id, contract_id, site_id, pay_type, daily_rate_snapshot, overtime_hourly_rate_snapshot, days_worked, overtime_hours_worked, base_salary, overtime_pay) VALUES
 (1, 1, 7, 9, 'Daily', 100000, 150, 2, 1, 200000, 150),
 (2, 2, 7, 8, 'Daily', 100000, NULL, 1, 0, 100000, 0);
INSERT INTO worker_transfer_requests (worker_id, current_site_id, target_site_id, requested_by_user_id, status, admin_notes, effective_date) VALUES
 (4, 10, 8, 12, 'Approved', 'ok', '2026-09-10');
INSERT INTO staff_members (staff_id, staff_unique_id, full_name, position, site_id, hire_date, first_hire_date, monthly_salary, standard_daily_hours, status) VALUES
 (1, 'S-1', 'Engineer One', 'Engineer', 9, '2026-08-01', '2026-08-01', 1000, 8, 'Active');
INSERT INTO staff_status_history (staff_id, old_status, new_status, effective_date, reason) VALUES (1, NULL, 'Active', '2026-08-01', 'hire');
INSERT INTO staff_site_assignments (staff_id, site_id, assigned_date, unassigned_date) VALUES (1, 10, '2026-08-01', '2026-08-15'), (1, 9, '2026-08-15', NULL);
INSERT INTO staff_supervisor_assignments (staff_id, supervisor_user_id, assigned_date) VALUES (1, 14, '2026-08-01');
INSERT INTO system_settings (setting_key, setting_value) VALUES ('is_lunch_paid', 'false'), ('standard_work_minutes', '600');
SET FOREIGN_KEY_CHECKS = 1;
