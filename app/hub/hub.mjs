// Crew Dock live aggregator (/api/hub, /api/hub/drop, /api/hub/ack) + static /hub asset server.
// Synthesizes Foundry, Hopper (On Deck), Monty's Floor, Schedule, The Link, and Homebase/Den into plain English.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from '../lib.mjs';
import * as H from '../hopper/hopper.mjs';
import { CONFIG } from '../config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FACES_DIR = path.join(HERE, 'faces');

const CREW_META = CONFIG.crew;

const CREW_IDS = new Set(CREW_META.map((c) => c.id));

const PROJECT_NAMES = {
  'the-foundry': 'The Foundry',
  'monty-floor': "Monty's Floor",
  'the-homebase': 'Homebase',
  'the-den': 'The Den',
  'the-glass': 'The Glass',
  'the-shelves': 'The Shelves',
};

const HINT_TO_HOPPER = {
  build: 'prototype',
  fix: 'upgrade',
  explore: 'explore',
  scout: 'scout',
  prototype: 'prototype',
  upgrade: 'upgrade',
};

const HOPPER_TO_LABEL = {
  prototype: 'Build',
  upgrade: 'Fix',
  explore: 'Explore',
  scout: 'Scout',
};

const FACE_MIMES = {
  'builder.svg': 'image/svg+xml',
  'planner.svg': 'image/svg+xml',
  'lead.svg': 'image/svg+xml',
  'breaker.svg': 'image/svg+xml',
};
const EXT_MIMES = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const STATIC_ASSETS = {
  '/hub': { file: 'index.html', mime: 'text/html; charset=utf-8' },
  '/hub/': { file: 'index.html', mime: 'text/html; charset=utf-8' },
  '/hub/index.html': { file: 'index.html', mime: 'text/html; charset=utf-8' },
  '/hub/hub.css': { file: 'hub.css', mime: 'text/css; charset=utf-8' },
  '/hub/hub.js': { file: 'hub.js', mime: 'application/javascript; charset=utf-8' },
  '/hub/manifest.webmanifest': { file: 'manifest.webmanifest', mime: 'application/manifest+json; charset=utf-8' },
};

function hubStateDir() {
  return path.resolve(process.env.FOUNDRY_HUB_STATE_DIR || path.join(F.FOUNDRY, 'state', 'foundry-hub'));
}

function ackFilePath() {
  return path.join(hubStateDir(), 'ack.json');
}

function readAckMap() {
  try {
    const raw = JSON.parse(fs.readFileSync(ackFilePath(), 'utf8'));
    if (raw && raw.acked && typeof raw.acked === 'object') return raw.acked;
  } catch {}
  return {};
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function writeAckMapAtomic(acked) {
  const file = ackFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), acked }, null, 2) + '\n', 'utf8');
  let lastErr;
  for (let i = 0; i < 10; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
      sleepSync(20 + i * 10);
    }
  }
  try { fs.rmSync(tmp, { force: true }); } catch {}
  throw lastErr;
}

