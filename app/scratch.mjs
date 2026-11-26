// Isolated loopback scratch server manager for Hopper On Deck previews.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { CONFIG } from './config.mjs';

export const LIVE_PORTS = new Set([CONFIG.port, 7931, 7940, 7950, 7960, 7968]);
const SCRATCH_META_DIR = () => path.join(CONFIG.home, 'state', 'scratch');

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitPort(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const up = await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.setTimeout(300);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
    });
    if (up) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export function listScratch() {
  const dir = SCRATCH_META_DIR();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({ ...j, running: pidAlive(j.pid) });
    } catch {}
  }
  return out;
}

export async function buildScratch(project = 'standalone', opts = {}) {
  const extDir = opts.dir ? path.resolve(opts.dir) : '';
  if (!extDir || !fs.existsSync(extDir)) {
    return { ok: false, error: `Scratch directory not found: ${extDir || '(empty)'}` };
  }
  let port = await freePort();
  while (LIVE_PORTS.has(port)) port = await freePort();

  const entryCandidates = [opts.entry, 'server.mjs', 'server.js', 'app/server.mjs', 'index.mjs', 'index.js'].filter(Boolean);
  const entryRel = entryCandidates.find((e) => fs.existsSync(path.join(extDir, e)));
  if (!entryRel) {
    return { ok: false, error: `No server entry file found in ${extDir}` };
  }

  const id = 'sc-' + crypto.randomBytes(3).toString('hex');
  const child = spawn(process.execPath, [path.join(extDir, entryRel)], {
    cwd: extDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PORT: String(port) },
  });
  child.unref();

  const ready = await waitPort(port, 45);
  if (!ready) {
    try { process.kill(child.pid); } catch {}
    return { ok: false, error: `Scratch server exited or did not bind 127.0.0.1:${port}` };
  }

  fs.mkdirSync(SCRATCH_META_DIR(), { recursive: true });
  const rec = { id, project, externalDir: extDir, entry: entryRel, port, pid: child.pid, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(SCRATCH_META_DIR(), `${id}.json`), JSON.stringify(rec, null, 2) + '\n');
  return { ok: true, ...rec, url: `http://127.0.0.1:${port}${opts.page || '/'}` };
}

export async function verifyScratch(id) {
  const item = listScratch().find((x) => x.id === id);
  if (!item) return { ok: false, error: `Unknown scratch id: ${id}` };
  const portUp = await waitPort(item.port, 3);
  return { ok: item.running && portUp, ...item, portUp };
}

export async function stopScratch(id) {
  const file = path.join(SCRATCH_META_DIR(), `${id}.json`);
  if (!fs.existsSync(file)) return { ok: true, stopped: false };
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (rec.pid && pidAlive(rec.pid)) {
      try { process.kill(rec.pid); } catch {}
    }
  } catch {}
  try { fs.rmSync(file, { force: true }); } catch {}
  return { ok: true, stopped: true, id };
}

export async function reconcileScratchOrphans(keepIds = []) {
  const keep = new Set(keepIds);
  const stopped = [];
  for (const sc of listScratch()) {
    if (!keep.has(sc.id)) {
      await stopScratch(sc.id);
      stopped.push(sc.id);
    }
  }
  return { stopped };
}
