// scripts/verifyLiveDashboard.js
//
// READ-ONLY verification of the Live Site Operations dashboard against the
// real database configured in .env. Nothing is written.
//
//   node scripts/verifyLiveDashboard.js [YYYY-MM-DD]
//
// 1. Runs the real GET /live and GET /sites/:id handlers (no HTTP, no auth).
// 2. Re-counts expected workers with an independent query and compares.
// 3. Checks the internal invariants of every site/shift row.
// 4. Checks the Site 8 / 9 / 10 expectations.
// 5. Prints EXPLAIN for the main aggregation and the endpoint timings.
// Exit code 0 = all checks passed, 1 = at least one check failed.

require('dotenv').config();
const pool = require('../config/db');
const controller = require('../controllers/mainDashboardController');
const { businessToday, addDays } = require('../services/businessDate');

const date = process.argv[2] || businessToday();
let failures = 0;

function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function call(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    handler(req, res);
  });
}

(async () => {
  console.log(`Verifying Live Site Operations for ${date}\n`);

  let t0 = Date.now();
  const live = await call(controller.getLiveOperations, { query: { date }, params: {} });
  const liveMs = Date.now() - t0;
  check(live.status === 200, 'GET /live returns 200', `${liveMs} ms`);
  if (live.status !== 200) {
    console.log(live.body);
    process.exit(1);
  }
  const d = live.body.data;

  // ---- 2. Independent expected count per site/shift
  const [indep] = await pool.query(
    `SELECT wsa.site_id, wsa.shift_type, COUNT(DISTINCT wsa.worker_id) AS cnt
     FROM workersiteassignments wsa
     JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
     JOIN sites s ON s.site_id = wsa.site_id AND s.site_status = 'Active'
     WHERE wsa.assigned_date <= ? AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ?)
     GROUP BY wsa.site_id, wsa.shift_type`,
    [date, date]
  );
  const indepMap = new Map(indep.map((r) => [`${r.site_id}|${r.shift_type}`, Number(r.cnt)]));
  for (const site of d.sites) {
    for (const u of site.units) {
      const want = indepMap.get(`${site.site_id}|${u.shift_type}`) || 0;
      check(u.expected === want, `${site.site_name} ${u.shift_type}: expected = independent count`, `${u.expected} vs ${want}`);
      const statusSum = u.not_recorded + u.present + u.absent + u.sick + u.vacation + u.holiday;
      check(statusSum === u.expected, `${site.site_name} ${u.shift_type}: not_recorded + statuses = expected`, `${statusSum} vs ${u.expected}`);
      const presentSplit = u.on_site_now + u.on_break + u.checked_out;
      check(presentSplit <= u.present, `${site.site_name} ${u.shift_type}: on site + break + out <= present`, `${presentSplit} vs ${u.present}`);
      const wf = u.workflow.draft + u.workflow.submitted + u.workflow.approved + u.workflow.rejected;
      check(wf === u.recorded, `${site.site_name} ${u.shift_type}: workflow counts = recorded`, `${wf} vs ${u.recorded}`);
    }
  }
  const totalIndep = [...indepMap.values()].reduce((a, b) => a + b, 0);
  check(d.summary.expected === totalIndep, 'Summary expected = independent total', `${d.summary.expected} vs ${totalIndep}`);

  // Assignments whose LAST day (inclusive) is this date: they ARE expected on this date.
  const [[incl]] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM workersiteassignments wsa
     JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
     JOIN sites s ON s.site_id = wsa.site_id AND s.site_status = 'Active'
     WHERE wsa.assigned_date <= ? AND wsa.unassigned_date = ?`,
    [date, date]
  );
  console.log(`INFO  assignments whose last assigned day is ${date} (counted as expected): ${incl.cnt}`);

  // ---- 3. Site expectations
  const [siteRows] = await pool.query(
    'SELECT site_id, site_name, site_status, supports_shifts FROM sites WHERE site_id IN (8, 9, 10)'
  );
  for (const s of siteRows) {
    const shown = d.sites.find((x) => x.site_id === Number(s.site_id));
    if (s.site_status === 'Active') {
      check(Boolean(shown), `Site ${s.site_id} (${s.site_name}) is shown`, s.site_status);
      if (shown) {
        check(shown.supports_shifts === (Number(s.supports_shifts) === 1),
          `Site ${s.site_id} shift mode matches DB`, shown.units.map((u) => u.shift_type).join('/'));
      }
    } else {
      check(!shown, `Site ${s.site_id} (${s.site_name}) is NOT shown as active`, s.site_status);
    }
  }

  // ---- 4. Drill-down agrees with the overview for every site
  for (const site of d.sites) {
    t0 = Date.now();
    const det = await call(controller.getSiteOperations, { query: { date }, params: { siteId: String(site.site_id) } });
    check(det.status === 200, `GET /sites/${site.site_id} returns 200`, `${Date.now() - t0} ms`);
    if (det.status !== 200) continue;
    for (const u of site.units) {
      const workers = det.body.data.workers.filter((w) => w.shift_type === u.shift_type);
      check(workers.length === u.expected, `${site.site_name} ${u.shift_type}: drill-down workers = expected`, `${workers.length} vs ${u.expected}`);
      const nr = workers.filter((w) => w.state === 'not_recorded').length;
      check(nr === u.not_recorded, `${site.site_name} ${u.shift_type}: drill-down not recorded matches`, `${nr} vs ${u.not_recorded}`);
    }
  }

  // ---- 5. EXPLAIN the heaviest statement
  const [plan] = await pool.query(
    `EXPLAIN ${controller._internal.workerStateSql('')}`,
    [date, addDays(date, -1), date, date, date]
  );
  console.log('\nEXPLAIN worker-state query:');
  console.table(plan.map((p) => ({ table: p.table, type: p.type, key: p.key, rows: p.rows, extra: p.Extra })));

  console.log('\nSummary:', JSON.stringify(d.summary));
  console.log(`Exceptions (${d.exceptions.length}):`);
  for (const e of d.exceptions) console.log(`  [${e.severity}] ${e.title}${e.site_name ? ` — ${e.site_name}` : ''}${e.shift_type ? ` ${e.shift_type}` : ''}: ${e.detail}`);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('Verification crashed:', error);
  process.exit(1);
});
