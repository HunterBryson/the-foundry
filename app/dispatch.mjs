// Optional local CLI flag dispatcher (Antigravity or Claude Code), configured via foundry.config.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG, expandPath } from './config.mjs';
import { FOUNDRY, getFlag, saveFlag, logActivity, now, writeContextFile } from './lib.mjs';

const CANDIDATES = [
  process.env.AGY_PATH,
  CONFIG.dispatch?.bin ? expandPath(CONFIG.dispatch.bin) : '',
  path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'),
  path.join(os.homedir(), '.local', 'bin', 'agy'),
].filter(Boolean);

export const AGY = CANDIDATES.find((p) => fs.existsSync(p)) || null;
const running = new Map();

function promptFor(flag) {
  return [
    `A flag was opened in the local Foundry workshop at ${FOUNDRY}.`,
    ``,
    `Flag id: ${flag.id}`,
    `Where: ${flag.path || '(whole Foundry)'}  (absolute: ${path.join(FOUNDRY, flag.path || '')})`,
    `Kind: ${flag.tag}`,
    `Note: ${flag.note || '(inspect what needs attention here)'}`,
    ``,
    `Read ${path.join(FOUNDRY, '.foundry', 'CONTEXT.md')} first.`,
    `Rules: never edit core/ or state/ by hand. Start changes on a bench under lab/_trials/.`,
    `Finish with a concise plain-English summary (at most 8 short lines): what you found, what changed, and any decision needed.`,
  ].join('\n');
}

function extractText(stdout) {
  const s = stdout.trim();
  try {
    const j = JSON.parse(s);
    return j.result || j.response || j.text || j.content || j.message || s;
  } catch {
    for (const l of s.split('\n').reverse()) {
      try { const j = JSON.parse(l); const t = j.result || j.response || j.text; if (t) return t; } catch {}
    }
    return s;
  }
}

export function dispatch(id, onChange = () => {}) {
  if (!AGY) throw new Error('Antigravity CLI (agy) was not found. Configure dispatch.bin in foundry.config.json if installed elsewhere.');
  if (running.has(id)) return getFlag(id);
  const flag = getFlag(id);
  if (!flag) throw new Error(`No flag ${id}`);
  const agentId = CONFIG.dispatch?.agentId || CONFIG.crew[0]?.id || 'agent';
  const workDir = CONFIG.dispatch?.cwd ? expandPath(CONFIG.dispatch.cwd) : FOUNDRY;
  flag.agent = { state: 'working', startedAt: now() };
  saveFlag(flag);
  logActivity({ by: 'foundry', path: flag.path, kind: 'dispatch', text: `Dispatched flag on ${flag.path} to ${agentId}` });
  writeContextFile().catch(() => {});
  onChange();

  const child = spawn(AGY, ['-p', promptFor(flag), '--output-format', 'json', '--print-timeout', '30m', '--dangerously-skip-permissions', '--add-dir', FOUNDRY], {
    cwd: fs.existsSync(workDir) ? workDir : FOUNDRY,
    windowsHide: true,
    env: { ...process.env, FOUNDRY_AGENT: agentId },
  });
  running.set(id, child);
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const finish = (code) => {
    running.delete(id);
    const f = getFlag(id);
    if (!f) return;
    const text = extractText(out);
    f.agent = {
      ...f.agent,
      endedAt: now(),
      state: code === 0 && text ? 'answered' : 'failed',
      answer: code === 0 ? text : `Agent exited (${code}). ${(err || text || '').slice(-1200)}`,
    };
    saveFlag(f);
    logActivity({ by: agentId, path: f.path, kind: 'answer', text: f.agent.state === 'answered' ? `Answered flag on ${f.path}` : `Could not finish flag on ${f.path}` });
    writeContextFile().catch(() => {});
    onChange();
  };
  child.on('error', (e) => { err += e.message; finish(-1); });
  child.on('close', finish);
  return flag;
}

export function sweepInterrupted() {
  const dir = path.join(FOUNDRY, '.foundry', 'flags');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const id = file.replace(/\.json$/, '');
    const f = getFlag(id);
    if (f?.agent?.state === 'working' && !running.has(id)) {
      f.agent.state = 'interrupted';
      saveFlag(f);
    }
  }
}
