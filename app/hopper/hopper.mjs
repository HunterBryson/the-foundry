// The Hopper: isolated idea queue, On Deck contender slots, and Caretaker Check-In state.
import fs from 'node:fs';
import path from 'node:path';
import * as F from '../lib.mjs';
import { CONFIG } from '../config.mjs';
import { takeSnapshot, compareSnapshots } from './tripwire.mjs';

export const HOPPER_DIR = path.resolve(process.env.HOPPER_DIR || path.join(F.FOUNDRY, 'state', 'hopper'));
const CARDS = () => path.join(HOPPER_DIR, 'cards');
const BACKUPS = () => path.join(HOPPER_DIR, 'backups');
const SNAPS = () => path.join(HOPPER_DIR, 'snapshots');
const META = () => path.join(HOPPER_DIR, 'meta.json');
const LOCK = () => path.join(HOPPER_DIR, 'hopper.lock');
const LOG = () => path.join(HOPPER_DIR, 'log.jsonl');

export const LIMITS = { running: 2, bench: 3, shots: 3 };
export const STAGES = ['hopper', 'running', 'bench', 'lab', 'parked', 'ended', 'halted'];
export const MODES = ['arena', 'scout', 'spike', 'scratch-fix', 'craft-lab'];
export const HINTS = ['explore', 'prototype', 'upgrade', 'scout'];
const ID_RE = /^h\d{3,}$/;
// Marker file written into external shot clones so `nuke` only deletes marked scratch clones.
export const SHOT_MARKER = '.hopper-shot.json';

function normHint(hint) {
  if (hint === undefined || hint === null || hint === '') return '';
  const h = String(hint).trim().toLowerCase();
  if (!h) return '';
  if (!HINTS.includes(h)) throw new Error(`--hint must be one of: ${HINTS.join(', ')}.`);
  return h;
}

function normSlot(slot) {
  if (slot === undefined || slot === null || slot === '') return null;
  const n = Number(slot);
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.bench) {
    throw new Error(`--slot must be 1, 2, or ${LIMITS.bench}.`);
  }
  return n;
}

function normClicks(v) {
  if (Array.isArray(v)) return v.map((s) => String(s || '').trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    return v.split('||').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function normScreenshots(v) {
  const arr = Array.isArray(v)
    ? v
    : (typeof v === 'string' && v.trim() ? v.split(',') : []);
  return arr
    .map((s) => path.basename(String(s || '').trim()))
    .filter((f) => f && /^[a-zA-Z0-9._-]+$/.test(f));
}

function normBootRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object') return null;
  const project = String(recipe.project || '').trim();
  const clone = recipe.clone ? path.resolve(String(recipe.clone).trim()) : '';
  const entry = String(recipe.entry || '').trim();
  const page = String(recipe.page || '/').trim() || '/';
  const seed = recipe.seed === 'empty' ? 'empty' : 'realistic';
  if (!project && !clone) return null;
  return { project: project || 'standalone', clone, entry, page: page.startsWith('/') ? page : '/' + page, seed };
}

function normOptions(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (let i = 0; i < v.length && out.length < 8; i++) {
    const raw = v[i];
    if (!raw || typeof raw !== 'object') continue;
    const label = String(raw.label || raw.title || '').trim().slice(0, 80);
    if (!label) continue;
    const id = String(raw.id || `opt-${i + 1}`).trim().slice(0, 32);
    const pRaw = String(raw.path || '/').trim();
    const optPath = pRaw.startsWith('/') || pRaw.startsWith('?') || pRaw.startsWith('#')
      ? (pRaw.startsWith('/') ? pRaw : '/' + pRaw)
      : '/' + pRaw;
    const note = String(raw.note || '').trim().slice(0, 140);
    out.push({ id, label, path: optPath, ...(note ? { note } : {}) });
  }
  return out;
}

function normQuestions(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (let i = 0; i < v.length && out.length < 4; i++) {
    const raw = v[i];
    if (!raw || typeof raw !== 'object') continue;
    const text = String(raw.text || raw.q || '').trim().slice(0, 180);
    if (!text) continue;
    const id = String(raw.id || `q${i + 1}`).trim().slice(0, 32);
    const chips = Array.isArray(raw.chips)
      ? raw.chips.map((c) => String(c || '').trim().slice(0, 60)).filter(Boolean).slice(0, 6)
      : [];
    out.push({ id, text, chips });
  }
  return out;
}

export const PULSES = ['on-track', 'needs-twist', 'missed'];
export const PULSE_LABELS = {
  'on-track': 'On track',
  'needs-twist': 'Close, needs a twist',
  'missed': 'Missed the mark',
};

export function normalizeCheckin(input, existing = null) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const src = input && typeof input === 'object' ? input : {};
  const rawPulse = src.pulse !== undefined ? String(src.pulse || '').trim().toLowerCase() : String(base.pulse || '').trim().toLowerCase();
  const pulse = PULSES.includes(rawPulse) ? rawPulse : '';
  const answers = {};
  const rawAns = src.answers !== undefined ? src.answers : base.answers;
  if (rawAns && typeof rawAns === 'object' && !Array.isArray(rawAns)) {
    for (const [k, v] of Object.entries(rawAns)) {
      const ck = String(k || '').trim().slice(0, 40);
      const cv = String(v || '').trim().slice(0, 120);
      if (ck && cv) answers[ck] = cv;
    }
  }
  const note = src.note !== undefined
    ? String(src.note || '').trim().slice(0, 800)
    : String(base.note || '').trim().slice(0, 800);
  const rawReacts = Array.isArray(src.reactions) ? src.reactions : (Array.isArray(base.reactions) ? base.reactions : []);
  const reactions = rawReacts
    .filter((r) => r && typeof r === 'object')
    .slice(-30)
    .map((r) => ({
      id: String(r.id || '').trim() || `r-${Math.random().toString(36).slice(2, 8)}`,
      at: String(r.at || ''),
      kind: r.kind === 'love' ? 'love' : 'note',
      screen: String(r.screen || '').trim().slice(0, 90),
      url: String(r.url || '').trim().slice(0, 240),
      text: String(r.text || '').trim().slice(0, 360),
    }));
  const updatedAt = src.updatedAt || base.updatedAt || null;
  if (!pulse && !Object.keys(answers).length && !note && !reactions.length) {
    return { pulse: '', answers: {}, note: '', reactions: [], updatedAt: null };
  }
  return { pulse, answers, note, reactions, updatedAt };
}

