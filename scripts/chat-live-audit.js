require('dotenv').config();
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const fail = (name, details) => {
  throw new Error(`${name}: ${details}`);
};

(async () => {
  if (!process.env.NVIDIA_API_KEY?.trim() || !process.env.NVIDIA_MODEL?.trim()) {
    console.error('Live chat audit skipped: configure NVIDIA_API_KEY and NVIDIA_MODEL in .env.');
    process.exitCode = 2;
    return;
  }
  const port = await freePort();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventgenie-chat-audit-'));
  const dbPath = path.join(dir, 'audit.sqlite');
  const child = spawn(process.execPath, [path.join(process.cwd(), 'server', 'index.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DB_PATH: dbPath,
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  async function request(route, options = {}) {
    const response = await fetch(`${base}${route}`, {
      ...options,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }
  async function chat(message) {
    const result = await request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    if (!result.response.ok)
      fail(
        `Chat ${JSON.stringify(message)}`,
        `${result.response.status} ${result.data.error || ''}`,
      );
    const rows = result.data.messages || [];
    return { action: result.data.action || null, answer: rows.at(-1)?.content || '', rows };
  }
  async function confirm(action, decision = 'confirm') {
    const result = await request(`/api/chat/actions/${encodeURIComponent(action.id)}`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
    if (!result.response.ok)
      fail(`Action ${action.type}`, `${result.response.status} ${result.data.error || ''}`);
    return result.data;
  }
  async function workspace() {
    const result = await request('/api/workspace');
    if (!result.response.ok) fail('Workspace read', `${result.response.status}`);
    return result.data.workspace;
  }

  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) fail('Backend startup', 'server did not become healthy');
    const registration = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Live Audit',
        email: `audit-${crypto.randomUUID()}@example.test`,
        password: 'A-long-live-audit-password-2026!',
      }),
    });
    if (registration.response.status !== 201)
      fail(
        'Test account setup',
        `${registration.response.status} ${registration.data.error || ''}`,
      );
    cookie = registration.response.headers.get('set-cookie')?.split(';')[0] || '';
    if (!cookie) fail('Test account setup', 'session cookie missing');

    const questions = await chat('What tasks are pending?');
    if (questions.action) fail('Read-only question', 'assistant proposed a workspace mutation');
    if (!questions.answer.trim())
      fail('Read-only question', 'assistant returned an empty response');
    if (
      /^\s*```|^\s*\{\s*["'](?:event|tasks|vendors|budget|entity|action)["']\s*:/i.test(
        questions.answer,
      )
    )
      fail(
        'Reply formatting',
        'assistant returned a code fence or raw JSON instead of a chat answer',
      );
    console.log(
      `PASS read-only question: natural reply, no action proposed — ${questions.answer.replace(/\s+/g, ' ').slice(0, 160)}`,
    );

    const task = await chat(
      'Add a high priority task called Confirm the birthday cake, due 2026-11-30.',
    );
    if (!task.action || task.action.type !== 'portal_change')
      fail('Create task', task.answer.slice(0, 180));
    const taskResult = await confirm(task.action);
    if (
      !taskResult.workspace.tasks.some((row) => row.title.toLowerCase().includes('birthday cake'))
    )
      fail('Create task', 'confirmation did not update the workspace');
    console.log('PASS create task: validated preview and confirmation updated the workspace');

    const vendor = await chat('Mark Saffron Table Co. as Booked.');
    if (!vendor.action || vendor.action.type !== 'portal_change')
      fail('Update vendor booking status', vendor.answer.slice(0, 180));
    const vendorResult = await confirm(vendor.action);
    if (
      !vendorResult.workspace.vendors.some(
        (row) => row.name === 'Saffron Table Co.' && row.status === 'Booked',
      )
    )
      fail('Update vendor booking status', 'confirmed status not saved');
    console.log('PASS update vendor status: exact vendor match, confirmation required');

    const budget = await chat('Reduce my total budget to ₹800,000.');
    if (!budget.action) fail('Budget update', budget.answer.slice(0, 180));
    const budgetResult = await confirm(budget.action);
    if (
      budgetResult.workspace.event.budget !== 800000 ||
      budgetResult.workspace.expenses.reduce((sum, item) => sum + item.planned, 0) !== 800000
    )
      fail('Budget update', 'budget allocations do not equal the new budget');
    console.log('PASS budget update: total and allocations match after confirmation');

    const guest = await chat('Mira Kapoor ka RSVP Yes mark karo.');
    if (!guest.action || guest.action.type !== 'portal_change')
      fail('Hinglish RSVP update', guest.answer.slice(0, 180));
    const guestResult = await confirm(guest.action);
    if (
      !guestResult.workspace.guests.some((row) => row.name === 'Mira Kapoor' && row.rsvp === 'Yes')
    )
      fail('Hinglish RSVP update', 'RSVP was not saved');
    console.log('PASS Hindi/Hinglish update: guest RSVP changed after confirmation');

    const newExpense = await chat('Add an expense called Party lighting for ₹25,000.');
    if (!newExpense.action || newExpense.action.type !== 'portal_change')
      fail('Create expense', newExpense.answer.slice(0, 180));
    const expenseResult = await confirm(newExpense.action);
    if (
      !expenseResult.workspace.expenses.some(
        (row) => row.name === 'Party lighting' && row.planned === 25000,
      )
    )
      fail('Create expense', 'expense was not saved');
    console.log('PASS create expense: planned value saved as an estimate');

    const newVendor = await chat(
      'Add a caterer named Celebration Bites quote ₹35,000 location Jaipur.',
    );
    if (!newVendor.action || newVendor.action.type !== 'portal_change')
      fail('Create vendor', newVendor.answer.slice(0, 180));
    const vendorCreateResult = await confirm(newVendor.action);
    if (
      !vendorCreateResult.workspace.vendors.some(
        (row) => row.name === 'Celebration Bites' && row.quote === 35000,
      )
    )
      fail('Create vendor', 'vendor quotation was not saved');
    console.log('PASS create vendor: user-entered quote saved without verification claims');

    const newGuest = await chat('Add guest named Riya Test RSVP Pending dietary vegan.');
    if (!newGuest.action || newGuest.action.type !== 'portal_change')
      fail('Create guest', newGuest.answer.slice(0, 180));
    const guestCreateResult = await confirm(newGuest.action);
    if (
      !guestCreateResult.workspace.guests.some(
        (row) => row.name === 'Riya Test' && row.dietary.toLowerCase() === 'vegan',
      )
    )
      fail('Create guest', 'guest was not saved');
    console.log('PASS create guest: name and dietary detail saved after confirmation');

    const theme = await chat('Change my event theme to a colorful garden party.');
    if (!theme.action || theme.action.type !== 'portal_change')
      fail('Update event theme', theme.answer.slice(0, 180));
    const themeResult = await confirm(theme.action);
    if (themeResult.workspace.event.theme !== 'a colorful garden party')
      fail('Update event theme', 'theme was not saved');
    console.log('PASS update event: theme changed after confirmation');

    const ideas = await chat('Suggest three birthday decoration ideas for a small indoor party.');
    if (ideas.action) fail('Recommendation request', 'assistant proposed an unrequested mutation');
    if (!ideas.answer.trim())
      fail('Recommendation request', 'assistant returned an empty response');
    if (
      /^\s*```|^\s*\{\s*["'](?:event|tasks|vendors|budget|entity|action)["']\s*:/i.test(
        ideas.answer,
      )
    )
      fail(
        'Reply formatting',
        'assistant returned a code fence or raw JSON instead of a chat answer',
      );
    console.log(
      `PASS recommendation request: natural reply, no mutation — ${ideas.answer.replace(/\s+/g, ' ').slice(0, 160)}`,
    );

    const firstTurn = await chat('Create to organise a birthday party.');
    if (firstTurn.action)
      fail('Birthday setup clarification', 'created an event before collecting required details');
    if (!/date|location|guest|budget/i.test(firstTurn.answer))
      fail('Birthday setup clarification', firstTurn.answer.slice(0, 180));
    const secondTurn = await chat(
      'Date 2027-05-15, location Jaipur. Budget 50000, guest count 50. Select the theme yourself.',
    );
    if (
      !secondTurn.action ||
      secondTurn.action.type !== 'portal_change' ||
      secondTurn.action.proposal?.entity !== 'event'
    )
      fail('Birthday follow-up', secondTurn.answer.slice(0, 220));
    if (!/replaces the active event/i.test(secondTurn.action.summary || ''))
      fail('Birthday follow-up', 'replacement warning missing from preview');
    await confirm(secondTurn.action, 'reject');
    const afterReject = await workspace();
    if (afterReject.event.type !== 'Wedding')
      fail('Birthday proposal rejection', 'rejected proposal changed the active event');
    console.log(
      'PASS multi-turn birthday setup: carried date, location, guests, and budget forward; rejection preserved current event',
    );

    const demoContext = await workspace();
    const demoResponse = await fetch(`${base}/api/demo/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Add a high priority task called Confirm demo sound check, due 2026-12-01.',
        context: demoContext,
        history: [],
      }),
    });
    const demoData = await demoResponse.json();
    if (!demoResponse.ok || demoData.action?.proposal?.entity !== 'task')
      fail(
        'Local demo chat',
        `${demoResponse.status} ${demoData.error || 'no task proposal returned'}`,
      );
    if (
      demoData.action?.status !== 'pending' ||
      (await workspace()).tasks.some((row) => row.title === 'Confirm demo sound check')
    )
      fail('Local demo isolation', 'demo proposal wrote into the authenticated workspace');
    console.log(
      'PASS local demo: action preview returned without auth or account-workspace mutation',
    );

    const history = await request('/api/chat/history');
    if (!history.response.ok || history.data.messages.length < 14)
      fail('Chat history', 'messages were not persisted to the isolated account');
    const isolated = await request('/api/workspace', { headers: { cookie: '' } });
    if (isolated.response.status !== 401)
      fail('Authorization', 'unauthenticated workspace read was not rejected');
    console.log('PASS authorization: workspace requires the test account session');
    console.log(
      `PASS conversation persistence: ${history.data.messages.length} messages saved in the test account`,
    );
    console.log(
      `Live chat audit succeeded using NVIDIA model ${process.env.NVIDIA_MODEL}. No production workspace was touched.`,
    );
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
    child.kill('SIGKILL');
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(`Live chat audit failed: ${error.message}`);
  process.exitCode = 1;
});
