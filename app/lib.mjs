// Foundry core — shared by the window (server.mjs) and the agent CLI (foundry.mjs).
// Everything lives as plain files under <FOUNDRY>/.foundry so any agent can read/write it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';

export const FOUNDRY = CONFIG.home;
export const BOARD = path.join(FOUNDRY, '.foundry');
export const FLAGS_DIR = path.join(BOARD, 'flags');
export const TRIALS_DIR = path.join(BOARD, 'trials');
export const HIDDEN = new Set(['.git', 'node_modules', '.foundry', '__pycache__', '.venv']);

const DEFAULT_CONFIG = { pairs: CONFIG.pairs || {} };

// ---------- paths ----------
export function toRel(abs) {
  return path.relative(FOUNDRY, abs).split(path.sep).join('/');
}
export function toAbs(rel = '') {
  const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(FOUNDRY, clean);
  if (abs !== FOUNDRY && !abs.startsWith(FOUNDRY + path.sep)) throw new Error('Path is outside the Foundry');
  return abs;
}
export function normRel(rel = '') {
  return toRel(toAbs(rel));
}
const under = (child, parent) => !parent || child === parent || child.startsWith(parent + '/');

// ---------- small file helpers ----------
export function ensureBoard() {
  fs.mkdirSync(FLAGS_DIR, { recursive: true });
  fs.mkdirSync(TRIALS_DIR, { recursive: true });
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}
function readLines(file, max = 500) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-max)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
export const now = () => new Date().toISOString();

export function config() {
  return { ...DEFAULT_CONFIG, ...readJSON(path.join(BOARD, 'config.json'), {}) };
}

// ---------- current work (pins) ----------
const PINS = () => path.join(BOARD, 'current-work.json');
export function getPins() {
  return readJSON(PINS(), { items: [] }).items || [];
}
export function pin(rel, note = '', by = 'you') {
  ensureBoard();
  rel = normRel(rel);
  if (!fs.existsSync(toAbs(rel))) throw new Error(`Nothing at ${rel}`);
  const items = getPins().filter((p) => p.path !== rel);
  items.unshift({ path: rel, note, by, at: now() });
  writeJSON(PINS(), { items });
  logActivity({ by, path: rel, kind: 'pin', text: `Pinned ${rel}${note ? ` — "${note}"` : ''}` });
  return items;
}
export function unpin(rel, by = 'you') {
  ensureBoard();
  rel = normRel(rel);
  const items = getPins().filter((p) => p.path !== rel);
  writeJSON(PINS(), { items });
  logActivity({ by, path: rel, kind: 'unpin', text: `Unpinned ${rel}` });
  return items;
}

// ---------- flags (open to any sender -> any configured agent or human) ----------
export function getFlags({ includeDone = false } = {}) {
  ensureBoard();
  const out = [];
  for (const f of fs.readdirSync(FLAGS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const flag = readJSON(path.join(FLAGS_DIR, f), null);
    if (flag && (includeDone || flag.status !== 'done')) {
      if (!flag.for) flag.for = CONFIG.crew[0]?.id || 'builder';
      out.push(flag);
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
export function getFlag(id) {
  const f = readJSON(path.join(FLAGS_DIR, `${id}.json`), null);
  if (f && !f.for) f.for = CONFIG.crew[0]?.id || 'builder';
  return f;
}
export function saveFlag(flag) {
  ensureBoard();
  writeJSON(path.join(FLAGS_DIR, `${flag.id}.json`), flag);
  return flag;
}
export function addFlag({ path: rel, note = '', tag = 'Review', by = 'you', for: target = 'breaker' }) {
  rel = normRel(rel);
  const id = 'f-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex');
  const flag = { id, path: rel, note, tag, by, for: target, at: now(), status: 'open', agent: null };
  saveFlag(flag);
  logActivity({ by, path: rel, kind: 'flag', text: `Flagged ${rel} for ${target} [${tag}]${note ? ` — "${note}"` : ''}` });
  return flag;
}
export function assignFlag(id, target, by = 'you') {
  const flag = getFlag(id);
  if (!flag) throw new Error(`No flag ${id}`);
  flag.for = target;
  saveFlag(flag);
  logActivity({ by, path: flag.path, kind: 'flag', text: `Routed flag on ${flag.path} → ${target}` });
  return flag;
}
export function resolveFlag(id, summary = '', by = 'you') {
  const flag = getFlag(id);
  if (!flag) throw new Error(`No flag ${id}`);
  flag.status = 'done';
  flag.doneAt = now();
  flag.doneBy = by;
  if (summary) flag.resolution = summary;
  saveFlag(flag);
  logActivity({ by, path: flag.path, kind: 'flag-done', text: `Closed flag on ${flag.path}${summary ? ` — ${summary}` : ''}` });
  return flag;
}

// ---------- dismissed promotes (snoozed until lab gets a newer commit) ----------
const DISMISSED = () => path.join(BOARD, 'dismissed.json');
function getDismissed() { return readJSON(DISMISSED(), {}); }
export function dismissPromote(labName, head) {
  ensureBoard();
  const d = getDismissed();
  d[labName] = head;
  writeJSON(DISMISSED(), d);
  return d;
}

// ---------- activity ----------
const ACTIVITY = () => path.join(BOARD, 'activity.jsonl');
export function logActivity({ by = 'agent', path: rel = '', kind = 'note', text }) {
  ensureBoard();
  appendLine(ACTIVITY(), { at: now(), by, path: rel, kind, text });
}
export function getNotes(max = 300) {
  return readLines(ACTIVITY(), max);
}

// ---------- git ----------
export function git(dir, args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr || err?.message || '').trim() }));
  });
}
export const isRepo = (abs) => fs.existsSync(path.join(abs, '.git'));

export function listRepos() {
  const repos = [];
  for (const room of ['lab', 'core', 'public']) {
    const dir = path.join(FOUNDRY, room);
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && isRepo(path.join(dir, d.name))) repos.push({ room, name: d.name, rel: `${room}/${d.name}` });
    }
  }
  return repos;
}
export function coreFor(labName) {
  const name = config().pairs[labName] || labName;
  const abs = path.join(FOUNDRY, 'core', name);
  return isRepo(abs) ? { name, rel: `core/${name}`, abs } : null;
}

