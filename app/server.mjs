// Foundry window server — private, this PC only, no logins.
// Usage: node server.mjs [--open]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';
import { doorOk } from './security.mjs';
import * as F from './lib.mjs';
import * as U from './usage.mjs';
import * as H from './hopper/hopper.mjs';
import * as HP from './hopper/proxy.mjs';
import * as HW from './hopper/watcher.mjs';
import * as BP from './hopper/bench-ports.mjs';
import * as HUB from './hub/hub.mjs';
import { AGY, dispatch, sweepInterrupted } from './dispatch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Launched through a junction or with different letter case (Live Match, the vbs, the old scratch path),
// argv[1] and import.meta.url can name the same file differently, so compare real paths, case-blind.
const realLow = (p) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };
const IS_MAIN = Boolean(process.argv[1] && realLow(process.argv[1]) === realLow(fileURLToPath(import.meta.url)));
const PORT = CONFIG.port;
const HOST = CONFIG.host;
const URL_ = `http://${HOST}:${PORT}/`;
const OPEN = process.argv.includes('--open');

function openWindow() {
  const edges = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const edge = edges.find((p) => fs.existsSync(p));
  if (edge) spawn(edge, [`--app=${URL_}`, '--window-size=1500,960'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('cmd', ['/c', 'start', '', URL_], { detached: true, stdio: 'ignore' }).unref();
}

// ---------- live updates (SSE) ----------
const clients = new Set();

const clock = (iso) => { try { return new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

// On-click Antigravity quota pull (never auto-polled): spawns one lightweight Flash-Low turn
// in os.tmpdir() to read official live quotas from swarm(action="models", all=true).
let agyRefreshInFlight = null;
function parseQuotaPct(v) {
  const m = String(v ?? '').match(/(\d+(?:\.\d+)?)/);
  return m ? Math.max(0, Math.min(100, Math.round(Number(m[1])))) : null;
}
function pickQuota(quotas, preferred, matchFn) {
  for (const k of preferred) if (quotas[k]) return quotas[k];
  for (const [k, v] of Object.entries(quotas)) if (matchFn(k)) return v;
  return null;
}
function parseAgyQuotas(stdout) {
  const raw = stdout.trim();
  let resp = raw;
  try {
    const outer = JSON.parse(raw);
    if (typeof outer?.response === 'string') resp = outer.response;
  } catch {
    for (const line of raw.split('\n').reverse()) {
      try { const j = JSON.parse(line); if (typeof j?.response === 'string') { resp = j.response; break; } } catch {}
    }
  }
  const cleaned = resp.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(cleaned);
  return parsed?.quotas && typeof parsed.quotas === 'object' ? parsed.quotas : parsed;
}
function pullAgyUsage() {
  if (agyRefreshInFlight) return agyRefreshInFlight;
  if (!AGY) return Promise.resolve({ ok: false, error: 'Antigravity CLI (agy) not found' });
  agyRefreshInFlight = new Promise((resolve) => {
    const prompt = 'Call the swarm tool once with action="models" and all=true. Reply with ONLY the raw JSON object of the quotas field, no markdown or extra text.';
    const child = spawn(AGY, ['-p', prompt, '--model', 'gemini-3.8-flash-low', '--output-format', 'json', '--disable-slash-commands', '--print-timeout', '60s'], {
      cwd: os.tmpdir(), windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const finish = (code) => {
      agyRefreshInFlight = null;
      if (code !== 0) return resolve({ ok: false, error: (err || out || `exit ${code}`).slice(-300) });
      try {
        const quotas = parseAgyQuotas(out);
        if (!quotas || typeof quotas !== 'object') throw new Error('No quotas object returned');
        const updated = [];
        const qGem = pickQuota(quotas, ['gemini-4-neon-medium', 'gemini-4-neon-high', 'gemini-4-hydrogen-medium', 'gemini-3.8-flash-medium'], (k) => /neon|hydrogen|flash/i.test(k));
        if (qGem) {
          const rem = parseQuotaPct(qGem.quota_remaining);
          if (rem !== null) {
            const rst = qGem.quota_resets ? `resets ${clock(qGem.quota_resets)}` : '';
            U.writePoolReading('agy-gemini', { pct: rem, fiveHourPct: rem, fiveHourReset: rst, weekPct: null, weekReset: 'in AGY Settings', note: `5h tank · Neon / Hydrogen / Flash` });
            updated.push('agy-gemini');
          }
        }
        const qArg = pickQuota(quotas, ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-pro-orchestrator-g1-pro'], (k) => /argon|g1-pro/i.test(k));
        if (qArg) {
          const rem = parseQuotaPct(qArg.quota_remaining);
          if (rem !== null) {
            const rst = qArg.quota_resets ? `resets ${clock(qArg.quota_resets)}` : '';
            U.writePoolReading('agy-argon', { pct: rem, fiveHourPct: null, fiveHourReset: 'weekly pool', weekPct: rem, weekReset: rst, note: `weekly tank · Argon / Orchestrator (Argon)` });
            updated.push('agy-argon');
          }
        }
        const qCl = pickQuota(quotas, ['claude-opus-5-5-medium', 'claude-sonnet-5-5-medium', 'claude-opus-5-5-high', 'gpt-oss-120b-medium'], (k) => /claude|gpt-oss/i.test(k));
        if (qCl) {
          const rem = parseQuotaPct(qCl.quota_remaining);
          if (rem !== null) {
            const rst = qCl.quota_resets ? `resets ${clock(qCl.quota_resets)}` : '';
            U.writePoolReading('agy-claude', { pct: rem, fiveHourPct: null, fiveHourReset: 'weekly pool', weekPct: rem, weekReset: rst, note: `weekly tank · Claude Opus/Sonnet & GPT-OSS` });
            updated.push('agy-claude');
          }
        }
        resolve({ ok: updated.length > 0, updated });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    };
    child.on('error', (e) => { err += e.message; finish(-1); });
    child.on('close', finish);
  });
  return agyRefreshInFlight;
}
let pending = null;
// The window stays current (Nov 24): a change throws away the saved board, builds the new one once, and only then
// tells every open window, so the window's refresh gets the new board, never the old saved copy.
function broadcast() {
  F.clearCaches();
  invalidateBoardCache();
  HUB.invalidateHubCache();
  clearTimeout(pending);
  pending = setTimeout(async () => {
    invalidateBoardCache();
    HUB.invalidateHubCache();
    try { await getBoardCore(); } catch {}
    for (const res of clients) res.write(`data: change\n\n`);
    F.writeContextFile().catch(() => {});
  }, 700);
}
// Each start of the window server has its own id, so an open window can tell it's talking to a new server
// (after a Move to core restarts it) and reload itself onto the new page.
const BOOT = `${Date.now().toString(36)}-${process.pid}`;
if (IS_MAIN) {
  try {
    fs.watch(F.FOUNDRY, { recursive: true }, (_e, file) => {
      if (!file) return;
      const f = String(file).replace(/\\/g, '/');
      if ((f.startsWith('state/hopper/cards/') || f === 'state/hopper/caretaker.json' || f === 'state/hopper/playbook.json' || f === 'state/foundry-hub/ack.json') && f.endsWith('.json')) { broadcast(); return; }
      if (f.startsWith('state/') || f.includes('node_modules/') || f.endsWith('.foundry/CONTEXT.md') || f.endsWith('.tmp') || f.endsWith('.lock')) return;
      if (f.includes('/.git/') && !f.endsWith('/.git/HEAD') && !f.includes('/.git/refs/heads/')) return;
      broadcast();
    });
  } catch (e) { console.error('watch failed', e.message); }
}

// ---------- helpers ----------
const send = (res, code, body, type = 'application/json') => {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': type === 'application/json' ? 'application/json; charset=utf-8' : type, 'Cache-Control': 'no-store' });
  res.end(payload);
};
const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const TEXT_EXT = new Set(['.md','.markdown','.txt','.yaml','.yml','.json','.jsonl','.js','.mjs','.cjs','.ts','.tsx','.jsx','.html','.htm','.css','.scss','.py','.ps1','.sh','.cmd','.bat','.vbs','.env','.ini','.toml','.xml','.csv','.log','.gitignore','.gitattributes','.sql','.rs','.go','.c','.h','.cpp','.java']);

function decodeText(buf, ext) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.subarray(2).toString('utf16le');
  if (!TEXT_EXT.has(ext)) {
    const sample = buf.subarray(0, 4096);
    let bad = 0;
    for (const b of sample) if (b === 0 || (b < 7 || (b > 14 && b < 32))) bad++;
    if (sample.length && bad / sample.length > 0.1) return null;
  }
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return s.replace(/\0/g, '');
}

const ROOT_ORDER = { lab: 0, core: 1, public: 2, state: 3 };

async function listDir(rel) {
  const abs = F.toAbs(rel);
  const pins = F.getPins();
  const flags = F.getFlags();
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((d) => !F.HIDDEN.has(d.name) && !(rel === '' && (d.name.startsWith('.') || d.name === 'workspaces')))
    .sort((a, b) => {
      if (rel === '' && a.isDirectory() && b.isDirectory()) {
        const oa = ROOT_ORDER[a.name] ?? 99, ob = ROOT_ORDER[b.name] ?? 99;
        if (oa !== ob) return oa - ob;
      }
      return (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  return Promise.all(entries.map(async (d) => {
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    const isDir = d.isDirectory();
    const item = {
      name: d.name, path: childRel, dir: isDir,
      pinned: pins.some((p) => p.path === childRel),
      pinnedInside: pins.some((p) => p.path.startsWith(childRel + '/')),
      flags: flags.filter((f) => f.path === childRel || f.path.startsWith(childRel + '/')).length,
    };
    if (isDir && F.isRepo(path.join(abs, d.name))) {
      const info = await F.repoInfo(childRel);
      item.repo = { changes: info.changes, version: info.version };
      if (rel === 'lab') {
        const s = await F.labVsCore(d.name);
        item.repo.ahead = s.ahead; item.repo.state = s.state;
      }
    }
    return item;
  }));
}

async function focusInfo(rel) {
  const abs = F.toAbs(rel);
  const st = fs.statSync(abs);
  const info = { path: rel, dir: st.isDirectory(), size: st.size, modified: st.mtime };
  if (info.dir) {
    if (F.isRepo(abs)) {
      const [room, name] = rel.split('/');
      info.repo = { ...(await F.repoInfo(rel, { fresh: true })), room };
      if (room === 'lab') info.repo.vs = await F.labVsCore(name);
      if (room === 'core') info.repo.canRollback = !!F.lastPromotion(name);
    }
    const kids = fs.readdirSync(abs).filter((n) => !F.HIDDEN.has(n));
    info.count = kids.length;
    const readme = kids.find((n) => /^(readme|start|brief)\.md$/i.test(n));
    if (readme) info.readme = { name: readme, text: fs.readFileSync(path.join(abs, readme), 'utf8').slice(0, 20000) };
  } else {
    const ext = path.extname(abs).toLowerCase();
    if (MIME[ext]) info.image = true;
    else if (st.size > 1_000_000) info.tooBig = true;
    else {
      const text = decodeText(fs.readFileSync(abs), ext);
      if (text === null) info.binary = true;
      else info.text = text;
    }
  }
  return info;
}

function openInExplorer(rel) {
  const abs = F.toAbs(rel);
  const args = fs.statSync(abs).isDirectory() ? [abs] : [`/select,${abs}`];
  spawn('explorer.exe', args, { detached: true, stdio: 'ignore' }).unref();
}

// ---------- routes ----------
// Host & Origin security guard imported from ./security.mjs (127.0.0.1, localhost, [::1], *.ts.net, allowHosts).
const MEDIA_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const DEFAULT_PLAYBOOK = {
  items: [
    {
      title: 'Name the itch, not a spec',
      body: 'What feels annoying or what 3-second moment you wish you had. knowing the *why* lets your AI pit 2–3 real angles against each other.',
    },
    {
      title: "Where you'll hold it",
      body: '*Thumb at work · Desktop at night · Inside Floor/Schedule · Not sure yet.*',
    },
    {
      title: 'Pick your swing style',
      body: '*Explore angles (2–3 wild contenders) · Upgrade ours · Prototype · Deep scout.*',
    },
    {
      title: 'Any gut "don\'t"',
      body: 'One quick line like *"don\'t make it feel like homework"* or *"keep it dead simple."*',
    },
  ],
  note: 'Raw one-line voice dumps from work are always enough — never hold back a spark.',
};

function playbookFile() {
  return path.join(H.HOPPER_DIR, 'playbook.json');
}

function readPlaybook() {
  try {
    const raw = JSON.parse(fs.readFileSync(playbookFile(), 'utf8'));
    if (raw && Array.isArray(raw.items) && raw.items.length > 0) {
      const items = raw.items
        .map((it) => ({
          title: String(it?.title || '').trim(),
          body: String(it?.body || '').trim(),
        }))
        .filter((it) => it.title || it.body);
      if (items.length > 0) {
        return {
          items,
          note: typeof raw.note === 'string' ? raw.note.trim() : DEFAULT_PLAYBOOK.note,
          updatedAt: raw.updatedAt || null,
        };
      }
    }
  } catch {}
  return {
    items: DEFAULT_PLAYBOOK.items.map((it) => ({ ...it })),
    note: DEFAULT_PLAYBOOK.note,
    updatedAt: null,
  };
}

function writePlaybook(payload = {}) {
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items = rawItems
    .slice(0, 12)
    .map((it) => ({
      title: String(it?.title || '').trim().slice(0, 140),
      body: String(it?.body || '').trim().slice(0, 500),
    }))
    .filter((it) => it.title || it.body);
  if (!items.length) throw new Error('Drop Framework needs at least one point.');
  const note = typeof payload.note === 'string'
    ? payload.note.trim().slice(0, 280)
    : DEFAULT_PLAYBOOK.note;
  const saved = { items, note, updatedAt: F.now() };
  const file = playbookFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(saved, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return saved;
}

export async function hopperSnapshot() {
  const all = H.listCards();
  const benchRaw = all.filter((c) => c.stage === 'bench');
  const bpStatus = BP.status();
  const usedSlots = new Set(benchRaw.map((c) => c.benchSlot).filter((s) => Number.isInteger(s) && s >= 1 && s <= H.LIMITS.bench));
  let nextFallback = 1;
  const bench = await Promise.all(benchRaw.map(async (c) => {
    let slot = Number.isInteger(c.benchSlot) && c.benchSlot >= 1 && c.benchSlot <= H.LIMITS.bench ? c.benchSlot : null;
    if (!slot) {
      while (usedSlots.has(nextFallback) && nextFallback <= H.LIMITS.bench) nextFallback++;
      if (nextFallback <= H.LIMITS.bench) { slot = nextFallback; usedSlots.add(slot); }
    }
    const t = HP.parseLiveTarget(c);
    const hasBoot = Boolean(c.showroom?.bootRecipe);
    const slotInfo = slot ? bpStatus[slot] : null;
    const activePort = slotInfo?.active?.cardId === c.id ? slotInfo.active.port : null;
    const liveUp = activePort
      ? await HP.probePort(activePort)
      : (t.kind === 'http' ? await HP.probePort(t.port) : (hasBoot ? false : true));
    const liveKind = (hasBoot || t.kind === 'http') ? 'web' : (t.kind === 'blocked' ? 'blocked' : 'read');
    return {
      ...c,
      benchSlot: slot,
      benchPort: slot ? (slotInfo?.boundPort || (7990 + slot)) : null,
      liveMount: `/hopper/live/${c.id}/`,
      liveKind,
      liveUp,
      bootable: hasBoot,
    };
  }));
  const running = all.filter((c) => c.stage === 'running');
  const halted = all.filter((c) => c.stage === 'halted');
  const queue = all.filter((c) => c.stage === 'hopper').map((c) => ({
    ...c,
    runNowRequested: Boolean(c.runNowAt),
  }));
  const parked = all.filter((c) => c.stage === 'parked');
  const lab = all.filter((c) => c.stage === 'lab');
  const graveyard = all.filter((c) => c.stage === 'ended')
    .sort((a, b) => String(b.updated || b.at).localeCompare(String(a.updated || a.at)));
  const caretaker = HW.status();
  return {
    limits: H.LIMITS,
    modes: H.MODES,
    hints: H.HINTS,
    bench,
    running,
    halted,
    queue,
    parked,
    lab,
    graveyard,
    caretaker,
    watcher: caretaker,
    benchPorts: bpStatus,
    playbook: readPlaybook(),
  };
}

function serveHopperMedia(res, id, rawFile) {
  let file;
  try { file = decodeURIComponent(rawFile); } catch { return send(res, 400, { error: 'bad media path' }); }
  if (!file || !/^[a-zA-Z0-9._-]+$/.test(file) || file.includes('..') || path.basename(file) !== file) {
    return send(res, 400, { error: 'invalid media filename' });
  }
  const ext = path.extname(file).toLowerCase();
  const mime = MEDIA_MIME[ext];
  if (!mime) return send(res, 415, { error: 'unsupported media type' });
  const mediaRoot = path.resolve(H.HOPPER_DIR, 'media', id);
  const abs = path.resolve(mediaRoot, file);
  if (!abs.toLowerCase().startsWith(mediaRoot.toLowerCase() + path.sep)) {
    return send(res, 403, { error: 'forbidden media path' });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return send(res, 404, { error: 'media not found' });
  }
  return send(res, 200, fs.readFileSync(abs), mime);
}

async function openChopRoom(id) {
  const card = H.getCard(id);
  const floorBase = String(process.env.HOPPER_FLOOR_URL || process.env.FLOOR_URL || CONFIG.surfaces.floorUrl || 'http://127.0.0.1:7960').replace(/\/+$/, '');
  const roomName = `chop-${card.id}`;
  if (card.chopRoomId) {
    return { ok: true, roomId: card.chopRoomId, roomName, floorUrl: `${floorBase}/`, reused: true };
  }
  const slot = Number.isInteger(card.benchSlot) ? card.benchSlot : null;
  const benchUrl = slot ? `http://127.0.0.1:${7990 + slot}/` : (card.live || `/hopper/live/${card.id}/`);
  const itch = card.showroom?.itch || card.drop;
  const swing = card.showroom?.swing || card.bet || '—';
  const weakest = card.showroom?.weakestSpot || card.weakest || '—';
  const checkinSummary = H.formatCheckinBrief(card);
  const openingText = [
    `Hopper Chop — ${card.id}: ${card.drop}`,
    `Bench URL: ${benchUrl}`,
    `The Itch: ${itch}`,
    `Our Swing: ${swing}`,
    `Weakest Spot: ${weakest}`,
    ...(checkinSummary ? ['', 'Check-In:', checkinSummary] : []),
  ].join('\n');

  // Match configured Foundry crew IDs against Floor's live enabled agents so default configs pair cleanly.
  let members = CONFIG.crew.slice(0, 3).map((c) => c.id);
  try {
    const ar = await fetch(`${floorBase}/api/agents`, { signal: AbortSignal.timeout(3000) });
    if (ar.ok) {
      const ad = await ar.json();
      const enabled = (ad.agents || []).filter((a) => !a.disabled).map((a) => a.id);
      if (enabled.length) {
        const matched = members.filter((id) => enabled.includes(id));
        members = matched.length ? matched : enabled.slice(0, 3);
      }
    }
  } catch {}

  const r = await fetch(`${floorBase}/api/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'room',
      name: roomName,
      members,
      openingText,
      frameWithFramer: false,
    }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Floor returned HTTP ${r.status}`);
  const roomId = data.id || data.channel?.id;
  if (!roomId) throw new Error('Floor did not return a room id.');
  H.setChopRoom(card.id, roomId, { by: 'you' });
  return { ok: true, roomId, roomName, floorUrl: `${floorBase}/`, reused: false };
}

// Single-flight + short TTL cache for /api/board so concurrent polls (browser + Live Match)
// never stampede 100+ git.exe processes on Windows. Invalidated on every POST mutation and every file change.
let boardCache = { at: 0, data: null };
let boardInFlight = null;
function invalidateBoardCache() { boardCache = { at: 0, data: null }; }
async function getBoardCore() {
  if (boardCache.data && (Date.now() - boardCache.at) < 4000) return boardCache.data;
  if (!boardInFlight) {
    boardInFlight = (async () => {
      const memo = new Map();
      const [attention, standings] = await Promise.all([
        F.attention({ memo }),
        F.standings({ memo }),
      ]);
      const data = { attention, standings };
      boardCache = { at: Date.now(), data };
      return data;
    })().finally(() => { boardInFlight = null; });
  }
  return await boardInFlight;
}

const server = http.createServer(async (req, res) => {
  if (!doorOk(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Not from here.'); }
  const u = new URL(req.url, URL_);
  const q = Object.fromEntries(u.searchParams);
  try {
    const liveMatch = u.pathname.match(/^\/hopper\/live\/(h\d{3,})(\/.*)?$/);
    if (liveMatch) {
      return await HP.handleLiveRequest(req, res, liveMatch[1], liveMatch[2] || '/');
    }
    if (u.pathname === '/' || u.pathname === '/index.html')
      return send(res, 200, fs.readFileSync(path.join(HERE, 'index.html')), 'text/html; charset=utf-8');
    if ((req.method === 'GET' || req.method === 'HEAD') && (u.pathname === '/hub' || u.pathname.startsWith('/hub/'))) {
      if (HUB.serveHubAsset(u.pathname, res)) return;
    }
    if (u.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: hello ${BOOT}\n\n`);
      clients.add(res);
      // a heartbeat, so a window can tell a quiet line from a dead one
      const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch {} }, 20000);
      beat.unref?.();
      req.on('close', () => { clearInterval(beat); clients.delete(res); });
      return;
    }
    if (req.method === 'GET') {
      if (u.pathname === '/api/health') return send(res, 200, { ok: true, service: 'foundry-window', port: PORT });
      if (u.pathname === '/api/tree') return send(res, 200, await listDir(F.normRel(q.path || '')));
      if (u.pathname === '/api/board') {
        const [{ attention, standings }, activity] = await Promise.all([
          getBoardCore(),
          q.filter || q.log === '1' ? F.getActivity({ filter: q.filter ? F.normRel(q.filter) : '', max: 40 }) : Promise.resolve([]),
        ]);
        return send(res, 200, {
          home: F.FOUNDRY, title: CONFIG.title, crew: CONFIG.crew, agy: !!AGY,
          pins: F.getPins(),
          blocks: F.getBlocks(),
          attention,
          standings,
          activity,
        });
      }
      if (u.pathname === '/api/focus') return send(res, 200, await focusInfo(F.normRel(q.path || '')));
      if (u.pathname === '/api/hopper') return send(res, 200, await hopperSnapshot());
      if (u.pathname === '/api/hub') return send(res, 200, await HUB.getHubState({ getBoardCore, hopperSnapshot, fresh: q.fresh === '1' }));
      const mediaMatch = u.pathname.match(/^\/api\/hopper\/media\/(h\d{3,})\/([^/]+)$/);
      if (mediaMatch) return serveHopperMedia(res, mediaMatch[1], mediaMatch[2]);
      if (u.pathname === '/api/usage') return send(res, 200, U.getUsage());
      if (u.pathname === '/api/raw') {
        const abs = F.toAbs(q.path);
        return send(res, 200, fs.readFileSync(abs), MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
      }
      if (u.pathname === '/api/context') return send(res, 200, await F.writeContextFile(), 'text/markdown; charset=utf-8');
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      const done = (v) => { invalidateBoardCache(); broadcast(); send(res, 200, v ?? { ok: true }); };
      if (u.pathname === '/api/usage/open-config') {
        U.ensureUsageConfig();
        spawn('explorer.exe', [`/select,${U.USAGE_CONFIG}`], { detached: true, stdio: 'ignore' }).unref();
        return send(res, 200, { ok: true, path: U.USAGE_CONFIG });
      }
      if (u.pathname === '/api/usage/refresh') {
        const [agyRes] = await Promise.all([pullAgyUsage()]);
        broadcast();
        return send(res, 200, { ...agyRes, usage: U.getUsage() });
      }
      if (u.pathname.startsWith('/api/usage/')) {
        const id = decodeURIComponent(u.pathname.slice('/api/usage/'.length));
        return done(U.writePoolReading(id, b));
      }
      switch (u.pathname) {
        case '/api/pin': return done(F.pin(b.path, b.note || '', 'you'));
        case '/api/unpin': return done(F.unpin(b.path, 'you'));
        case '/api/flag': {
          const target = b.for || 'antigravity';
          const flag = F.addFlag({ path: b.path, note: b.note, tag: b.tag || 'Review', by: b.by || 'you', for: target });
          if (b.send && target === 'antigravity' && AGY) dispatch(flag.id, broadcast);
          return done(flag);
        }
        case '/api/flag/assign': {
          const flag = F.assignFlag(b.id, b.for, 'you');
          if (b.send && b.for === 'antigravity' && AGY) dispatch(flag.id, broadcast);
          return done(flag);
        }
        case '/api/flag/send': return done(dispatch(b.id, broadcast));
        case '/api/flag/done': return done(F.resolveFlag(b.id, b.summary || '', 'you'));
        case '/api/note': F.logActivity({ by: 'you', path: b.path || '', kind: 'note', text: b.text }); return done();
        case '/api/promote': return done(await F.promote(b.name, 'you'));
        case '/api/promote/dismiss': F.withdraw(b.name, 'you', 'not now'); return done(F.dismissPromote(b.name, b.head));
        case '/api/rollback': return done(await F.rollback(b.name, 'you'));
        case '/api/open': openInExplorer(b.path || ''); return send(res, 200, { ok: true });
        case '/api/hub/drop': {
          const dropped = await HUB.addHubDrop(
            { text: b.text, hint: b.hint },
            { getBoardCore, hopperSnapshot, onMutate: () => invalidateBoardCache() },
          );
          return done(dropped);
        }
        case '/api/hub/ack': {
          const acked = await HUB.toggleHubAck(b.id, { getBoardCore, hopperSnapshot });
          broadcast();
          return send(res, 200, acked);
        }
        case '/api/hopper/add': {
          const added = H.add({ drop: b.drop, from: b.from || 'you', hint: b.hint || '', by: 'you' });
          return done(added);
        }
        case '/api/hopper/playbook': {
          const playbook = writePlaybook(b);
          return done({ ok: true, playbook });
        }
        case '/api/hopper/run-now': {
          const card = H.markRunNow(b.id, { by: 'you' });
          return done({ ok: true, id: card.id, runNowAt: card.runNowAt, card, caretaker: HW.status() });
        }
        case '/api/hopper/chop': {
          const chopped = await openChopRoom(b.id);
          return done(chopped);
        }
        case '/api/hopper/checkin': {
          const updated = H.saveCheckin({
            id: b.id,
            pulse: b.pulse,
            answers: b.answers,
            note: b.note,
            by: 'you',
          });
          return done({ ok: true, card: updated, checkin: updated.checkin });
        }
        case '/api/hopper/react': {
          if (b.removeId) {
            const updated = H.removeReaction({ id: b.id, reactionId: b.removeId, by: 'you' });
            return done({ ok: true, card: updated, checkin: updated.checkin });
          }
          const saved = H.addReaction({
            id: b.id,
            kind: b.kind || 'note',
            screen: b.screen || '',
            url: b.url || '',
            text: b.text || '',
            by: 'you',
          });
          return done({ ok: true, reaction: saved.reaction, card: saved.card, checkin: saved.card.checkin });
        }
        case '/api/hopper/push': {
          const existing = H.getCard(b.id);
          const hasOverride = b.pulse !== undefined || b.answers !== undefined || b.note !== undefined;
          const cardForBrief = hasOverride
            ? H.saveCheckin({ id: b.id, pulse: b.pulse, answers: b.answers, note: b.note, by: 'you' })
            : existing;
          const brief = String(b.brief || '').trim() || H.formatCheckinBrief(cardForBrief);
          const againRes = H.again({ id: b.id, brief, weakest: !brief, by: 'you' });
          const released = await BP.releaseCard(existing);
          return done({ ok: true, card: againRes, brief, released });
        }
        case '/api/hopper/steer': return done(H.steer({ id: b.id, brief: b.brief, by: 'you' }));
        case '/api/hopper/pull': {
          const existing = H.getCard(b.id);
          const pulled = await H.pull({ id: b.id, build: b.build || undefined, shot: b.shot || undefined, by: 'you' });
          const released = await BP.releaseCard(existing);
          return done({ ...pulled, released });
        }
        case '/api/hopper/again': {
          const existing = H.getCard(b.id);
          const againRes = H.again({ id: b.id, brief: b.brief || '', weakest: Boolean(b.weakest), by: 'you' });
          const released = await BP.releaseCard(existing);
          return done({ ...againRes, released });
        }
        case '/api/hopper/park': {
          const existing = H.getCard(b.id);
          const parked = H.park({ id: b.id, why: b.why || '', by: 'you' });
          const released = await BP.releaseCard(existing);
          return done({ ...parked, released });
        }
        case '/api/hopper/nuke': {
          const existing = H.getCard(b.id);
          const rel = await BP.releaseCard(existing);
          const nuked = H.nuke({ id: b.id, why: b.why, reopen: b.reopen, by: 'you' });
          const stopped = [
            ...(rel.released || []).filter((x) => x.stopped && x.prev?.scratchId).map((x) => ({ id: x.prev.scratchId, port: x.prev.port })),
            ...(rel.cleaned?.stopped || []),
          ];
          return done({ ...nuked, cleaned: { stopped }, released: rel.released });
        }
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(new Date().toISOString(), req.method, u.pathname, e.message);
    if (res.headersSent) { try { res.end(); } catch {} return; }
    send(res, 400, { error: e.message });
  }
});

export { server };

server.on('upgrade', (req, socket, head) => {
  if (!doorOk(req)) { socket.destroy(); return; }
  if (!HP.handleLiveUpgrade(req, socket, head)) socket.destroy();
});

if (IS_MAIN) {
  // Never let one bad request take the window down.
  process.on('uncaughtException', (e) => console.error('uncaught', e));
  process.on('unhandledRejection', (e) => console.error('unhandled', e));
  const onExitSignal = () => { BP.stop().catch(() => {}).finally(() => process.exit(0)); };
  process.on('SIGINT', onExitSignal);
  process.on('SIGTERM', onExitSignal);

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { if (OPEN) openWindow(); process.exit(0); }
    console.error(e); process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    F.ensureBoard();
    U.ensureUsageConfig();
    sweepInterrupted();
    getBoardCore().catch(() => {});
    const ctxTimer = setTimeout(() => { F.writeContextFile().catch(() => {}); }, 5000);
    ctxTimer.unref?.();
    BP.start()
      .then(() => {
        const t = setTimeout(() => {
          BP.reconcileOnStartup().catch((e) => console.error('[bench-ports]', e.message));
        }, 6000);
        t.unref?.();
      })
      .catch((e) => console.error('[bench-ports]', e.message));
    console.log(`Foundry running at ${URL_}`);
    if (OPEN) openWindow();
  });
}
