// Live Match: after a move or roll back, make what's running match core, then prove it.
// It rebuilds changed pages, restarts only what the move touched, and checks the live process and page.
// A process is trusted only if it started after this restart: an old process can't report the new version.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import * as F from './lib.mjs';
import { CONFIG } from './config.mjs';

const NODE = process.env.NODE_EXE || process.execPath;
const LIVE_PORTS = new Set([CONFIG.port, ...(CONFIG.benchPorts || [7991, 7992, 7993])]);
const isConfiguredHome = () => path.resolve(F.FOUNDRY).toLowerCase() === path.resolve(CONFIG.home).toLowerCase();
const DEFAULT_SURFACES = {};

const receiptDir = () => path.join(F.BOARD, 'live-match');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(file, args, { cwd, timeout = 120000, env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, env: env || process.env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr || err?.message || '').trim() }));
  });
}
const ps = (script, opts) => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], opts);

export function surfacesFor(name) {
  const custom = F.config().liveMatch?.surfaces?.[name] || CONFIG.liveMatch?.surfaces?.[name];
  if (custom) return custom;
  return isConfiguredHome() ? (DEFAULT_SURFACES[name] || []) : [];
}
function matches(file, rule) {
  if (rule === '*') return true;
  if (rule.startsWith('*.')) return file.endsWith(rule.slice(1));
  return rule.endsWith('/') ? file.startsWith(rule) : file === rule;
}
export const touched = (surface, files) => files.filter((f) =>
  surface.touches.some((r) => matches(f, r)) && !(surface.except || []).some((r) => matches(f, r)));

// Only the owner of the 127.0.0.1 port, so tailscaled on the same port number is never in play.
export async function portOwner(port) {
  const script = `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -LocalAddress 127.0.0.1 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; [pscustomobject]@{ pid = [int]$c.OwningProcess; name = $p.Name; started = $p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`;
  const r = await ps(script, { timeout: 20000 });
  if (!r.ok || !r.out) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}
function assertScratchSafePort(port) {
  if (!isConfiguredHome() && port && LIVE_PORTS.has(Number(port))) {
    throw new Error(`refusing to touch live port ${port} while running on scratch Foundry (${F.FOUNDRY})`);
  }
}
async function renameRetry(from, to) {
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) { if (i === 5 || !/EPERM|EBUSY|EACCES/.test(e.code || '')) throw e; await sleep(150); }
  }
}
async function stopOwner(port) {
  assertScratchSafePort(port);
  const owner = await portOwner(port);
  if (!owner) return { stopped: false };
  if (!/^node(\.exe)?$/i.test(owner.name || '')) throw new Error(`port ${port} on 127.0.0.1 belongs to ${owner.name}, so it was left alone`);
  const r = await ps(`Stop-Process -Id ${owner.pid} -Force -ErrorAction SilentlyContinue`, { timeout: 15000 });
  for (let i = 0; i < 20 && await portOwner(port); i++) await sleep(200);
  if (await portOwner(port)) {
    await run('taskkill.exe', ['/F', '/T', '/PID', String(owner.pid)], { timeout: 15000 });
    for (let i = 0; i < 30 && await portOwner(port); i++) await sleep(250);
  }
  if (await portOwner(port)) throw new Error(`the old process on ${port} (pid ${owner.pid}) did not exit${r.err ? `: ${r.err}` : ''}`);
  return { stopped: true, pid: owner.pid };
}