const repoCache = new Map();
const repoInFlight = new Map();
const activityCache = new Map();
export function clearCaches() { repoCache.clear(); activityCache.clear(); }
export async function repoInfo(rel, { fresh = false } = {}) {
  const hit = repoCache.get(rel);
  if (!fresh && hit && Date.now() - hit.t < 15000) return { ...hit.v };
  if (!fresh && repoInFlight.has(rel)) return { ...(await repoInFlight.get(rel)) };
  const p = (async () => {
    const abs = toAbs(rel);
    const [status, last] = await Promise.all([
      git(abs, ['status', '--porcelain=v1', '-b']),
      git(abs, ['log', '-n', '1', '--pretty=format:%H%x1f%an%x1f%aI%x1f%s%x1f%D']),
    ]);
    let branch = '(detached)', changes = 0;
    if (status.ok && status.out) {
      const lines = status.out.split('\n');
      const m = lines[0].match(/^##\s+(?:No commits yet on\s+)?([^\.\s]+)/);
      if (m && m[1] !== 'HEAD') branch = m[1];
      changes = lines.slice(1).filter(Boolean).length;
    }
    const [head, lastBy, lastAt, lastMsg, refs] = last.ok && last.out ? last.out.split('\x1f') : ['', '', '', '', ''];
    const tagMatch = (refs || '').match(/tag:\s*([^,]+)/);
    const v = {
      rel,
      changes,
      branch,
      head: head || '',
      version: tagMatch ? tagMatch[1].trim() : null,
      lastBy: lastBy || '',
      lastAt: lastAt || '',
      lastMsg: lastMsg || '',
    };
    repoCache.set(rel, { t: Date.now(), v });
    return v;
  })();
  repoInFlight.set(rel, p);
  try { return { ...(await p) }; } finally { repoInFlight.delete(rel); }
}

function smartTitle(labName, files) {
  if (!files.length) return labName;
  const tops = new Set(files.map((f) => f.file.split('/')[0]).filter(Boolean));
  if (tops.size === 1) {
    const only = [...tops][0];
    if (files.some((f) => f.file.includes('/'))) return only;
  }
  return labName;
}

// lab vs core for a lab repo — includes real commits & files so you never get a mystery box
export async function labVsCore(labName) {
  const labRel = `lab/${labName}`;
  const labAbs = toAbs(labRel);
  const core = coreFor(labName);
  const lab = await repoInfo(labRel);
  if (!core) return { lab, core: null, ahead: 0, state: 'no-core', commits: [], files: [], title: labName };
  const c = await repoInfo(core.rel);
  if (lab.head === c.head) return { lab, core: c, ahead: 0, state: 'same', commits: [], files: [], title: labName };
  const known = await git(labAbs, ['cat-file', '-e', `${c.head}^{commit}`]);
  if (!known.ok) return { lab, core: c, ahead: 0, state: 'unknown', commits: [], files: [], title: labName };
  const isAnc = await git(labAbs, ['merge-base', '--is-ancestor', c.head, 'HEAD']);
  const count = await git(labAbs, ['rev-list', '--count', `${c.head}..HEAD`]);
  const ahead = parseInt(count.out, 10) || 0;
  if (!isAnc.ok) return { lab, core: c, ahead, state: 'diverged', commits: [], files: [], title: labName };
  if (!ahead) return { lab, core: c, ahead: 0, state: 'same', commits: [], files: [], title: labName };

  const [logRes, diffRes] = await Promise.all([
    git(labAbs, ['log', `${c.head}..HEAD`, '-n', '8', '--pretty=format:%an%x1f%aI%x1f%s']),
    git(labAbs, ['diff', '--name-status', `${c.head}..HEAD`]),
  ]);
  const commits = logRes.ok && logRes.out
    ? logRes.out.split('\n').map((l) => { const [by, at, text] = l.split('\x1f'); return { by, at, text }; })
    : [];
  const files = diffRes.ok && diffRes.out
    ? diffRes.out.split('\n').slice(0, 12).map((l) => { const [code, ...rest] = l.split('\t'); return { code: code[0], file: rest.join(' → ') }; })
    : [];
  return { lab, core: c, ahead, state: 'ahead', commits, files, title: smartTitle(labName, files) };
}

async function repoGitActivity(r, days = 14, perRepo = 25) {
  const key = `${r.rel}:${days}:${perRepo}`;
  const hit = activityCache.get(key);
  if (hit && Date.now() - hit.t < 15000) return hit.v;
  const res = await git(toAbs(r.rel), ['log', `--since=${days}.days`, '-n', String(perRepo), '--pretty=format:%H%x1f%an%x1f%aI%x1f%s']);
  const rows = [];
  if (res.ok && res.out) {
    for (const line of res.out.split('\n')) {
      const [hash, author, at, subject] = line.split('\x1f');
      rows.push({ hash, author, at, subject, rel: r.rel });
    }
  }
  activityCache.set(key, { t: Date.now(), v: rows });
  return rows;
}

export async function gitActivity(days = 14, perRepo = 25, filter = '') {
  const repos = listRepos().filter((r) => !filter || under(r.rel, filter) || under(filter, r.rel));
  const lists = await Promise.all(repos.map((r) => repoGitActivity(r, days, perRepo)));
  const seen = new Map();
  for (const rows of lists) {
    for (const row of rows) {
      const prev = seen.get(row.hash);
      if (prev) { prev.alsoIn.push(row.rel); continue; }
      seen.set(row.hash, { at: row.at, by: row.author, path: row.rel, kind: 'commit', text: row.subject, hash: row.hash.slice(0, 7), alsoIn: [] });
    }
  }
  return [...seen.values()];
}

export async function getActivity({ filter = '', max = 80 } = {}) {
  const all = [...getNotes(), ...(await gitActivity(14, 25, filter))];
  return all
    .filter((a) => !filter || under(a.path || '', filter) || under(filter, a.path || '\0'))
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, max);
}