export function normalizeShowroom(input, existing = null) {
  if (!input && !existing) return null;
  const base = existing && typeof existing === 'object' ? existing : {};
  const src = input && typeof input === 'object' ? input : {};
  const itch = src.itch !== undefined ? String(src.itch || '').trim() : String(base.itch || '').trim();
  const swing = src.swing !== undefined ? String(src.swing || '').trim() : String(base.swing || '').trim();
  const firstClicks = src.firstClicks !== undefined ? normClicks(src.firstClicks) : normClicks(base.firstClicks);
  const weakestSpot = src.weakestSpot !== undefined ? String(src.weakestSpot || '').trim() : String(base.weakestSpot || '').trim();
  const screenshots = src.screenshots !== undefined ? normScreenshots(src.screenshots) : normScreenshots(base.screenshots);
  const bootRecipe = src.bootRecipe !== undefined ? normBootRecipe(src.bootRecipe) : normBootRecipe(base.bootRecipe);
  const options = src.options !== undefined ? normOptions(src.options) : normOptions(base.options);
  const questions = src.questions !== undefined ? normQuestions(src.questions) : normQuestions(base.questions);
  if (!itch && !swing && !firstClicks.length && !weakestSpot && !screenshots.length && !bootRecipe && !options.length && !questions.length) return null;
  return {
    itch, swing, firstClicks, weakestSpot, screenshots, bootRecipe,
    ...(options.length ? { options } : {}),
    ...(questions.length ? { questions } : {}),
  };
}

function hydrateCard(c) {
  if (!c || typeof c !== 'object') return c;
  return {
    ...c,
    hint: typeof c.hint === 'string' ? c.hint : '',
    benchSlot: Number.isInteger(c.benchSlot) && c.benchSlot >= 1 && c.benchSlot <= LIMITS.bench ? c.benchSlot : null,
    runNowAt: typeof c.runNowAt === 'string' && c.runNowAt ? c.runNowAt : null,
    chopRoomId: typeof c.chopRoomId === 'string' && c.chopRoomId ? c.chopRoomId : null,
    showroom: c.showroom ? normalizeShowroom(c.showroom) : null,
    checkin: normalizeCheckin(c.checkin),
  };
}

export function inferMode({ mode, run = '', build = '' } = {}) {
  if (mode !== undefined && mode !== '') {
    const m = String(mode).trim().toLowerCase();
    if (!MODES.includes(m)) throw new Error(`--mode must be one of: ${MODES.join(', ')}.`);
    return m;
  }
  const r = String(run || '').trim().toLowerCase();
  const b = String(build || '').trim().toLowerCase();
  if (b === 'craft-lab' || /\bcraft[- ]?lab\b/.test(r)) return 'craft-lab';
  if (/\barena\b/.test(r)) return 'arena';
  if (/\bscout\b/.test(r)) return 'scout';
  if (/\bscratch[- ]?fix\b/.test(r)) return 'scratch-fix';
  if (/\bspike\b/.test(r)) return 'spike';
  if (b && !['standalone', 'craft-lab'].includes(b)) return 'scratch-fix';
  return 'spike';
}

