'use strict';
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const https   = require('https');

const PORT        = Number(process.env.PORT) || 4321;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD || 'api@dumbfuck123';
const SESSION_KEY = process.env.SESSION_SECRET || ADMIN_PASS + ':session_v1';
const DATA_FILE   = path.join(process.cwd(), 'data.json');
const HTML_DIR    = __dirname;
const USE_DB      = !!(process.env.DATABASE_URL);
const DEMO_HOST   = 'gids.meshapi.ai';
const DEMO_PATH   = '/apps/chat-app/api/chat';

// ── Per-model pricing (USD per token) ────────────────────────────────────────
const PRICING = {
  'anthropic/claude-fable-5':        { in: 15/1e6,   out: 75/1e6  },
  'anthropic/claude-sonnet-5':       { in: 3/1e6,    out: 15/1e6  },
  'anthropic/claude-opus-4.8':       { in: 15/1e6,   out: 75/1e6  },
  'anthropic/claude-opus-4.8-fast':  { in: 15/1e6,   out: 75/1e6  },
  'anthropic/claude-opus-4.7':       { in: 15/1e6,   out: 60/1e6  },
  'anthropic/claude-opus-4.7-fast':  { in: 15/1e6,   out: 60/1e6  },
  'anthropic/claude-opus-4.6':       { in: 15/1e6,   out: 60/1e6  },
  'anthropic/claude-opus-4.5':       { in: 15/1e6,   out: 60/1e6  },
  'anthropic/claude-haiku-4.5':      { in: 0.8/1e6,  out: 4/1e6   },
  'anthropic/claude-3-haiku':        { in: 0.25/1e6, out: 1.25/1e6 },
  'openai/gpt-4o':                   { in: 2.5/1e6,  out: 10/1e6  },
  'openai/gpt-4.1':                  { in: 2/1e6,    out: 8/1e6   },
  'openai/gpt-4.1-mini':             { in: 0.4/1e6,  out: 1.6/1e6 },
  'openai/gpt-4.1-nano':             { in: 0.1/1e6,  out: 0.4/1e6 },
  'openai/gpt-4o-mini':              { in: 0.15/1e6, out: 0.6/1e6 },
  'openai/gpt-4o-search-preview':    { in: 2.5/1e6,  out: 10/1e6  },
  'openai/o4-mini':                  { in: 1.1/1e6,  out: 4.4/1e6 },
  'openai/gpt-3.5-turbo':            { in: 0.5/1e6,  out: 1.5/1e6 },
  'google/gemini-3.1-pro':           { in: 1.25/1e6, out: 5/1e6   },
  'google/gemini-3.1-pro-preview':   { in: 1.25/1e6, out: 5/1e6   },
  'google/gemini-3.5-flash':         { in: 0.3/1e6,  out: 1.0/1e6 },
  'google/gemini-2.5-pro':           { in: 1.25/1e6, out: 10/1e6  },
  'google/gemini-2.5-pro-preview':   { in: 1.25/1e6, out: 10/1e6  },
  'google/gemini-2.5-flash':         { in: 0.3/1e6,  out: 1.0/1e6 },
  'google/gemini-2.5-flash-lite':    { in: 0.1/1e6,  out: 0.4/1e6 },
};
function calcCost(model, promptTok, completionTok) {
  const p = PRICING[model] || { in: 3/1e6, out: 15/1e6 };
  return (promptTok || 0) * p.in + (completionTok || 0) * p.out;
}

// ── Models ────────────────────────────────────────────────────────────────────
const MODELS = Object.keys(PRICING).map(id => ({
  id,
  object: 'model',
  created: 1700000000,
  owned_by: id.split('/')[0],
}));

