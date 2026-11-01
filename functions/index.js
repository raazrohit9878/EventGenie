require('dotenv').config();
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { rateLimit } = require('express-rate-limit');
const starterWorkspace = require('./seed');
const { createNimCompletion, isNimConfigured } = require('./nvidia');
const {
  buildMessages,
  PORTAL_CHANGE_TOOL,
  parseProposal,
  sanitizeDemoWorkspace,
  normalizeAssistantReply,
} = require('./chat');
const {
  buildPortalChange,
  applyPortalChange,
  clarifyPortalChange,
  isEventCreationIntent,
  isPendingEventCreation,
  extractEventCreationData,
  parseDirectPortalChange,
  shouldEnablePortalTool,
} = require('./actions');
const { onRequest } = require('firebase-functions/v2/https');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const sessionDays = Math.max(1, Math.min(30, Number(process.env.SESSION_DAYS || 14)));

// In Cloud Functions, write to the /tmp directory
const defaultDbPath = path.join(os.tmpdir(), 'eventgenie.sqlite');
const dbPath = path.resolve(process.env.DB_PATH || defaultDbPath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS workspaces (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    model TEXT,
    action_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS chat_history_owner ON chat_messages(user_id,id DESC);
  CREATE TABLE IF NOT EXISTS pending_actions (
    action_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','confirmed','rejected','conflict','expired')),
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

app.disable('x-powered-by');
// Firebase Functions sits behind one trusted Google front proxy. Trusting all
// forwarded hops lets a client spoof req.ip and evade IP-based rate limits.
app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(express.json({ limit: '1mb', strict: true }));
const configuredOrigins = new Set(
  (process.env.APP_ORIGINS || '')
    .split(',')
    .map((value) => {
      try {
        return new URL(value.trim()).origin;
      } catch {
        return '';
      }
    })
    .filter(Boolean),
);
app.use((req, res, next) => {
  res.setHeader('Cache-Control', req.path.startsWith('/api/') ? 'no-store' : 'no-cache');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) {
      try {
        const parsedOrigin = new URL(origin);
        const reqHost = req.get('x-forwarded-host') || req.get('host');
        const isLocalDevelopment =
          !isProduction && /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(parsedOrigin.host);
        const isAllowed =
          (parsedOrigin.protocol === 'https:' || isLocalDevelopment) &&
          (parsedOrigin.host === reqHost || configuredOrigins.has(parsedOrigin.origin));
        if (!isAllowed) return res.status(403).json({ error: 'Cross-site request rejected.' });
      } catch {
        return res.status(403).json({ error: 'Invalid request origin.' });
      }
    } else if (isProduction) return res.status(403).json({ error: 'Request origin is required.' });
  }
  next();
});

// Firebase Hosting forwards cookies only when named __session
const cookieName = process.env.COOKIE_NAME || '__session';
const cookieOptions = {
  httpOnly: true,
  secure: process.env.FUNCTIONS_EMULATOR !== 'true',
  sameSite: 'strict',
  path: '/',
  maxAge: sessionDays * 86400000,
};
const tokenDigest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Chat is busy. Wait a minute and try again.', code: 'chat_rate_limit' },
});
const demoChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Demo chat is busy. Wait a minute and try again.',
    code: 'demo_chat_rate_limit',
  },
});
const actionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many action requests. Please slow down.' },
});
const cleanText = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const validDate = (d) => {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const parsed = new Date(`${d}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
};
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
function requireAuth(req, res, next) {
  const token = readCookie(req, cookieName);
  if (!token || token.length > 200) return res.status(401).json({ error: 'Sign in to continue.' });
  const row = db
    .prepare(
      `SELECT users.id, users.name, users.email, sessions.token_hash FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?`,
    )
    .get(tokenDigest(token), Date.now());
  if (!row) {
    res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined });
    return res.status(401).json({ error: 'Your session expired. Sign in again.' });
  }
  req.user = row;
  next();
}
function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiry = Date.now() + sessionDays * 86400000;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(
    tokenDigest(token),
    userId,
    expiry,
  );
  res.cookie(cookieName, token, cookieOptions);
}
function safeUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, service: 'eventgenie-cloud', timestamp: new Date().toISOString() }),
);
app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  try {
    const name = cleanText(req.body?.name, 80);
    const email = cleanText(req.body?.email, 254).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (name.length < 2)
      return res.status(400).json({ error: 'Enter your name (at least 2 characters).' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 12 || password.length > 200)
      return res.status(400).json({ error: 'Password must be 12–200 characters.' });
    const userId = crypto.randomUUID();
    const hash = await bcrypt.hash(password, 12);
    const create = db.transaction(() => {
      db.prepare('INSERT INTO users(id,name,email,password_hash) VALUES(?,?,?,?)').run(
        userId,
        name,
        email,
        hash,
      );
      db.prepare('INSERT INTO workspaces(user_id,data) VALUES(?,?)').run(
        userId,
        JSON.stringify(starterWorkspace()),
      );
    });
    try {
      create();
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE')
        return res.status(409).json({ error: 'An account with that email already exists.' });
      throw err;
    }
    createSession(userId, res);
    res
      .status(201)
      .json({ user: { id: userId, name, email }, workspace: starterWorkspace(), revision: 1 });
  } catch (err) {
    next(err);
  }
});
app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const email = cleanText(req.body?.email, 254).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = db
      .prepare('SELECT id,name,email,password_hash FROM users WHERE email=?')
      .get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    createSession(user.id, res);
    const workspace = db
      .prepare('SELECT data,revision,updated_at FROM workspaces WHERE user_id=?')
      .get(user.id);
    res.json({
      user: safeUser(user),
      workspace: workspace ? JSON.parse(workspace.data) : starterWorkspace(),
      revision: workspace?.revision || 1,
      updatedAt: workspace?.updated_at || null,
    });
  } catch (err) {
    next(err);
  }
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: safeUser(req.user) }));
app.post('/api/auth/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.user.token_hash);
  res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined });
  res.json({ ok: true });
});

function validateWorkspace(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Workspace must be an object.';
  const e = raw.event;
  if (!e || typeof e !== 'object') return 'Event details are required.';
  if (!cleanText(e.name, 120) || !cleanText(e.location, 160) || !validDate(e.date))
    return 'Event name, date, and location are required.';
  if (
    cleanText(e.name, 120) !== e.name ||
    cleanText(e.location, 160) !== e.location ||
    !['₹', '$', '€', '£', 'INR', 'USD', 'EUR', 'GBP'].includes(e.currency || '₹')
  )
    return 'Event details contain an unsupported value.';
  for (const key of [
    'type',
    'theme',
    'venue',
    'venueTier',
    'dietary',
    'cateringNotes',
    'priorities',
    'time',
  ])
    if (typeof e[key] !== 'string' || e[key].length > 300)
      return `Event ${key} must be text of 300 characters or fewer.`;
  if (!Number.isInteger(Number(e.guests)) || Number(e.guests) < 1 || Number(e.guests) > 100000)
    return 'Guest count must be between 1 and 100,000.';
  if (!Number.isFinite(Number(e.budget)) || Number(e.budget) <= 0 || Number(e.budget) > 1e12)
    return 'Budget must be a positive amount.';
  for (const key of ['expenses', 'tasks', 'vendors', 'guests', 'ideasSaved', 'chat'])
    if (!Array.isArray(raw[key]) || raw[key].length > 10000)
      return `${key} must be a list of 10,000 items or fewer.`;
  const validId = (item) => Number.isSafeInteger(Number(item?.id)) && Number(item.id) > 0;
  for (const x of raw.expenses)
    if (
      !validId(x) ||
      !cleanText(x.name, 120) ||
      x.name.length > 120 ||
      typeof x.category !== 'string' ||
      x.category.length > 80 ||
      !Number.isFinite(Number(x.planned)) ||
      Number(x.planned) < 0 ||
      !Number.isFinite(Number(x.actual)) ||
      Number(x.actual) < 0
    )
      return 'Expense entries need valid IDs, names, categories, and non-negative amounts.';
  for (const t of raw.tasks) {
    if (
      !validId(t) ||
      !cleanText(t.title, 180) ||
      t.title.length > 180 ||
      typeof t.category !== 'string' ||
      t.category.length > 80 ||
      !validDate(t.due) ||
      t.due > e.date
    )
      return 'Tasks need valid IDs, titles, and a due date on or before the event date.';
    if (!['Not started', 'In progress', 'Completed', 'Blocked'].includes(t.status))
      return 'A task has an unsupported status.';
  }
  for (const v of raw.vendors)
    if (
      !validId(v) ||
      !cleanText(v.name, 160) ||
      v.name.length > 160 ||
      typeof v.category !== 'string' ||
      v.category.length > 80 ||
      !Number.isFinite(Number(v.quote)) ||
      Number(v.quote) < 0
    )
      return 'Vendor entries need valid IDs, names, categories, and non-negative quotes.';
  for (const g of raw.guests)
    if (
      !validId(g) ||
      !cleanText(g.name, 160) ||
      g.name.length > 160 ||
      typeof g.contact !== 'string' ||
      g.contact.length > 240 ||
      typeof g.category !== 'string' ||
      g.category.length > 80 ||
      typeof g.dietary !== 'string' ||
      g.dietary.length > 240 ||
      !['Pending', 'Yes', 'No'].includes(g.rsvp)
    )
      return 'Guest entries need valid IDs, names, and RSVP values.';
  return null;
}
app.get('/api/workspace', requireAuth, (req, res) => {
  let row = db
    .prepare('SELECT data,revision,updated_at FROM workspaces WHERE user_id=?')
    .get(req.user.id);
  if (!row) {
    db.prepare('INSERT INTO workspaces(user_id,data) VALUES(?,?)').run(
      req.user.id,
      JSON.stringify(starterWorkspace()),
    );
    row = db
      .prepare('SELECT data,revision,updated_at FROM workspaces WHERE user_id=?')
      .get(req.user.id);
  }
  res.json({ workspace: JSON.parse(row.data), revision: row.revision, updatedAt: row.updated_at });
});
app.put('/api/workspace', requireAuth, (req, res) => {
  const problem = validateWorkspace(req.body);
  if (problem) return res.status(400).json({ error: problem });
  const data = JSON.stringify(req.body);
  if (Buffer.byteLength(data) > 900_000)
    return res.status(413).json({ error: 'Workspace is too large to save.' });
  const expected = req.get('if-match');
  const current = db.prepare('SELECT revision FROM workspaces WHERE user_id=?').get(req.user.id);
  if (
    expected !== undefined &&
    (!/^\d+$/.test(expected) || !current || Number(expected) !== current.revision)
  )
    return res
      .status(409)
      .json({ error: 'Workspace changed since it was loaded.', revision: current?.revision || 0 });
  db.prepare(
    `INSERT INTO workspaces(user_id,data,revision,updated_at) VALUES(?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,revision=workspaces.revision+1,updated_at=CURRENT_TIMESTAMP`,
  ).run(req.user.id, data);
  const row = db
    .prepare('SELECT revision,updated_at FROM workspaces WHERE user_id=?')
    .get(req.user.id);
  res.json({ ok: true, revision: row.revision, updatedAt: row.updated_at });
});
app.get('/api/summary', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM workspaces WHERE user_id=?').get(req.user.id);
  const w = row ? JSON.parse(row.data) : starterWorkspace();
  const planned = w.expenses.reduce((n, x) => n + Number(x.planned || 0), 0);
  const actual = w.expenses.reduce((n, x) => n + Number(x.actual || 0), 0);
  const byCategory = {};
  for (const x of w.expenses) {
    const c = cleanText(x.category, 60) || 'Other';
    byCategory[c] ||= { planned: 0, actual: 0 };
    byCategory[c].planned += Number(x.planned || 0);
    byCategory[c].actual += Number(x.actual || 0);
  }
  res.json({
    budget: Number(w.event.budget),
    planned,
    actual,
    remainingAfterActual: Number(w.event.budget) - actual,
    overPlannedBy: Math.max(0, planned - Number(w.event.budget)),
    byCategory,
    taskCounts: {
      total: w.tasks.length,
      completed: w.tasks.filter((x) => x.status === 'Completed').length,
    },
  });
});

const chatHistory = db.prepare(
  'SELECT id,role,content,model,action_json,created_at FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT 80',
);
app.get('/api/chat/status', (_req, res) => {
  const configured = isNimConfigured();
  res.json({ configured, model: configured ? process.env.NVIDIA_MODEL.trim() : null });
});
function publicChatMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    model: row.model || null,
    action: row.action_json ? JSON.parse(row.action_json) : null,
    createdAt: row.created_at,
  };
}
app.get('/api/chat/history', requireAuth, (req, res) => {
  const rows = chatHistory.all(req.user.id).reverse();
  res.json({ messages: rows.map(publicChatMessage) });
});
app.delete('/api/chat/history', requireAuth, (req, res) => {
  const clear = db.transaction(() => {
    db.prepare('DELETE FROM chat_messages WHERE user_id=?').run(req.user.id);
    db.prepare("DELETE FROM pending_actions WHERE user_id=? AND status='pending'").run(req.user.id);
  });
  clear();
  res.json({ ok: true, messages: [] });
});
function changeReply(change) {
  if (
    change?.type === 'portal_change' &&
    change.entity === 'event' &&
    change.operation === 'create'
  ) {
    const f = change.fields;
    const feasibility =
      f.venueTier && /luxury|5.star|premium/i.test(f.venueTier)
        ? `\n\nFeasibility: ${f.currency}${Math.round(f.budget / f.guests).toLocaleString('en-IN')} per person may constrain a ${f.venueTier} venue. Local prices vary; compare actual quotations. A boutique venue or a simpler decor scope may be alternatives.`
        : '';
    return `Here’s the event setup recap:\n\n${change.summary.replace(/^Create new event:\s*/, '')}${feasibility}\n\n**This will replace your active event and clear its current tasks, expenses, vendors, guest list, and saved ideas.** Nothing has changed yet. Review the details, then confirm below to replace it.`;
  }
  if (change?.type === 'portal_change')
    return `I’ve prepared this portal change for review: **${change.summary}**. Nothing has changed yet. Confirm below to apply it.`;
  if (change?.type === 'adjust_budget')
    return `I’ve prepared a budget change from ${change.currency}${Number(change.from).toLocaleString('en-IN')} to ${change.currency}${Number(change.to).toLocaleString('en-IN')}. Planned allocations will be recalculated to match the new total. Confirm below to apply it.`;
  if (change?.type === 'adjust_guests')
    return `I’ve prepared a guest-count change from ${change.from} to ${change.to}. Confirm below to update your event.`;
  return '';
}
app.post('/api/chat', requireAuth, chatLimiter, async (req, res) => {
  const userMessage = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!userMessage)
    return res
      .status(400)
      .json({ error: 'Write a message before sending.', code: 'empty_message' });
  if (userMessage.length > 4000)
    return res
      .status(400)
      .json({ error: 'Messages must be 4,000 characters or fewer.', code: 'message_too_long' });
  const row = db.prepare('SELECT data,revision FROM workspaces WHERE user_id=?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'Your event workspace was not found.' });
  const workspace = JSON.parse(row.data);
  const pastRows = chatHistory.all(req.user.id).reverse();
  const past = pastRows.map((x) => ({ role: x.role, content: x.content }));
  const eventSetup = isEventCreationIntent(userMessage) || isPendingEventCreation(past);
  const collectedEvent = eventSetup ? extractEventCreationData(past, userMessage) : null;
  const directChange = eventSetup ? null : parseDirectPortalChange(userMessage, workspace);
  const numericChange = eventSetup || directChange ? null : parseProposal(userMessage, workspace);
  let completion = { ok: true, content: '', model: null, toolCall: null };
  if (!eventSetup && !directChange && !numericChange) {
    const usePortalTools = shouldEnablePortalTool(userMessage);
    completion = await createNimCompletion({
      messages: buildMessages({
        workspace,
        history: past,
        userMessage,
        proposal: null,
        allowActions: usePortalTools,
      }),
      ...(usePortalTools ? { tools: [PORTAL_CHANGE_TOOL] } : {}),
      timeoutMs: 80000,
    });
    if (!completion.ok)
      return res.status(completion.status).json({ error: completion.error, code: completion.code });
    completion.content = normalizeAssistantReply(completion.content);
  }
  const eventCandidate = eventSetup
    ? {
        entity: 'event',
        action: 'create',
        data: {
          ...collectedEvent,
          ...(!collectedEvent.type && completion.toolCall?.data?.type
            ? { type: completion.toolCall.data.type }
            : {}),
        },
      }
    : null;
  const portalChange = eventSetup
    ? buildPortalChange(eventCandidate, workspace)
    : directChange || buildPortalChange(completion.toolCall, workspace);
  const proposal = portalChange || numericChange || parseProposal(userMessage, workspace);
  if (portalChange || numericChange)
    completion.content = changeReply(portalChange || numericChange);
  if (eventSetup && !portalChange)
    completion.content = clarifyPortalChange(eventCandidate, workspace);
  else if (!completion.content)
    completion.content =
      completion.toolCall && !portalChange
        ? clarifyPortalChange(completion.toolCall, workspace)
        : 'I can help with that. Please tell me what you would like to plan or change.';

  const action = proposal
    ? {
        id: crypto.randomUUID(),
        type: proposal.type,
        from: proposal.from,
        to: proposal.to,
        currency: proposal.currency || workspace.event.currency || '₹',
        summary: portalChange?.summary || null,
        proposal: portalChange || null,
        status: 'pending',
        expiresAt: Date.now() + 15 * 60 * 1000,
      }
    : null;
  const saveConversation = db.transaction(() => {
    if (action)
      db.prepare(
        'INSERT INTO pending_actions(action_id,user_id,action_type,payload,base_revision,status,expires_at) VALUES(?,?,?,?,?,?,?)',
      ).run(
        action.id,
        req.user.id,
        action.type,
        JSON.stringify(proposal),
        row.revision,
        'pending',
        action.expiresAt,
      );
    db.prepare('INSERT INTO chat_messages(user_id,role,content) VALUES(?,?,?)').run(
      req.user.id,
      'user',
      userMessage,
    );
    db.prepare(
      'INSERT INTO chat_messages(user_id,role,content,model,action_json) VALUES(?,?,?,?,?)',
    ).run(
      req.user.id,
      'assistant',
      completion.content,
      completion.model,
      action ? JSON.stringify(action) : null,
    );
    db.prepare(
      'DELETE FROM chat_messages WHERE user_id=? AND id NOT IN (SELECT id FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT 100)',
    ).run(req.user.id, req.user.id);
  });
  saveConversation();
  const rows = chatHistory.all(req.user.id).reverse();
  res.json({ model: completion.model, messages: rows.map(publicChatMessage), action });
});
app.post('/api/demo/chat', demoChatLimiter, async (req, res) => {
  const userMessage = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!userMessage) return res.status(400).json({ error: 'Write a message before sending.' });
  if (userMessage.length > 2000)
    return res.status(400).json({ error: 'Demo messages must be 2,000 characters or fewer.' });
  const workspace = sanitizeDemoWorkspace(req.body?.context);
  const history = Array.isArray(req.body?.history)
    ? req.body.history
        .slice(-20)
        .filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m?.content === 'string')
        .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 1200) }))
    : [];
  const eventSetup = isEventCreationIntent(userMessage) || isPendingEventCreation(history);
  const collectedEvent = eventSetup ? extractEventCreationData(history, userMessage) : null;
  const directChange = eventSetup ? null : parseDirectPortalChange(userMessage, workspace);
  const numericChange = eventSetup || directChange ? null : parseProposal(userMessage, workspace);
  let completion = { ok: true, content: '', model: null, toolCall: null };
  if (!eventSetup && !directChange && !numericChange) {
    const usePortalTools = shouldEnablePortalTool(userMessage);
    completion = await createNimCompletion({
      messages: buildMessages({
        workspace,
        history,
        userMessage,
        proposal: null,
        allowActions: usePortalTools,
      }),
      ...(usePortalTools ? { tools: [PORTAL_CHANGE_TOOL] } : {}),
      timeoutMs: 80000,
    });
    if (!completion.ok)
      return res.status(completion.status).json({ error: completion.error, code: completion.code });
    completion.content = normalizeAssistantReply(completion.content);
  }
  const eventCandidate = eventSetup
    ? { entity: 'event', action: 'create', data: collectedEvent }
    : null;
  const portalChange = eventSetup
    ? buildPortalChange(eventCandidate, workspace)
    : directChange || buildPortalChange(completion.toolCall, workspace);
  const proposal = portalChange || numericChange || parseProposal(userMessage, workspace);
  if (portalChange || numericChange)
    completion.content = changeReply(portalChange || numericChange);
  if (eventSetup && !portalChange)
    completion.content = clarifyPortalChange(eventCandidate, workspace);
  else if (!completion.content)
    completion.content =
      completion.toolCall && !portalChange
        ? clarifyPortalChange(completion.toolCall, workspace)
        : 'I can help with that. Please tell me what you would like to plan or change.';
  const action = proposal
    ? {
        id: crypto.randomUUID(),
        type: proposal.type,
        from: proposal.from,
        to: proposal.to,
        currency: proposal.currency || workspace.event.currency || '₹',
        summary: portalChange?.summary || null,
        proposal: portalChange || null,
        status: 'pending',
        expiresAt: Date.now() + 15 * 60 * 1000,
      }
    : null;
  res.json({ reply: completion.content, model: completion.model, action });
});
app.post('/api/chat/actions/:actionId', requireAuth, actionLimiter, (req, res) => {
  const decision = req.body?.decision;
  if (!['confirm', 'reject'].includes(decision))
    return res.status(400).json({ error: 'Decision must be confirm or reject.' });
  const proposal = db
    .prepare('SELECT * FROM pending_actions WHERE action_id=? AND user_id=?')
    .get(req.params.actionId, req.user.id);
  if (!proposal) return res.status(404).json({ error: 'This proposed change was not found.' });
  if (proposal.status !== 'pending')
    return res.status(409).json({ error: `This proposal is already ${proposal.status}.` });
  if (proposal.expires_at <= Date.now()) {
    db.prepare("UPDATE pending_actions SET status='expired' WHERE action_id=? AND user_id=?").run(
      proposal.action_id,
      req.user.id,
    );
    db.prepare(
      "UPDATE chat_messages SET action_json=json_set(action_json,'$.status','expired') WHERE user_id=? AND action_json IS NOT NULL AND json_extract(action_json,'$.id')=?",
    ).run(req.user.id, proposal.action_id);
    return res
      .status(410)
      .json({ error: 'This proposal expired. Ask Genie to prepare a fresh one.' });
  }
  const workspaceRow = db
    .prepare('SELECT data,revision FROM workspaces WHERE user_id=?')
    .get(req.user.id);
  const payload = JSON.parse(proposal.payload);
  if (decision === 'reject') {
    const reject = db.transaction(() => {
      db.prepare(
        "UPDATE pending_actions SET status='rejected' WHERE action_id=? AND user_id=? AND status='pending'",
      ).run(proposal.action_id, req.user.id);
      db.prepare(
        "UPDATE chat_messages SET action_json=json_set(action_json,'$.status','rejected') WHERE user_id=? AND action_json IS NOT NULL AND json_extract(action_json,'$.id')=?",
      ).run(req.user.id, proposal.action_id);
    });
    reject();
    return res.json({ ok: true, status: 'rejected' });
  }
  if (!workspaceRow || workspaceRow.revision !== proposal.base_revision) {
    db.prepare("UPDATE pending_actions SET status='conflict' WHERE action_id=? AND user_id=?").run(
      proposal.action_id,
      req.user.id,
    );
    db.prepare(
      "UPDATE chat_messages SET action_json=json_set(action_json,'$.status','conflict') WHERE user_id=? AND action_json IS NOT NULL AND json_extract(action_json,'$.id')=?",
    ).run(req.user.id, proposal.action_id);
    return res.status(409).json({
      error: 'The event changed since Genie proposed this. Review the latest plan and ask again.',
    });
  }
  const workspace = JSON.parse(workspaceRow.data);
  if (proposal.action_type === 'portal_change') {
    try {
      applyPortalChange(workspace, payload);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'The proposed change is invalid.' });
    }
  } else if (proposal.action_type === 'adjust_budget') {
    const target = Number(payload.to);
    if (!Number.isFinite(target) || target <= 0 || target > 1e12)
      return res.status(400).json({ error: 'The proposed budget is invalid.' });
    const planned = workspace.expenses.reduce((sum, item) => sum + Number(item.planned || 0), 0);
    let allocated = 0;
    workspace.expenses.forEach((item, index) => {
      const next =
        index === workspace.expenses.length - 1
          ? 0
          : planned > 0
            ? Math.round((Number(item.planned || 0) / planned) * target)
            : Math.floor(target / workspace.expenses.length);
      item.planned = next;
      allocated += next;
    });
    if (workspace.expenses.length) workspace.expenses.at(-1).planned += target - allocated;
    workspace.event.budget = target;
  } else if (proposal.action_type === 'adjust_guests') {
    const target = Number(payload.to);
    if (!Number.isInteger(target) || target < 1 || target > 100000)
      return res.status(400).json({ error: 'The proposed guest count is invalid.' });
    workspace.event.guests = target;
  } else return res.status(400).json({ error: 'Unsupported proposed action.' });

  const apply = db.transaction(() => {
    const changed = db
      .prepare(
        'UPDATE workspaces SET data=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND revision=?',
      )
      .run(JSON.stringify(workspace), req.user.id, proposal.base_revision);
    if (changed.changes !== 1) throw new Error('Workspace changed while confirming proposal.');
    db.prepare(
      "UPDATE pending_actions SET status='confirmed' WHERE action_id=? AND user_id=? AND status='pending'",
    ).run(proposal.action_id, req.user.id);
    db.prepare(
      "UPDATE chat_messages SET action_json=json_set(action_json,'$.status','confirmed') WHERE user_id=? AND action_json IS NOT NULL AND json_extract(action_json,'$.id')=?",
    ).run(req.user.id, proposal.action_id);
  });
  try {
    apply();
  } catch {
    return res
      .status(409)
      .json({ error: 'The event changed while confirming. Refresh the workspace and try again.' });
  }
  const saved = db.prepare('SELECT revision FROM workspaces WHERE user_id=?').get(req.user.id);
  res.json({ ok: true, status: 'confirmed', workspace, revision: saved.revision });
});

app.use((req, res) =>
  req.path.startsWith('/api/')
    ? res.status(404).json({ error: 'API route not found.' })
    : res.status(404).send('Not found'),
);
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large')
    return res.status(413).json({ error: 'Request payload is too large.' });
  if (err instanceof SyntaxError && 'body' in err)
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

exports.api = onRequest(
  {
    cors: true,
    region: 'us-central1',
    maxInstances: 10,
    timeoutSeconds: 60,
    invoker: 'public',
  },
  app,
);