// ---------- lock, backup, atomic write ----------
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function ensureDirs() {
  for (const d of [CARDS(), BACKUPS(), SNAPS()]) fs.mkdirSync(d, { recursive: true });
}
function acquireLock(timeoutMs = 8000) {
  ensureDirs();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK(), 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const info = JSON.parse(fs.readFileSync(LOCK(), 'utf8'));
        stale = Date.now() - Number(info.at || 0) > 30000 || (info.pid && !pidAlive(info.pid));
      } catch {
        try { stale = Date.now() - fs.statSync(LOCK()).mtimeMs > 30000; } catch { stale = true; }
      }
      if (stale) { try { fs.rmSync(LOCK(), { force: true }); } catch {} continue; }
      if (Date.now() >= deadline) throw new Error('The Hopper is busy with another change. Try again in a moment.');
      sleepSync(15 + Math.floor(Math.random() * 30));
    }
  }
}
function releaseLock() {
  try {
    const info = JSON.parse(fs.readFileSync(LOCK(), 'utf8'));
    if (info.pid === process.pid) fs.rmSync(LOCK(), { force: true });
  } catch { try { fs.rmSync(LOCK(), { force: true }); } catch {} }
}
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  let last;
  for (let i = 0; i < 12; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      last = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
      sleepSync(20 + i * 10);
    }
  }
  try { fs.rmSync(tmp, { force: true }); } catch {}
  throw last;
}
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
const today = () => new Date().toISOString().slice(0, 10);

function saveCard(card) {
  const file = path.join(CARDS(), `${card.id}.json`);
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, path.join(BACKUPS(), `${card.id}.prev.json`));
      const dayDir = path.join(BACKUPS(), today());
      fs.mkdirSync(dayDir, { recursive: true });
      const daySnap = path.join(dayDir, `${card.id}.json`);
      if (!fs.existsSync(daySnap)) fs.copyFileSync(file, daySnap);
    } catch {}
  }
  card.updated = F.now();
  atomicWrite(file, card);
  return card;
}
function log(entry) {
  try { fs.appendFileSync(LOG(), JSON.stringify({ at: F.now(), ...entry }) + '\n'); } catch {}
}
// Every change: lock, read fresh, run, unlock. The rules see every card as it is on disk right now.
function change(fn) {
  acquireLock();
  try { return fn(); } finally { releaseLock(); }
}

// ---------- reading ----------
export function allCards() {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(CARDS())) {
    if (!/^h\d+\.json$/.test(f)) continue;
    const c = readJSON(path.join(CARDS(), f), null);
    if (c && c.id) out.push(hydrateCard(c));
  }
  return out;
}
// Human drops first, then oldest first. This order is the queue.
export const byPriority = (a, b) => (a.from === b.from ? 0 : (a.from === 'you' || a.from === 'user') ? -1 : 1) || String(a.at).localeCompare(String(b.at));
export function listCards({ stage } = {}) {
  return allCards().filter((c) => !stage || c.stage === stage).sort(byPriority);
}
export function getCard(id) {
  if (!ID_RE.test(String(id || ''))) throw new Error(`"${id}" isn't a card. Cards look like h001.`);
  const c = readJSON(path.join(CARDS(), `${id}.json`), null);
  if (!c) throw new Error(`No card ${id} in the Hopper.`);
  return hydrateCard(c);
}
const shotLimit = (c) => LIMITS.shots + (c.extraShots || 0);
const shotsTaken = (c) => (c.shots || []).length;
const flying = (c) => (c.shots || []).some((s) => s.status === 'flying');
const short = (t, n = 50) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const need = (v, what) => { if (!v || typeof v !== 'string' || !v.trim()) throw new Error(what); return v.trim(); };

// ---------- the commands ----------
export function add({ drop, from = 'you', by = 'you', hint = '' }) {
  drop = need(drop, 'A drop needs its line: foundry hopper add "the idea, however it comes out"');
  if (from === 'user') from = 'you';
  if (!['you', 'agent'].includes(from)) throw new Error('--from is you or agent.');
  const cleanHint = normHint(hint);
  return change(() => {
    const meta = readJSON(META(), { next: 1 });
    const used = allCards().reduce((m, c) => Math.max(m, Number(c.id.slice(1)) || 0), 0);
    const n = Math.max(meta.next || 1, used + 1);
    const id = `h${String(n).padStart(3, '0')}`;
    atomicWrite(META(), { ...meta, next: n + 1 });
    const card = saveCard({
      id, drop, from, by, at: F.now(),
      hint: cleanHint,
      hard: '', run: '', mode: '', build: '', stage: 'hopper',
      shots: [], extraShots: 0, brief: '',
      bet: '', weakest: '', live: '',
      benchSlot: null, runNowAt: null, chopRoomId: null, showroom: null,
      chop: null, ended: '', trial: '', tripped: null, history: [{ at: F.now(), by, did: 'dropped' }],
    });
    log({ id, by, did: 'add', from, ...(cleanHint ? { hint: cleanHint } : {}) });
    return card;
  });
}

