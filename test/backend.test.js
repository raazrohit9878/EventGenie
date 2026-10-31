const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const { buildPortalChange } = require('../server/actions');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('authenticated workspaces persist and remain isolated between accounts', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventgenie-test-'));
  const dbFile = path.join(dir, 'test.sqlite');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), DB_PATH: dbFile, NVIDIA_API_KEY: '', NVIDIA_MODEL: '' },
    stdio: 'ignore'
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; if (ready) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'server should become healthy');
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/package.json`)).status, 404, 'server source files must not be publicly served');
  assert.equal((await fetch(`${base}/server/index.js`)).status, 404, 'backend source must not be publicly served');
  assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const unauthorized = await fetch(`${base}/api/workspace`);
  assert.equal(unauthorized.status, 401);

  async function createAccount(email) {
    const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Test User', email, password: 'A-long-test-password-2026!' }) });
    assert.equal(response.status, 201);
    return { cookie: response.headers.get('set-cookie').split(';')[0], body: await response.json() };
  }
  const one = await createAccount(`one-${Date.now()}@example.test`);
  const two = await createAccount(`two-${Date.now()}@example.test`);
  assert.equal(one.body.workspace.event.budget, 1200000);
  const headers = cookie => ({ cookie, 'content-type': 'application/json' });
  const chatStatus = await (await fetch(`${base}/api/chat/status`, { headers: headers(one.cookie) })).json();
  assert.equal(chatStatus.configured, false);
  const noKey = await fetch(`${base}/api/chat`, { method: 'POST', headers: headers(one.cookie), body: JSON.stringify({ message: 'What should I do next?' }) });
  assert.equal(noKey.status, 503);
  assert.equal((await noKey.json()).code, 'not_configured');
  const demoNoKey = await fetch(`${base}/api/demo/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'What tasks are pending?', context: { event: { name: 'Demo event', guests: 45 }, guests: [{ name: 'Private guest', contact: 'secret@example.test' }] } }) });
  assert.equal(demoNoKey.status, 503, 'demo chat must report missing AI configuration instead of simulating success');
  assert.equal((await demoNoKey.json()).code, 'not_configured');
  for (let i = 0; i < 11; i++) {
    const missing = await fetch(`${base}/api/chat`, { method: 'POST', headers: headers(one.cookie), body: JSON.stringify({ message: 'Try chat' }) });
    assert.equal(missing.status, 503);
  }
  const rateLimited = await fetch(`${base}/api/chat`, { method: 'POST', headers: headers(one.cookie), body: JSON.stringify({ message: 'One more' }) });
  assert.equal(rateLimited.status, 429);
  assert.equal((await (await fetch(`${base}/api/chat/history`, { headers: headers(one.cookie) })).json()).messages.length, 0, 'failed provider requests are not saved as successful conversation');
  const workspaceResponse = await fetch(`${base}/api/workspace`, { headers: headers(one.cookie) });
  const workspace = await workspaceResponse.json();
  workspace.workspace.event.name = 'Private updated event';
  const saved = await fetch(`${base}/api/workspace`, { method: 'PUT', headers: { ...headers(one.cookie), 'if-match': String(workspace.revision) }, body: JSON.stringify(workspace.workspace) });
  assert.equal(saved.status, 200);
  const staleWrite = await fetch(`${base}/api/workspace`, { method: 'PUT', headers: { ...headers(one.cookie), 'if-match': String(workspace.revision) }, body: JSON.stringify(workspace.workspace) });
  assert.equal(staleWrite.status, 409, 'stale clients must not overwrite a newer workspace');
  const readBack = await (await fetch(`${base}/api/workspace`, { headers: headers(one.cookie) })).json();
  assert.equal(readBack.workspace.event.name, 'Private updated event');
  const otherAccount = await (await fetch(`${base}/api/workspace`, { headers: headers(two.cookie) })).json();
  assert.notEqual(otherAccount.workspace.event.name, 'Private updated event');

  const summary = await (await fetch(`${base}/api/summary`, { headers: headers(one.cookie) })).json();
  assert.equal(summary.planned, 1200000);
  assert.equal(summary.remainingAfterActual, 1200000);
  const localDb = new Database(dbFile);
  const budgetActionId = crypto.randomUUID();
  localDb.prepare('INSERT INTO pending_actions(action_id,user_id,action_type,payload,base_revision,status,expires_at) VALUES(?,?,?,?,?,?,?)').run(budgetActionId, one.body.user.id, 'adjust_budget', JSON.stringify({ from: 1200000, to: 900000, currency: '₹' }), readBack.revision, 'pending', Date.now() + 60000);
  const otherUserAction = await fetch(`${base}/api/chat/actions/${budgetActionId}`, { method: 'POST', headers: headers(two.cookie), body: JSON.stringify({ decision: 'confirm' }) });
  assert.equal(otherUserAction.status, 404);
  const applied = await fetch(`${base}/api/chat/actions/${budgetActionId}`, { method: 'POST', headers: headers(one.cookie), body: JSON.stringify({ decision: 'confirm' }) });
  assert.equal(applied.status, 200);
  const appliedData = await applied.json();
  assert.equal(appliedData.workspace.event.budget, 900000);
  assert.equal(appliedData.workspace.expenses.reduce((n, x) => n + x.planned, 0), 900000);
  const guestActionId = crypto.randomUUID();
  localDb.prepare('INSERT INTO pending_actions(action_id,user_id,action_type,payload,base_revision,status,expires_at) VALUES(?,?,?,?,?,?,?)').run(guestActionId, one.body.user.id, 'adjust_guests', JSON.stringify({ from: 120, to: 200 }), appliedData.revision, 'pending', Date.now() + 60000);
  const rejectedAction = await fetch(`${base}/api/chat/actions/${guestActionId}`, { method: 'POST', headers: headers(one.cookie), body: JSON.stringify({ decision: 'reject' }) });
  assert.equal(rejectedAction.status, 200);
  assert.equal((await (await fetch(`${base}/api/workspace`, { headers: headers(one.cookie) })).json()).workspace.event.guests, 120);
  const latest = await (await fetch(`${base}/api/workspace`, { headers: headers(one.cookie) })).json();
  const portalChange = buildPortalChange({ entity: 'task', action: 'create', data: { title: 'Confirm menu', due: '2026-11-20', priority: 'High' } }, latest.workspace);
  const portalActionId = crypto.randomUUID();
  localDb.prepare('INSERT INTO pending_actions(action_id,user_id,action_type,payload,base_revision,status,expires_at) VALUES(?,?,?,?,?,?,?)').run(portalActionId, one.body.user.id, 'portal_change', JSON.stringify(portalChange), latest.revision, 'pending', Date.now() + 60000);
  const portalApplied = await fetch(`${base}/api/chat/actions/${portalActionId}`, { method: 'POST', headers: headers(one.cookie), body: JSON.stringify({ decision: 'confirm' }) });
  assert.equal(portalApplied.status, 200);
  const portalWorkspace = await portalApplied.json();
  assert.equal(portalWorkspace.workspace.tasks.some(task => task.title === 'Confirm menu'), true);
  localDb.close();
  const invalid = structuredClone(workspace.workspace);
  invalid.event.guests = 0;
  const rejected = await fetch(`${base}/api/workspace`, { method: 'PUT', headers: headers(one.cookie), body: JSON.stringify(invalid) });
  assert.equal(rejected.status, 400);
  const loggedOut = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: headers(one.cookie) });
  assert.equal(loggedOut.status, 200);
  assert.equal((await fetch(`${base}/api/workspace`, { headers: headers(one.cookie) })).status, 401);
});
