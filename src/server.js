'use strict';
/**
 * Kira App Server — HTTP API for the Kira mobile app.
 *
 * Runs Kira headless (no TUI) and exposes a small JSON/streaming API that the
 * mobile app (mobile/www) talks to. Also serves the app itself, so opening
 * http://127.0.0.1:7071 in the phone's browser works as an installable PWA.
 *
 *   kira serve            # listen on 127.0.0.1:7071 (this phone only)
 *   kira serve --lan      # listen on 0.0.0.0 (other devices on your Wi-Fi)
 *   kira serve --port N   # custom port (7070 is reserved for KiraService)
 *
 * Every /api route except /api/health requires the app token:
 *   Authorization: Bearer <token>
 * The token is generated on first run and stored in ~/.droidclaw/config.json
 * as `appToken`.
 */

require('./error_boundary').install();

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const config    = require('./config');
const workspace = require('./workspace');
const soul      = require('./core/soul');
const mind      = require('./core/mind');
const nexus     = require('./core/nexus');
const engine    = require('./core/engine');
const heartbeat = require('./core/heartbeat');
const loop      = require('./core/loop');

// Load tools (same set as the TUI)
for (const t of ['exec', 'memory', 'realworld', 'kiraservice', 'semantic_memory', 'social',
                 'self_modify', 'google', 'search', 'web_fetch', 'task_tools']) {
  try { require('./tools/' + t); } catch (e) { console.error(`tool ${t} failed to load: ${e.message}`); }
}
try { require('./tools/skills/loader').loadAll(); } catch {}
try { require('./world_model_loop'); } catch {}

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const LAN  = argv.includes('--lan');
const portIdx = argv.indexOf('--port');
const PORT = parseInt(portIdx !== -1 ? argv[portIdx + 1] : process.env.KIRA_APP_PORT, 10) || 7071;
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const WWW  = path.join(__dirname, '..', 'mobile', 'www');

// ── auth token ────────────────────────────────────────────────────────────────
function getToken() {
  let token = config.get('appToken');
  if (!token) {
    token = crypto.randomBytes(18).toString('base64url');
    config.set('appToken', token);
  }
  return token;
}