export function frame({ id, hard, run, mode, build, by = 'lead' }) {
  return change(() => {
    const c = getCard(id);
    if (!['hopper', 'parked'].includes(c.stage)) throw new Error(`${id} is ${c.stage}; a card is framed while it waits in the Hopper.`);
    if (hard !== undefined) c.hard = need(hard, '--hard needs the hard part in words.');
    if (run !== undefined) c.run = need(run, '--run needs the run shape in words.');
    if (build !== undefined) c.build = need(build, '--build names the lab project the shots change, e.g. homebase.');
    if (mode !== undefined) c.mode = inferMode({ mode });
    else if (!c.mode) c.mode = inferMode({ run: c.run, build: c.build });
    if (!c.hard) throw new Error(`${id} still needs its hard part: foundry hopper frame ${id} --hard "..." --run "..."`);
    c.history.push({ at: F.now(), by, did: 'framed' });
    log({ id, by, did: 'frame', mode: c.mode });
    return saveCard(c);
  });
}

// The card the engine should shoot next, or null when the caps are full or nothing is framed.
export function next() {
  const cards = allCards();
  const running = cards.filter((c) => c.stage === 'running');
  const ready = running.filter((c) => !flying(c) && shotsTaken(c) < shotLimit(c)).sort(byPriority);
  if (ready.length) return { card: ready[0], why: 'running, ready for its next shot' };
  if (running.length >= LIMITS.running) return { card: null, why: `${running.length} cards are running, the most at once` };
  const waiting = cards.filter((c) => c.stage === 'hopper' && c.hard && c.run).sort(byPriority);
  return waiting.length ? { card: waiting[0], why: waiting[0].from === 'you' ? 'your card, framed and waiting' : 'agent-spotted, and none of his are waiting' } : { card: null, why: 'nothing framed is waiting' };
}

export async function shotStart({ id, by = 'builder' }) {
  // The snapshot is taken before the lock so a slow git read never holds the Hopper.
  const snapshot = await takeSnapshot();
  return change(() => {
    const c = getCard(id);
    if (!['hopper', 'running'].includes(c.stage)) throw new Error(`${id} is ${c.stage}; only a card in the Hopper or already running takes a shot.`);
    if (!c.hard || !c.run) throw new Error(`${id} isn't framed. The hard part and the run shape come first: foundry hopper frame ${id} --hard "..." --run "..."`);
    if (flying(c)) throw new Error(`${id} already has a shot in flight. Land it first.`);
    if (shotsTaken(c) >= shotLimit(c)) throw new Error(`${id} has taken ${shotsTaken(c)} of ${shotLimit(c)} shots. Bench it, nuke it, or give it one more with again.`);
    if (c.stage === 'hopper') {
      const cards = allCards();
      const running = cards.filter((x) => x.stage === 'running');
      if (running.length >= LIMITS.running) throw new Error(`${running.length} cards are already running (${running.map((x) => x.id).join(', ')}), the most at once on his one PC.`);
      if (c.from === 'agent') {
        const his = cards.filter((x) => x.stage === 'hopper' && x.from === 'you' && x.hard && x.run);
        if (his.length) throw new Error(`Your drops go first: ${his.map((x) => x.id).join(', ')} ${his.length === 1 ? 'is' : 'are'} framed and waiting.`);
      }
    }
    const n = shotsTaken(c) + 1;
    const snapFile = path.join(SNAPS(), `${id}-shot${n}.json`);
    atomicWrite(snapFile, snapshot);
    c.shots.push({ n, status: 'flying', startedAt: snapshot.at, by, aim: c.brief || '', snapshot: path.basename(snapFile) });
    c.brief = '';
    c.stage = 'running';
    c.history.push({ at: F.now(), by, did: `shot ${n} started` });
    log({ id, by, did: 'shot-start', n });
    return saveCard(c);
  });
}