// ---------- promote (lab -> core) / roll back ----------
const PROMOS = () => path.join(BOARD, 'promotions.jsonl');
function coreStamp() {
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  return `core-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
// ---------- the block guard ----------
// A version that broke stays blocked, with the files that broke, until a newer save changes those files.
// An unrelated save can't carry the broken code back into core. You can override when needed.
const BLOCKS = () => path.join(BOARD, 'blocks.json');
export function getBlocks({ includeCleared = false } = {}) {
  const items = readJSON(BLOCKS(), { items: [] }).items || [];
  return includeCleared ? items : items.filter((b) => !b.clearedAt);
}
function saveBlocks(items) { ensureBoard(); writeJSON(BLOCKS(), { items }); }
export async function addBlock({ name, commit, files = [], why = '', by = 'foundry' }) {
  const abs = toAbs(`core/${name}`);
  if (!isRepo(abs)) throw new Error(`No core/${name} to block a version of.`);
  let full = await git(abs, ['rev-parse', '--verify', `${commit}^{commit}`]);
  if (!full.ok) {
    // A version can be blocked before it ever reaches core, from its lab twin.
    const labName = Object.entries(config().pairs || {}).find(([, c]) => c === name)?.[0] || name;
    const labAbs = toAbs(`lab/${labName}`);
    if (isRepo(labAbs)) full = await git(labAbs, ['rev-parse', '--verify', `${commit}^{commit}`]);
  }
  if (!full.ok) throw new Error(`${name} has no version ${commit}.`);
  const items = getBlocks({ includeCleared: true });
  const open = items.find((b) => b.name === name && b.commit === full.out && !b.clearedAt);
  if (open) {
    open.files = [...new Set([...open.files, ...files])];
    if (why) open.why = why;
    saveBlocks(items);
    return open;
  }
  const block = { id: 'b-' + crypto.randomBytes(3).toString('hex'), name, commit: full.out, files: [...new Set(files)], why, by, at: now() };
  items.push(block);
  saveBlocks(items);
  logActivity({ by, path: `core/${name}`, kind: 'block', text: `Blocked a broken version of ${name} until its files change${why ? ` — ${why}` : ''}` });
  return block;
}
export function clearBlock(id, why = '', by = 'you') {
  const items = getBlocks({ includeCleared: true });
  const block = items.find((b) => b.id === id && !b.clearedAt);
  if (!block) throw new Error(`No open block ${id}.`);
  Object.assign(block, { clearedAt: now(), clearedBy: by, clearedWhy: why || 'override' });
  saveBlocks(items);
  logActivity({ by, path: `core/${block.name}`, kind: 'block', text: `Cleared the block on ${block.name}${why ? ` — ${why}` : ''}` });
  return block;
}
// Read-only block check: finds the open block this lab version is still carrying (if any) and which blocks it clears.
// Never mutates blocks.json so an aborted move (dirty core or another open block) leaves all blocks intact.
export async function checkBlocks(labAbs, coreName) {
  const releasable = [];
  for (const block of getBlocks().filter((b) => b.name === coreName)) {
    const inHistory = await git(labAbs, ['merge-base', '--is-ancestor', block.commit, 'HEAD']);
    if (!inHistory.ok) continue;
    const diff = await git(labAbs, ['diff', '--name-only', block.commit, 'HEAD']);
    if (!diff.ok) return { blocked: block, releasable };
    const changed = new Set(diff.out.split('\n').filter(Boolean));
    const released = block.files.length ? block.files.some((f) => changed.has(f)) : changed.size > 0;
    if (!released) return { blocked: block, releasable };
    releasable.push(block);
  }
  return { blocked: null, releasable };
}
export async function blockingMove(labAbs, coreName) {
  return (await checkBlocks(labAbs, coreName)).blocked;
}

// Live Match runs detached, so a move of the Foundry window can restart the window and still check it.
// It stays off until .foundry/config.json says { "liveMatch": { "enabled": true } }.
function launchLiveMatch(name, from, to, kind) {
  if (config().liveMatch?.enabled !== true) return null;
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'live-match-run.mjs');
  const child = spawn(process.execPath, [runner, name, from || '-', to, kind], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, FOUNDRY_HOME: FOUNDRY },
  });
  child.unref();
  return child.pid;
}

export async function promote(labName, by = 'you', { override = false } = {}) {
  const labAbs = toAbs(`lab/${labName}`);
  if (!isRepo(labAbs)) throw new Error(`No lab repo found at lab/${labName}.`);
  const core = coreFor(labName);
  if (!core) {
    // First-time promotion ("Start core"): clone lab cleanly into core and tag it.
    const coreName = config().pairs[labName] || labName;
    const coreAbs = path.join(FOUNDRY, 'core', coreName);
    if (fs.existsSync(coreAbs)) throw new Error(`core/${coreName} already exists (not a git repo). Needs a look first.`);
    const labInfo = await repoInfo(`lab/${labName}`, { fresh: true });
    if (!labInfo.head) throw new Error(`lab/${labName} has no commits yet.`);
    fs.mkdirSync(path.join(FOUNDRY, 'core'), { recursive: true });
    const c = await git(FOUNDRY, ['clone', '--no-hardlinks', labAbs, coreAbs]);
    if (!c.ok) throw new Error('Could not start core copy: ' + c.err);
    await git(coreAbs, ['remote', 'remove', 'origin']);
    const after = await repoInfo(`core/${coreName}`, { fresh: true });
    await git(coreAbs, ['tag', coreStamp()]);
    clearCaches();
    appendLine(PROMOS(), { at: now(), by, name: coreName, from: null, to: after.head, initialized: true });
    logActivity({ by, path: `core/${coreName}`, kind: 'promote', text: `Started core/${coreName} from lab/${labName}` });
    return { from: null, to: after.head, initialized: true, liveMatch: launchLiveMatch(coreName, null, after.head, 'move') };
  }
  const ciEarly = await repoInfo(core.rel, { fresh: true });
  const prop = await standingProposal(labName, ciEarly.head);
  if (!prop && !override) throw new Error(`Nobody has made the case for moving lab/${labName} to core yet. (foundry propose ${labName} --why "...")  Nothing was moved.`);
  const target = prop ? prop.head : 'FETCH_HEAD';
  const { blocked, releasable } = await checkBlocks(labAbs, core.name);
  if (blocked && !override) {
    throw new Error(`This version still carries a break${blocked.why ? ` (${blocked.why})` : ''}. It stays out of core until a newer save changes ${blocked.files.length ? blocked.files.join(', ') : 'it'}. Nothing was moved.`);
  }
  const ci = await repoInfo(core.rel, { fresh: true });
  if (ci.changes) throw new Error(`core/${core.name} has ${ci.changes} hand edits. Nothing was moved — it needs a look first.`);
  const f = await git(core.abs, ['fetch', '--no-tags', labAbs, 'HEAD']);
  if (!f.ok) throw new Error('Could not read the lab copy: ' + f.err);
  const m = await git(core.abs, ['merge', '--ff-only', target]);
  if (!m.ok) throw new Error('Lab and core have split apart, so this cannot be a clean step forward. Nothing changed.');
  const after = await repoInfo(core.rel, { fresh: true });
  await git(core.abs, ['tag', coreStamp()]);
  for (const b of releasable) clearBlock(b.id, 'a newer save changed the files that broke', 'foundry');
  if (blocked) clearBlock(blocked.id, 'overridden on a move to core', by);
  clearCaches();
  appendLine(PROMOS(), { at: now(), by, name: core.name, from: ci.head, to: after.head, ...(prop ? { case: prop.why, caseBy: prop.by } : { override: true }) });
  if (prop) { const all = getProposals(); delete all[labName]; writeJSON(PROPOSALS(), all); }
  logActivity({ by, path: core.rel, kind: 'promote', text: `Moved lab/${labName} → core/${core.name}` });
  return { from: ci.head, to: after.head, liveMatch: launchLiveMatch(core.name, ci.head, after.head, 'move') };
}
export async function rollback(coreName, by = 'you', { noMatch = false } = {}) {
  const promos = readLines(PROMOS(), 1000).filter((p) => p.name === coreName && !p.rolledBack && !p.rollbackOf && p.from);
  const last = promos[promos.length - 1];
  if (!last) throw new Error(`No move of ${coreName} to roll back.`);
  const abs = toAbs(`core/${coreName}`);
  const ci = await repoInfo(`core/${coreName}`, { fresh: true });
  if (ci.changes) throw new Error(`core/${coreName} has ${ci.changes} hand edits. Nothing was rolled back.`);
  if (ci.head !== last.to) throw new Error(`core/${coreName} isn't on the version its last move left it on, so it needs a look first. Nothing was rolled back.`);
  const r = await git(abs, ['reset', '--hard', last.from]);
  if (!r.ok) throw new Error('Roll back failed: ' + r.err);
  clearCaches();
  // The dated tag on the version we left is renamed, so it no longer reads as a good core version. Its history stays.
  const tags = await git(abs, ['tag', '--points-at', last.to, '--list', 'core-*']);
  for (const t of tags.ok ? tags.out.split('\n').filter(Boolean) : []) {
    const kept = await git(abs, ['tag', `rolled-back/${t}`, t]);
    if (kept.ok) await git(abs, ['tag', '-d', t]);
  }
  writePromotions(coreName, last, { at: now(), by, name: coreName, from: last.to, to: last.from, rollbackOf: last.at });
  logActivity({ by, path: `core/${coreName}`, kind: 'rollback', text: `Rolled core/${coreName} back to previous version.` });
  return { to: last.from, liveMatch: noMatch ? null : launchLiveMatch(coreName, last.to, last.from, 'rollback') };
}
// One atomic write: a crash leaves the old record or the new one, never half of it. Lines it can't read are kept.
function writePromotions(coreName, last, entry) {
  let raw = '';
  try { raw = fs.readFileSync(PROMOS(), 'utf8'); } catch {}
  const lines = raw.split('\n').filter(Boolean).map((line) => {
    try {
      const p = JSON.parse(line);
      return p.at === last.at && p.name === coreName ? JSON.stringify({ ...p, rolledBack: true }) : line;
    } catch { return line; }
  });
  lines.push(JSON.stringify(entry));
  const tmp = PROMOS() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n') + '\n');
  fs.renameSync(tmp, PROMOS());
}
export function lastPromotion(coreName) {
  const promos = readLines(PROMOS(), 1000).filter((p) => p.name === coreName && !p.rolledBack && !p.rollbackOf && p.from);
  return promos[promos.length - 1] || null;
}