// ── DB (NeonDB or local JSON file fallback) ───────────────────────────────────
let _sql = null;
function getSql() {
  if (!_sql) {
    const { neon } = require('@neondatabase/serverless');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql;
}

let _dbInited = false;
async function initDB() {
  if (!USE_DB || _dbInited) return;
  const sql = getSql();
  await sql`CREATE TABLE IF NOT EXISTS api_keys (
    id               TEXT             PRIMARY KEY,
    key              TEXT             UNIQUE NOT NULL,
    name             TEXT             NOT NULL DEFAULT 'Unnamed Key',
    status           TEXT             NOT NULL DEFAULT 'active',
    created_at       BIGINT           NOT NULL,
    last_used        BIGINT,
    lim_req_day      INTEGER,
    lim_tok_day      INTEGER,
    lim_tok_total    INTEGER,
    usage_req_total  INTEGER          NOT NULL DEFAULT 0,
    usage_tok_total  INTEGER          NOT NULL DEFAULT 0,
    usage_cost_total DOUBLE PRECISION NOT NULL DEFAULT 0,
    usage_req_today  INTEGER          NOT NULL DEFAULT 0,
    usage_tok_today  INTEGER          NOT NULL DEFAULT 0,
    usage_cost_today DOUBLE PRECISION NOT NULL DEFAULT 0,
    last_reset       TEXT             NOT NULL DEFAULT ''
  )`;
  await sql`CREATE TABLE IF NOT EXISTS usage_logs (
    id               SERIAL           PRIMARY KEY,
    key_id           TEXT             NOT NULL,
    key_name         TEXT             NOT NULL DEFAULT '',
    model            TEXT             NOT NULL,
    prompt_tokens    INTEGER          NOT NULL DEFAULT 0,
    completion_tokens INTEGER         NOT NULL DEFAULT 0,
    cost             DOUBLE PRECISION NOT NULL DEFAULT 0,
    ts               BIGINT           NOT NULL
  )`;
  _dbInited = true;
}

function rowToKey(r) {
  return {
    id: r.id, key: r.key, name: r.name, status: r.status,
    created_at: Number(r.created_at),
    last_used:  r.last_used ? Number(r.last_used) : null,
    limits: { requests_per_day: r.lim_req_day, tokens_per_day: r.lim_tok_day, tokens_total: r.lim_tok_total },
    usage: {
      requests_total: Number(r.usage_req_total), tokens_total: Number(r.usage_tok_total), cost_total: Number(r.usage_cost_total),
      requests_today: Number(r.usage_req_today), tokens_today: Number(r.usage_tok_today), cost_today: Number(r.usage_cost_today),
      last_reset: r.last_reset,
    },
  };
}

// Local file fallback
async function dbRead() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return { keys: [] }; }
}
async function dbWrite(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

// ── Sessions (stateless HMAC — works across serverless cold starts) ────────────
function sessionCreate() {
  const ts  = Date.now().toString(36);
  const sig = crypto.createHmac('sha256', SESSION_KEY).update(ts).digest('hex').slice(0, 24);
  return ts + '.' + sig;
}
function sessionValid(req) {
  const m = (req.headers.cookie || '').match(/mesh_session=([a-z0-9]+\.[a-f0-9]+)/);
  if (!m) return false;
  const [ts, sig] = m[1].split('.');
  if (!ts || !sig) return false;
  if (Date.now() - parseInt(ts, 36) > 86_400_000) return false;
  const expected = crypto.createHmac('sha256', SESSION_KEY).update(ts).digest('hex').slice(0, 24);
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig)); }
  catch { return false; }
}
function requireSession(req, res, next) {
  if (sessionValid(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().slice(0, 10); }
function resetDaily(k) {
  if (k.usage.last_reset !== todayStr()) {
    k.usage.requests_today = k.usage.tokens_today = 0;
    k.usage.cost_today = 0;
    k.usage.last_reset = todayStr();
  }
}

// ── Key CRUD ──────────────────────────────────────────────────────────────────
async function keyList() {
  if (USE_DB) {
    await initDB();
    const rows = await getSql()`SELECT * FROM api_keys ORDER BY created_at DESC`;
    return rows.map(rowToKey);
  }
  return (await dbRead()).keys;
}

async function keyById(id) {
  if (USE_DB) {
    await initDB();
    const rows = await getSql()`SELECT * FROM api_keys WHERE id = ${id}`;
    return rows[0] ? rowToKey(rows[0]) : null;
  }
  return (await dbRead()).keys.find(k => k.id === id) || null;
}

async function keyCreate(name, limits = {}) {
  const id    = crypto.randomBytes(8).toString('hex');
  const key   = 'sk-mesh-' + crypto.randomBytes(20).toString('hex');
  const n     = (name || 'Unnamed Key').slice(0, 80);
  const now   = Date.now();
  const today = todayStr();
  const lrd   = limits.requests_per_day || null;
  const ltd   = limits.tokens_per_day   || null;
  const ltt   = limits.tokens_total     || null;

  if (USE_DB) {
    await initDB();
    const rows = await getSql()`
      INSERT INTO api_keys (id, key, name, status, created_at, lim_req_day, lim_tok_day, lim_tok_total, last_reset)
      VALUES (${id}, ${key}, ${n}, 'active', ${now}, ${lrd}, ${ltd}, ${ltt}, ${today})
      RETURNING *`;
    return rowToKey(rows[0]);
  }

  const d = await dbRead();
  const k = {
    id, key, name: n, status: 'active', created_at: now, last_used: null,
    limits: { requests_per_day: lrd, tokens_per_day: ltd, tokens_total: ltt },
    usage:  { requests_total: 0, tokens_total: 0, cost_total: 0, requests_today: 0, tokens_today: 0, cost_today: 0, last_reset: today },
  };
  d.keys.push(k);
  await dbWrite(d);
  return k;
}

async function keyPatch(id, patch) {
  if (USE_DB) {
    await initDB();
    const sql = getSql();
    const cur = await sql`SELECT * FROM api_keys WHERE id = ${id}`;
    if (!cur[0]) return null;
    const c = cur[0];
    const name   = patch.name   != null ? String(patch.name).slice(0, 80) : c.name;
    const status = patch.status != null ? (patch.status === 'active' ? 'active' : 'revoked') : c.status;
    const lrd    = patch.limits?.requests_per_day !== undefined ? (patch.limits.requests_per_day || null) : c.lim_req_day;
    const ltd    = patch.limits?.tokens_per_day   !== undefined ? (patch.limits.tokens_per_day   || null) : c.lim_tok_day;
    const ltt    = patch.limits?.tokens_total     !== undefined ? (patch.limits.tokens_total     || null) : c.lim_tok_total;
    const rows = await sql`
      UPDATE api_keys SET name=${name}, status=${status}, lim_req_day=${lrd}, lim_tok_day=${ltd}, lim_tok_total=${ltt}
      WHERE id=${id} RETURNING *`;
    return rows[0] ? rowToKey(rows[0]) : null;
  }

  const d = await dbRead();
  const k = d.keys.find(k => k.id === id);
  if (!k) return null;
  if (patch.name   != null) k.name   = String(patch.name).slice(0, 80);
  if (patch.status != null) k.status = patch.status === 'active' ? 'active' : 'revoked';
  if (patch.limits != null)
    for (const f of ['requests_per_day', 'tokens_per_day', 'tokens_total'])
      if (patch.limits[f] !== undefined) k.limits[f] = patch.limits[f] || null;
  await dbWrite(d);
  return k;
}

async function keyDelete(id) {
  // Soft delete — row stays forever with full usage history
  if (USE_DB) {
    await initDB();
    const rows = await getSql()`UPDATE api_keys SET status='deleted' WHERE id=${id} RETURNING id`;
    return rows.length > 0;
  }
  const d = await dbRead();
  const k = d.keys.find(k => k.id === id);
  if (!k) return false;
  k.status = 'deleted';
  await dbWrite(d);
  return true;
}

async function keyAuth(authHeader) {
  const token = String(authHeader || '').replace(/^Bearer\s+/, '').trim();
  if (!token) return { err: 'missing_api_key', status: 401 };

  if (USE_DB) {
    await initDB();
    const today = todayStr();
    const rows = await getSql()`SELECT * FROM api_keys WHERE key=${token}`;
    if (!rows[0])              return { err: 'invalid_api_key', status: 401 };
    const r = rows[0];
    if (r.status !== 'active') return { err: 'revoked_api_key', status: 403 };
    const rToday = r.last_reset === today ? Number(r.usage_req_today) : 0;
    const tToday = r.last_reset === today ? Number(r.usage_tok_today) : 0;
    if (r.lim_req_day   != null && rToday                    >= r.lim_req_day)   return { err: 'daily_request_limit_exceeded', status: 429 };
    if (r.lim_tok_day   != null && tToday                    >= r.lim_tok_day)   return { err: 'daily_token_limit_exceeded',   status: 429 };
    if (r.lim_tok_total != null && Number(r.usage_tok_total) >= r.lim_tok_total) return { err: 'total_token_limit_exceeded',   status: 429 };
    return { id: r.id };
  }

  const d = await dbRead();
  const k = d.keys.find(k => k.key === token);
  if (!k)                    return { err: 'invalid_api_key', status: 401 };
  if (k.status !== 'active') return { err: 'revoked_api_key', status: 403 };
  resetDaily(k);
  if (k.limits.requests_per_day != null && k.usage.requests_today >= k.limits.requests_per_day) return { err: 'daily_request_limit_exceeded', status: 429 };
  if (k.limits.tokens_per_day   != null && k.usage.tokens_today   >= k.limits.tokens_per_day)   return { err: 'daily_token_limit_exceeded',   status: 429 };
  if (k.limits.tokens_total     != null && k.usage.tokens_total   >= k.limits.tokens_total)     return { err: 'total_token_limit_exceeded',   status: 429 };
  await dbWrite(d);
  return { id: k.id };
}

async function keyRecordUsage(keyId, usage, model) {
  const tok  = (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
  const cost = calcCost(model, usage?.prompt_tokens, usage?.completion_tokens);
  const now  = Date.now();
  const today = todayStr();

  if (USE_DB) {
    await initDB();
    const sql = getSql();
    const keyRow = await sql`SELECT name FROM api_keys WHERE id=${keyId}`;
    const keyName = keyRow[0]?.name || '';
    const ptok = usage?.prompt_tokens || 0;
    const ctok = usage?.completion_tokens || 0;
    await Promise.all([
      sql`
        UPDATE api_keys SET
          usage_req_today  = CASE WHEN last_reset=${today} THEN usage_req_today  + 1      ELSE 1      END,
          usage_tok_today  = CASE WHEN last_reset=${today} THEN usage_tok_today  + ${tok}  ELSE ${tok}  END,
          usage_cost_today = CASE WHEN last_reset=${today} THEN usage_cost_today + ${cost} ELSE ${cost} END,
          last_reset       = ${today},
          usage_req_total  = usage_req_total  + 1,
          usage_tok_total  = usage_tok_total  + ${tok},
          usage_cost_total = usage_cost_total + ${cost},
          last_used        = ${now}
        WHERE id = ${keyId}`,
      sql`
        INSERT INTO usage_logs (key_id, key_name, model, prompt_tokens, completion_tokens, cost, ts)
        VALUES (${keyId}, ${keyName}, ${model}, ${ptok}, ${ctok}, ${cost}, ${now})`,
    ]);
    return;
  }

  const d = await dbRead();
  const k = d.keys.find(k => k.id === keyId);
  if (!k) return;
  resetDaily(k);
  k.usage.requests_total++; k.usage.requests_today++;
  k.usage.tokens_total += tok; k.usage.tokens_today += tok;
  k.usage.cost_total   += cost; k.usage.cost_today   += cost;
  k.last_used = now;
  await dbWrite(d);
}

async function getStats() {
  if (USE_DB) {
    await initDB();
    const today = todayStr();
    const rows = await getSql()`
      SELECT
        COUNT(*)                                                              AS total_keys,
        COUNT(*) FILTER (WHERE status = 'active')                            AS active_keys,
        COALESCE(SUM(CASE WHEN last_reset=${today} THEN usage_req_today  ELSE 0 END), 0) AS requests_today,
        COALESCE(SUM(CASE WHEN last_reset=${today} THEN usage_tok_today  ELSE 0 END), 0) AS tokens_today,
        COALESCE(SUM(CASE WHEN last_reset=${today} THEN usage_cost_today ELSE 0 END), 0) AS cost_today
      FROM api_keys`;
    const r = rows[0];
    return {
      total_keys: Number(r.total_keys), active_keys: Number(r.active_keys),
      requests_today: Number(r.requests_today), tokens_today: Number(r.tokens_today), cost_today: Number(r.cost_today),
    };
  }

  const d = await dbRead(); const t = todayStr();
  let active = 0, rToday = 0, tToday = 0, cToday = 0;
  for (const k of d.keys) {
    if (k.status === 'active') active++;
    if (k.usage.last_reset === t) { rToday += k.usage.requests_today; tToday += k.usage.tokens_today; cToday += (k.usage.cost_today || 0); }
  }
  return { total_keys: d.keys.length, active_keys: active, requests_today: rToday, tokens_today: tToday, cost_today: cToday };
}

// ── Proxy ─────────────────────────────────────────────────────────────────────
function proxyToDemo(messages, model, onData, onEnd, onError) {
  const body = JSON.stringify({ messages, model });
  const req  = https.request({
    hostname: DEMO_HOST, path: DEMO_PATH, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Mozilla/5.0' }
  }, res => { res.on('data', onData); res.on('end', onEnd); res.on('error', onError); });
  req.on('error', onError);
  req.write(body); req.end();
}

function sseToCompletion(sse, model) {
  let content = '', id = '', m = model, usage = null, finish = 'stop';
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6).trim();
    if (raw === '[DONE]') continue;
    try {
      const j = JSON.parse(raw);
      if (!id && j.id) id = j.id;
      if (j.model)     m  = j.model;
      if (j.usage)     usage = j.usage;
      const delta = j.choices?.[0]?.delta;
      if (delta?.content) content += delta.content;
      const fr = j.choices?.[0]?.finish_reason;
      if (fr) finish = fr;
    } catch {}
  }
  return {
    id: id || 'chatcmpl-' + Date.now(), object: 'chat.completion',
    created: Math.floor(Date.now() / 1000), model: m,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

function sendFile(res, name) {
  try {
    const html = fs.readFileSync(path.join(HTML_DIR, name), 'utf8');
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    res.send(html);
  } catch { res.status(500).send('Cannot read ' + name); }
}

// ── Auth pages ────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => res.send(loginHTML()));
app.post('/api/login', (req, res) => {
  if (req.body?.password !== ADMIN_PASS) return res.status(401).json({ error: 'Wrong password' });
  const tok = sessionCreate();
  res.setHeader('Set-Cookie', `mesh_session=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'mesh_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ── Dashboard + Docs + Playground ────────────────────────────────────────────
app.get('/',            requireSession, (req, res) => sendFile(res, 'platform.html'));
app.get('/docs',        (req, res) => sendFile(res, 'docs.html'));
app.get('/chat',        (req, res) => sendFile(res, 'chat.html'));
app.get('/playground',  (req, res) => res.redirect('/chat'));

// ── Admin API ─────────────────────────────────────────────────────────────────
app.get('/api/admin/stats',       requireSession, async (req, res) => res.json(await getStats()));
app.get('/api/admin/keys',        requireSession, async (req, res) => res.json(await keyList()));
app.post('/api/admin/keys',       requireSession, async (req, res) => res.status(201).json(await keyCreate(req.body?.name, req.body?.limits)));
app.patch('/api/admin/keys/:id',  requireSession, async (req, res) => {
  const k = await keyPatch(req.params.id, req.body);
  k ? res.json(k) : res.status(404).json({ error: 'not found' });
});
app.delete('/api/admin/keys/:id', requireSession, async (req, res) => {
  const ok = await keyDelete(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

app.get('/api/admin/model-stats', requireSession, async (req, res) => {
  if (!USE_DB) return res.json([]);
  await initDB();
  const rows = await getSql()`
    SELECT model,
           COUNT(*)                              AS requests,
           SUM(prompt_tokens + completion_tokens) AS tokens,
           SUM(cost)                             AS cost
    FROM usage_logs
    GROUP BY model
    ORDER BY cost DESC`;
  res.json(rows.map(r => ({ model: r.model, requests: Number(r.requests), tokens: Number(r.tokens), cost: Number(r.cost) })));
});

app.get('/api/admin/logs', requireSession, async (req, res) => {
  if (!USE_DB) return res.json([]);
  await initDB();
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await getSql()`
    SELECT id, key_id, key_name, model, prompt_tokens, completion_tokens, cost, ts
    FROM usage_logs
    ORDER BY ts DESC
    LIMIT ${limit}`;
  res.json(rows.map(r => ({
    id: Number(r.id), key_id: r.key_id, key_name: r.key_name, model: r.model,
    prompt_tokens: Number(r.prompt_tokens), completion_tokens: Number(r.completion_tokens),
    cost: Number(r.cost), ts: Number(r.ts),
  })));
});

// ── OpenAI-compatible API ──────────────────────────────────────────────────────
app.get('/v1/models', (req, res) => res.json({ object: 'list', data: MODELS }));

app.get('/v1/usage', async (req, res) => {
  const auth = await keyAuth(req.headers.authorization);
  if (auth.err) return res.status(auth.status).json({ error: { message: auth.err } });
  const k = await keyById(auth.id);
  if (!k) return res.status(404).json({ error: { message: 'key_not_found' } });
  res.json({
    name: k.name, status: k.status,
    requests_today: k.usage.requests_today, tokens_today: k.usage.tokens_today, cost_today: k.usage.cost_today || 0,
    requests_total: k.usage.requests_total, tokens_total: k.usage.tokens_total, cost_total: k.usage.cost_total || 0,
    limits: k.limits, last_used: k.last_used,
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  const auth = await keyAuth(req.headers.authorization);
  if (auth.err) return res.status(auth.status).json({ error: { message: auth.err, type: 'error' } });

  const { messages = [], model = 'anthropic/claude-fable-5', stream = true } = req.body || {};

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let buf = '';
    proxyToDemo(messages, model,
      c  => { buf += c.toString(); try { res.write(c); } catch {} },
      () => { const c = sseToCompletion(buf, model); keyRecordUsage(auth.id, c.usage, model); try { res.end(); } catch {} },
      e  => { try { res.write(`data: {"error":{"message":"${e.message.replace(/"/g,'')}"}}\n\ndata: [DONE]\n\n`); res.end(); } catch {} }
    );
  } else {
    let buf = '';
    proxyToDemo(messages, model,
      c  => { buf += c.toString(); },
      () => { const c = sseToCompletion(buf, model); keyRecordUsage(auth.id, c.usage, model); res.json(c); },
      e  => res.status(502).json({ error: { message: e.message, type: 'server_error' } })
    );
  }
});

// ── Local server ──────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  MeshAPI Platform`);
    console.log(`  ─────────────────────────────────────────`);
    console.log(`  Dashboard  →  http://localhost:${PORT}`);
    console.log(`  API Base   →  http://localhost:${PORT}/v1`);
    console.log(`  Docs       →  http://localhost:${PORT}/docs`);
    console.log(`  ─────────────────────────────────────────`);
    console.log(`  Password:  ${ADMIN_PASS}`);
    if (USE_DB) console.log(`  Storage:   NeonDB (PostgreSQL)`);
    else        console.log(`  Storage:   ${DATA_FILE}`);
    console.log();
  });
}
module.exports = app;