function cap(s = '') {
  const str = String(s || '');
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

function normAgent(who, fallback = CREW_META[0]?.id || 'builder') {
  const w = String(who || '').trim().toLowerCase();
  if (CREW_IDS.has(w)) return w;
  return fallback;
}

function prettyProjectName(raw = '') {
  const clean = String(raw || '').trim().replace(/^(lab|core|public)\//, '');
  if (!clean) return 'Foundry';
  if (PROJECT_NAMES[clean]) return PROJECT_NAMES[clean];
  return clean
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((w) => cap(w))
    .join(' ');
}

function prettyPathLabel(rel = '') {
  const clean = String(rel || '').trim().replace(/\\/g, '/');
  if (!clean) return 'Foundry';
  if (clean.startsWith('lab/_trials/')) {
    const parts = clean.split('/');
    return `${parts[2] || 'trial'} bench`;
  }
  const segs = clean.split('/');
  if ((segs[0] === 'lab' || segs[0] === 'core' || segs[0] === 'public') && segs[1]) {
    return prettyProjectName(segs[1]);
  }
  return prettyProjectName(segs[segs.length - 1]);
}

// Plain-English cleaner: removes raw commit hashes, bare Hopper/flag/Link IDs, and raw localhost/port numbers.
export function sanitizePlainText(input = '') {
  let s = String(input || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // Remove URLs with localhost/127.0.0.1 ports
  s = s.replace(/\bhttps?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/?[^\s)]*/gi, '');
  // Remove parenthesized or standalone port numbers like (:7991), :7988, port 7960
  s = s.replace(/\(\s*:\d{4,5}(?:\/:\d{4,5})*\s*\)/g, '');
  s = s.replace(/(?<=^|[\s/,(]):\d{4,5}\b/g, '');
  s = s.replace(/\bports?\s+\d{4,5}(?:\s*[-–/]\s*:?\d{4,5})?\b/gi, '');
  // Remove bare flag IDs (f-20261125-abcd) and bare Hopper IDs (h004)
  s = s.replace(/\bf-\d{8}-[0-9a-f]{3,8}\b[:\s·-]*/gi, '');
  s = s.replace(/\(\s*h\d{3,}\s*\)/gi, '');
  s = s.replace(/\bh\d{3,}\b(?:\s*[·:—-]\s*|\s+)/gi, '');
  s = s.replace(/\bh\d{3,}\b/gi, '');
  // Remove bare Link item numbers like "#12" or "Item #4" (keep named #room channel tags intact)
  s = s.replace(/\b(?:link\s*|item\s*)?#\d+\b[:\s·-]*/gi, '');
  // Remove standalone git commit hashes (7-40 hex chars containing at least one digit)
  s = s.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi, '');
  // Replace any legacy "Bench" reference to Hopper slots with "On Deck" when paired with Hopper/Showroom
  s = s.replace(/\bBench Showroom\b/gi, 'On Deck');
  // Clean up leftover empty parens or double punctuation
  s = s.replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').replace(/^[\s·:—-]+|[\s·:—-]+$/g, '').trim();
  return s;
}

function truncate(str = '', max = 72) {
  const s = String(str || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function formatAgo(iso) {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const sec = Math.max(0, (Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

export function labelForHint(hint = '') {
  const h = String(hint || '').trim().toLowerCase();
  return HOPPER_TO_LABEL[h] || (h ? cap(h) : 'Drop');
}

export function mapDropHint(rawHint = '') {
  const h = String(rawHint || '').trim().toLowerCase();
  if (!h) return '';
  if (HINT_TO_HOPPER[h]) return HINT_TO_HOPPER[h];
  if (H.HINTS.includes(h)) return h;
  return '';
}

function formatNextScheduleCheck(nextCheck) {
  if (!nextCheck) return '';
  if (typeof nextCheck === 'string') return sanitizePlainText(nextCheck);
  if (typeof nextCheck === 'object') {
    const lbl = nextCheck.label || nextCheck.pill || nextCheck.text || nextCheck.slot || '';
    if (lbl) return sanitizePlainText(lbl);
    if (nextCheck.at) {
      try {
        const t = new Date(nextCheck.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return `Schedule check ${t}`;
      } catch {}
    }
  }
  return '';
}

async function fetchUpstreamJson(baseUrl, relPath, timeoutMs = 1800) {
  const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!cleanBase || cleanBase === 'off' || cleanBase === 'none') {
    return { ok: false, offline: true, data: null };
  }
  try {
    const res = await fetch(`${cleanBase}${relPath}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, offline: true, status: res.status, data: null };
    const data = await res.json();
    return { ok: true, offline: false, data };
  } catch {
    return { ok: false, offline: true, data: null };
  }
}

// 2.5s single-flight cache for /api/hub
let hubCache = { at: 0, state: null };
let hubInFlight = null;

export function invalidateHubCache() {
  hubCache = { at: 0, state: null };
}

export async function getHubState({ getBoardCore, hopperSnapshot, fresh = false } = {}) {
  if (!fresh && hubCache.state && (Date.now() - hubCache.at) < 2500) {
    return hubCache.state;
  }
  if (!fresh && hubInFlight) {
    return await hubInFlight;
  }

  const run = (async () => {
    const floorBase = CONFIG.surfaces.floorUrl;
    const schedBase = CONFIG.surfaces.scheduleUrl;
    const linkBase = CONFIG.surfaces.linkUrl;
    const hbBase = CONFIG.surfaces.homebaseUrl;

    const [boardCore, hopper, floorRes, schedRes, linkRes, hbRes] = await Promise.all([
      typeof getBoardCore === 'function'
        ? getBoardCore().catch(() => ({ attention: [], standings: [] }))
        : Promise.all([F.attention().catch(() => []), F.standings().catch(() => [])]).then(([attention, standings]) => ({ attention, standings })),
      typeof hopperSnapshot === 'function'
        ? hopperSnapshot().catch(() => ({ bench: [], running: [], halted: [], queue: [], caretaker: {} }))
        : Promise.resolve({ bench: [], running: [], halted: [], queue: [], caretaker: {} }),
      fetchUpstreamJson(floorBase, '/api/channels', 1800),
      fetchUpstreamJson(schedBase, '/api/schedule', 1800),
      fetchUpstreamJson(linkBase, '/api/state', 1800),
      fetchUpstreamJson(hbBase, '/api/health', 1800),
    ]);

    const pins = F.getPins();
    const trials = F.listTrials();
    const acked = readAckMap();
    const rawItems = [];

    // ---- 1. Foundry attention (proposals, start-core, flags, diverged, core-edited) ----
    for (const att of boardCore?.attention || []) {
      if (att.type === 'promote') {
        const proj = prettyProjectName(att.title || att.lab);
        const proposer = normAgent(att.proposal?.by, CREW_META[0]?.id || 'builder');
        const why = sanitizePlainText(att.proposal?.why || '') || `${att.ahead || 1} lab update${(att.ahead || 1) === 1 ? '' : 's'} ready for core`;
        rawItems.push({
          id: `promote:${att.lab}:${String(att.head || '').slice(0, 12)}`,
          surface: 'hopper',
          surfaceTag: 'Foundry',
          openPath: '/#needs',
          actionLabel: 'Review Move',
          agent: proposer,
          priority: 'urgent',
          urgent: true,
          title: `Move ${proj} to core`,
          why: truncate(why, 110),
          at: att.at || att.proposal?.at || '',
        });
      } else if (att.type === 'start-core') {
        const proj = prettyProjectName(att.title || att.lab);
        rawItems.push({
          id: `start-core:${att.lab}:${String(att.head || '').slice(0, 12)}`,
          surface: 'hopper',
          surfaceTag: 'Foundry',
          openPath: '/#needs',
          actionLabel: 'Review Core',
          agent: CREW_META[0]?.id || 'builder',
          priority: 'urgent',
          urgent: true,
          title: `Start ${proj} in core`,
          why: 'New lab project ready for its first trusted core copy',
          at: att.at || '',
        });
      } else if (att.type === 'diverged') {
        const proj = prettyProjectName(att.lab);
        rawItems.push({
          id: `diverged:${att.lab}`,
          surface: 'hopper',
          surfaceTag: 'Foundry',
          openPath: '/#needs',
          actionLabel: 'Open Foundry',
          agent: CREW_META[0]?.id || 'builder',
          priority: 'urgent',
          urgent: true,
          title: `${proj} lab and core split apart`,
          why: 'Needs reconciliation before moving changes forward',
          at: new Date().toISOString(),
        });
      } else if (att.type === 'core-edited') {
        const proj = prettyProjectName(String(att.rel || '').replace(/^core\//, ''));
        rawItems.push({
          id: `core-edited:${att.rel}:${att.changes || 1}`,
          surface: 'hopper',
          surfaceTag: 'Foundry',
          openPath: '/#needs',
          actionLabel: 'Open Foundry',
          agent: CREW_META[3]?.id || CREW_META[0]?.id || 'breaker',
          priority: 'urgent',
          urgent: true,
          title: `Direct edits found inside ${proj} core`,
          why: `${att.changes || 1} unsaved file change${(att.changes || 1) === 1 ? '' : 's'} in core need a look`,
          at: new Date().toISOString(),
        });
      } else if (att.type === 'flag' && att.flag) {
        const f = att.flag;
        const targetRaw = String(f.for || '').toLowerCase();
        const forYou = targetRaw === 'you';
        const agent = forYou
          ? (String(f.by || '').toLowerCase() === 'you' ? CREW_META[2]?.id || CREW_META[0]?.id || 'lead' : normAgent(f.by, CREW_META[2]?.id || CREW_META[0]?.id || 'lead'))
          : normAgent(targetRaw, CREW_META[3]?.id || CREW_META[0]?.id || 'breaker');
        const place = prettyPathLabel(f.path);
        const cleanNote = sanitizePlainText(f.note || '');
        const title = forYou
          ? (cleanNote ? truncate(cleanNote, 64) : `${place} needs your look`)
          : `${cap(agent)} ${String(f.tag || 'review').toLowerCase()} on ${place}`;
        const why = forYou
          ? (cleanNote && cleanNote.length > 64 ? truncate(cleanNote, 120) : `${f.tag || 'Flag'} on ${place} · from ${cap(f.by || 'agent')}`)
          : (cleanNote ? truncate(cleanNote, 110) : `Open ${f.tag || 'review'} assigned to ${cap(agent)}`);
        rawItems.push({
          id: `flag:${f.id}:${f.updatedAt || f.at || ''}`,
          surface: 'hopper',
          surfaceTag: 'Foundry',
          openPath: '/#needs',
          actionLabel: 'Open Foundry',
          agent,
          priority: forYou ? 'urgent' : 'peek',
          urgent: forYou,
          title,
          why,
          at: f.updatedAt || f.at || '',
        });
      }
    }

    // ---- 2. Hopper (Halted, On Deck, Running, Queued + Recent You Drops) ----
    const deckCards = Array.isArray(hopper?.bench) ? hopper.bench : [];
    const runningCards = Array.isArray(hopper?.running) ? hopper.running : [];
    const haltedCards = Array.isArray(hopper?.halted) ? hopper.halted : [];
    const queueCards = Array.isArray(hopper?.queue) ? hopper.queue : [];
    const caretaker = hopper?.caretaker || hopper?.watcher || {};

    for (const c of haltedCards) {
      const dropClean = sanitizePlainText(c.drop) || 'Hopper build';
      const whyClean = sanitizePlainText((c.tripped?.why || []).join('; ')) || 'Safety wall paused this swing — needs a look';
      rawItems.push({
        id: `hopper-halt:${c.id}:${c.tripped?.at || c.updated || c.at || ''}`,
        surface: 'hopper',
        surfaceTag: 'Hopper',
        openPath: '/#hopper',
        actionLabel: 'Open Hopper',
        agent: CREW_META[2]?.id || CREW_META[0]?.id || 'lead',
        priority: 'urgent',
        urgent: true,
        title: `Tripwire paused "${truncate(dropClean, 44)}"`,
        why: truncate(whyClean, 115),
        at: c.tripped?.at || c.updated || c.at || '',
      });
    }

    if (deckCards.length > 0) {
      const deckSig = deckCards.map((c) => `${c.id}@${c.updated || c.at || ''}`).sort().join('|');
      const newestAt = deckCards
        .map((c) => c.updated || c.at || '')
        .sort()
        .pop() || '';
      const names = deckCards
        .map((c) => truncate(sanitizePlainText(c.drop) || 'New build', 42))
        .join(' · ');
      rawItems.push({
        id: `hopper-deck:${deckSig}`,
        surface: 'hopper',
        surfaceTag: 'On Deck',
        openPath: '/#hopper',
        actionLabel: 'Open On Deck',
        agent: CREW_META[2]?.id || CREW_META[0]?.id || 'lead',
        priority: 'urgent',
        urgent: true,
        title: deckCards.length === 1
          ? '1 build On Deck ready for your look'
          : `${deckCards.length} builds On Deck ready for your look`,
        why: truncate(names, 120),
        at: newestAt,
      });
    }

    if (runningCards.length > 0) {
      const runSig = runningCards.map((c) => `${c.id}@${(c.shots || []).length}`).sort().join('|');
      const newestAt = runningCards.map((c) => c.updated || c.at || '').sort().pop() || '';
      const names = runningCards.map((c) => truncate(sanitizePlainText(c.drop) || 'Active swing', 44)).join(' · ');
      rawItems.push({
        id: `hopper-run:${runSig}`,
        surface: 'hopper',
        surfaceTag: 'Hopper',
        openPath: '/#hopper',
        actionLabel: 'Peek Hopper',
        agent: CREW_META[3]?.id || CREW_META[0]?.id || 'breaker',
        priority: 'peek',
        urgent: false,
        title: runningCards.length === 1
          ? `Actively building: ${truncate(sanitizePlainText(runningCards[0].drop), 44)}`
          : `${runningCards.length} Hopper swings actively building`,
        why: runningCards.length === 1
          ? truncate(sanitizePlainText(runningCards[0].hard) || 'Shot in flight in isolated scratch', 110)
          : truncate(names, 115),
        at: newestAt,
      });
    }

    if (queueCards.length > 0) {
      const qSig = queueCards.map((c) => `${c.id}@${c.updated || c.at || ''}`).join('|');
      const newestAt = queueCards.map((c) => c.updated || c.at || '').sort().pop() || '';
      const firstDrop = truncate(sanitizePlainText(queueCards[0].drop) || 'Queued spark', 44);
      const why = queueCards.length === 1
        ? (sanitizePlainText(queueCards[0].hard) || (caretaker.armed ? 'Caretaker armed and queued next' : 'Queued safely in Hopper'))
        : queueCards.slice(0, 3).map((c) => truncate(sanitizePlainText(c.drop), 34)).join(' · ');
      rawItems.push({
        id: `hopper-queue:${qSig}`,
        surface: 'hopper',
        surfaceTag: 'Hopper',
        openPath: '/#hopper',
        actionLabel: 'Peek Queue',
        agent: CREW_META[2]?.id || CREW_META[0]?.id || 'lead',
        priority: 'peek',
        urgent: false,
        title: queueCards.length === 1 ? `Queued in Hopper: ${firstDrop}` : `${queueCards.length} drops queued in Hopper`,
        why: truncate(why, 115),
        at: newestAt,
      });
    }

    // Recent drops across queue + running + On Deck (newest first)
    const drops = [...queueCards, ...runningCards, ...deckCards]
      .filter((c) => c && c.from === 'you' && c.drop)
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      .map((c) => ({
        id: c.id,
        text: sanitizePlainText(c.drop) || c.drop,
        hint: labelForHint(c.hint),
        at: c.at || '',
      }));

    // ---- 3. Schedule (:7968/api/schedule) ----
    const sched = schedRes.ok && schedRes.data ? schedRes.data : null;
    let schedPlanItems = [];
    const shopLabel = sched?.shopBand?.label ? sanitizePlainText(sched.shopBand.label) : '';
    const nextCheckLabel = formatNextScheduleCheck(sched?.nextCheck);

    if (sched) {
      const openBuilds = (Array.isArray(sched.openBuilds) ? sched.openBuilds : []).filter(
        (b) => b && !b.removedAt && b.status !== 'done' && b.stage !== 'done'
      );
      for (const b of openBuilds) {
        if (String(b.waitingOn || '').toLowerCase() === 'you') {
          const titleClean = sanitizePlainText(b.title) || 'Open build waiting on you';
          const nextClean = sanitizePlainText(b.nextStep) || 'Waiting on your decision in Schedule';
          rawItems.push({
            id: `sched-open:${b.id}:${b.updatedAt || b.addedAt || ''}`,
            surface: 'schedule',
            surfaceTag: 'Schedule',
            openPath: '/',
            actionLabel: 'Open Schedule',
            agent: CREW_META[1]?.id || CREW_META[0]?.id || 'planner',
            priority: 'urgent',
            urgent: true,
            title: truncate(titleClean, 66),
            why: truncate(nextClean, 115),
            at: b.updatedAt || b.addedAt || sched.now || '',
          });
        }
      }

      const todayStr = sched.today || new Date().toISOString().slice(0, 10);
      const todayUndone = (Array.isArray(sched.items) ? sched.items : []).filter(
        (i) => i && !i.removedAt && !i.done && i.day === todayStr
      );
      schedPlanItems = todayUndone.filter((i) => !/^\s*shop\b/i.test(String(i.what || '')));
      if (schedPlanItems.length > 0) {
        const pSig = schedPlanItems.map((i) => `${i.id}@${i.updatedAt || i.added || i.time || ''}`).join('|');
        const newestAt = schedPlanItems.map((i) => i.updatedAt || i.added || '').sort().pop() || sched.now || '';
        const firstWhat = sanitizePlainText(schedPlanItems[0].what) || 'Scheduled item';
        const whyBits = [
          schedPlanItems.length > 1
            ? schedPlanItems.slice(0, 2).map((i) => sanitizePlainText(i.what)).join(' · ')
            : '',
          shopLabel,
          nextCheckLabel,
        ].filter(Boolean);
        rawItems.push({
          id: `sched-today:${todayStr}:${pSig}`,
          surface: 'schedule',
          surfaceTag: 'Schedule',
          openPath: '/',
          actionLabel: 'Open Schedule',
          agent: CREW_META[1]?.id || CREW_META[0]?.id || 'planner',
          priority: 'peek',
          urgent: false,
          title: schedPlanItems.length === 1
            ? `Today: ${truncate(firstWhat, 56)}`
            : `${schedPlanItems.length} items on today's schedule`,
          why: truncate(whyBits.join(' · ') || "On today's schedule on schedule", 115),
          at: newestAt,
        });
      }
    }

    // ---- 4. Monty's Floor (:7960/api/channels) ----
    const floorChannels = floorRes.ok && Array.isArray(floorRes.data?.channels)
      ? floorRes.data.channels.filter((ch) => ch && !ch.archived && !ch.closedAt)
      : [];

    for (const ch of floorChannels) {
      const roomLabel = ch.kind === 'dm'
        ? `DM with ${cap(ch.agentId || ch.name || 'Agent')}`
        : `#${String(ch.name || 'room').replace(/^#+/, '')}`;
      const unread = Number(ch.unread) || 0;
      const waitingYou = Boolean(ch.waitingOnYou || ch.needsYou || unread > 0);
      const thinkingAgent = ch.thinking
        ? (typeof ch.thinking === 'string' ? ch.thinking : (ch.thinking.who || ch.thinking.agent || ''))
        : '';
      const queuedAgents = Array.isArray(ch.queued) ? ch.queued : [];
      const isRunning = Boolean(thinkingAgent || queuedAgents.length > 0);
      const isStaged = Boolean(ch.staged) || (ch.kind === 'room' && !waitingYou && !isRunning && ((Number(ch.messageCount) || 0) === 0 || ch.name === 'schedule'));
      const baseAgent = normAgent(
        thinkingAgent || queuedAgents[0] || ch.agentId || ch.lastMessageWho || (ch.members?.includes(CREW_META[1]?.id || CREW_META[0]?.id || 'planner') && ch.name === 'schedule' ? CREW_META[1]?.id || CREW_META[0]?.id || 'planner' : ch.members?.[0]),
        CREW_META[2]?.id || CREW_META[0]?.id || 'lead'
      );
      const preview = sanitizePlainText(ch.lastMessagePreview || '');

      if (waitingYou) {
        rawItems.push({
          id: `floor-wait:${ch.id}:${ch.lastMessageAt || ch.updated || unread}`,
          surface: 'floor',
          surfaceTag: 'Floor',
          openPath: '/',
          actionLabel: 'Open Floor',
          agent: baseAgent,
          priority: 'urgent',
          urgent: true,
          title: unread > 0 ? `${roomLabel} (${unread} unread)` : `${roomLabel} waiting on you`,
          why: truncate(preview || 'Waiting for your reply on the Floor', 115),
          at: ch.lastMessageAt || ch.updated || ch.created || '',
        });
      } else if (isRunning) {
        const runner = normAgent(thinkingAgent || queuedAgents[0], baseAgent);
        rawItems.push({
          id: `floor-run:${ch.id}:${ch.updated || ''}`,
          surface: 'floor',
          surfaceTag: 'Floor',
          openPath: '/',
          actionLabel: 'Open Floor',
          agent: runner,
          priority: 'peek',
          urgent: false,
          title: `${cap(runner)} active in ${roomLabel}`,
          why: truncate(preview || 'Live turn running in room', 115),
          at: ch.updated || ch.created || '',
        });
      } else if (isStaged) {
        rawItems.push({
          id: `floor-staged:${ch.id}:${ch.updated || ch.created || ''}`,
          surface: 'floor',
          surfaceTag: 'Floor',
          openPath: '/',
          actionLabel: 'Open Floor',
          agent: ch.members?.includes(CREW_META[1]?.id || CREW_META[0]?.id || 'planner') ? CREW_META[1]?.id || CREW_META[0]?.id || 'planner' : baseAgent,
          priority: 'peek',
          urgent: false,
          title: `${roomLabel} room staged and ready`,
          why: truncate(preview || 'Ready whenever you want to tap in', 115),
          at: ch.updated || ch.created || '',
        });
      }
    }

    // ---- 5. The Link (:7970/api/state) ----
    const linkItems = linkRes.ok && Array.isArray(linkRes.data?.items)
      ? linkRes.data.items.filter((it) => it && !it.away && !it.done && it.status !== 'done' && it.ready !== false)
      : [];

    for (const it of linkItems) {
      const toList = (Array.isArray(it.to) ? it.to : [it.to])
        .filter(Boolean)
        .map((s) => String(s).toLowerCase());
      const replies = Array.isArray(it.replies) ? it.replies : [];
      const lastReply = replies.length ? replies[replies.length - 1] : null;
      const latestAt = lastReply?.at || it.updated || it.created || '';
      const plainTitle = sanitizePlainText(it.title || it.note) || 'Family Link note';

      if (toList.includes('you')) {
        const senderRaw = String(it.from || '').toLowerCase();
        const sender = CREW_IDS.has(senderRaw) ? senderRaw : CREW_META[0]?.id || 'builder';
        const whyText = sanitizePlainText(lastReply?.text || it.note) || `From ${cap(it.from || sender)} on the Link`;
        rawItems.push({
          id: `link-you:${it.id}:${latestAt}`,
          surface: 'floor',
          surfaceTag: 'Link',
          openKind: 'link',
          actionLabel: 'Open Link',
          agent: sender,
          priority: 'urgent',
          urgent: true,
          title: truncate(plainTitle, 66),
          why: truncate(whyText, 115),
          at: latestAt,
        });
      } else {
        let waitingAgent = null;
        if (it.waitingOn && CREW_IDS.has(String(it.waitingOn).toLowerCase())) {
          waitingAgent = String(it.waitingOn).toLowerCase();
        } else {
          for (const ag of toList) {
            if (!CREW_IDS.has(ag)) continue;
            const seenAt = it.seen && typeof it.seen === 'object' ? it.seen[ag] : null;
            const hasUnseenReply = replies.some(
              (r) => String(r.from || '').toLowerCase() !== ag && (!seenAt || r.at > seenAt)
            );
            const neverSeen = !seenAt && !replies.some((r) => String(r.from || '').toLowerCase() === ag);
            if (neverSeen || hasUnseenReply) {
              waitingAgent = ag;
              break;
            }
          }
        }
        if (waitingAgent) {
          rawItems.push({
            id: `link-wait:${it.id}:${waitingAgent}:${latestAt}`,
            surface: 'floor',
            surfaceTag: 'Link',
            openKind: 'link',
            actionLabel: 'Open Link',
            agent: waitingAgent,
            priority: 'peek',
            urgent: false,
            title: truncate(plainTitle, 66),
            why: `Waiting on ${cap(waitingAgent)} on the Link`,
            at: latestAt,
          });
        }
      }
    }

    // ---- 6. Den / Homebase (:7930/api/health + Foundry standings / trials / pins) ----
    const standings = Array.isArray(boardCore?.standings) ? boardCore.standings : [];
    const hbStanding = standings.find((s) => s.name === 'homebase' || s.name === 'surface');
    const denTrial = trials.find((t) =>
      t.name === 'surface' ||
      t.name.includes('den') ||
      (Array.isArray(t.builds) && t.builds.some((b) => b.name === 'homebase' || b.name === 'surface'))
    );
    const denPin = pins.find((p) => /(^|\/)(homebase|surface|den)(\/|$)/i.test(p.path || ''));

    // Apply persistent ack state + relative timestamps + deterministic ordering
    const items = rawItems
      .map((it) => ({
        ...it,
        done: Boolean(acked[it.id]),
        ago: formatAgo(it.at),
      }))
      .sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
        return String(b.at || '').localeCompare(String(a.at || ''));
      });

    const needsCount = items.filter((i) => !i.done && i.urgent).length;

    // ---- Build 4 Surfaces ----
    const surfaceMetrics = (id) => {
      const open = items.filter((i) => !i.done && i.surface === id);
      const urg = open.filter((i) => i.urgent);
      const peek = open.filter((i) => !i.urgent && i.priority !== 'calm');
      const status = urg.length > 0 ? 'needs' : peek.length > 0 ? 'ready' : 'calm';
      return { open, urg, peek, status, count: urg.length + peek.length };
    };

    const floorM = surfaceMetrics('floor');
    const floorHeadline = floorM.urg.length > 0
      ? floorM.urg[0].title
      : floorM.peek.length > 0
      ? floorM.peek[0].title
      : !floorRes.ok
      ? 'Offline · Floor & Link quiet'
      : floorChannels.length > 0
      ? `${floorChannels.length} room${floorChannels.length === 1 ? '' : 's'} calm · Link clear`
      : 'All rooms & Link calm';

    const hopperM = surfaceMetrics('hopper');
    const hopperHeadline = deckCards.length > 0
      ? (deckCards.length === 1 ? '1 build On Deck ready for your look' : `${deckCards.length} builds On Deck ready for your look`)
      : hopperM.urg.length > 0
      ? hopperM.urg[0].title
      : runningCards.length > 0
      ? `${runningCards.length} swing${runningCards.length === 1 ? '' : 's'} building · ${queueCards.length} queued`
      : queueCards.length > 0
      ? `${queueCards.length} drop${queueCards.length === 1 ? '' : 's'} queued in Hopper`
      : caretaker.armed
      ? 'Caretaker armed · On Deck clear'
      : 'On Deck clear · ready for sparks';

    const schedM = surfaceMetrics('schedule');
    let schedHeadline = '';
    if (!schedRes.ok) {
      schedHeadline = 'Offline · Schedule quiet';
    } else {
      const lead = schedM.urg.length > 0
        ? schedM.urg[0].title
        : schedPlanItems.length > 0
        ? sanitizePlainText(schedPlanItems[0].what)
        : '';
      const bits = [shopLabel, lead, nextCheckLabel].filter(Boolean);
      schedHeadline = bits.join(' · ') || 'Schedule synced & calm';
    }

    const denM = surfaceMetrics('den');
    let denHeadline = '';
    if (!hbRes.ok) {
      denHeadline = denTrial
        ? `Offline · Builder "${denTrial.name}" bench saved`
        : 'Offline · Den & Homebase sleeping';
    } else if (denTrial) {
      denHeadline = `Live · Builder active on "${denTrial.name}" bench`;
    } else if (denPin) {
      denHeadline = `Live · Focused on ${prettyPathLabel(denPin.path)}`;
    } else if (hbStanding?.state === 'ahead') {
      denHeadline = `Live · ${hbStanding.ahead} lab update${hbStanding.ahead === 1 ? '' : 's'} ahead of core`;
    } else {
      denHeadline = 'Live · Den & Homebase synced in core';
    }

    const surfaces = [
      {
        id: 'floor',
        name: "Monty's Floor",
        path: '/',
        status: floorM.status,
        count: floorM.count,
        headline: truncate(floorHeadline, 110),
        online: floorRes.ok,
      },
      {
        id: 'hopper',
        name: 'Foundry · Hopper',
        path: deckCards.length > 0 ? '/#hopper' : '/',
        status: hopperM.status,
        count: hopperM.count,
        headline: truncate(hopperHeadline, 110),
        online: true,
      },
      {
        id: 'schedule',
        name: 'Schedule',
        path: '/',
        status: schedM.status,
        count: schedM.count,
        headline: truncate(schedHeadline, 110),
        online: schedRes.ok,
      },
      {
        id: 'den',
        name: 'Homebase · Den',
        path: '/',
        status: denM.status,
        count: denM.count,
        headline: truncate(denHeadline, 110),
        online: hbRes.ok,
      },
    ];

    // ---- Build 4 Crew Members ----
    const activeTrial = trials[0] || denTrial;
    const crew = CREW_META.map((meta, idx) => {
      const openFor = items.filter((i) => !i.done && i.agent === meta.id);
      const urgFor = openFor.filter((i) => i.urgent);
      const myTrial = trials.find((t) => t.by === meta.id) || (idx === 0 ? activeTrial : null);
      let statusText = '';
      if (urgFor.length > 0) statusText = urgFor[0].title;
      else if (openFor.length > 0) statusText = openFor[0].title;
      else if (myTrial) statusText = `Active on "${myTrial.name}" bench`;
      else if (meta.surfaces?.includes('hopper') && caretaker.armed) statusText = 'Caretaker armed · watching Hopper';
      else if (runningCards.length > 0 && idx === CREW_META.length - 1) statusText = `Building ${runningCards.length} Hopper swing${runningCards.length === 1 ? '' : 's'}`;
      else statusText = meta.role || 'Ready · 0 blockers';

      return {
        ...meta,
        status: urgFor.length > 0 ? 'waiting' : 'active',
        needsCount: urgFor.length,
        openCount: openFor.length,
        statusText: truncate(statusText, 56),
      };
    });

    const state = {
      ok: true,
      updatedAt: new Date().toISOString(),
      needsCount,
      crew,
      surfaces,
      items,
      drops,
    };

    hubCache = { at: Date.now(), state };
    return state;
  })().finally(() => {
    hubInFlight = null;
  });

  hubInFlight = run;
  return await run;
}

export async function toggleHubAck(id, deps = {}) {
  const cleanId = String(id || '').trim();
  if (!cleanId) throw new Error('Item id is required.');
  const acked = readAckMap();
  let done;
  if (acked[cleanId]) {
    delete acked[cleanId];
    done = false;
  } else {
    acked[cleanId] = new Date().toISOString();
    done = true;
  }
  writeAckMapAtomic(acked);
  invalidateHubCache();
  const state = await getHubState({ ...deps, fresh: true });
  return { ok: true, id: cleanId, done, state };
}

export async function addHubDrop({ text, hint }, deps = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) throw new Error('Drop text is required.');
  const mappedHint = mapDropHint(hint);
  const card = H.add({
    drop: cleanText,
    from: 'you',
    hint: mappedHint,
    by: 'you',
  });
  invalidateHubCache();
  if (typeof deps.onMutate === 'function') {
    deps.onMutate();
  }
  const state = await getHubState({ ...deps, fresh: true });
  return { ok: true, card, state };
}

export function serveHubAsset(pathname, res) {
  if (STATIC_ASSETS[pathname]) {
    const { file, mime } = STATIC_ASSETS[pathname];
    const abs = path.join(HERE, file);
    if (!fs.existsSync(abs)) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Hub asset not found' }));
      return true;
    }
    const buf = fs.readFileSync(abs);
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store',
      'Content-Length': buf.length,
    });
    res.end(buf);
    return true;
  }

  if (pathname.startsWith('/hub/faces/custom/')) {
    const id = decodeURIComponent(pathname.slice('/hub/faces/custom/'.length));
    const member = CREW_META.find((c) => c.id === id && c.avatarPath);
    if (!member || !fs.existsSync(member.avatarPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Custom portrait not found' }));
      return true;
    }
    const mime = EXT_MIMES[path.extname(member.avatarPath).toLowerCase()] || 'application/octet-stream';
    const buf = fs.readFileSync(member.avatarPath);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Length': buf.length });
    res.end(buf);
    return true;
  }
  if (pathname.startsWith('/hub/faces/')) {
    const rawName = pathname.slice('/hub/faces/'.length);
    let file;
    try { file = decodeURIComponent(rawName); } catch { file = ''; }
    const mime = FACE_MIMES[file];
    if (!mime || file.includes('..') || path.basename(file) !== file) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Portrait not found' }));
      return true;
    }
    const abs = path.join(FACES_DIR, file);
    if (!fs.existsSync(abs)) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Portrait missing' }));
      return true;
    }
    const buf = fs.readFileSync(abs);
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=3600',
      'Content-Length': buf.length,
    });
    res.end(buf);
    return true;
  }

  return false;
}