export async function shotLand({ id, branch, clone, note = '', failed = '', bootedBy = '', by = 'builder' }) {
  let c = getCard(id);
  const shot = (c.shots || []).find((s) => s.status === 'flying');
  if (!shot) throw new Error(`${id} has no shot in flight.`);
  if (!failed) {
    need(branch, '--branch names the shot\'s branch in its clone (or --failed "why" if it didn\'t produce one).');
    need(clone, '--clone is the full path of the engine clone the shot ran in.');
  }
  const before = readJSON(path.join(SNAPS(), shot.snapshot), null);
  const after = await takeSnapshot();
  const trip = before ? await compareSnapshots(before, after) : { tripped: true, why: ['the starting snapshot is missing, so nothing can be proven'] };
  const result = change(() => {
    c = getCard(id);
    const s = c.shots.find((x) => x.n === shot.n);
    if (!s || s.status !== 'flying') throw new Error(`${id}'s shot ${shot.n} was already landed.`);
    Object.assign(s, {
      status: failed ? 'failed' : 'landed',
      landedAt: F.now(),
      branch: branch || '',
      clone: clone ? path.resolve(clone) : '',
      note: note || failed || '',
      tripwire: trip.tripped ? 'tripped' : 'clean',
      ...(bootedBy ? { bootedBy: String(bootedBy) } : {}),
    });
    if (trip.tripped) {
      c.stage = 'halted';
      c.tripped = { at: F.now(), shot: s.n, why: trip.why };
    }
    c.history.push({ at: F.now(), by, did: `shot ${s.n} ${s.status}${trip.tripped ? ', TRIPWIRE' : ''}` });
    log({ id, by, did: 'shot-land', n: s.n, status: s.status, tripwire: s.tripwire });
    return saveCard(c);
  });
  if (trip.tripped) {
    const note2 = `Hopper tripwire on ${id} shot ${shot.n} ("${short(c.drop, 60)}"): ${trip.why.join('; ')}. The card is halted. Look, then park or nuke it.`;
    for (const who of (CONFIG.crew.slice(0, 2).map((c) => c.id))) F.addFlag({ path: 'state/hopper', note: note2, tag: 'Fix', by: 'hopper', for: who });
    F.logActivity({ by: 'hopper', path: 'state/hopper', kind: 'tripwire', text: note2 });
  }
  return { card: result, tripwire: trip };
}

// Run the tripwire by hand against a card's last shot (it runs by itself on every land).
export async function tripwire({ id }) {
  const c = getCard(id);
  const shot = (c.shots || []).slice(-1)[0];
  if (!shot) throw new Error(`${id} hasn't taken a shot.`);
  const before = readJSON(path.join(SNAPS(), shot.snapshot), null);
  if (!before) throw new Error(`${id}'s shot ${shot.n} has no starting snapshot.`);
  return await compareSnapshots(before, await takeSnapshot());
}

function pickBenchSlot(onBench, requestedSlot) {
  const used = new Set();
  for (const x of onBench) {
    if (Number.isInteger(x.benchSlot) && x.benchSlot >= 1 && x.benchSlot <= LIMITS.bench) {
      used.add(x.benchSlot);
    }
  }
  // Account for legacy bench cards that lacked benchSlot so we don't collide with their fallback slots
  const unslotted = onBench.filter((x) => !x.benchSlot);
  for (const _ of unslotted) {
    for (let s = 1; s <= LIMITS.bench; s++) {
      if (!used.has(s)) { used.add(s); break; }
    }
  }
  if (requestedSlot !== null) {
    if (used.has(requestedSlot)) throw new Error(`Bench slot ${requestedSlot} is already occupied.`);
    return requestedSlot;
  }
  for (let s = 1; s <= LIMITS.bench; s++) {
    if (!used.has(s)) return s;
  }
  return null;
}

export function bench({ id, bet, weakest, live, slot, showroom, itch, swing, firstClicks, screenshots, bootRecipe, options, questions, by = 'lead' }) {
  const requestedSlot = normSlot(slot);
  return change(() => {
    const c = getCard(id);
    if (c.stage !== 'running') throw new Error(`${id} is ${c.stage}; a card goes to the bench from running.`);
    if (flying(c)) throw new Error(`${id} has a shot in flight. Land it first.`);
    if (!c.shots.some((s) => s.status === 'landed')) throw new Error(`${id} has no landed shot to show.`);
    const showroomInput = showroom && typeof showroom === 'object' ? { ...showroom } : {};
    if (itch !== undefined) showroomInput.itch = itch;
    if (swing !== undefined) showroomInput.swing = swing;
    if (firstClicks !== undefined) showroomInput.firstClicks = firstClicks;
    if (screenshots !== undefined) showroomInput.screenshots = screenshots;
    if (bootRecipe !== undefined) showroomInput.bootRecipe = bootRecipe;
    if (options !== undefined) showroomInput.options = options;
    if (questions !== undefined) showroomInput.questions = questions;

    const betVal = bet ?? (showroomInput.swing || undefined) ?? c.bet;
    const weakVal = weakest ?? (showroomInput.weakestSpot || undefined) ?? c.weakest;
    c.bet = need(betVal, '--bet is the bet in a sentence.');
    c.weakest = need(weakVal, '--weakest is where it\'s weakest.');

    const normSR = normalizeShowroom({
      ...showroomInput,
      ...(showroomInput.swing === undefined && !c.showroom?.swing ? { swing: c.bet } : {}),
      ...(showroomInput.weakestSpot === undefined && !c.showroom?.weakestSpot ? { weakestSpot: c.weakest } : {}),
    }, c.showroom);

    const liveVal = live !== undefined ? live : (c.live || (normSR?.bootRecipe ? (normSR.bootRecipe.clone || 'bench-slot') : ''));
    c.live = need(liveVal, '--live is the live thing he can open (a URL, a path, a command).');

    const onBench = allCards().filter((x) => x.stage === 'bench' && x.id !== c.id).sort(byPriority);
    if (onBench.length >= LIMITS.bench) throw new Error(`The bench is full (${onBench.map((x) => `${x.id} "${short(x.drop, 30)}"`).join(', ')}). Three at most: chop one first.`);
    const assignedSlot = pickBenchSlot(onBench, requestedSlot);
    c.benchSlot = assignedSlot;
    if (normSR) c.showroom = normSR;
    c.stage = 'bench';
    c.history.push({ at: F.now(), by, did: `benched${assignedSlot ? ` (slot ${assignedSlot})` : ''}` });
    log({ id, by, did: 'bench', slot: assignedSlot });
    return saveCard(c);
  });
}