async function buildPages(coreAbs, build, onTouch = () => {}) {
  const dir = path.join(coreAbs, build.dir);
  const vite = path.join(coreAbs, 'node_modules', 'vite', 'bin', 'vite.js');
  const tsc = path.join(coreAbs, 'node_modules', 'typescript', 'bin', 'tsc');
  const next = path.join(dir, 'dist.next');
  const dist = path.join(dir, 'dist');
  const prev = path.join(dir, 'dist.prev');
  fs.rmSync(next, { recursive: true, force: true });
  if (fs.existsSync(tsc)) {
    const t = await run(NODE, [tsc, '--noEmit'], { cwd: dir, timeout: 240000 });
    if (!t.ok) throw new Error('the page failed its type check: ' + (t.out || t.err).slice(-400));
  }
  // Built beside the live page and swapped in, so a failed build leaves the working page up.
  const b = await run(NODE, [vite, 'build', '--outDir', 'dist.next', '--emptyOutDir'], { cwd: dir, timeout: 240000 });
  if (!b.ok) { fs.rmSync(next, { recursive: true, force: true }); throw new Error('the page build failed: ' + (b.err || b.out).slice(-400)); }
  if (!fs.existsSync(path.join(next, 'index.html'))) throw new Error('the page build made no index.html');
  fs.rmSync(prev, { recursive: true, force: true });
  onTouch();
  if (fs.existsSync(dist)) await renameRetry(dist, prev);
  try { await renameRetry(next, dist); } catch (e) { if (fs.existsSync(prev)) await renameRetry(prev, dist); throw e; }
  fs.rmSync(prev, { recursive: true, force: true });
}

async function restartSurface(coreAbs, s) {
  assertScratchSafePort(s.port);
  const r = s.restart;
  if (r.ps1) {
    const res = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(coreAbs, r.ps1)], { cwd: coreAbs, timeout: 60000 });
    if (!res.ok) throw new Error(`${s.id} did not restart: ${(res.out || res.err).slice(-300)}`);
  } else if (r.tool) {
    const res = await run(NODE, [path.join(coreAbs, r.tool[0]), ...r.tool.slice(1)], { cwd: coreAbs, timeout: 60000 });
    if (!res.ok) throw new Error(`${s.id} did not restart: ${(res.out || res.err).slice(-300)}`);
  } else if (r.vbs) {
    await stopOwner(s.port);
    const file = path.isAbsolute(r.vbs) ? r.vbs : path.join(coreAbs, r.vbs);
    const res = await run('wscript.exe', [file], { cwd: path.dirname(file), timeout: 20000 });
    if (!res.ok) throw new Error(`${s.id} did not restart: ${res.err.slice(-300)}`);
  } else if (r.node) {
    await stopOwner(s.port);
    const child = spawn(NODE, r.node.map((a) => (/\.m?js$/.test(a) ? path.join(coreAbs, a) : a)), {
      cwd: coreAbs, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...(r.env || {}) },
    });
    child.unref();
  } else throw new Error(`${s.id} has no way to restart`);
}

async function fetchOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { host: '127.0.0.1' } });
    return { ok: res.ok, status: res.status, body: res.ok ? await res.text() : '' };
  } catch (e) { return { ok: false, status: 0, body: '', error: e.message }; }
}

async function checkSurface(coreAbs, s, { restartedAt, beforePid } = {}) {
  const deadline = Date.now() + 20000;
  let last = 'nothing answered';
  while (Date.now() < deadline) {
    const owner = s.port ? await portOwner(s.port) : null;
    if (s.port && !owner) { last = `nothing is listening on ${s.port}`; await sleep(500); continue; }
    if (beforePid && owner && owner.pid === beforePid) { last = `the process on ${s.port} is still the old one (pid ${beforePid})`; await sleep(500); continue; }
    if (restartedAt && owner && Date.parse(owner.started) < restartedAt - 1500) { last = `the process on ${s.port} is the old one`; await sleep(500); continue; }
    if (s.health) {
      const h = await fetchOk(`http://127.0.0.1:${s.port}${s.health}`);
      if (!h.ok) { last = `${s.health} answered ${h.status || h.error}`; await sleep(500); continue; }
    }
    if (s.served) {
      const disk = JSON.parse(fs.readFileSync(path.join(coreAbs, s.build.dir, 'dist', 'build.json'), 'utf8')).build;
      const page = await fetchOk(`http://127.0.0.1:${s.port}${s.served}`);
      let live = null;
      try { live = JSON.parse(page.body).build; } catch {}
      if (!disk || live !== disk) { last = `the page being served is ${live || 'unreadable'}, not the new build ${disk}`; await sleep(500); continue; }
    }
    return { id: s.id, ok: true, pid: owner?.pid, started: owner?.started };
  }
  return { id: s.id, ok: false, problem: last };
}