// ---------- lab trials (isolated paired build + skill capsules) ----------
const TRIAL_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,47}$/;
export function listTrials() {
  ensureBoard();
  const out = [];
  for (const f of fs.readdirSync(TRIALS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const t = readJSON(path.join(TRIALS_DIR, f), null);
    if (t) out.push(t);
  }
  return out.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}
export function getTrial(name) {
  ensureBoard();
  return readJSON(path.join(TRIALS_DIR, `${name}.json`), null);
}
function saveTrial(t) {
  ensureBoard();
  writeJSON(path.join(TRIALS_DIR, `${t.name}.json`), t);
  return t;
}
async function baseRefForLab(labName) {
  const labAbs = toAbs(`lab/${labName}`);
  const core = coreFor(labName);
  if (core) {
    const ci = await repoInfo(core.rel, { fresh: true });
    if (ci.head) {
      const known = await git(labAbs, ['cat-file', '-e', `${ci.head}^{commit}`]);
      if (known.ok) return ci.head;
    }
  }
  const li = await repoInfo(`lab/${labName}`, { fresh: true });
  if (!li.head) throw new Error(`lab/${labName} has no commits yet.`);
  return li.head;
}
// bases: { <build>: <commit> } starts that build's trial from a given commit instead of core (the Hopper's Pull to Lab uses it).
export async function startTrial({ name, builds = [], skills = [], goal = '', note = '', by = 'builder', bases = {} }) {
  ensureBoard();
  if (!name || !TRIAL_NAME_RE.test(name)) throw new Error('Trial name must be lowercase letters, numbers, - or _ (max 48 chars).');
  if (getTrial(name)) throw new Error(`Trial "${name}" already exists.`);
  const cleanBuilds = [...new Set(builds.map((s) => s.trim()).filter(Boolean))];
  const cleanSkills = [...new Set(skills.map((s) => s.trim()).filter(Boolean))];
  if (!cleanBuilds.length && !cleanSkills.length) throw new Error('A trial needs at least one build (--builds) or skill (--skills).');
  const resolvedGoal = goal || (cleanBuilds.length && cleanSkills.length ? 'paired' : (cleanSkills.length ? 'core-skill' : 'build-only'));
  if (!['paired', 'core-skill', 'build-only'].includes(resolvedGoal)) throw new Error('Trial goal must be paired, core-skill, or build-only.');

  // Validate all repos upfront before creating anything
  for (const b of cleanBuilds) {
    if (!isRepo(toAbs(`lab/${b}`))) throw new Error(`No lab repo at lab/${b}.`);
  }
  if (cleanSkills.length && !isRepo(toAbs('lab/agent-skills'))) {
    throw new Error('No lab repo at lab/agent-skills for skills.');
  }

  const branch = `trial/${name}`;
  const rootRel = `lab/_trials/${name}`;
  const rootAbs = toAbs(rootRel);
  fs.mkdirSync(rootAbs, { recursive: true });

  const createdWorktrees = [];
  try {
    const buildEntries = [];
    for (const b of cleanBuilds) {
      const labAbs = toAbs(`lab/${b}`);
      let base = bases[b];
      if (base) {
        const known = await git(labAbs, ['cat-file', '-e', `${base}^{commit}`]);
        if (!known.ok) throw new Error(`lab/${b} does not have commit ${base}.`);
      } else base = await baseRefForLab(b);
      const wtRel = `${rootRel}/${b}`;
      const wtAbs = toAbs(wtRel);
      const r = await git(labAbs, ['worktree', 'add', '-b', branch, wtAbs, base]);
      if (!r.ok) throw new Error(`Failed creating worktree for ${b}: ${r.err}`);
      createdWorktrees.push({ labAbs, wtAbs });
      buildEntries.push({ name: b, labRel: `lab/${b}`, worktreeRel: wtRel, base });
    }
    let skillsEntry = null;
    if (cleanSkills.length) {
      const labAbs = toAbs('lab/agent-skills');
      const base = await baseRefForLab('agent-skills');
      const wtRel = `${rootRel}/skills`;
      const wtAbs = toAbs(wtRel);
      const r = await git(labAbs, ['worktree', 'add', '-b', branch, wtAbs, base]);
      if (!r.ok) throw new Error(`Failed creating worktree for agent-skills: ${r.err}`);
      createdWorktrees.push({ labAbs, wtAbs });
      skillsEntry = { labRel: 'lab/agent-skills', worktreeRel: wtRel, base, skills: cleanSkills };
    }

    const trial = saveTrial({
      name,
      goal: resolvedGoal,
      note,
      by,
      at: now(),
      branch,
      rootRel,
      builds: buildEntries,
      skills: skillsEntry,
      status: 'active',
      flagId: null,
    });
    const desc = [
      `Trial (${resolvedGoal})`,
      cleanBuilds.length ? `builds: ${cleanBuilds.join(', ')}` : '',
      cleanSkills.length ? `skills: ${cleanSkills.join(', ')}` : '',
      note ? `— ${note}` : '',
    ].filter(Boolean).join(' · ');
    pin(rootRel, desc, by);
    logActivity({ by, path: rootRel, kind: 'trial', text: `Started trial "${name}" (${resolvedGoal})${note ? ` — ${note}` : ''}` });
    return trial;
  } catch (err) {
    // Atomic rollback if setup partially failed
    for (const { labAbs, wtAbs } of createdWorktrees) {
      await git(labAbs, ['worktree', 'remove', '--force', wtAbs]);
      await git(labAbs, ['branch', '-D', branch]);
    }
    fs.rmSync(rootAbs, { recursive: true, force: true });
    throw err;
  }
}
export async function reviewTrial(name, { note = '', salvage = false, by = 'builder' } = {}) {
  const trial = getTrial(name);
  if (!trial) throw new Error(`No trial named "${name}".`);
  const summaryParts = [];
  for (const b of trial.builds || []) {
    const wtAbs = toAbs(b.worktreeRel);
    const cnt = await git(wtAbs, ['rev-list', '--count', `${b.base}..HEAD`]);
    const st = await git(wtAbs, ['status', '--porcelain']);
    summaryParts.push(`build ${b.name}: ${cnt.out || '0'} commit(s)${st.out ? ', uncommitted edits' : ''}`);
  }
  if (trial.skills) {
    const wtAbs = toAbs(trial.skills.worktreeRel);
    const cnt = await git(wtAbs, ['rev-list', '--count', `${trial.skills.base}..HEAD`]);
    const st = await git(wtAbs, ['status', '--porcelain']);
    summaryParts.push(`skills [${trial.skills.skills.join(', ')}]: ${cnt.out || '0'} commit(s)${st.out ? ', uncommitted edits' : ''}`);
  }
  const mode = salvage ? 'salvage-skill' : trial.goal;
  const auditCue = mode === 'paired'
    ? 'Audit: verify build<->skill parity and stage together as a matched pair.'
    : mode === 'core-skill'
      ? 'Audit: anti-overfitting check vs core/agent-skills + CONTRACT.yaml; strip any test-bench leaks.'
      : mode === 'salvage-skill'
        ? 'Audit: build is scrapped — extract ONLY clean general skill upgrade (strip build-v2 leaks) and stage for core.'
        : 'Audit: check build diff, tests, and state safety before core.';
  const flagNote = `Trial "${name}" [${mode}] (${summaryParts.join('; ')}). ${auditCue}${note ? ` Note: ${note}` : ''}`;
  const flag = addFlag({ path: trial.rootRel, note: flagNote, tag: 'Trial', by, for: 'breaker' });
  trial.status = 'in-review';
  trial.flagId = flag.id;
  saveTrial(trial);
  return { trial, flag };
}
export async function killTrial(name, { by = 'builder', reason = '' } = {}) {
  const trial = getTrial(name);
  if (!trial) throw new Error(`No trial named "${name}".`);
  for (const b of trial.builds || []) {
    const labAbs = toAbs(b.labRel);
    const wtAbs = toAbs(b.worktreeRel);
    unlinkLinks(wtAbs);
    await git(labAbs, ['worktree', 'remove', '--force', wtAbs]);
    await git(labAbs, ['worktree', 'prune']);
    await git(labAbs, ['branch', '-D', trial.branch]);
  }
  if (trial.skills) {
    const labAbs = toAbs(trial.skills.labRel);
    const wtAbs = toAbs(trial.skills.worktreeRel);
    await git(labAbs, ['worktree', 'remove', '--force', wtAbs]);
    await git(labAbs, ['worktree', 'prune']);
    await git(labAbs, ['branch', '-D', trial.branch]);
  }
  const rootAbs = toAbs(trial.rootRel);
  fs.rmSync(rootAbs, { recursive: true, force: true });
  const trialsRoot = toAbs('lab/_trials');
  if (fs.existsSync(trialsRoot) && !fs.readdirSync(trialsRoot).length) fs.rmdirSync(trialsRoot);
  fs.rmSync(path.join(TRIALS_DIR, `${name}.json`), { force: true });
  unpin(trial.rootRel, by);
  if (trial.flagId) {
    const f = getFlag(trial.flagId);
    if (f && f.status !== 'done') resolveFlag(trial.flagId, `Trial "${name}" killed.`, by);
  }
  logActivity({ by, path: trial.rootRel, kind: 'trial-kill', text: `Killed trial "${name}"${reason ? ` — ${reason}` : ''} (build + skill edits cleaned up)` });
  return { killed: name };
}

// ---------- outbound private GitHub backup (push-only, never pulls back) ----------
function gh(args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile('gh', args, { timeout, windowsHide: true },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr || err?.message || '').trim() }));
  });
}
export const BACKUP_STATUS = () => path.join(BOARD, 'backup-status.json');
function isNonFastForward(err = '') {
  return /non-fast-forward|fetch first|\[rejected\]/i.test(err);
}
function syncBackupFlag(projectKey, flagPath, failed, repoFull) {
  const openFlags = getFlags().filter((f) => f.tag === 'Backup' && f.meta?.backupProject === projectKey);
  if (!failed.length) {
    for (const f of openFlags) resolveFlag(f.id, `GitHub backup for ${projectKey} (${repoFull}) succeeded cleanly.`, 'foundry-backup');
    return;
  }
  const hasDiverged = failed.some((x) => x.kind === 'diverged');
  const branchList = failed.map((x) => `${x.branch} (${x.kind})`).join(', ');
  const note = hasDiverged
    ? `GitHub backup refused to overwrite diverged history on ${repoFull} [${branchList}]. Remote backup was kept intact; inspect and reconcile before pushing.`
    : `GitHub backup failed for ${repoFull} [${branchList}]: ${failed[0].error.slice(0, 240)}`;
  if (openFlags.length) {
    const existing = openFlags[0];
    existing.note = note;
    existing.updatedAt = now();
    existing.meta = { backupProject: projectKey, repo: repoFull, branches: failed.map((x) => x.branch) };
    saveFlag(existing);
    return;
  }
  const flag = addFlag({ path: flagPath, note, tag: 'Backup', by: 'foundry-backup', for: 'builder' });
  flag.meta = { backupProject: projectKey, repo: repoFull, branches: failed.map((x) => x.branch) };
  saveFlag(flag);
}
export async function backupRepos({ dryRun = false, owner = CONFIG.githubOwner || '', by = 'you', remoteBase = '' } = {}) {
  const cfg = config();
  const map = cfg.backups || {};
  const pairs = cfg.pairs || {};
  const reversePairs = Object.fromEntries(Object.entries(pairs).map(([k, v]) => [v, k]));
  const projects = new Map();
  for (const r of listRepos()) {
    if (r.room !== 'lab' && r.room !== 'core') continue;
    const key = r.room === 'core' ? (reversePairs[r.name] || r.name) : r.name;
    if (!projects.has(key)) projects.set(key, {});
    projects.get(key)[r.room] = r;
  }
  const results = [];
  for (const [key, rooms] of projects) {
    const repoName = map[key] || `foundry-${key}`;
    const full = `${owner}/${repoName}`;
    const url = remoteBase ? path.join(remoteBase, `${repoName}.git`) : `https://github.com/${full}.git`;
    const flagPath = rooms.lab ? rooms.lab.rel : (rooms.core ? rooms.core.rel : '');
    const branches = [];
    if (rooms.core) branches.push({ branch: 'core', rel: rooms.core.rel });
    if (rooms.lab) branches.push({ branch: 'lab', rel: rooms.lab.rel });
    if (dryRun) {
      results.push({ project: key, repo: full, branches: branches.map((b) => b.branch), status: 'dry-run' });
      continue;
    }
    if (!remoteBase && !owner) throw new Error('Set "githubOwner" in foundry.config.json (or pass --owner <github-username>) before running outbound backup.');
    if (!remoteBase) {
      // Ensure private repo exists on GitHub (fail closed if privacy cannot be confirmed)
      const view = await gh(['repo', 'view', full, '--json', 'isPrivate']);
      if (!view.ok) {
        const cr = await gh(['repo', 'create', full, '--private', '--description', `Foundry private outbound backup (${key})`]);
        if (!cr.ok) {
          const failed = [{ branch: 'repo', kind: 'error', error: cr.err || 'Could not create private repo' }];
          syncBackupFlag(key, flagPath, failed, full);
          results.push({ project: key, repo: full, pushed: [], failed, status: 'error', error: failed[0].error });
          continue;
        }
      } else {
        let isPrivate = false;
        try { isPrivate = JSON.parse(view.out).isPrivate === true; } catch { isPrivate = false; }
        if (!isPrivate) {
          const msg = 'Refusing to push private backup to a public or unverified repo.';
          const failed = [{ branch: 'repo', kind: 'error', error: msg }];
          syncBackupFlag(key, flagPath, failed, full);
          results.push({ project: key, repo: full, pushed: [], failed, status: 'skipped-public', error: msg });
          continue;
        }
      }
    }
    const pushed = [];
    const failed = [];
    for (const b of branches) {
      // Never --force: a damaged or rewound local repo must fail loudly instead of overwriting good GitHub history.
      const p = await git(toAbs(b.rel), ['push', url, `HEAD:refs/heads/${b.branch}`], { timeout: 60000 });
      if (p.ok) pushed.push(b.branch);
      else failed.push({ branch: b.branch, kind: isNonFastForward(p.err) ? 'diverged' : 'error', error: p.err || 'git push failed' });
    }
    const status = !failed.length ? 'ok' : (failed.some((x) => x.kind === 'diverged') ? 'diverged' : 'error');
    const error = failed.map((x) => `${x.branch}: ${x.error}`).join(' | ');
    syncBackupFlag(key, flagPath, failed, full);
    results.push({ project: key, repo: full, pushed, ...(failed.length ? { failed, error } : {}), status });
  }
  if (!dryRun) {
    ensureBoard();
    const okCount = results.filter((r) => r.status === 'ok').length;
    const problems = results.filter((r) => r.status !== 'ok');
    const receipt = {
      at: now(),
      by,
      ok: problems.length === 0,
      okCount,
      total: results.length,
      diverged: problems.filter((r) => r.status === 'diverged').map((r) => r.project),
      failed: problems.map((r) => ({ project: r.project, repo: r.repo, status: r.status, failed: r.failed || [], error: r.error || '' })),
      results,
    };
    writeJSON(BACKUP_STATUS(), receipt);
    const summary = problems.length
      ? `Outbound private backup FAILED for ${problems.length}/${results.length} project(s): ${problems.map((r) => `${r.project} (${r.status})`).join(', ')}. Remote history kept intact.`
      : `Outbound private backup ran cleanly for ${okCount}/${results.length} project(s).`;
    logActivity({ by, path: '', kind: problems.length ? 'backup-error' : 'backup', text: summary });
  }
  return results;
}

