// Honest Caretaker Presence Reader for Hopper.
import fs from 'node:fs';
import path from 'node:path';
import * as H from './hopper.mjs';

export const CARETAKER_FILE = () => path.join(H.HOPPER_DIR, 'caretaker.json');
export const HEARTBEAT_TTL_MS = 35_000;

export function readCaretakerStatus(nowMs = Date.now()) {
  let data = null;
  try {
    const raw = JSON.parse(fs.readFileSync(CARETAKER_FILE(), 'utf8'));
    if (raw && typeof raw === 'object') data = raw;
  } catch {}

  const heartbeatAt = typeof data?.heartbeatAt === 'string' && data.heartbeatAt ? data.heartbeatAt : null;
  const hbMs = heartbeatAt ? Date.parse(heartbeatAt) : NaN;
  const ageMs = Number.isFinite(hbMs) ? nowMs - hbMs : Infinity;
  const live = Boolean(data?.armed === true && Number.isFinite(ageMs) && ageMs <= HEARTBEAT_TTL_MS && ageMs >= -60_000);
  const activeRuns = (data?.activeRuns && typeof data.activeRuns === 'object' && !Array.isArray(data.activeRuns))
    ? data.activeRuns
    : {};
  const lastWakeAt = typeof data?.lastWakeAt === 'string' && data.lastWakeAt ? data.lastWakeAt : null;

  const statusLine = live
    ? (String(data?.statusLine || '').trim() || 'Caretaker Armed · Watching Hopper & Board')
    : 'Queued · Caretaker Sleeping';

  const note = live
    ? (String(data?.note || '').trim() || 'Caretaker is armed and watching Hopper.')
    : (data?.armed === true && heartbeatAt
        ? 'Caretaker heartbeat is stale (>35s); queued drops wait safely.'
        : 'Caretaker is sleeping; drops queue safely until armed.');

  return {
    mode: live ? 'live' : 'sleeping',
    armed: live,
    enabled: live,
    running: live,
    heartbeatAt,
    statusLine,
    activeRuns,
    lastWakeAt,
    note,
  };
}

export function status(nowMs = Date.now()) {
  return readCaretakerStatus(nowMs);
}