export function markRunNow(id, { by = 'you' } = {}) {
  return change(() => {
    const c = getCard(id);
    if (c.stage !== 'hopper') {
      throw new Error(`${id} is ${c.stage}; Run Now is for a queued card in the Hopper.`);
    }
    c.runNowAt = F.now();
    c.history.push({ at: c.runNowAt, by, did: 'run now requested' });
    log({ id, by, did: 'run-now' });
    return saveCard(c);
  });
}

export function setChopRoom(id, roomId, { by = 'you' } = {}) {
  const rid = need(roomId, 'roomId is required.');
  return change(() => {
    const c = getCard(id);
    const ts = F.now();
    c.chopRoomId = rid;
    c.chopRequestedAt = ts;
    c.history.push({ at: ts, by, did: `chop room ${rid}` });
    log({ id, by, did: 'chop-room', roomId: rid });
    return saveCard(c);
  });
}

export function saveCheckin({ id, pulse, answers, note, by = 'you' }) {
  return change(() => {
    const c = getCard(id);
    const cur = normalizeCheckin(c.checkin);
    const nextAnswers = { ...cur.answers };
    if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
      for (const [k, v] of Object.entries(answers)) {
        const ck = String(k || '').trim().slice(0, 40);
        if (!ck) continue;
        const cv = String(v || '').trim().slice(0, 120);
        if (cv) nextAnswers[ck] = cv;
        else delete nextAnswers[ck];
      }
    }
    const nextPulse = pulse !== undefined
      ? (PULSES.includes(String(pulse).trim().toLowerCase()) ? String(pulse).trim().toLowerCase() : '')
      : cur.pulse;
    const nextNote = note !== undefined ? String(note || '').trim().slice(0, 800) : cur.note;
    c.checkin = normalizeCheckin({
      pulse: nextPulse,
      answers: nextAnswers,
      note: nextNote,
      reactions: cur.reactions,
      updatedAt: F.now(),
    });
    log({ id, by, did: 'checkin', pulse: c.checkin.pulse });
    return saveCard(c);
  });
}