// ---------- project standings (footing — replaces raw log wall) ----------
function memoLabVsCore(memo, name) {
  if (!memo) return labVsCore(name);
  const k = `lvc:${name}`;
  if (!memo.has(k)) memo.set(k, labVsCore(name));
  return memo.get(k);
}

export async function standings({ memo } = {}) {
  const pins = getPins();
  const flags = getFlags();
  const notes = getNotes(100);
  const labRepos = listRepos().filter((x) => x.room === 'lab');
  const out = await Promise.all(labRepos.map(async (r) => {
    const s = await memoLabVsCore(memo, r.name);
    const repoFlags = flags.filter((f) => under(f.path, r.rel) || (s.core && under(f.path, s.core.rel)));
    const latestNote = [...notes].reverse().find((n) => n.kind === 'note' && under(n.path, r.rel));
    const useNote = latestNote && (!s.lab.lastAt || new Date(latestNote.at) > new Date(s.lab.lastAt));
    return {
      name: r.name,
      rel: r.rel,
      coreRel: s.core?.rel || null,
      version: s.core?.version || s.lab.version || null,
      state: s.core?.changes ? 'core-edited' : s.state,
      ahead: s.ahead,
      changes: s.lab.changes,
      openFlags: repoFlags.length,
      pinned: pins.some((p) => under(p.path, r.rel)),
      lastText: useNote ? latestNote.text : (s.lab.lastMsg || ''),
      lastBy: useNote ? latestNote.by : (s.lab.lastBy || ''),
      lastAt: useNote ? latestNote.at : (s.lab.lastAt || ''),
    };
  }));
  return out.sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));
}

