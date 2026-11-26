// The Hopper's post-shot tripwire. Before a shot: a snapshot of every live repo. After it: the same snapshot again.
// It trips when
//   1. anything in core/ or public/ moved (a HEAD, a branch tip, or files changed in the folder), unless the core move is an intentional Move to core or Roll back recorded in .foundry/promotions.jsonl;
//   2. an engine-signed commit landed on any branch of a live repo (lab, core, public, and the agents' homes).
//      Engine-signed means author or committer email ending @hopper.engine, a name starting "Hopper Engine",
//      or a "Hopper-Card:" trailer. Trial branches (trial/*) are where Pull to Lab puts swings on purpose, so they're skipped.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as F from '../lib.mjs';
import { CONFIG } from '../config.mjs';

const ENGINE_EMAIL = /@hopper\.engine>?$/i;
const ENGINE_NAME = /^hopper engine/i;

export function liveRepos() {
  const repos = [];
  for (const room of ['lab', 'core', 'public']) {
    const dir = path.join(F.FOUNDRY, room);
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory() && F.isRepo(abs)) repos.push({ room, key: `${room}/${d.name}`, abs });
    }
  }
  const extra = (process.env.HOPPER_LIVE_EXTRA ?? (CONFIG.liveExtraDirs || []).join(';')).split(';').filter(Boolean);
  for (const e of extra) if (F.isRepo(e)) repos.push({ room: 'home', key: path.resolve(e), abs: path.resolve(e) });
  return repos;
}

async function repoState(r) {
  const [head, refs, status] = await Promise.all([
    F.git(r.abs, ['rev-parse', 'HEAD']),
    F.git(r.abs, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads']),
    // Folder changes matter only where nothing should move (core, public); lab and homes move all day.
    r.room === 'core' || r.room === 'public' ? F.git(r.abs, ['status', '--porcelain', '--untracked-files=all'], { timeout: 60000 }) : Promise.resolve({ ok: true, out: '' }),
  ]);
  const branches = {};
  for (const line of (refs.out || '').split('\n').filter(Boolean)) {
    const [ref, sha] = line.split('\t');
    branches[ref] = sha;
  }
  return {
    room: r.room, abs: r.abs, head: head.ok ? head.out : '', branches,
    status: crypto.createHash('sha1').update(status.out || '').digest('hex').slice(0, 16),
    statusOk: status.ok,
  };
}

export async function takeSnapshot() {
  const at = F.now();
  const repos = {};
  const list = liveRepos();
  const states = await Promise.all(list.map(repoState));
  list.forEach((r, i) => { repos[r.key] = states[i]; });
  return { at, foundry: F.FOUNDRY, repos };
}

function promotionsSince(at) {
  try {
    return fs.readFileSync(path.join(F.BOARD, 'promotions.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((p) => p && p.at >= at);
  } catch { return []; }
}

async function engineCommits(abs, newSha, oldTips) {
  const args = ['log', '--format=%H%x09%an%x09%ae%x09%cn%x09%ce%x09%(trailers:key=Hopper-Card,valueonly,separator=%x2C)', newSha];
  const not = oldTips.filter(Boolean);
  if (not.length) args.push('--not', ...not);
  else args.push('-n', '200');
  const r = await F.git(abs, args, { timeout: 60000 });
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([, an, ae, cn, ce, card]) =>
    ENGINE_EMAIL.test(ae || '') || ENGINE_EMAIL.test(ce || '') || ENGINE_NAME.test(an || '') || ENGINE_NAME.test(cn || '') || (card || '').trim())
    .map(([sha]) => sha.slice(0, 10));
}

export async function compareSnapshots(before, after) {
  const why = [];
  const promos = promotionsSince(before.at);
  const herMove = (key, sha) => promos.some((p) => `core/${p.name}` === key && p.to === sha);
  for (const [key, b] of Object.entries(before.repos)) {
    const a = after.repos[key];
    if (b.room === 'core' || b.room === 'public') {
      if (!a) { why.push(`${key} disappeared`); continue; }
      const moved = a.head !== b.head;
      if (moved && !(b.room === 'core' && herMove(key, a.head))) why.push(`${key} moved (${b.head.slice(0, 7)} to ${a.head.slice(0, 7)}) and no Move to core or Roll back explains it`);
      for (const [ref, sha] of Object.entries(a.branches)) {
        const was = b.branches[ref];
        if (was === sha) continue;
        if (b.room === 'core' && herMove(key, sha)) continue;
        if (!moved || sha !== a.head) why.push(`${key} ${ref.replace('refs/heads/', 'branch ')} ${was ? 'moved' : 'appeared'}`);
      }
      if (a.status !== b.status) why.push(`${key} has files changed in its folder since the shot started`);
    }
  }
  // Engine-signed commits on any live branch, new since the shot started.
  for (const [key, a] of Object.entries(after.repos)) {
    const b = before.repos[key];
    const oldTips = b ? [...new Set(Object.values(b.branches))] : [];
    for (const [ref, sha] of Object.entries(a.branches)) {
      if (ref.startsWith('refs/heads/trial/')) continue;
      if (b && b.branches[ref] === sha) continue;
      const found = await engineCommits(a.abs, sha, oldTips);
      if (found.length) why.push(`engine-signed commit${found.length > 1 ? 's' : ''} ${found.join(', ')} landed on ${key} ${ref.replace('refs/heads/', '')}`);
    }
  }
  for (const key of Object.keys(after.repos)) {
    if (!before.repos[key] && (after.repos[key].room === 'core' || after.repos[key].room === 'public')) why.push(`${key} is new since the shot started`);
  }
  return { tripped: why.length > 0, why: [...new Set(why)], checked: Object.keys(after.repos).length, since: before.at };
}