async function changedFiles(coreAbs, from, to) {
  const r = from
    ? await F.git(coreAbs, ['diff', '--name-only', from, to])
    : await F.git(coreAbs, ['ls-tree', '-r', '--name-only', to]);
  if (!r.ok) throw new Error('could not read what changed: ' + r.err);
  return r.out.split('\n').filter(Boolean);
}

export async function planMatch(name, from, to) {
  const coreAbs = F.toAbs(`core/${name}`);
  const files = await changedFiles(coreAbs, from, to);
  const hit = surfacesFor(name).filter((s) => touched(s, files).length);
  return {
    name, from, to, files,
    packagesChanged: files.filter((f) => /(^|\/)(package\.json|package-lock\.json)$/.test(f)),
    rebuild: hit.filter((s) => s.build).map((s) => s.id),
    restart: hit.filter((s) => s.restart).map((s) => s.id),
    check: hit.map((s) => s.id),
  };
}

function saveReceipt(result) {
  fs.mkdirSync(receiptDir(), { recursive: true });
  const file = path.join(receiptDir(), `${result.name}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, file);
  fs.appendFileSync(path.join(receiptDir(), 'history.jsonl'), JSON.stringify({ at: result.at, name: result.name, kind: result.kind, ok: result.ok, to: result.to, problems: result.problems }) + '\n');
}

// touchedLive tells the caller whether anything running was changed before a problem appeared.
export async function liveMatch(name, { from, to, kind = 'move', dryRun = false }) {
  const coreAbs = F.toAbs(`core/${name}`);
  const plan = await planMatch(name, from, to);
  if (dryRun) return { ok: true, dryRun: true, kind, ...plan };
  const result = { at: F.now(), kind, ...plan, ok: false, superseded: false, touchedLive: false, surfaces: [], failedFiles: [], problems: [] };
  const finish = () => { result.ok = result.problems.length === 0; saveReceipt(result); return result; };
  const head = await F.git(coreAbs, ['rev-parse', 'HEAD']);
  if (head.out !== to) {
    const newer = to ? await F.git(coreAbs, ['merge-base', '--is-ancestor', to, 'HEAD']) : { ok: false };
    if (newer.ok) result.superseded = true;
    result.problems.push(newer.ok
      ? `core/${name} already moved on to a newer version`
      : `core/${name} is not on the version this check was for`);
    return finish();
  }
  const surfaces = surfacesFor(name).filter((s) => plan.check.includes(s.id));
  const surfaceFiles = (list) => [...new Set(list.flatMap((s) => touched(s, plan.files)))];
  if (surfaces.length && plan.packagesChanged.length) {
    result.failedFiles = [...new Set([...plan.packagesChanged, ...surfaceFiles(surfaces)])];
    result.problems.push(`its packages changed (${plan.packagesChanged.join(', ')}), and those are copied by hand`);
    return finish();
  }
  const failedSurfaces = [];
  try {
    for (const s of surfaces.filter((x) => x.build)) {
      try { await buildPages(coreAbs, s.build, () => { result.touchedLive = true; }); }
      catch (e) { failedSurfaces.push(s); throw e; }
    }
    const restarted = {};
    const seen = new Set();
    for (const s of surfaces.filter((x) => x.restart)) {
      const key = `${s.port}:${JSON.stringify(s.restart)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const beforePid = s.port ? (await portOwner(s.port))?.pid || null : null;
      result.touchedLive = true;
      const at = Date.now();
      try { await restartSurface(coreAbs, s); }
      catch (e) { failedSurfaces.push(s); throw e; }
      for (const x of surfaces) if (x.port === s.port) restarted[x.id] = { at, beforePid };
    }
    for (const s of surfaces) {
      const c = await checkSurface(coreAbs, s, restarted[s.id]);
      result.surfaces.push(c);
      if (!c.ok) { failedSurfaces.push(s); result.problems.push(`${s.id}: ${c.problem}`); }
    }
  } catch (e) { result.problems.push(e.message); }
  if (result.problems.length) {
    result.failedFiles = failedSurfaces.length ? surfaceFiles(failedSurfaces) : surfaceFiles(surfaces);
  }
  return finish();
}

