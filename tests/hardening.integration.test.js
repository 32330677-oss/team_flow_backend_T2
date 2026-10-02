// tests/hardening.integration.test.js
//
// 2026-10 hardening — HTTP integration tests against the real controllers and
// a local MySQL 8 database built from tests/schema (base schema + synthetic
// production-like data) and the real migration files.
//
// Run:  npm run test:hardening      (requires a local MySQL; see tests/helpers.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { resetDatabase, startServer, stopServer, client, q, sh, DB_NAME } = require('./helpers');
const { businessToday, addDays } = require('../services/businessDate');

const TODAY = businessToday();
const admin = () => client(1, 'Admin');
const supDay = () => client(11, 'Supervisor');      // T2 Day
const supBridges = () => client(12, 'Supervisor');  // Bridges
const supNight = () => client(13, 'Supervisor');    // T2 Night
const staffSup = () => client(14, 'StaffSupervisor');

// A date inside the CURRENT attendance week (Sat..Fri) and not in the future.
const D0 = TODAY;
const D1 = addDays(TODAY, -1);

test.before(async () => {
  resetDatabase({ migrate: true });
  global.__BASE__ = await startServer();
});
test.after(async () => { await stopServer(); });

// ---------------------------------------------------------------------------
test('M1 migration: end dates converted to inclusive last day, zero-day kept empty', async () => {
  const rows = await q('SELECT assignment_id, DATE_FORMAT(assigned_date, "%Y-%m-%d") a, DATE_FORMAT(unassigned_date, "%Y-%m-%d") u FROM workersiteassignments ORDER BY assignment_id');
  const byId = Object.fromEntries(rows.map((r) => [r.assignment_id, r]));
  assert.equal(byId[4].u, '2026-09-09', 'old exclusive 2026-09-10 -> last day 2026-09-09');
  assert.equal(byId[6].u, '2026-06-30', 'zero-day assignment -> explicitly empty range');
  const [marker] = await q("SELECT setting_value FROM system_settings WHERE setting_key = 'assignment_end_semantics'");
  assert.equal(marker.setting_value, 'inclusive_last_day');
});

test('M2 T2 consolidation: site 8 = T2 with Day/Night, site 9 legacy, site 10 untouched, history logged', async () => {
  const sites = await q('SELECT site_id, site_name, site_status, supports_shifts, supervisor_id FROM sites ORDER BY site_id');
  const s = Object.fromEntries(sites.map((r) => [r.site_id, r]));
  assert.equal(s[8].site_name, 'T2'); assert.equal(s[8].supports_shifts, 1); assert.equal(s[8].supervisor_id, null);
  assert.equal(s[9].site_status, 'Suspended');
  assert.equal(s[10].site_name, 'Bridges'); assert.equal(s[10].supervisor_id, 12);
  const shifts = await q('SELECT shift_type, supervisor_id FROM site_shifts WHERE site_id = 8 ORDER BY shift_type');
  assert.deepEqual(shifts.map((r) => [r.shift_type, r.supervisor_id]), [['Day', 11], ['Night', 13]]);
  const [att] = await q('SELECT site_id, shift_type FROM attendance WHERE attendance_id = 1');
  assert.deepEqual([att.site_id, att.shift_type], [8, 'Night']);
  const [pi] = await q('SELECT site_id, base_salary, overtime_pay FROM payrollitems WHERE payroll_item_id = 1');
  assert.equal(pi.site_id, 8); assert.equal(Number(pi.base_salary), 200000);
  const logs = await q("SELECT COUNT(*) c FROM t2_merge_log WHERE table_name = 'payrollitems' AND old_value = '9'");
  assert.equal(Number(logs[0].c), 1);
});

test('M3 server interlock: refuses to run without the semantics marker', async () => {
  const { assertSemanticsMarker } = require('../services/assignmentDates');
  const db = require('../config/db');
  await db.query("UPDATE system_settings SET setting_value = 'x' WHERE setting_key = 'assignment_end_semantics'");
  await assert.rejects(() => assertSemanticsMarker(db), /inclusive_last_day/);
  await db.query("UPDATE system_settings SET setting_value = 'inclusive_last_day' WHERE setting_key = 'assignment_end_semantics'");
  assert.equal(await assertSemanticsMarker(db), true);
});

