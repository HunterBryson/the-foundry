// Open Usage Pool reader for Foundry.
// Config lives at <FOUNDRY>/.foundry/usage-pools.json so any pool, script, or agent can plug in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as F from './lib.mjs';

export const USAGE_CONFIG = path.join(F.BOARD, 'usage-pools.json');
export const USAGE_DIR = path.join(F.BOARD, 'usage');

// Named color presets: [darkStart, brightTip, glow]
const PRESETS = {
  teal:   ['#0f766e', '#5eead4', 'rgba(94,234,212,0.35)'],  // Antigravity
  amber:  ['#b45309', '#f59e0b', 'rgba(245,158,11,0.35)'],  // Claude
  coral:  ['#b84a32', '#f08767', 'rgba(240,135,103,0.35)'], // Claude API / terracotta
  sky:    ['#1d6fb8', '#60c3ff', 'rgba(96,195,255,0.35)'],  // GPT / Codex
  violet: ['#6d28d9', '#c084fc', 'rgba(192,132,252,0.35)'], // Shared / extra pool
  green:  ['#15803d', '#4ade80', 'rgba(74,222,128,0.35)'],
  rose:   ['#be123c', '#fb7185', 'rgba(251,113,133,0.35)'],
  gold:   ['#a16207', '#facc15', 'rgba(250,204,21,0.35)'],
};

const DEFAULT_POOLS = {
  _note: 'Open Foundry usage pool list. Reorder, rename, recolor, or add pools freely. Sources: "antigravity-local", "json-file", or "placeholder". Any agent/script can also POST to /api/usage/<id>.',
  pools: [
    { id: 'claude', label: 'Claude · 5h', color: 'amber', source: 'json-file', file: 'usage/claude.json' },
    { id: 'agy-gemini', label: 'AGY · Gemini', color: 'violet', source: 'antigravity-local', modelFilter: 'gemini', display: '5h' },
    { id: 'agy-claude', label: 'AGY · Claude', color: 'rose', source: 'antigravity-local', modelFilter: 'claude-extra', display: 'week' },
    { id: 'weekly-pool', label: 'Weekly Pool', color: 'green', source: 'json-file', file: 'usage/weekly.json' },
  ],
};

function resolveColors(color) {
  if (Array.isArray(color) && color.length >= 2) {
    return [color[0], color[1], color[2] || 'rgba(255,255,255,0.2)'];
  }
  if (typeof color === 'string' && PRESETS[color.toLowerCase()]) {
    return PRESETS[color.toLowerCase()];
  }
  if (typeof color === 'string' && color.startsWith('#')) {
    return [color, color, 'rgba(255,255,255,0.22)'];
  }
  return PRESETS.teal;
}

export function ensureUsageConfig() {
  F.ensureBoard();
  fs.mkdirSync(USAGE_DIR, { recursive: true });
  if (!fs.existsSync(USAGE_CONFIG)) {
    fs.writeFileSync(USAGE_CONFIG, JSON.stringify(DEFAULT_POOLS, null, 2));
  }
}

export function loadPoolConfig() {
  ensureUsageConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_CONFIG, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.pools)) return raw.pools;
  } catch {}
  return DEFAULT_POOLS.pools;
}

// ---------- cached Antigravity transcript scanner ----------
// Caches parsed turns per file keyed by mtimeMs:size so repeated reads stay <5ms.
const transcriptCache = new Map();

function scanTranscriptFile(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch { return []; }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = transcriptCache.get(filePath);
  if (hit && hit.key === key) return hit.turns;

  const turns = [];
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line || !line.includes('"input_tokens"')) continue;
      try {
        const obj = JSON.parse(line);
        const ts = obj.created_at ? Date.parse(obj.created_at) : st.mtimeMs;
        if (!Number.isFinite(ts)) continue;
        const inp = Number(obj.input_tokens) || 0;
        const cache = Number(obj.cache_read_tokens) || 0;
        const out = Number(obj.output_tokens) || 0;
        if (inp || cache || out) {
          turns.push({ ts, inp, cache, out, model: obj.model || '' });
        }
      } catch {}
    }
  } catch {}
  transcriptCache.set(filePath, { key, turns });
  return turns;
}

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(n);
}

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function matchesModelFilter(model, filter) {
  if (!filter || filter === 'all') return true;
  const m = String(model || '').toLowerCase();
  if (filter === 'gemini') return m.startsWith('gemini');
  if (filter === 'claude-extra' || filter === 'claude-gpt') return !!m && !m.startsWith('gemini');
  return m.includes(String(filter).toLowerCase());
}

