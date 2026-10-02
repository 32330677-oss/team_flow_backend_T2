// tests/helpers.js — test harness (local MySQL 8 only, never production).
const { execSync } = require('child_process');
const path = require('path');
const jwt = require('jsonwebtoken');

const DB_NAME = process.env.TEST_DB_NAME || 'team_flow_test';
const MYSQL = process.env.TEST_MYSQL_CLI || 'mysql -uroot';
const ROOT = path.join(__dirname, '..');

process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'tf';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'tfpass';
process.env.DB_NAME = DB_NAME;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret';
process.env.ATTENDANCE_CONNECTOR_TOKEN = process.env.ATTENDANCE_CONNECTOR_TOKEN || 'connector-token-connector-token-1234';
process.env.LOGIN_RATE_LIMIT_MAX = '1000';

function sh(cmd) {
  return execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT }).toString();
}

function resetDatabase({ migrate = true } = {}) {
  sh(`${MYSQL} -e "DROP DATABASE IF EXISTS ${DB_NAME}; CREATE DATABASE ${DB_NAME} CHARACTER SET utf8mb4;"`);
  sh(`${MYSQL} ${DB_NAME} < tests/schema/base_schema.sql`);
  sh(`${MYSQL} ${DB_NAME} < tests/schema/seed_prod_like.sql`);
  if (migrate) {
    for (const f of ['02_backup', '03_t2_consolidation', '04_ddl', '05_data']) {
      sh(`${MYSQL} ${DB_NAME} < migrations/2026_10_hardening/${f}.sql`);
    }
  }
}

function token(userId, role) {
  return jwt.sign({ user_id: userId, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

let server;
let baseUrl;
async function startServer() {
  const { app } = require('../server');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}
async function stopServer() {
  if (server) await new Promise((r) => server.close(r));
  const db = require('../config/db');
  await db.end().catch(() => {});
}

function client(userId, role) {
  const t = userId ? token(userId, role) : null;
  const call = async (method, url, body) => {
    const res = await fetch(baseUrl + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
    return { status: res.status, body: json };
  };
  return {
    get: (u) => call('GET', u),
    post: (u, b) => call('POST', u, b ?? {}),
    put: (u, b) => call('PUT', u, b ?? {}),
    patch: (u, b) => call('PATCH', u, b ?? {}),
    del: (u, b) => call('DELETE', u, b),
  };
}

async function q(sql, params = []) {
  const db = require('../config/db');
  const [rows] = await db.query(sql, params);
  return rows;
}

module.exports = { resetDatabase, startServer, stopServer, client, q, token, sh, DB_NAME };