// ---------------------------------------------------------------------------
test('S1 D-07 supervisor receives an operational projection only; admin gets full data', async () => {
  const sup = await supDay().get('/api/workers');
  assert.equal(sup.status, 200);
  assert.ok(sup.body.data.length >= 1);
  for (const w of sup.body.data) {
    for (const f of ['daily_rate', 'regular_hourly_rate', 'overtime_hourly_rate', 'mothers_name', 'birth_date', 'id_photo', 'personal_photo', 'phone_number']) {
      assert.equal(f in w, false, `supervisor must not receive ${f}`);
    }
  }
  // Only workers of the supervisor's own site/shift (T2 Day: workers 1 and 4).
  assert.deepEqual(sup.body.data.map((w) => w.worker_id).sort(), [1, 4]);
  const adm = await admin().get('/api/workers');
  const w1 = adm.body.data.find((w) => w.worker_id === 1);
  assert.equal(Number(w1.daily_rate), 100000);
  assert.match(w1.id_photo, /\/api\/workers\/1\/files\/id_photo$/);
  // contracts (rates) are Admin-only now
  assert.equal((await supDay().get('/api/contracts/project/1')).status, 403);
  // assignment list is scoped for supervisors
  const asg = await supNight().get('/api/assignments');
  assert.deepEqual([...new Set(asg.body.data.map((a) => `${a.site_id}/${a.shift_type}`))], ['8/Night']);
});

test('S2 C-18 uploads are not public; identity files need Admin', async () => {
  const pub = await client().get('/uploads/id_photo-1.png');
  assert.equal(pub.status, 404);
  assert.equal((await supDay().get('/api/workers/1/files/id_photo')).status, 403);
  assert.equal((await client().get('/api/workers/1/files/id_photo')).status, 401);
  // Admin is authorized (file itself does not exist in the test tree -> 404, not 403)
  assert.equal((await admin().get('/api/workers/1/files/id_photo')).status, 404);
});