// ---------- needs attention (self-contained, zero homework) ----------
export async function attention({ memo } = {}) {
  const flags = getFlags();
  const dismissed = getDismissed();
  const flagItems = flags.map((f) => ({ type: 'flag', at: f.at, flag: f }));
  const repos = listRepos();
  const labNames = new Set(repos.filter((x) => x.room === 'lab').map((x) => x.name));
  const repoItems = (await Promise.all(repos.map(async (r) => {
    const found = [];
    if (r.room === 'lab') {
      const s = await memoLabVsCore(memo, r.name);
      // ground: being ahead is quiet. A card needs a case (foundry propose), and it carries the proposed version.
      const prop = s.state === 'ahead' ? await standingProposal(r.name, s.core.head) : null;
      if (prop) {
        const d = prop.head === s.lab.head ? { commits: s.commits, files: s.files, ahead: s.ahead } : await proposalDiff(r.name, s.core.head, prop.head);
        found.push({
          type: 'promote',
          lab: r.name,
          labRel: r.rel,
          core: s.core.rel,
          head: prop.head,
          title: s.title,
          ahead: d.ahead,
          labAhead: s.ahead,
          uncommitted: s.lab.changes,
          commits: d.commits,
          files: d.files,
          proposal: { why: prop.why, lived: prop.lived, restarts: prop.restarts, by: prop.by, at: prop.at },
          at: prop.at,
        });
      }
      if (s.state === 'no-core' && s.lab?.head && dismissed[r.name] !== s.lab.head) {
        found.push({ type: 'start-core', lab: r.name, labRel: r.rel, head: s.lab.head, title: s.title || r.name, at: s.lab.lastAt || now() });
      }
      if (s.state === 'diverged') found.push({ type: 'diverged', lab: r.name, labRel: r.rel, core: s.core.rel });
      if (s.core?.changes) found.push({ type: 'core-edited', rel: s.core.rel, changes: s.core.changes });
    } else if (r.room === 'core' && !labNames.has(r.name)) {
      const i = await repoInfo(r.rel);
      if (i.changes) found.push({ type: 'core-edited', rel: r.rel, changes: i.changes });
    }
    return found;
  }))).flat();
  return [...flagItems, ...repoItems];
}

// ---------- context file for agents ----------
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
export async function renderContext() {
  const pins = getPins();
  const trials = listTrials();
  const flags = getFlags();
  const lines = [`# Foundry — live context`, ``, `_Generated ${new Date().toLocaleString()} · home: ${FOUNDRY}_`, ``];
  lines.push(`## Current Focus (start here)`);
  if (!pins.length) lines.push(`- (none)`);
  for (const p of pins) lines.push(`- \`${p.path}\`${p.note ? ` — ${p.note}` : ''} _(pinned by ${p.by}, ${ago(p.at)})_`);
  if (trials.length) {
    lines.push(``, `## Active Trials (isolated build + skill capsules)`);
    for (const t of trials) {
      const bNames = (t.builds || []).map((b) => b.name).join(', ');
      const sNames = t.skills?.skills?.join(', ') || '';
      const parts = [bNames ? `builds: ${bNames}` : '', sNames ? `skills: ${sNames}` : ''].filter(Boolean).join(' · ');
      lines.push(`- **${t.name}** [${t.goal} · ${t.status}] · \`${t.rootRel}\` (${parts})${t.note ? ` — ${t.note}` : ''}`);
    }
  }
  lines.push(``, `## Open Flags (grouped by who should pick them up)`);
  if (!flags.length) lines.push(`- (none)`);
  else {
    const groups = new Map();
    for (const f of flags) { const k = f.for || 'breaker'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
    for (const [who, list] of groups) {
      lines.push(`### For ${who}`);
      for (const f of list) lines.push(`- **${f.id}** · \`${f.path}\` · ${f.tag} (from ${f.by})${f.note ? ` — "${f.note}"` : ''}${f.agent?.state ? ` · agent: ${f.agent.state}` : ''}`);
    }
  }
  lines.push(``, `## Where Things Stand`);
  for (const s of (await standings())) {
    const bits = [];
    if (s.state === 'no-core') bits.push('lab only');
    else if (s.state === 'same') bits.push('in core & synced');
    else if (s.state === 'ahead') bits.push(getProposal(s.name) ? `${s.ahead} save(s) ahead of core, case made for core` : `${s.ahead} save(s) ahead of core, no case made`);
    else if (s.state === 'core-edited') bits.push(`WARNING: hand edits inside core`);
    else bits.push(`lab and core split apart`);
    if (s.changes) bits.push(`${s.changes} uncommitted in lab`);
    lines.push(`- **${s.name}** (${bits.join(', ')}) — ${s.lastText || 'no recent notes'}`);
  }
  lines.push(``, `_Rules: edit only under lab/. Never edit core/ or state/ by hand. Log notes: \`foundry note "..." --by <you> --path <path>\`. Flag another agent: \`foundry flag <path> "note" --for <agent|you> --by <you>\`._`);
  return lines.join('\n');
}
export async function writeContextFile() {
  ensureBoard();
  const md = await renderContext();
  const file = path.join(BOARD, 'CONTEXT.md');
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, md);
  await fsp.rename(tmp, file);
  return md;
}