export function addReaction({ id, kind = 'note', screen = '', url = '', text = '', by = 'you' }) {
  const cleanKind = kind === 'love' ? 'love' : 'note';
  const cleanText = String(text || '').trim().slice(0, 360);
  if (cleanKind === 'note' && !cleanText) {
    throw new Error('Add a short note or tap Love this screen.');
  }
  return change(() => {
    const c = getCard(id);
    const cur = normalizeCheckin(c.checkin);
    const reaction = {
      id: `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      at: F.now(),
      kind: cleanKind,
      screen: String(screen || '').trim().slice(0, 90),
      url: String(url || '').trim().slice(0, 240),
      text: cleanText,
    };
    c.checkin = normalizeCheckin({
      ...cur,
      reactions: [...cur.reactions, reaction].slice(-30),
      updatedAt: reaction.at,
    });
    c.history.push({
      at: reaction.at,
      by,
      did: cleanKind === 'love'
        ? `loved ${reaction.screen || 'screen'}`
        : `screen note${reaction.screen ? ` (${reaction.screen})` : ''}: ${short(cleanText, 70)}`,
    });
    log({ id, by, did: 'react', kind: cleanKind, screen: reaction.screen });
    saveCard(c);
    return { card: c, reaction };
  });
}

export function removeReaction({ id, reactionId, by = 'you' }) {
  const rid = need(reactionId, 'reactionId is required.');
  return change(() => {
    const c = getCard(id);
    const cur = normalizeCheckin(c.checkin);
    const next = cur.reactions.filter((r) => r.id !== rid);
    c.checkin = normalizeCheckin({
      ...cur,
      reactions: next,
      updatedAt: F.now(),
    });
    log({ id, by, did: 'unreact', reactionId: rid });
    return saveCard(c);
  });
}

export function formatCheckinBrief(card, override = {}) {
  const ck = normalizeCheckin({
    ...(card?.checkin || {}),
    ...(override.pulse !== undefined ? { pulse: override.pulse } : {}),
    ...(override.answers !== undefined ? { answers: { ...(card?.checkin?.answers || {}), ...(override.answers || {}) } } : {}),
    ...(override.note !== undefined ? { note: override.note } : {}),
  });
  const lines = [];
  if (ck.pulse) lines.push(`Gut pulse: ${PULSE_LABELS[ck.pulse] || ck.pulse}`);
  const qMap = new Map((card?.showroom?.questions || []).map((q) => [q.id, q.text]));
  const ansEntries = Object.entries(ck.answers || {});
  if (ansEntries.length) {
    lines.push('Check-in answers: ' + ansEntries.map(([k, v]) => `${qMap.get(k) || k} -> ${v}`).join(' | '));
  }
  if (ck.reactions && ck.reactions.length) {
    const rTxt = ck.reactions.map((r) => {
      const where = r.screen || r.url || 'screen';
      return r.kind === 'love'
        ? `Loved [${where}]${r.text ? `: ${r.text}` : ''}`
        : `Note [${where}]: ${r.text}`;
    }).join(' ; ');
    lines.push(`Screen reactions: ${rTxt}`);
  }
  if (ck.note) lines.push(`Check-in note: ${ck.note}`);
  return lines.join('\n');
}

export function again({ id, brief = '', weakest = false, by = 'you' }) {
  return change(() => {
    const c = getCard(id);
    const outOfShots = c.stage === 'running' && !flying(c) && shotsTaken(c) >= shotLimit(c);
    if (!['bench', 'parked'].includes(c.stage) && !outOfShots) {
      throw new Error(c.stage === 'halted'
        ? `${id} tripped the tripwire. Someone looks first, then parks it; again works from there.`
        : `${id} is ${c.stage}${c.stage === 'running' ? ` with ${shotLimit(c) - shotsTaken(c)} shot(s) left` : ''}; again is for a benched or parked card, or a running one out of shots.`);
    }
    const aim = (brief && brief.trim()) || (c.weakest ? `Aim at where it's weakest: ${c.weakest}` : '');
    if (!aim && weakest) throw new Error(`${id} has no weakest spot written yet, so give the shot a brief.`);
    c.extraShots = (c.extraShots || 0) + 1;
    c.brief = aim;
    c.benchSlot = null;
    c.chop = { kind: 'again', at: F.now(), by, brief: aim };
    if (c.stage !== 'running') c.stage = 'hopper';
    c.history.push({ at: F.now(), by, did: `one more shot${aim ? `: ${short(aim, 80)}` : ''}` });
    log({ id, by, did: 'again' });
    return saveCard(c);
  });
}

export function steer({ id, brief, by = 'you' }) {
  brief = need(brief, 'Steer needs a 1-line note for the next shot.');
  return change(() => {
    const c = getCard(id);
    if (!['running', 'hopper'].includes(c.stage)) throw new Error(`${id} is ${c.stage}; steer is for a running or queued card.`);
    c.brief = brief;
    c.history.push({ at: F.now(), by, did: `steer: ${short(brief, 80)}` });
    log({ id, by, did: 'steer' });
    return saveCard(c);
  });
}

export function park({ id, why = '', by = 'you' }) {
  return change(() => {
    const c = getCard(id);
    if (!['hopper', 'running', 'bench', 'halted'].includes(c.stage)) throw new Error(`${id} is ${c.stage}; nothing to park.`);
    if (flying(c)) throw new Error(`${id} has a shot in flight. Land it first.`);
    if (c.stage === 'bench') c.chop = { kind: 'park', at: F.now(), by, why };
    c.benchSlot = null;
    c.stage = 'parked';
    c.parked = { at: F.now(), by, why };
    c.history.push({ at: F.now(), by, did: `parked${why ? `: ${short(why, 80)}` : ''}` });
    log({ id, by, did: 'park' });
    return saveCard(c);
  });
}

// Wipes the card's engine clones (only folders carrying the shot marker for this card, never anything in the Foundry
// or a living agent's home), its snapshots, and keeps one line: why it died and what would reopen it.
export function nuke({ id, why, reopen, by = 'you' }) {
  why = need(why, 'A nuke keeps why it died: foundry hopper nuke <id> "why" --reopen "what would reopen it"');
  reopen = need(reopen, '--reopen says what would bring it back, so a dropped idea never turns into a fence.');
  return change(() => {
    const c = getCard(id);
    if (['ended', 'lab'].includes(c.stage)) throw new Error(`${id} is already ${c.stage}.`);
    if (flying(c) && c.stage !== 'halted') throw new Error(`${id} has a shot in flight. Land it first.`);
    const wiped = []; const kept = [];
    for (const s of c.shots || []) {
      if (s.clone) (wipeClone(s.clone, id) ? wiped : kept).push(s.clone);
      if (s.snapshot) { try { fs.rmSync(path.join(SNAPS(), s.snapshot), { force: true }); } catch {} }
    }
    c.benchSlot = null;
    c.chop = { kind: 'nuke', at: F.now(), by };
    c.ended = `${short(why, 200)} | reopens if: ${short(reopen, 200)}`;
    c.stage = 'ended';
    c.history.push({ at: F.now(), by, did: 'nuked' });
    log({ id, by, did: 'nuke', wiped, kept });
    saveCard(c);
    return { card: c, wiped, kept };
  });
}
function liveRoots() {
  const extra = (process.env.HOPPER_LIVE_EXTRA ?? (CONFIG.liveExtraDirs || []).join(';')).split(';').filter(Boolean);
  return [F.FOUNDRY, ...extra].map((p) => path.resolve(p).toLowerCase());
}
function wipeClone(clone, id) {
  const abs = path.resolve(clone);
  const low = abs.toLowerCase();
  if (liveRoots().some((r) => low === r || low.startsWith(r + path.sep) || r.startsWith(low + path.sep))) return false;
  const marker = readJSON(path.join(abs, SHOT_MARKER), null);
  if (!marker || marker.card !== id) return false;
  fs.rmSync(abs, { recursive: true, force: true });
  return !fs.existsSync(abs);
}

// Pull to Lab: the winning shot's branch comes into its own `foundry trial` (lab/_trials/hopper-<id>).
// The fetch only adds objects to the lab repo; no lab branch or working folder moves.
export async function pull({ id, build, shot: shotN, by = 'you' }) {
  const c = getCard(id);
  if (c.stage !== 'bench') throw new Error(`${id} is ${c.stage}; Pull to Lab is a chop from the bench.`);
  const target = need(build || c.build, `Which lab project does ${id} change? frame it with --build, or pull with --build <name>.`);
  const landed = (c.shots || []).filter((s) => s.status === 'landed' && s.branch && s.clone);
  const s = shotN ? landed.find((x) => x.n === Number(shotN)) : landed[landed.length - 1];
  if (!s) throw new Error(`${id} has no landed shot${shotN ? ` ${shotN}` : ''} with a branch to pull.`);
  if (!fs.existsSync(s.clone)) throw new Error(`The clone for shot ${s.n} is gone (${s.clone}).`);
  const labAbs = F.toAbs(`lab/${target}`);
  if (!F.isRepo(labAbs)) throw new Error(`No lab repo at lab/${target}.`);
  const f = await F.git(labAbs, ['fetch', '--no-tags', s.clone, s.branch], { timeout: 120000 });
  if (!f.ok) throw new Error(`Couldn't read ${s.branch} from the clone: ${f.err}`);
  const sha = (await F.git(labAbs, ['rev-parse', 'FETCH_HEAD'])).out;
  const trialName = `hopper-${id}`;
  const trial = await F.startTrial({ name: trialName, builds: [target], bases: { [target]: sha }, goal: 'build-only', note: `Hopper ${id}: ${short(c.bet || c.drop, 80)}`, by });
  const card = change(() => {
    const x = getCard(id);
    x.stage = 'lab';
    x.benchSlot = null;
    x.trial = trialName;
    x.chop = { kind: 'pull', at: F.now(), by, shot: s.n, commit: sha, trial: trialName };
    x.history.push({ at: F.now(), by, did: `pulled to lab as trial ${trialName}` });
    log({ id, by, did: 'pull', trial: trialName, commit: sha });
    return saveCard(x);
  });
  return { card, trial };
}

// One line for my wake (and anyone's): what's on the bench and what's moving.
export function benchLine() {
  const cards = allCards();
  const b = cards.filter((c) => c.stage === 'bench').sort(byPriority);
  const r = cards.filter((c) => c.stage === 'running').length;
  const h = cards.filter((c) => c.stage === 'hopper').length;
  const t = cards.filter((c) => c.stage === 'halted').length;
  const head = b.length ? `Bench: ${b.length} waiting (${b.map((c) => `${c.id} "${short(c.drop, 40)}"`).join('; ')})` : 'Bench: empty';
  return `${head}; ${r} running, ${h} in the Hopper${t ? `, ${t} HALTED by the tripwire` : ''}.`;
}