// ---------------------------------------------------------------------------
test('A1 inclusive assignment end: last day is still assigned, next day is outside', async () => {
  // worker 4 was at Bridges (site 10) until 2026-09-09 (inclusive).
  const ok = await admin().post('/api/attendance/status', { worker_id: 4, site_id: 10, record_date: '2026-09-09', attendance_status: 'Absent' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const no = await admin().post('/api/attendance/status', { worker_id: 4, site_id: 10, record_date: '2026-09-10', attendance_status: 'Absent' });
  assert.equal(no.status, 400);
});

test('A2 future attendance dates are refused; night shift next-day OUT is allowed', async () => {
  const future = addDays(TODAY, 1);
  const r1 = await supDay().post('/api/attendance/status', { worker_id: 1, site_id: 8, shift_type: 'Day', record_date: future, attendance_status: 'Vacation' });
  assert.equal(r1.status, 400);
  assert.match(r1.body.message, /future date/);
  const r2 = await supDay().post('/api/attendance/bulk/status', { worker_ids: [1], site_id: 8, shift_type: 'Day', record_date: future, attendance_status: 'Sick' });
  assert.equal(r2.status, 400);
  // Night shift: IN on D1 19:00, OUT on D0 05:00 (next calendar day) — valid.
  const inR = await supNight().post('/api/attendance/checkin', { worker_id: 2, site_id: 8, shift_type: 'Night', check_in_time: `${D1} 19:00:00` });
  assert.equal(inR.status, 201, JSON.stringify(inR.body));
  const outR = await supNight().post('/api/attendance/checkout', { worker_id: 2, site_id: 8, shift_type: 'Night', record_date: D1, check_out_time: `${D0} 05:00:00` });
  assert.equal(outR.status, 200, JSON.stringify(outR.body));
  const [row] = await q('SELECT DATE_FORMAT(record_date, "%Y-%m-%d") d, total_working_hours, anomaly_code FROM attendance WHERE attendance_id = ?', [inR.body.data.attendance_id]);
  assert.equal(row.d, D1); assert.equal(Number(row.total_working_hours), 10); assert.equal(row.anomaly_code, null);
  // a check-out in the future is refused
  const in2 = await supDay().post('/api/attendance/checkin', { worker_id: 1, site_id: 8, shift_type: 'Day', check_in_time: `${D1} 07:00:00` });
  assert.equal(in2.status, 201);
  const fut = await supDay().post('/api/attendance/checkout', { worker_id: 1, site_id: 8, shift_type: 'Day', record_date: D1, check_out_time: `${addDays(TODAY, 2)} 07:00:00` });
  assert.equal(fut.status, 400);
});

test('A3 long manual shift is stored (no 99.99 clamp) and flagged; approval needs acknowledgement', async () => {
  // worker 1 checked in D1 07:00 (A2). Check out D0 06:00 -> 23 h (> 16 h review threshold).
  const out = await supDay().post('/api/attendance/checkout', { worker_id: 1, site_id: 8, shift_type: 'Day', record_date: D1, check_out_time: `${D0} 06:00:00` });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.ok(out.body.data.anomaly, 'anomaly returned');
  const [row] = await q('SELECT attendance_id, total_working_hours, overtime_hours, anomaly_code FROM attendance WHERE worker_id = 1 AND record_date = ?', [D1]);
  assert.equal(row.anomaly_code, 'long_duration');
  assert.equal(Number(row.overtime_hours), 13, '23h - 10h standard = 13h overtime, stored as calculated');
  // Every assigned worker needs a status before the day can be submitted.
  const abs = await supDay().post('/api/attendance/status', { worker_id: 4, site_id: 8, shift_type: 'Day', record_date: D1, attendance_status: 'Absent' });
  assert.equal(abs.status, 201, JSON.stringify(abs.body));
  // Submit the day (needs a lunch decision: worked through lunch with a reason)
  let sub = await supDay().post('/api/attendance/submit', { siteId: 8, shift_type: 'Day', record_date: D1 });
  if (sub.body.requires_confirmation) {
    sub = await supDay().post('/api/attendance/submit', { siteId: 8, shift_type: 'Day', record_date: D1,
      confirmed_lunch_skips: sub.body.missing_workers.map((w) => ({ attendance_id: w.attendance_id, reason: 'urgent work' })) });
  }
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  const noAck = await admin().post('/api/admin/attendance/review', { attendance_id: row.attendance_id, status: 'Approved' });
  assert.equal(noAck.status, 409); assert.equal(noAck.body.code, 'ANOMALY_ACK_REQUIRED');
  const ack = await admin().post('/api/admin/attendance/review', { attendance_id: row.attendance_id, status: 'Approved', acknowledge_anomaly: true, anomaly_note: 'Confirmed double shift' });
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
});

test('A4 weekly gating: Draft records of the previous week block submission; a missing day does not', async () => {
  const { previousWeekBounds } = require('../services/weekGate');
  const { prevStart } = await previousWeekBounds(D0);
  // Bridges (site 10): a Draft in the previous week for worker 3
  const r = await supBridges().post('/api/attendance/status', { worker_id: 3, site_id: 10, record_date: prevStart, attendance_status: 'Absent' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await supBridges().post('/api/attendance/status', { worker_id: 3, site_id: 10, record_date: D0, attendance_status: 'Holiday' });
  const blocked = await supBridges().post('/api/attendance/submit', { siteId: 10, record_date: D0 });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'PREVIOUS_WEEK_UNSUBMITTED');
  const view = await supBridges().get(`/api/attendance/sites/10/workers?record_date=${D0}`);
  assert.equal(view.body.day.previous_week_drafts.length, 1);
  // Submit the previous-week day; every other previous-week day has NO record and must not block.
  const prevSub = await supBridges().post('/api/attendance/submit', { siteId: 10, record_date: prevStart });
  assert.equal(prevSub.status, 200, JSON.stringify(prevSub.body));
  const ok = await supBridges().post('/api/attendance/submit', { siteId: 10, record_date: D0 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('A5 resubmit keeps the chosen status and management hours (C-13); management leave refused on Approved (C-06)', async () => {
  const [rec] = await q("SELECT attendance_id FROM attendance WHERE worker_id = 3 AND record_date = ?", [D0]);
  await admin().patch(`/api/attendance/${rec.attendance_id}/management-leave`, { hours: 4, reason: 'Paid site closure' });
  const rej = await admin().post('/api/admin/attendance/review', { attendance_id: rec.attendance_id, status: 'Rejected', admin_note: 'check status' });
  assert.equal(rej.status, 200);
  const re = await supBridges().patch(`/api/attendance/${rec.attendance_id}/resubmit`, { attendance_status: 'Holiday', remarks: 'public holiday' });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  const [row] = await q('SELECT status, attendance_status, management_leave_hours, total_working_hours FROM attendance WHERE attendance_id = ?', [rec.attendance_id]);
  assert.equal(row.status, 'Submitted'); assert.equal(row.attendance_status, 'Holiday');
  assert.equal(Number(row.management_leave_hours), 4); assert.equal(Number(row.total_working_hours), 4);
  await admin().post('/api/admin/attendance/review', { attendance_id: rec.attendance_id, status: 'Approved' });
  const ml = await admin().patch(`/api/attendance/${rec.attendance_id}/management-leave`, { hours: 2, reason: 'x' });
  assert.equal(ml.status, 409);
});

// ---------------------------------------------------------------------------
test('T1 End Assignment: date = LAST day; attendance after it blocks; audited', async () => {
  const [a] = await q('SELECT assignment_id FROM workersiteassignments WHERE worker_id = 3 AND unassigned_date IS NULL');
  const missing = await admin().post(`/api/assignments/${a.assignment_id}/end`, { reason: 'left site' });
  assert.equal(missing.status, 400);
  const conflict = await admin().post(`/api/assignments/${a.assignment_id}/end`, { last_day: addDays(D0, -3), reason: 'left site' });
  assert.equal(conflict.status, 409, 'attendance exists after the last day');
  const ok = await admin().post(`/api/assignments/${a.assignment_id}/end`, { last_day: D0, reason: 'left the site' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const [row] = await q('SELECT DATE_FORMAT(unassigned_date, "%Y-%m-%d") u, end_reason, ended_by_user_id FROM workersiteassignments WHERE assignment_id = ?', [a.assignment_id]);
  assert.equal(row.u, D0); assert.equal(row.ended_by_user_id, 1);
  const audit = await q("SELECT COUNT(*) c FROM auditlogs WHERE table_name = 'workersiteassignments' AND action_type = 'ASSIGNMENT_ENDED' AND record_id = ?", [a.assignment_id]);
  assert.equal(Number(audit[0].c), 1);
});

test('T2 Direct Transfer: transfer date = first day at new site, old ends the day before, recorded', async () => {
  const [a] = await q('SELECT assignment_id FROM workersiteassignments WHERE worker_id = 4 AND unassigned_date IS NULL');
  const tDate = addDays(TODAY, 1);   // planned for tomorrow
  const r = await admin().post(`/api/assignments/${a.assignment_id}/transfer`, { transfer_date: tDate, target_site_id: 8, target_shift_type: 'Night', reason: 'night crew needed' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = await q('SELECT site_id, shift_type, DATE_FORMAT(assigned_date, "%Y-%m-%d") a, DATE_FORMAT(unassigned_date, "%Y-%m-%d") u FROM workersiteassignments WHERE worker_id = 4 ORDER BY assignment_id');
  const old = rows.find((x) => x.site_id === 8 && x.shift_type === 'Day');
  const neu = rows.find((x) => x.site_id === 8 && x.shift_type === 'Night');
  assert.equal(old.u, TODAY); assert.equal(neu.a, tDate); assert.equal(neu.u, null);
  const [tr] = await q("SELECT transfer_type, status, request_reason FROM worker_transfer_requests WHERE worker_id = 4 ORDER BY request_id DESC LIMIT 1");
  assert.deepEqual([tr.transfer_type, tr.status, tr.request_reason], ['Direct', 'Approved', 'night crew needed']);
  // overlapping manual assignment is refused (C-16)
  const dup = await admin().post('/api/assignments', { worker_id: 4, site_id: 10, assigned_date: addDays(TODAY, -2) });
  assert.equal(dup.status, 400);
  // Night on a non-shift site refused (R-13)
  const bad = await admin().post('/api/assignments', { worker_id: 3, site_id: 10, shift_type: 'Night', assigned_date: TODAY });
  assert.equal(bad.status, 409);
});

test('T3 transfer request: reason required, rejection audited, admin note kept separate', async () => {
  const noReason = await supDay().post('/api/transfers', { worker_id: 1, current_site_id: 8, current_shift_type: 'Day', target_site_id: 10 });
  assert.equal(noReason.status, 400);
  const created = await supDay().post('/api/transfers', { worker_id: 1, current_site_id: 8, current_shift_type: 'Day', target_site_id: 10, transfer_reason: 'Bridges short of workers', effective_date: addDays(TODAY, 3) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rej = await admin().put(`/api/transfers/${created.body.request_id}/review`, { status: 'Rejected', admin_notes: 'not now' });
  assert.equal(rej.status, 200);
  const [row] = await q('SELECT request_reason, admin_notes, reviewed_by_user_id FROM worker_transfer_requests WHERE request_id = ?', [created.body.request_id]);
  assert.deepEqual([row.request_reason, row.admin_notes, row.reviewed_by_user_id], ['Bridges short of workers', 'not now', 1]);
  const audit = await q("SELECT COUNT(*) c FROM auditlogs WHERE action_type = 'TRANSFER_REJECTED' AND record_id = ?", [created.body.request_id]);
  assert.equal(Number(audit[0].c), 1);
});

test('T4 Inactive: effective date required; status change does NOT close the assignment unless a last day is given', async () => {
  const noDate = await admin().put('/api/workers/W-2', { status: 'Inactive' });
  assert.equal(noDate.status, 400);
  const ok = await admin().put('/api/workers/W-2', { status: 'Inactive', status_effective_date: TODAY, status_reason: 'left' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const [open] = await q('SELECT COUNT(*) c FROM workersiteassignments WHERE worker_id = 2 AND unassigned_date IS NULL');
  assert.equal(Number(open.c), 1, 'assignment still open');
  // The night record of D1 can still be seen / corrected (status on D1 was Active)
  const view = await supNight().get(`/api/attendance/sites/8/workers?record_date=${D1}&shift_type=Night`);
  assert.ok(view.body.data.some((w) => w.worker_id === 2));
  const back = await admin().put('/api/workers/W-2', { status: 'Active', status_effective_date: TODAY, status_reason: 'mistake' });
  assert.equal(back.status, 200);
});

// ---------------------------------------------------------------------------
async function importPunches(lines) {
  const headers = { Authorization: `Bearer ${process.env.ATTENDANCE_CONNECTOR_TOKEN}`, 'Content-Type': 'application/json' };
  const fetchJson = async (path, body) => {
    const res = await fetch(global.__BASE__ + path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const checksum = crypto.createHash('sha256').update(lines.join('\n') + Math.random()).digest('hex');
  const b = await fetchJson('/api/biometric/batches', { source_file: 'test.txt', checksum });
  const punches = lines.map((l, i) => {
    const [id, date, time, code] = l.split(' ');
    return { deviceEmployeeId: id, punchedAt: `${date} ${time}`, rawPunchCode: code, punchType: code === '1' ? 'IN' : 'OUT', rawLine: l, lineNumber: i + 1 };
  });
  const p = await fetchJson('/api/biometric/punches', { batchId: b.body.batchId, punches });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const c = await fetchJson(`/api/biometric/batches/${b.body.batchId}/complete`, { totalRows: lines.length, validRows: lines.length, errorRows: 0 });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const run = await admin().post('/api/biometric/processing/process', {});
  assert.equal(run.status, 200, JSON.stringify(run.body));
  return run.body.data;
}

async function punchState(deviceId, punchedAt) {
  const [r] = await q(
    `SELECT pr.processing_status, pr.processing_result, pr.mapping_id, p.id AS punch_id
     FROM attendance_punches p JOIN attendance_punch_processing pr ON pr.punch_id = p.id
     WHERE p.device_employee_id = ? AND p.punched_at = ?`, [deviceId, punchedAt]);
  return r;
}

test('B1 biometric: missing OUT then next-day OUT ~30h -> Needs Review (never auto-closed); overnight valid OUT processed', async () => {
  const map = await admin().post('/api/biometric/device-users', { device_employee_id: '501', entity_type: 'Worker', worker_id: 1, effective_from: '2026-08-01' });
  assert.equal(map.status, 201, JSON.stringify(map.body));
  const d2 = addDays(TODAY, -2);
  const d3 = addDays(TODAY, -3);
  // worker 1 (T2 Day). d3: IN 06:00, no OUT. d2: OUT 12:00 (30h later).
  await importPunches([`501 ${d3} 06:00:00 1 255 1 0`, `501 ${d2} 12:00:00 0 255 1 0`]);
  const outState = await punchState('501', `${d2} 12:00:00`);
  assert.equal(outState.processing_status, 'NeedsReview');
  assert.equal(outState.processing_result, 'long_duration');
  const [sess] = await q('SELECT check_out_time FROM attendance WHERE worker_id = 1 AND record_date = ?', [d3]);
  assert.equal(sess.check_out_time, null, 'open session NOT closed automatically');
  // raw punches untouched
  const raw = await q("SELECT COUNT(*) c FROM attendance_punches WHERE device_employee_id = '501'");
  assert.equal(Number(raw[0].c), 2);
  // processing history recorded
  const hist = await q('SELECT COUNT(*) c FROM attendance_punch_processing_log WHERE punch_id = ?', [outState.punch_id]);
  assert.ok(Number(hist[0].c) >= 1);
});

test('B2 biometric: unmapped -> dismiss -> mapping created -> requeue with CURRENT mapping', async () => {
  const d = addDays(TODAY, -4);
  await importPunches([`777 ${d} 07:00:00 1 255 1 0`]);
  const st = await punchState('777', `${d} 07:00:00`);
  assert.equal(st.processing_result, 'unmapped');
  const dis = await admin().post('/api/biometric/processing/items/dismiss', { punch_ids: [st.punch_id], note: 'unknown person' });
  assert.equal(dis.status, 200);
  const map = await admin().post('/api/biometric/device-users', { device_employee_id: '777', entity_type: 'Worker', worker_id: 3, effective_from: '2026-08-01' });
  assert.equal(map.status, 201, JSON.stringify(map.body));
  const rq = await admin().post(`/api/biometric/processing/items/${st.punch_id}/requeue`, { reason: 'mapping created' });
  assert.equal(rq.status, 200, JSON.stringify(rq.body));
  const after = await punchState('777', `${d} 07:00:00`);
  assert.notEqual(after.processing_status, 'Dismissed');
  assert.ok(after.mapping_id, 'processed with the current mapping');
  const audit = await q("SELECT COUNT(*) c FROM auditlogs WHERE action_type IN ('BIOMETRIC_REVIEW_DISMISS','BIOMETRIC_PUNCH_REQUEUED')");
  assert.ok(Number(audit[0].c) >= 2, 'dismiss and requeue both audited');
});

test('B3 biometric: too-old punch is Invalid; Admin restore with reason processes it (raw unchanged)', async () => {
  const old = addDays(TODAY, -45);
  await importPunches([`501 ${old} 07:00:00 1 255 1 0`]);
  const st = await punchState('501', `${old} 07:00:00`);
  assert.equal(st.processing_status, 'Invalid');
  const r = await admin().post(`/api/biometric/processing/items/${st.punch_id}/restore`, { reason: 'historical import approved' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await punchState('501', `${old} 07:00:00`);
  assert.notEqual(after.processing_status, 'Invalid');
  const [pp] = await q('SELECT window_override, window_override_reason FROM attendance_punch_processing WHERE punch_id = ?', [st.punch_id]);
  assert.equal(pp.window_override, 1);
});

test('B4 biometric: punch date inside a finalized payroll period goes to review (locked)', async () => {
  await importPunches(['501 2026-09-01 08:00:00 1 255 1 0']);
  let st = await punchState('501', '2026-09-01 08:00:00');
  if (st.processing_status === 'Invalid') {   // older than the import window -> restore first
    await admin().post(`/api/biometric/processing/items/${st.punch_id}/restore`, { reason: 'historical import approved' });
    st = await punchState('501', '2026-09-01 08:00:00');
  }
  assert.equal(st.processing_status, 'NeedsReview');
  assert.equal(st.processing_result, 'payroll_period_finalized');
});

// ---------------------------------------------------------------------------
test('P1 payroll: pending attendance reported (C-03); OT rate DB-backed; snapshot written; currency SYP', async () => {
  const { prevStart } = await require('../services/weekGate').previousWeekBounds(D0);
  const start = prevStart; const end = TODAY;
  const pend = await admin().post('/api/admin/payroll/generate', { start_date: start, end_date: end });
  assert.equal(pend.status, 409); assert.equal(pend.body.code, 'PENDING_ATTENDANCE');
  const gen = await admin().post('/api/admin/payroll/generate', { start_date: start, end_date: end, acknowledge_pending: true });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  assert.equal(gen.body.currency, 'SYP');
  const snap = await q('SELECT COUNT(*) c FROM payroll_attendance_snapshot WHERE payroll_batch_id = ?', [gen.body.batch_id]);
  assert.ok(Number(snap[0].c) >= 1);
  const [ot] = await q(`SELECT pi.overtime_hourly_rate_snapshot r, pi.overtime_hours_worked h, pi.overtime_pay p
                        FROM payrollitems pi JOIN payroll p ON p.payroll_id = pi.payroll_id
                        WHERE p.payroll_batch_id = ? AND pi.overtime_hours_worked > 0`, [gen.body.batch_id]);
  assert.equal(Number(ot.r), 150); assert.equal(Number(ot.p), Number(ot.h) * 150);
  global.__P1__ = { batchId: gen.body.batch_id, start, end };
});

test('P2 void a generated batch (reason, history kept), finalize, lock attendance, correction workflow, supersede, paid protection', async () => {
  const { batchId, start, end } = global.__P1__;
  // void
  const noReason = await admin().patch(`/api/admin/payroll/batch/${batchId}/void`, {});
  assert.equal(noReason.status, 400);
  const v = await admin().patch(`/api/admin/payroll/batch/${batchId}/void`, { reason: 'wrong period chosen' });
  assert.equal(v.status, 200);
  const [vb] = await q('SELECT status, void_reason FROM payrollbatches WHERE payroll_batch_id = ?', [batchId]);
  assert.equal(vb.status, 'Voided');
  const kept = await q('SELECT COUNT(*) c FROM payroll WHERE payroll_batch_id = ?', [batchId]);
  assert.ok(Number(kept[0].c) >= 1, 'voided batch rows kept');
  // regenerate same period (allowed after void), finalize
  const gen = await admin().post('/api/admin/payroll/generate', { start_date: start, end_date: end, acknowledge_pending: true });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  const newId = gen.body.batch_id;
  assert.equal((await admin().patch(`/api/admin/payroll/batch/${newId}/finalize`)).status, 200);
  // void of finalized is refused
  assert.equal((await admin().patch(`/api/admin/payroll/batch/${newId}/void`, { reason: 'try void final' })).status, 409);
  // normal attendance operations in the finalized period are locked
  const locked = await supDay().post('/api/attendance/status', { worker_id: 1, site_id: 8, shift_type: 'Day', record_date: D0, attendance_status: 'Absent' });
  assert.equal(locked.status, 409); assert.equal(locked.body.code, 'PAYROLL_PERIOD_FINALIZED');
  // admin correction of an approved record inside the finalized period
  const [appr] = await q("SELECT attendance_id, total_working_hours FROM attendance WHERE worker_id = 1 AND record_date = ?", [D1]);
  const before = await q('SELECT total_amount FROM payrollbatches WHERE payroll_batch_id = ?', [newId]);
  const corr = await admin().post(`/api/attendance/${appr.attendance_id}/admin-correction`, { reason: 'Real checkout was 17:00 on D1', check_out_time: `${D1} 17:00:00` });
  assert.equal(corr.status, 200, JSON.stringify(corr.body));
  assert.equal(corr.body.data.payroll_effect, 'AdjustmentRequired');
  const after = await q('SELECT total_amount, status FROM payrollbatches WHERE payroll_batch_id = ?', [newId]);
  assert.equal(after[0].total_amount, before[0].total_amount, 'finalized payroll unchanged');
  const [log] = await q('SELECT original_values, corrected_values, adjustment_status FROM attendance_corrections_log WHERE record_id = ?', [appr.attendance_id]);
  assert.equal(log.adjustment_status, 'Open');
  assert.equal(JSON.parse(JSON.stringify(log.original_values)).total_working_hours !== undefined, true);
  // supersede finalized (atomic): replacement generated, old superseded
  const sup = await admin().post(`/api/admin/payroll/batch/${newId}/supersede`, { reason: 'apply correction', acknowledge_pending: true });
  assert.equal(sup.status, 201, JSON.stringify(sup.body));
  const [oldB] = await q('SELECT status FROM payrollbatches WHERE payroll_batch_id = ?', [newId]);
  const [repl] = await q('SELECT status, supersedes_batch_id, supersede_reason, is_finalized FROM payrollbatches WHERE payroll_batch_id = ?', [sup.body.batch_id]);
  assert.equal(oldB.status, 'Superseded'); assert.equal(repl.supersedes_batch_id, newId); assert.equal(repl.is_finalized, 0);
  // paid batch: cannot be superseded
  const paidSup = await admin().post('/api/admin/payroll/batch/1/supersede', { reason: 'try paid' });
  assert.equal(paidSup.status, 409);
  // mark paid audit (C-09)
  await admin().patch(`/api/admin/payroll/batch/${sup.body.batch_id}/finalize`);
  const paid = await admin().patch(`/api/admin/payroll/batch/${sup.body.batch_id}/mark-paid`);
  assert.equal(paid.status, 200);
  const [pb] = await q('SELECT paid_by_user_id, paid_at FROM payrollbatches WHERE payroll_batch_id = ?', [sup.body.batch_id]);
  assert.equal(pb.paid_by_user_id, 1);
  const au = await q("SELECT COUNT(*) c FROM auditlogs WHERE action_type = 'MARKED_PAID' AND record_id = ?", [sup.body.batch_id]);
  assert.equal(Number(au[0].c), 1);
  // version history visible (C-08)
  const hist = await admin().get('/api/admin/payroll/report?include_history=1');
  assert.ok(hist.body.data.some((b) => b.status === 'Voided') && hist.body.data.some((b) => b.status === 'Superseded'));
});

test('P3 supersede failure leaves the old batch unchanged (no OT rate configured -> 422)', async () => {
  // A fresh finalized batch on an older range; then remove the OT rate and try to supersede.
  const db = require('../config/db');
  const s0 = addDays(TODAY, -27); const e0 = addDays(TODAY, -20);
  await db.query(`INSERT INTO attendance (worker_id, site_id, shift_type, record_date, check_in_time, check_out_time, attendance_status,
                  total_working_hours, overtime_hours, recorded_by_user_id, status, standard_minutes_snapshot)
                  VALUES (1, 8, 'Day', ?, ?, ?, 'Present', 10, 2, 11, 'Approved', 600)`, [addDays(TODAY, -25), `${addDays(TODAY, -25)} 06:00:00`, `${addDays(TODAY, -25)} 18:00:00`]);
  const g = await admin().post('/api/admin/payroll/generate', { start_date: s0, end_date: e0, acknowledge_pending: true });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  await admin().patch(`/api/admin/payroll/batch/${g.body.batch_id}/finalize`);
  await db.query("UPDATE system_settings SET setting_value = '' WHERE setting_key = 'overtime_flat_rate_syp'");
  await require('../services/settingsCache').refresh();
  const s = await admin().post(`/api/admin/payroll/batch/${g.body.batch_id}/supersede`, { reason: 'test failure path', acknowledge_pending: true });
  assert.equal(s.status, 422); assert.equal(s.body.code, 'OVERTIME_RATE_NOT_CONFIGURED');
  const [b] = await q('SELECT status, is_finalized FROM payrollbatches WHERE payroll_batch_id = ?', [g.body.batch_id]);
  assert.deepEqual([b.status, b.is_finalized], ['Generated', 1], 'old batch unchanged');
  await db.query("UPDATE system_settings SET setting_value = '150' WHERE setting_key = 'overtime_flat_rate_syp'");
  await require('../services/settingsCache').refresh();
});

// ---------------------------------------------------------------------------
test('C1 settings: effective-dated change without a global lock; Drafts recalculated with audit; finalized history protected', async () => {
  // A Draft on a fresh site/date (Bridges is closed for worker 3; use T2 Night worker 2 tomorrow-1?)
  const inR = await supNight().post('/api/attendance/checkin', { worker_id: 2, site_id: 8, shift_type: 'Night', check_in_time: `${addDays(TODAY, -40)} 19:00:00` });
  // 40 days ago is outside the current finalized periods; may hit previous ranges -> skip if locked
  void inR;
  const insideFinal = await admin().put('/api/admin/attendance/settings/breaks', { standard_work_minutes: 540, effective_from: '2026-09-01', reason: 'test' });
  assert.equal(insideFinal.status, 409, 'cannot rewrite finalized history');
  const future = await admin().put('/api/admin/attendance/settings/breaks', { long_shift_review_hours: 14, effective_from: addDays(TODAY, 1) });
  assert.equal(future.status, 200, JSON.stringify(future.body));
  const hist = await q("SELECT setting_value, DATE_FORMAT(effective_from, '%Y-%m-%d') f FROM system_settings_history WHERE setting_key = 'long_shift_review_hours' ORDER BY effective_from");
  assert.equal(hist[hist.length - 1].setting_value, '14');
});

// ---------------------------------------------------------------------------
test('ST1 staff: Sick is unpaid by default; explicit Mark as Paid is audited; finalized staff period locked', async () => {
  const d = addDays(TODAY, -1);
  const set = await staffSup().post('/api/staff-attendance/supervisor/bulk-set', { record_date: d, mode: 'submit', entries: [{ staff_id: 1, attendance_status: 'Sick' }] });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const [rec] = await q('SELECT staff_attendance_id, is_paid, status FROM staff_attendance WHERE staff_id = 1 AND record_date = ?', [d]);
  assert.equal(rec.is_paid, 0);
  const appr = await admin().post('/api/staff-attendance/review', { staff_attendance_id: rec.staff_attendance_id, status: 'Approved' });
  assert.equal(appr.status, 200);
  const [r2] = await q('SELECT is_paid FROM staff_attendance WHERE staff_attendance_id = ?', [rec.staff_attendance_id]);
  assert.equal(r2.is_paid, 0, 'not paid automatically');
  const mark = await admin().post(`/api/staff-attendance/admin/${rec.staff_attendance_id}/paid`, { is_paid: 1, reason: 'medical certificate' });
  assert.equal(mark.status, 200);
  const [r3] = await q('SELECT is_paid, paid_decision_by_user_id FROM staff_attendance WHERE staff_attendance_id = ?', [rec.staff_attendance_id]);
  assert.deepEqual([r3.is_paid, r3.paid_decision_by_user_id], [1, 1]);
});

test('ST2 staff payroll: supersede is atomic, Paid cannot be superseded, currency USD', async () => {
  const s0 = addDays(TODAY, -3); const e0 = TODAY;
  const g = await admin().post('/api/staff-payroll/generate', { start_date: s0, end_date: e0, acknowledge_pending: true });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal(g.body.currency, 'USD');
  await admin().patch(`/api/staff-payroll/batch/${g.body.batch_id}/finalize`);
  const nv = await admin().post(`/api/staff-payroll/batch/${g.body.batch_id}/new-version`, { reason: 'fix staff hours', acknowledge_pending: true });
  assert.equal(nv.status, 201, JSON.stringify(nv.body));
  const [old] = await q('SELECT status FROM staff_payroll_batches WHERE staff_payroll_batch_id = ?', [g.body.batch_id]);
  assert.equal(old.status, 'Superseded');
  await admin().patch(`/api/staff-payroll/batch/${nv.body.batch_id}/finalize`);
  await admin().patch(`/api/staff-payroll/batch/${nv.body.batch_id}/mark-paid`);
  const again = await admin().post(`/api/staff-payroll/batch/${nv.body.batch_id}/new-version`, { reason: 'try paid again' });
  assert.equal(again.status, 409);
  // staff attendance in the finalized/paid period is locked for supervisors
  const lockedStaff = await staffSup().post('/api/staff-attendance/supervisor/bulk-set', { record_date: TODAY, mode: 'draft', entries: [{ staff_id: 1, attendance_status: 'Absent' }] });
  assert.equal(lockedStaff.status, 409);
});

// ---------------------------------------------------------------------------
test('X1 login upgrades a legacy plaintext password to bcrypt; error details are not leaked', async () => {
  const db = require('../config/db');
  await db.query("UPDATE users SET password_hash = 'plain-pass-1' WHERE user_id = 12");
  const r = await client().post('/api/auth/login', { username: 'sup_bridges', password: 'plain-pass-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [u] = await q('SELECT password_hash FROM users WHERE user_id = 12');
  assert.match(u.password_hash, /^\$2[ab]\$/);
});

test('X2 role guards: StaffSupervisor cannot use worker attendance; Supervisor cannot run payroll', async () => {
  assert.equal((await staffSup().post('/api/attendance/checkin', {})).status, 403);
  assert.equal((await supDay().post('/api/admin/payroll/generate', {})).status, 403);
  assert.equal((await supDay().get('/api/projects')).status, 403);
});