// ---------- ground: nothing moves up because someone saved ----------
// Four stages: bench (isolated trial), lab (active testing), core (trusted daily apps), public (shared releases).

// ----- 1. a core card needs a case -----
const PROPOSALS = () => path.join(BOARD, 'proposals.json');
export function getProposals() { return readJSON(PROPOSALS(), {}); }
export function getProposal(labName) { return getProposals()[labName] || null; }
/** Make the case for moving a lab version to core. why: what it is and what real work it did in the lab. */
export async function propose(labName, { why = '', lived = '', restarts = '', by = 'agent', commit = '' } = {}) {
  ensureBoard();
  const labAbs = toAbs(`lab/${labName}`);
  if (!isRepo(labAbs)) throw new Error(`No lab repo found at lab/${labName}.`);
  if (!String(why).trim()) throw new Error('A move to core needs its case: --why "what it is, and what real work it did in the lab".');
  const want = commit || 'HEAD';
  const h = await git(labAbs, ['rev-parse', '--verify', `${want}^{commit}`]);
  if (!h.ok) throw new Error(`lab/${labName} has no version ${want}.`);
  const onMain = await git(labAbs, ['merge-base', '--is-ancestor', h.out, 'HEAD']);
  if (!onMain.ok) throw new Error(`That version isn't in lab/${labName} yet. Land its bench first (foundry trial land).`);
  const core = coreFor(labName);
  if (core) {
    const ci = await repoInfo(core.rel, { fresh: true });
    if (ci.head === h.out) throw new Error(`core/${core.name} is already on that version.`);
    const fwd = await git(labAbs, ['merge-base', '--is-ancestor', ci.head, h.out]);
    if (!fwd.ok) throw new Error(`That version is behind core/${core.name}, or has split from it. Nothing was proposed.`);
  }
  const all = getProposals();
  all[labName] = { name: labName, head: h.out, why: String(why).trim(), lived: String(lived).trim(), restarts: String(restarts).trim(), by, at: now() };
  writeJSON(PROPOSALS(), all);
  clearCaches();
  logActivity({ by, path: `lab/${labName}`, kind: 'propose', text: `Made the case for core: ${String(why).trim()}` });
  return all[labName];
}
export function withdraw(labName, by = 'agent', why = '') {
  ensureBoard();
  const all = getProposals();
  if (!all[labName]) return false;
  delete all[labName];
  writeJSON(PROPOSALS(), all);
  clearCaches();
  logActivity({ by, path: `lab/${labName}`, kind: 'propose', text: `Took back the case for core${why ? `: ${why}` : ''}` });
  return true;
}
/** The proposal for a lab project if it still stands: its version is in the lab's line and ahead of core. */
export async function standingProposal(labName, coreHead) {
  const p = getProposal(labName);
  if (!p) return null;
  const labAbs = toAbs(`lab/${labName}`);
  const inLab = await git(labAbs, ['merge-base', '--is-ancestor', p.head, 'HEAD']);
  if (!inLab.ok) return null;
  if (coreHead) {
    if (coreHead === p.head) return null;
    const fwd = await git(labAbs, ['merge-base', '--is-ancestor', coreHead, p.head]);
    if (!fwd.ok) return null;
  }
  return p;
}
/** What a proposed move carries: the saves and files between core and the proposed version. */
export async function proposalDiff(labName, coreHead, head) {
  const labAbs = toAbs(`lab/${labName}`);
  const [logRes, diffRes, count] = await Promise.all([
    git(labAbs, ['log', `${coreHead}..${head}`, '-n', '8', '--pretty=format:%an%x1f%aI%x1f%s']),
    git(labAbs, ['diff', '--name-status', `${coreHead}..${head}`]),
    git(labAbs, ['rev-list', '--count', `${coreHead}..${head}`]),
  ]);
  const commits = logRes.ok && logRes.out ? logRes.out.split('\n').map((l) => { const [by, at, text] = l.split('\x1f'); return { by, at, text }; }) : [];
  const files = diffRes.ok && diffRes.out ? diffRes.out.split('\n').slice(0, 12).map((l) => { const [code, ...rest] = l.split('\t'); return { code: code[0], file: rest.join(' → ') }; }) : [];
  return { commits, files, ahead: parseInt(count.out, 10) || 0 };
}