function readAntigravityLocal(pool) {
  const roots = [
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
  ];
  const nowMs = Date.now();
  const win5h = (Number(pool.windowHours) || 5) * 3600 * 1000;
  const winWeek = 7 * 24 * 3600 * 1000;
  const cut5h = nowMs - win5h;
  const cutWeek = nowMs - winWeek;
  const filter = pool.modelFilter || 'all';

  let eff5h = 0, raw5h = 0, turns5h = 0, oldest5h = Infinity;
  let effW = 0, rawW = 0, turnsW = 0;

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let dirs;
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const tpath = path.join(root, d.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(tpath)) continue;
      // Quick skip: if file hasn't been modified in > 7 days, no turns in week window.
      let st;
      try { st = fs.statSync(tpath); } catch { continue; }
      if (st.mtimeMs < cutWeek) continue;

      const turns = scanTranscriptFile(tpath);
      for (const t of turns) {
        if (t.ts < cutWeek) continue;
        if (!matchesModelFilter(t.model, filter)) continue;
        // Weight cache reads lightly (0.1x) and output heavier (4x) to approximate quota weight.
        const eff = t.inp + Math.round(t.cache * 0.1) + t.out * 4;
        const raw = t.inp + t.cache + t.out;
        effW += eff; rawW += raw; turnsW++;
        if (t.ts >= cut5h) {
          eff5h += eff; raw5h += raw; turns5h++;
          if (t.ts < oldest5h) oldest5h = t.ts;
        }
      }
    }
  }

  const budget5h = Number(pool.budgetTokens5h) || 25_000_000;
  const budgetW = Number(pool.budgetTokensWeek) || 150_000_000;
  const fiveHourPct = Math.min(100, Math.round((eff5h / budget5h) * 100));
  const weekPct = Math.min(100, Math.round((effW / budgetW) * 100));
  const display = pool.display || '5h';
  const pct = display === 'week' ? weekPct : display === 'max' ? Math.max(fiveHourPct, weekPct) : fiveHourPct;

  const fiveHourReset = oldest5h < Infinity ? `clears ~${fmtClock(oldest5h + win5h)}` : 'fresh window';
  const weekReset = `${fmtTokens(rawW)} tok · ${turnsW} turns`;

  return {
    pct,
    fiveHourPct,
    weekPct,
    fiveHourReset,
    weekReset,
    note: `${fmtTokens(eff5h)} eff (5h) · ${fmtTokens(effW)} eff (7d)`,
    live: true,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function clampPct(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function readJsonFilePool(pool) {
  const filePath = pool.file
    ? (path.isAbsolute(pool.file) ? pool.file : path.join(F.BOARD, pool.file))
    : path.join(USAGE_DIR, `${pool.id}.json`);
  if (!fs.existsSync(filePath)) {
    return { pct: null, fiveHourPct: null, weekPct: null, note: 'not connected yet', live: false };
  }
  try {
    const st = fs.statSync(filePath);
    const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const fiveHourPct = clampPct(d.fiveHourPct ?? d.five_hour_pct ?? d['5h']);
    const weekPct = clampPct(d.weekPct ?? d.week_pct ?? d.week);
    const pct = clampPct(d.pct ?? d.percent) ?? (pool.display === 'week' ? weekPct : fiveHourPct ?? weekPct);
    return {
      pct,
      fiveHourPct,
      weekPct,
      fiveHourReset: d.fiveHourReset || d.reset5h || d.reset || '',
      weekReset: d.weekReset || d.resetWeek || '',
      note: d.note || d.detail || '',
      live: pct !== null,
      updatedAt: d.updatedAt || st.mtime.toISOString(),
    };
  } catch {
    return { pct: null, fiveHourPct: null, weekPct: null, note: 'could not read file', live: false };
  }
}

export function getUsage() {
  const configs = loadPoolConfig();
  const pools = configs.map((p) => {
    const [c1, c2, glow] = resolveColors(p.color);
    let reading;
    if (p.source === 'antigravity-local') reading = readAntigravityLocal(p);
    else if (p.source === 'placeholder') reading = { pct: null, fiveHourPct: null, weekPct: null, note: p.note || 'ready to connect', live: false };
    else reading = readJsonFilePool(p);

    return {
      id: p.id,
      label: p.label || p.id,
      colors: [c1, c2, glow],
      source: p.source || 'json-file',
      ...reading,
    };
  });
  return { configPath: USAGE_CONFIG, pools };
}

export function writePoolReading(id, payload = {}) {
  ensureUsageConfig();
  const safeId = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeId) throw new Error('Pool id required');
  const filePath = path.join(USAGE_DIR, `${safeId}.json`);
  const data = { ...payload, updatedAt: new Date().toISOString() };
  const tmp = filePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
  return data;
}
