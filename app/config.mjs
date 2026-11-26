import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_CREW = [
  { id: 'builder', name: 'Builder', role: 'Lab Maker', color: '#f5b44c', faceUrl: '/hub/faces/builder.svg', surfaces: ['den', 'floor'] },
  { id: 'planner', name: 'Planner', role: 'Scope & Schedule', color: '#a882ff', faceUrl: '/hub/faces/planner.svg', surfaces: ['schedule', 'floor'] },
  { id: 'lead', name: 'Lead', role: 'Caretaker & Floor', color: '#b8f24b', faceUrl: '/hub/faces/lead.svg', surfaces: ['hopper', 'floor'] },
  { id: 'breaker', name: 'Breaker', role: 'Tester & Swarms', color: '#3dd68c', faceUrl: '/hub/faces/breaker.svg', surfaces: ['hopper', 'floor'] },
];

export function expandPath(raw, baseDir = REPO_ROOT) {
  if (!raw || typeof raw !== 'string') return '';
  let p = raw.trim();
  if (!p) return '';
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1).replace(/^[\/]+/, ''));
  }
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(baseDir, p);
}

function normalizeCrew(rawCrew, baseDir) {
  if (!Array.isArray(rawCrew) || !rawCrew.length) return DEFAULT_CREW.map((c) => ({ ...c }));
  const out = [];
  for (const item of rawCrew) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || item.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!id) continue;
    const avatarPath = item.avatar ? expandPath(String(item.avatar), baseDir) : '';
    const faceUrl = avatarPath
      ? `/hub/faces/custom/${encodeURIComponent(id)}`
      : String(item.faceUrl || '/hub/faces/builder.svg').trim();
    out.push({
      id,
      name: String(item.name || id).trim(),
      role: String(item.role || 'Agent').trim(),
      color: String(item.color || '#f5b44c').trim(),
      faceUrl,
      ...(avatarPath ? { avatarPath } : {}),
      surfaces: Array.isArray(item.surfaces) ? item.surfaces.map(String) : ['floor', 'hopper'],
    });
  }
  return out.length ? out : DEFAULT_CREW.map((c) => ({ ...c }));
}

export function loadConfig(explicitPath = process.env.FOUNDRY_CONFIG || '') {
  const configPath = explicitPath
    ? path.resolve(explicitPath)
    : path.join(REPO_ROOT, 'foundry.config.json');
  const hasFile = fs.existsSync(configPath);
  const baseDir = hasFile ? path.dirname(configPath) : REPO_ROOT;
  const raw = hasFile ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};

  const home = process.env.FOUNDRY_HOME
    ? path.resolve(process.env.FOUNDRY_HOME)
    : (raw?.home ? expandPath(raw.home, baseDir) : path.join(os.homedir(), 'Foundry-Workshop'));

  const port = Number(process.env.FOUNDRY_PORT) || Number(raw?.port) || 7988;
  const host = process.env.FOUNDRY_HOST || raw?.host || '127.0.0.1';
  const title = (typeof raw?.title === 'string' && raw.title.trim()) || 'The Foundry';
  const shortName = (typeof raw?.shortName === 'string' && raw.shortName.trim()) || 'Foundry';

  const humanName = (typeof raw?.human?.name === 'string' && raw.human.name.trim()) || 'You';
  const humanId = ((typeof raw?.human?.id === 'string' && raw.human.id.trim()) || humanName)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '') || 'you';

  const crew = normalizeCrew(raw?.crew, baseDir);
  const benchPorts = Array.isArray(raw?.benchPorts) && raw.benchPorts.length === 3
    ? raw.benchPorts.map(Number)
    : [7991, 7992, 7993];

  const allowHosts = Array.isArray(raw?.allowHosts)
    ? raw.allowHosts.map((h) => String(h || '').trim().toLowerCase()).filter(Boolean)
    : [];

  const liveExtraDirs = Array.isArray(raw?.liveExtraDirs)
    ? raw.liveExtraDirs.map((d) => expandPath(String(d), baseDir)).filter(Boolean)
    : [];

  return {
    configPath: hasFile ? configPath : null,
    hasFile,
    title,
    shortName,
    home,
    port,
    host,
    benchPorts,
    allowHosts,
    liveExtraDirs,
    pairs: (raw?.pairs && typeof raw.pairs === 'object' && !Array.isArray(raw.pairs)) ? raw.pairs : {},
    githubOwner: typeof raw?.githubOwner === 'string' ? raw.githubOwner.trim() : '',
    human: { id: humanId, name: humanName },
    crew,
    surfaces: {
      floorUrl: process.env.HUB_FLOOR_URL || raw?.surfaces?.floorUrl || 'http://127.0.0.1:7960',
      scheduleUrl: process.env.HUB_SCHEDULE_URL || raw?.surfaces?.scheduleUrl || 'http://127.0.0.1:7968',
      linkUrl: process.env.HUB_LINK_URL || raw?.surfaces?.linkUrl || 'off',
      homebaseUrl: process.env.HUB_HOMEBASE_URL || raw?.surfaces?.homebaseUrl || 'http://127.0.0.1:7940',
      denUrl: raw?.surfaces?.denUrl || 'http://127.0.0.1:7950',
    },
    dispatch: raw?.dispatch && typeof raw.dispatch === 'object' ? raw.dispatch : null,
    liveMatch: raw?.liveMatch && typeof raw.liveMatch === 'object' ? raw.liveMatch : null,
  };
}

export const CONFIG = loadConfig();