// ----- 2. a bench lands in the lab, and the lab before it is kept -----
const LANDINGS = () => path.join(BOARD, 'landings.jsonl');
function labStamp() {
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  return `lab-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
// A link inside a bench (a junction to node_modules, say) is unlinked before the bench folder is removed,
// so removing the bench can never reach through the link and delete what it points at.
function unlinkLinks(dirAbs) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dirAbs)) {
      const p = path.join(dirAbs, e);
      let st; try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch {} } n++; }
    }
  } catch {}
  return n;
}
/** A bench joins the lab: each build's bench saves go onto the lab's line, and the lab before it gets a name. */
export async function landTrial(name, { by = 'builder', note = '' } = {}) {
  ensureBoard();
  const trial = getTrial(name);
  if (!trial) throw new Error(`No bench named "${name}".`);
  const parts = [...(trial.builds || []).map((b) => ({ labRel: b.labRel, worktreeRel: b.worktreeRel, base: b.base, name: b.name })),
    ...(trial.skills ? [{ labRel: trial.skills.labRel, worktreeRel: trial.skills.worktreeRel, base: trial.skills.base, name: 'agent-skills' }] : [])];
  // look before touching anything
  for (const p of parts) {
    const wt = await git(toAbs(p.worktreeRel), ['status', '--porcelain']);
    if (!wt.ok) throw new Error(`Can't read the bench copy of ${p.name}.`);
    if (wt.out) throw new Error(`The bench copy of ${p.name} has unsaved work. Save it first; nothing landed.`);
    const lab = await git(toAbs(p.labRel), ['status', '--porcelain']);
    if (lab.out) throw new Error(`${p.labRel} has unsaved work of its own. It needs a look first; nothing landed.`);
  }
  const stamp = labStamp();
  const landed = [];
  for (const p of parts) {
    const labAbs = toAbs(p.labRel);
    const before = (await git(labAbs, ['rev-parse', 'HEAD'])).out;
    const tip = (await git(toAbs(p.worktreeRel), ['rev-parse', 'HEAD'])).out;
    if (tip === before || (await git(labAbs, ['merge-base', '--is-ancestor', tip, 'HEAD'])).ok) { landed.push({ name: p.name, from: before, to: before, tag: null, nothing: true }); continue; }
    await git(labAbs, ['tag', stamp, before]);
    let m = await git(labAbs, ['merge', '--ff-only', tip]);
    if (!m.ok) {
      m = await git(labAbs, ['-c', `user.name=${by}`, 'merge', '--no-ff', '-m', `Land the bench "${name}" in the lab`, tip], { timeout: 60000 });
      if (!m.ok) {
        await git(labAbs, ['merge', '--abort']);
        await git(labAbs, ['tag', '-d', stamp]);
        throw new Error(`The bench "${name}" and ${p.labRel} changed the same lines of ${p.name}, so it can't land cleanly. Nothing changed in the lab; bring the lab's newer saves into the bench first.`);
      }
    }
    const after = (await git(labAbs, ['rev-parse', 'HEAD'])).out;
    appendLine(LANDINGS(), { at: now(), by, trial: name, name: p.name, from: before, to: after, tip, tag: stamp, note });
    landed.push({ name: p.name, from: before, to: after, tag: stamp });
  }
  // the bench is done: its copies go, its branch goes (the saves are in the lab now), anything else beside them stays
  for (const p of parts) {
    const labAbs = toAbs(p.labRel), wtAbs = toAbs(p.worktreeRel);
    unlinkLinks(wtAbs);
    await git(labAbs, ['worktree', 'remove', '--force', wtAbs]);
    await git(labAbs, ['worktree', 'prune']);
    await git(labAbs, ['branch', '-D', trial.branch]);
  }
  const rootAbs = toAbs(trial.rootRel);
  let kept = [];
  try { kept = fs.readdirSync(rootAbs); } catch {}
  if (!kept.length) { try { fs.rmdirSync(rootAbs); } catch {} }
  const trialsRoot = toAbs('lab/_trials');
  try { if (fs.existsSync(trialsRoot) && !fs.readdirSync(trialsRoot).length) fs.rmdirSync(trialsRoot); } catch {}
  fs.rmSync(path.join(TRIALS_DIR, `${name}.json`), { force: true });
  unpin(trial.rootRel, by);
  if (trial.flagId) { const f = getFlag(trial.flagId); if (f && f.status !== 'done') resolveFlag(trial.flagId, `Bench "${name}" landed in the lab.`, by); }
  clearCaches();
  logActivity({ by, path: parts[0]?.labRel || trial.rootRel, kind: 'land', text: `Landed the bench "${name}" in the lab${note ? `: ${note}` : ''} (the lab before it is kept as ${stamp})` });
  return { landed, tag: stamp, keptBeside: kept.length ? { where: trial.rootRel, what: kept } : null };
}
export function lastLanding(labName) {
  const rows = readLines(LANDINGS(), 1000).filter((p) => p.name === labName && !p.undone && !p.backOf);
  return rows[rows.length - 1] || null;
}
/** The lab returns to how it was before its last landing. The landed saves stay reachable on a branch. */
export async function labBack(labName, by = 'builder') {
  const last = lastLanding(labName);
  if (!last) throw new Error(`No landing in lab/${labName} to take back.`);
  const labAbs = toAbs(`lab/${labName}`);
  const st = await git(labAbs, ['status', '--porcelain']);
  if (st.out) throw new Error(`lab/${labName} has unsaved work. Nothing was taken back.`);
  const head = (await git(labAbs, ['rev-parse', 'HEAD'])).out;
  if (head !== last.to) throw new Error(`lab/${labName} has moved on since "${last.trial}" landed (newer saves sit on top), so it needs a look first. Nothing was taken back.`);
  const keep = `trial/${last.trial}-back`;
  await git(labAbs, ['branch', '-f', keep, last.to]);
  const r = await git(labAbs, ['reset', '--hard', last.from]);
  if (!r.ok) throw new Error('Could not take the landing back: ' + r.err);
  let raw = ''; try { raw = fs.readFileSync(LANDINGS(), 'utf8'); } catch {}
  const lines = raw.split('\n').filter(Boolean).map((line) => { try { const p = JSON.parse(line); return p.at === last.at && p.name === labName ? JSON.stringify({ ...p, undone: true }) : line; } catch { return line; } });
  lines.push(JSON.stringify({ at: now(), by, name: labName, from: last.to, to: last.from, backOf: last.at, trial: last.trial, keptOn: keep }));
  fs.writeFileSync(LANDINGS(), lines.join('\n') + '\n');
  const p = getProposal(labName); if (p && !(await git(labAbs, ['merge-base', '--is-ancestor', p.head, 'HEAD'])).ok) withdraw(labName, by, 'its landing was taken back');
  clearCaches();
  logActivity({ by, path: `lab/${labName}`, kind: 'land', text: `Took the landing of "${last.trial}" back out of the lab (its saves are kept on ${keep})` });
  return { to: last.from, keptOn: keep };
}

// ----- 3. every agent signs its own saves -----
// One shared hook folder for every lab project so every agent signs its own commits.
const SIGN_HOOK = `#!/bin/sh
name=$(git var GIT_AUTHOR_IDENT | sed 's/ <.*//')
case "$(printf '%s' "$name" | tr 'A-Z' 'a-z')" in
  you|"${CONFIG.human.id}"|"${CONFIG.human.name.toLowerCase()}"|"")
    if [ "$FOUNDRY_BY_HUMAN" = "1" ]; then exit 0; fi
    echo "This save has no agent name on it (signed \"$name\")." >&2
    echo "Save it as your agent:  git -c user.name=<agent-name> commit ..." >&2
    echo "Saving by hand:         FOUNDRY_BY_HUMAN=1 git commit ..." >&2
    exit 1 ;;
esac
exit 0
`;
export async function signInstall(by = 'builder') {
  fs.mkdirSync(HOOKS_DIR(), { recursive: true });
  fs.writeFileSync(path.join(HOOKS_DIR(), 'pre-commit'), SIGN_HOOK.replace(/\r\n/g, '\n'));
  const done = [];
  for (const r of listRepos().filter((x) => x.room === 'lab')) {
    const abs = toAbs(r.rel);
    const cur = await git(abs, ['config', '--local', '--get', 'core.hooksPath']);
    if (cur.ok && cur.out && path.resolve(cur.out) !== path.resolve(HOOKS_DIR())) { done.push({ name: r.name, skipped: `already uses its own hooks at ${cur.out}` }); continue; }
    const s = await git(abs, ['config', '--local', 'core.hooksPath', HOOKS_DIR().replace(/\\/g, '/')]);
    done.push({ name: r.name, ok: s.ok });
  }
  logActivity({ by, path: 'lab', kind: 'note', text: 'Lab saves now ask for an agent\'s name (foundry sign install)' });
  return done;
}
export async function signCheck(days = 3) {
  const out = [];
  for (const r of listRepos().filter((x) => x.room === 'lab')) {
    const abs = toAbs(r.rel);
    const hook = await git(abs, ['config', '--local', '--get', 'core.hooksPath']);
    const log = await git(abs, ['log', `--since=${days}.days`, '--pretty=format:%an']);
    const by = {};
    for (const n of (log.ok && log.out ? log.out.split('\n') : [])) by[n] = (by[n] || 0) + 1;
    out.push({ name: r.name, asks: !!(hook.ok && hook.out && path.resolve(hook.out) === path.resolve(HOOKS_DIR())), saves: by });
  }
  return out;
}