function authorized(req) {
  const h = req.headers['authorization'] || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  const want  = getToken();
  if (!given || given.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

// ── helpers ───────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',   '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(WWW, rel));
  if (!file.startsWith(WWW + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// Filters <think>…</think> and <tool:…>…</tool> out of the token stream,
// exactly like the TUI does, so the app only sees clean text.
function makeTokenFilter(emit) {
  let buf = '', inTool = false, inThink = false;
  return {
    push(token) {
      buf += token;
      for (;;) {
        if (inThink) {
          const i = buf.indexOf('</think>');
          if (i === -1) return;
          buf = buf.slice(i + 8); inThink = false; continue;
        }
        if (inTool) {
          const i = buf.indexOf('</tool>');
          if (i === -1) return;
          buf = buf.slice(i + 7); inTool = false; continue;
        }
        const t = buf.indexOf('<think>');
        const u = buf.indexOf('<tool:');
        const next = [t, u].filter(x => x !== -1).sort((a, b) => a - b)[0];
        if (next === undefined) {
          // hold back a possible partial tag at the end
          const lt = buf.lastIndexOf('<');
          if (lt !== -1 && buf.length - lt < 8 && !buf.slice(lt).includes('>')) {
            if (lt > 0) emit(buf.slice(0, lt));
            buf = buf.slice(lt);
          } else {
            if (buf) emit(buf);
            buf = '';
          }
          return;
        }
        if (next > 0) emit(buf.slice(0, next));
        if (next === t) { inThink = true; buf = buf.slice(t + 7); }
        else            { inTool  = true; buf = buf.slice(u + 6); }
      }
    },
    reset() { buf = ''; inTool = false; inThink = false; },
  };
}

let _busy = false;

function friendlyError(msg) {
  let m = String(msg || '');
  // Pull the human-readable "message" out of a JSON error body if present
  const inner = m.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (inner) m = m.replace(/:\s*[\[{][\s\S]*$/, '') + ': ' + inner[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
  if (/API 40[13]/.test(m) || /API key not valid|invalid api key|PERMISSION_DENIED/i.test(m))
    return 'AI provider rejected the API key — check it in Settings. (' + m.slice(0, 400) + ')';
  if (/API 404/.test(m) || /not found|does not exist/i.test(m))
    return 'model not found — check the model name in Settings. (' + m.slice(0, 400) + ')';
  if (/API 50[0234]/.test(m) || /high demand|overloaded|unavailable/i.test(m))
    return 'the AI is busy right now (too many people using it). Kira tried a few times — wait a minute and send again.';
  if (/API 429/.test(m) || /quota|rate/i.test(m))
    return 'free limit reached — wait a bit and try again. (' + m.slice(0, 400) + ')';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(m))
    return "can't reach the AI provider — check your internet or the API base URL.";
  return m.slice(0, 300);
}

// ── chat (streams NDJSON events) ──────────────────────────────────────────────
async function handleChat(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
  const message = String(body.message || '').trim();
  if (!message) return json(res, 400, { error: 'message is required' });
  if (message.length > 8000) return json(res, 400, { error: 'message too long' });
  if (!config.get('apiKey')) return json(res, 412, { error: 'no API key set — open Settings in the app' });
  if (_busy) return json(res, 409, { error: 'kira is still answering the previous message' });

  _busy = true;
  engine.lastError = null;
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  const send = (ev) => { try { res.write(JSON.stringify(ev) + '\n'); } catch {} };
  const filter = makeTokenFilter(text => send({ type: 'token', text }));

  let closed = false;
  res.on('close', () => { if (!res.writableEnded) { closed = true; loop.abort(); } });

  try {
    await loop.run(
      message,
      () => send({ type: 'thinking' }),
      (tok) => filter.push(tok),
      (name, args, result) => {
        if (result === null || result === undefined || result === '') {
          filter.reset();
          send({ type: 'tool_start', name, args: JSON.stringify(args || {}).slice(0, 200) });
        } else {
          send({ type: 'tool', name, result: String(result).slice(0, 400) });
        }
      },
      (reply, aborted) => {
        if (!aborted && !(reply || '').trim() && engine.lastError) {
          send({ type: 'error', error: friendlyError(engine.lastError) });
        }
        send({ type: 'done', reply: reply || '', aborted: !!aborted });
      }
    );
  } catch (e) {
    send({ type: 'error', error: e.message });
  } finally {
    _busy = false;
    if (!closed) res.end();
  }
}

// ── status / thoughts / config ────────────────────────────────────────────────
function status() {
  const cfg = config.load();
  let mstats = {};
  try { mstats = mind.stats(); } catch {}
  return {
    name:     'Kira',
    user:     cfg.name,
    model:    cfg.model,
    baseUrl:  cfg.baseUrl,
    hasKey:   !!cfg.apiKey,
    telegram: !!cfg.telegramToken,
    busy:     _busy,
    heartbeat: heartbeat.info(),
    turns:    engine.stats().turns,
    mind:     mstats,
  };
}

function thoughts() {
  const pick = (type, n) => {
    try {
      return mind.getKiraState(type).slice(0, n).map(k => ({ value: k.value, at: k.created_at || null }));
    } catch { return []; }
  };
  let mood = 'neutral';
  try { mood = mind.getMood(); } catch {}
  return {
    mood,
    thoughts:      pick('thought', 10),
    observations:  pick('observation', 10),
    uncertainties: pick('uncertainty', 5),
  };
}

function history() {
  try {
    return mind.getRecentConversations(1)
      .filter(c => c.role === 'user' || c.role === 'assistant')
      .slice(-60)
      .map(c => ({ role: c.role, content: c.content, at: c.created_at }));
  } catch { return []; }
}

const EDITABLE = ['name', 'baseUrl', 'model', 'apiKey'];
async function updateConfig(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
  const cfg = { ...config.load() };
  for (const k of EDITABLE) {
    if (typeof body[k] !== 'string') continue;
    const v = body[k].trim();
    if (k === 'apiKey' && !v) continue; // empty = keep existing key
    if (k === 'baseUrl' && v && !/^https?:\/\//.test(v)) return json(res, 400, { error: 'baseUrl must start with http(s)://' });
    if (v) cfg[k] = v;
  }
  cfg.setupDone = true;
  config.save(cfg);
  config.invalidate();
  return json(res, 200, status());
}

// ── router ────────────────────────────────────────────────────────────────────
async function route(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const { pathname } = new URL(req.url, 'http://x');
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res);
  }

  if (pathname === '/api/health') return json(res, 200, { status: 'ok', app: 'kira' });
  if (!authorized(req)) return json(res, 401, { error: 'unauthorized — check the app token' });

  const key = `${req.method} ${pathname}`;
  switch (key) {
    case 'GET /api/status':   return json(res, 200, status());
    case 'GET /api/thoughts': return json(res, 200, thoughts());
    case 'GET /api/history':  return json(res, 200, { messages: history() });
    case 'POST /api/chat':    return handleChat(req, res);
    case 'POST /api/abort':   return json(res, 200, { aborted: loop.abort() });
    case 'POST /api/clear':   engine.clearHistory(); return json(res, 200, { ok: true });
    case 'POST /api/config':  return updateConfig(req, res);
    default:                  return json(res, 404, { error: 'not found' });
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function main() {
  mind.init();
  try { mind.migrateFromJSON(); } catch {}
  workspace.init();
  engine.init(soul);
  // heartbeat.start() installs its own exit-on-SIGINT handler; we only need the clock
  heartbeat.startTime = new Date();
  heartbeat.status    = 'alive';

  const token  = getToken();
  const server = http.createServer((req, res) => {
    route(req, res).catch(e => { try { json(res, 500, { error: e.message }); } catch {} });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`port ${PORT} is already in use — is "kira serve" already running?`);
    else console.error(e.message);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const urls = [`http://127.0.0.1:${PORT}`];
    if (LAN) lanAddresses().forEach(ip => urls.push(`http://${ip}:${PORT}`));
    console.log('');
    console.log('  ◈ Kira app server running');
    console.log('');
    urls.forEach(u => console.log(`    open:  ${u}/#token=${token}`));
    console.log('');
    console.log(`    token: ${token}`);
    console.log('');
    console.log('  Open the link in Chrome, or paste the server URL + token into the Kira app.');
    if (!config.get('apiKey')) console.log('  No API key yet — set one in the app under Settings.');
    console.log('  Ctrl+C to stop.');
    console.log('');
  });

  // Telegram keeps working in server mode if configured
  try {
    if (config.get('telegramToken')) require('./integrations/telegram').start(m => console.log('tg: ' + m));
  } catch {}
}

let _shuttingDown = false;
async function shutdown() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log('saving…');
  try {
    loop.abort();
    await soul.updateDocs(engine);
    await nexus.sleep(engine);
    mind.flush && mind.flush();
  } catch {}
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

if (require.main === module) main();

module.exports = { makeTokenFilter, route };
