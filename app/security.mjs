import { CONFIG } from './config.mjs';

function extractHostname(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return end >= 0 ? s.slice(0, end + 1) : s;
  }
  return s.replace(/:\d+$/, '');
}

export function isAllowedHost(host) {
  const name = extractHostname(host);
  if (!name) return false;
  if (name === '127.0.0.1' || name === 'localhost' || name === '[::1]') return true;
  if (name.endsWith('.ts.net') && name.length > '.ts.net'.length) return true;
  if (CONFIG.allowHosts && CONFIG.allowHosts.includes(name)) return true;
  return false;
}

export function doorOk(req) {
  if (!isAllowedHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      if (!isAllowedHost(parsed.host)) return false;
    } catch {
      return false;
    }
  } else if (origin === 'null') {
    return false;
  }
  return true;
}