export function matchStatus() {
  let names = [];
  try { names = fs.readdirSync(receiptDir()).filter((f) => f.endsWith('.json')); } catch {}
  return names.map((f) => {
    const r = JSON.parse(fs.readFileSync(path.join(receiptDir(), f), 'utf8'));
    return { name: r.name, at: r.at, kind: r.kind, ok: r.ok, version: r.to, problems: r.problems };
  });
}

// By hand: re-run the check for the last move of a project. It reports and never rolls back.
export async function matchLastMove(name, { dryRun = false } = {}) {
  const last = F.lastPromotion(name);
  if (!last) throw new Error(`No move of ${name} to check.`);
  return liveMatch(name, { from: last.from, to: last.to, kind: 'move', dryRun });
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function withMatchLock(name, fn) {
  fs.mkdirSync(receiptDir(), { recursive: true });
  const lock = path.join(receiptDir(), `${name}.lock`);
  const deadline = Date.now() + 60000;
  let acquired = false;
  while (!acquired && Date.now() < deadline) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: F.now() }));
      fs.closeSync(fd);
      acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const cur = JSON.parse(fs.readFileSync(lock, 'utf8'));
        if (cur?.pid && !pidAlive(cur.pid)) { fs.rmSync(lock, { force: true }); continue; }
      } catch { fs.rmSync(lock, { force: true }); continue; }
      await sleep(200);
    }
  }
  if (!acquired) throw new Error(`another Live Match for ${name} is still holding the lock`);
  try { return await fn(); } finally { fs.rmSync(lock, { force: true }); }
}

// What the detached runner does: match; on a broken move, roll back, match again, block it, and tell him in one line.
export async function runAfterMove(name, from, to, kind) {
  return withMatchLock(name, async () => {
    const first = await liveMatch(name, { from, to, kind });
    if (first.ok) {
      F.logActivity({ by: 'live-match', path: `core/${name}`, kind: 'match', text: `Live Match: ${name} is really running the new version.` });
      await F.writeContextFile();
      return { ok: true, first };
    }
    if (first.superseded) {
      F.logActivity({ by: 'live-match', path: `core/${name}`, kind: 'match', text: `Live Match: skipped an older move of ${name} because a newer move is already in core.` });
      await F.writeContextFile();
      return { ok: true, superseded: true, first };
    }
    const why = first.problems.join('; ').slice(0, 300);
    if (kind !== 'move' || !from) {
      F.addFlag({ path: `core/${name}`, tag: 'Live Match', by: 'live-match', for: 'hunter', note: `${name} did not come up right after a ${kind === 'move' ? 'first move' : 'roll back'}: ${why}` });
      await F.writeContextFile();
      return { ok: false, first };
    }
    const blockFiles = first.failedFiles?.length ? first.failedFiles : first.files;
    try {
      await F.rollback(name, 'live-match', { noMatch: true });
    } catch (rbErr) {
      await F.addBlock({ name, commit: to, files: blockFiles, why, by: 'live-match' });
      F.addFlag({
        path: `core/${name}`, tag: 'Live Match', by: 'live-match', for: 'hunter',
        note: `URGENT: ${name} broke Live Match and automatic roll back failed (${rbErr.message.slice(0, 180)}). The broken version is blocked; core needs a look. Move failed on: ${why}`,
      });
      await F.writeContextFile();
      return { ok: false, rolledBack: false, held: false, rollbackError: rbErr.message, first };
    }
    let back = null;
    if (first.touchedLive) back = await liveMatch(name, { from: to, to: from, kind: 'rollback' });
    await F.addBlock({ name, commit: to, files: blockFiles, why, by: 'live-match' });
    const held = !back || back.ok;
    F.addFlag({
      path: `core/${name}`, tag: 'Live Match', by: 'live-match', for: 'hunter',
      note: held
        ? `${name} was rolled back to the last good version and is running it. The move didn't take: ${why}`
        : `URGENT: ${name} was rolled back but is NOT running right: ${back.problems.join('; ').slice(0, 240)}. The move failed on: ${why}`,
    });
    await F.writeContextFile();
    return { ok: false, rolledBack: true, held, first, back };
  });
}