// ── Login page ────────────────────────────────────────────────────────────────
function loginHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>MeshAPI Platform</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b0f1a;color:#e0e8f0;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;height:100dvh;display:flex;align-items:center;justify-content:center}
.card{background:#111827;border:1px solid #1f2d40;border-radius:14px;padding:40px;width:380px;max-width:92vw}
.logo{font-size:22px;font-weight:800;letter-spacing:-.03em;margin-bottom:4px}.logo b{color:#f97316}
.sub{font-size:13px;color:#6b7f96;margin-bottom:32px}
label{font-size:11px;font-weight:700;color:#6b7f96;display:block;margin-bottom:7px;text-transform:uppercase;letter-spacing:.08em}
.pw-wrap{position:relative}
input[type=password],input[type=text]{width:100%;background:#1a2436;border:1px solid #1f2d40;border-radius:8px;color:#e0e8f0;font-size:14px;font-family:inherit;padding:12px 42px 12px 14px;outline:none;transition:border-color .15s}
input:focus{border-color:#3b82f6}
.eye{position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;color:#6b7f96;cursor:pointer;padding:2px;display:flex;align-items:center}
.eye:hover{color:#e0e8f0}
.btn{width:100%;margin-top:18px;background:#f97316;border:none;border-radius:8px;color:#fff;font-size:15px;font-weight:700;font-family:inherit;padding:13px;cursor:pointer;transition:background .15s}
.btn:hover{background:#ea6a0a}
.err{color:#f87171;font-size:13px;margin-top:12px;display:none;text-align:center}
</style>
</head>
<body>
<div class="card">
  <div class="logo">Mesh<b>API</b> Platform</div>
  <div class="sub">Sign in to manage API keys and usage</div>
  <label for="pw">Admin Password</label>
  <div class="pw-wrap">
    <input type="password" id="pw" placeholder="••••••••" autocomplete="current-password"/>
    <button class="eye" id="eyeBtn" type="button" onclick="togglePw()" title="Show/hide password">
      <svg id="eyeIcon" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z"/>
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/>
      </svg>
    </button>
  </div>
  <button class="btn" id="btn">Sign In</button>
  <div class="err" id="err">Incorrect password. Try again.</div>
</div>
<script>
function togglePw(){
  var inp=document.getElementById('pw');
  var shown=inp.type==='text';
  inp.type=shown?'password':'text';
  document.getElementById('eyeIcon').innerHTML=shown
    ?'<path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/>'
    :'<path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88"/>';
}
async function login(){
  document.getElementById('err').style.display='none';
  var pw=document.getElementById('pw').value;
  var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
  if(r.ok){window.location='/';}else{document.getElementById('err').style.display='block';}
}
document.getElementById('btn').onclick=login;
document.getElementById('pw').addEventListener('keydown',function(e){if(e.key==='Enter')login();});
</script>
</body>
</html>`;
}
