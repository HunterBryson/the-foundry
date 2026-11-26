// Bench Live Reverse Proxy & Craft Lab Side-by-Side Read View for Foundry (:7988).
// Routes `/hopper/live/<id>/...` for up to 3 Bench cards directly under :7988 so your phone
// opens any scratch swing with zero Tailscale port juggling — and renders non-web Craft Lab runs
// as a clean Pure-Black Signal dark side-by-side read view on the exact same link.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import * as H from './hopper.mjs';
import * as S from '../scratch.mjs';

const LIVE_PORTS_SET = new Set([...S.LIVE_PORTS, 7991, 7992, 7993]);
const MAX_BENCH_ROUTES = H.LIMITS.bench; // 3

export function isLivePort(port) {
  const n = Number(port);
  return !Number.isInteger(n) || n < 1024 || n > 65535 || LIVE_PORTS_SET.has(n);
}

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Parse a card's `live` field into either a safe local scratch HTTP target or a non-web read target.
export function parseLiveTarget(card) {
  const raw = String(card?.live || '').trim();
  if (!raw) return { kind: 'none', raw: '' };

  // HTTP target: http://127.0.0.1:<port>/... or http://localhost:<port>/...
  const m = raw.match(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d+)(\/.*)?$/i);
  if (m) {
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || LIVE_PORTS_SET.has(port)) {
      return { kind: 'blocked', port, raw, reason: `Port ${port} is a protected live port and cannot be proxied.` };
    }
    const basePath = m[3] || '/';
    return { kind: 'http', host: '127.0.0.1', port, basePath, raw };
  }

  // Explicit craft side-by-side: craft:<pathA>|<pathB>
  if (raw.startsWith('craft:')) {
    const parts = raw.slice('craft:'.length).split('|').map((s) => s.trim()).filter(Boolean);
    return { kind: 'craft', paths: parts, raw };
  }

  // Local file or directory path (for Craft Lab or non-web artifact read views)
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    return { kind: 'path', targetPath: path.resolve(raw), raw };
  }

  return { kind: 'text', raw };
}

// Active bench route table (strictly capped at 3 bench cards).
export function activeBenchRoutes() {
  const bench = H.listCards({ stage: 'bench' }).slice(0, MAX_BENCH_ROUTES);
  const routes = new Map();
  for (const c of bench) {
    routes.set(c.id, { card: c, target: parseLiveTarget(c), mount: `/hopper/live/${c.id}/` });
  }
  return routes;
}

// Check if a file path is safe to read for a card's Craft Lab read view:
// must sit inside one of the card's shot clones, inside HOPPER_DIR, or inside FOUNDRY_SCRATCH.
function isAllowedReadPath(absPath, card) {
  const low = path.resolve(absPath).toLowerCase();
  const roots = [H.HOPPER_DIR];
  for (const s of card.shots || []) {
    if (s.clone) roots.push(s.clone);
  }
  if (process.env.FOUNDRY_SCRATCH) roots.push(process.env.FOUNDRY_SCRATCH);
  return roots.some((r) => {
    const rl = path.resolve(r).toLowerCase();
    return low === rl || low.startsWith(rl + path.sep);
  });
}

function safeReadText(filePath, card) {
  try {
    const abs = path.resolve(filePath);
    if (!isAllowedReadPath(abs, card)) return { error: 'Path is outside this card\'s scratch folder.' };
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return { error: 'File not found.' };
    const text = fs.readFileSync(abs, 'utf8');
    return { name: path.basename(abs), text: text.slice(0, 120_000) };
  } catch (e) {
    return { error: e.message };
  }
}

function loadReadPanels(card, target) {
  if (target.kind === 'craft' && target.paths.length >= 2) {
    const a = safeReadText(target.paths[0], card);
    const b = safeReadText(target.paths[1], card);
    return [
      { label: a.name || 'Baseline', body: a.error ? `[${a.error}]` : a.text },
      { label: b.name || 'Swing', body: b.error ? `[${b.error}]` : b.text },
    ];
  }
  if (target.kind === 'path') {
    const abs = target.targetPath;
    if (!isAllowedReadPath(abs, card)) {
      return [{ label: 'Live target', body: `${target.raw}\n\n(Read view only opens files inside this card's scratch clone or Hopper folder.)` }];
    }
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const files = fs.readdirSync(abs)
        .filter((f) => /\.(md|txt|json|log)$/i.test(f))
        .sort();
      const pick = (names) => names.find((n) => files.some((f) => f.toLowerCase() === n));
      const leftName = pick(['before.md', 'baseline.md', 'a.md', 'left.md', 'before.txt', 'a.txt']) || files[0];
      const rightName = pick(['after.md', 'swing.md', 'b.md', 'right.md', 'after.txt', 'b.txt']) || files[1];
      const panels = [];
      if (leftName) {
        const r = safeReadText(path.join(abs, leftName), card);
        panels.push({ label: leftName, body: r.error ? `[${r.error}]` : r.text });
      }
      if (rightName && rightName !== leftName) {
        const r = safeReadText(path.join(abs, rightName), card);
        panels.push({ label: rightName, body: r.error ? `[${r.error}]` : r.text });
      }
      if (panels.length) return panels;
    } else if (fs.existsSync(abs)) {
      const r = safeReadText(abs, card);
      if (!r.error && abs.toLowerCase().endsWith('.json')) {
        try {
          const j = JSON.parse(r.text);
          if (j && (j.before || j.left || j.a) && (j.after || j.right || j.b)) {
            const left = j.before ?? j.left ?? j.a;
            const right = j.after ?? j.right ?? j.b;
            return [
              { label: j.leftLabel || 'Before / Scratch Brain A', body: typeof left === 'string' ? left : JSON.stringify(left, null, 2) },
              { label: j.rightLabel || 'After / Scratch Brain B', body: typeof right === 'string' ? right : JSON.stringify(right, null, 2) },
            ];
          }
        } catch {}
      }
      return [{ label: r.name || 'Output', body: r.error ? `[${r.error}]` : r.text }];
    }
  }
  return [{ label: 'Live Note', body: target.raw || 'No live output attached yet.' }];
}

export function renderDarkShell({ title, kicker, card, bodyHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#09090b">
<meta name="color-scheme" content="dark">
<title>${esc(title)} · Hopper Live</title>
<style>
  :root{--bg:#09090b;--card:#111116;--card2:#17171f;--line:#22222c;--line2:#31313e;--text:#f0f0f4;--text2:#b8b8c6;--muted:#7e7e8f;--green:#5ec48e;--amber:#e5a956;--red:#eb7373;--violet:#a78bfa}
  *{box-sizing:border-box}
  html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font:14px/1.55 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
  .bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:10px;padding:12px 16px;background:rgba(9,9,11,.94);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .back{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:9px;background:#16161d;border:1px solid var(--line2);color:var(--text);text-decoration:none;font-size:13px;font-weight:600}
  .back:hover{background:#21212b}
  .kicker{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--amber);margin-left:auto}
  .wrap{max-width:1180px;margin:0 auto;padding:18px 16px 48px}
  .head{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:16px}
  .id{font-family:"Cascadia Code",Consolas,monospace;font-size:12px;color:var(--muted)}
  h1{margin:4px 0 10px;font-size:19px;font-weight:650;color:#fff;letter-spacing:-.2px}
  .meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .mcell{background:#0c0c10;border:1px solid var(--line);border-radius:10px;padding:10px 12px}
  .mlbl{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.55px;color:var(--muted);margin-bottom:4px}
  .mcell.bet .mlbl{color:var(--green)}
  .mcell.weak .mlbl{color:var(--amber)}
  .mval{font-size:13.5px;color:var(--text2);line-height:1.45}
  .panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
  .phead{padding:11px 14px;background:var(--card2);border-bottom:1px solid var(--line);font-size:12.5px;font-weight:650;color:var(--text);font-family:"Cascadia Code",Consolas,monospace}
  .pbody{margin:0;padding:14px 16px;font:13px/1.6 "Cascadia Code",Consolas,monospace;white-space:pre-wrap;word-break:break-word;color:#d6d6e0;overflow:auto;max-height:72vh}
  .msg{background:var(--card);border:1px solid #442628;border-radius:14px;padding:18px;color:var(--text2)}
  @media (max-width:700px){.meta-grid{grid-template-columns:1fr}.panels{grid-template-columns:1fr}}
</style>
</head>
<body>
  <header class="bar">
    <a class="back" href="/#hopper">← Foundry Hopper</a>
    <span class="kicker">${esc(kicker)}</span>
  </header>
  <main class="wrap">
    ${card ? `<section class="head">
      <div class="id">${esc(card.id)} · ${esc(card.run || 'craft-lab')} · ${(card.shots || []).length} shot${(card.shots || []).length === 1 ? '' : 's'}</div>
      <h1>${esc(card.drop)}</h1>
      <div class="meta-grid">
        <div class="mcell bet"><div class="mlbl">The Bet</div><div class="mval">${esc(card.bet || '—')}</div></div>
        <div class="mcell weak"><div class="mlbl">Weakest Spot</div><div class="mval">${esc(card.weakest || '—')}</div></div>
      </div>
    </section>` : ''}
    ${bodyHtml}
  </main>
</body>
</html>`;
}

function rewriteHtmlPaths(html, prefix) {
  // Rewrite root-relative href="/...", src="/...", action="/..." into `/hopper/live/<id>/...`
  // while leaving protocol-relative `//...` and already-prefixed paths untouched.
  return html.replace(
    /(\b(?:href|src|action)\s*=\s*["'])\/(?!\/|hopper\/live\/)/gi,
    `$1${prefix}/`,
  );
}

export function renderCraftReadView(card, target = parseLiveTarget(card)) {
  const panels = loadReadPanels(card, target);
  const bodyHtml = `<section class="panels">${panels.map((p) => `<article class="panel"><div class="phead">${esc(p.label)}</div><pre class="pbody">${esc(p.body)}</pre></article>`).join('')}</section>`;
  return renderDarkShell({
    title: `${card.id} Craft View`,
    kicker: 'Craft Lab · Side-by-Side',
    card,
    bodyHtml,
  });
}

// Check quickly whether a local scratch port is currently accepting connections.
export function probePort(port, timeoutMs = 450) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

// Reverse-proxy HTTP requests for `/hopper/live/<id>/*` or render the Craft Lab dark read view.
export async function handleLiveRequest(req, res, id, restPath) {
  const routes = activeBenchRoutes();
  const entry = routes.get(id);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderDarkShell({
      title: `${id} not on Bench`,
      kicker: 'Not on Bench',
      card: null,
      bodyHtml: `<div class="msg"><b>${esc(id)}</b> is not one of the active Bench cards right now (max ${MAX_BENCH_ROUTES}). If it was nuked or pulled to lab, its live route is already closed.</div>`,
    }));
  }

  const { card, target } = entry;
  const prefix = `/hopper/live/${card.id}`;

  if (target.kind === 'blocked') {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderDarkShell({
      title: `${card.id} blocked`,
      kicker: 'Port Guard',
      card,
      bodyHtml: `<div class="msg">${esc(target.reason)}</div>`,
    }));
  }

  if (target.kind !== 'http') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderCraftReadView(card, target));
  }

  // Ensure trailing slash on mount root so relative URLs resolve inside `/hopper/live/<id>/`
  const urlObj = new URL(req.url, 'http://127.0.0.1');
  if (urlObj.pathname === prefix) {
    res.writeHead(302, { Location: `${prefix}/${urlObj.search}` });
    return res.end();
  }

  // Build upstream path: if request is `/hopper/live/<id>/`, hit target.basePath (e.g. `/den/` or `/`).
  let upstreamPath;
  if (!restPath || restPath === '/') {
    upstreamPath = target.basePath || '/';
  } else {
    upstreamPath = restPath.startsWith('/') ? restPath : '/' + restPath;
  }
  if (urlObj.search) upstreamPath += urlObj.search;

  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${target.port}`;
  delete headers['accept-encoding']; // keep HTML readable for light path rewriting

  const proxyReq = http.request({
    hostname: target.host,
    port: target.port,
    path: upstreamPath,
    method: req.method,
    headers,
    timeout: 15_000,
  }, (proxyRes) => {
    proxyReq.setTimeout(0);
    const outHeaders = { ...proxyRes.headers };
    if (outHeaders.location && typeof outHeaders.location === 'string' && outHeaders.location.startsWith('/') && !outHeaders.location.startsWith(prefix)) {
      outHeaders.location = `${prefix}${outHeaders.location}`;
    }
    const ctype = String(outHeaders['content-type'] || '');
    if (ctype.includes('text/html')) {
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        const html = rewriteHtmlPaths(Buffer.concat(chunks).toString('utf8'), prefix);
        delete outHeaders['content-length'];
        outHeaders['cache-control'] = 'no-store';
        res.writeHead(proxyRes.statusCode || 200, outHeaders);
        res.end(html);
      });
    } else {
      res.writeHead(proxyRes.statusCode || 200, outHeaders);
      if (ctype.toLowerCase().includes('text/event-stream')) res.flushHeaders?.();
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', () => {
    if (res.headersSent) return;
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderDarkShell({
      title: `${card.id} offline`,
      kicker: 'Scratch Offline',
      card,
      bodyHtml: `<div class="msg">The scratch server for <b>${esc(card.id)}</b> on port <code>${target.port}</code> isn't running right now.</div>`,
    }));
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
  });

  req.pipe(proxyReq);
}

// Forward WebSocket upgrades for `/hopper/live/<id>/*` to the active bench scratch server.
export function handleLiveUpgrade(req, socket, head) {
  const m = String(req.url || '').match(/^\/hopper\/live\/(h\d{3,})(\/.*)?$/);
  if (!m) return false;
  const [, id, rest = '/'] = m;
  const entry = activeBenchRoutes().get(id);
  if (!entry || entry.target.kind !== 'http') {
    socket.destroy();
    return true;
  }
  const upstream = net.connect(entry.target.port, entry.target.host, () => {
    const reqLine = `${req.method} ${rest} HTTP/${req.httpVersion}\r\n`;
    const hdrs = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${k.toLowerCase() === 'host' ? `127.0.0.1:${entry.target.port}` : v}`)
      .join('\r\n');
    upstream.write(`${reqLine}${hdrs}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  return true;
}

// Cleanly stop any running scratch process owned by a card when Hunter taps Nuke It.
export async function cleanupCardLive(card) {
  const stopped = [];
  if (!card) return { stopped };
  const target = parseLiveTarget(card);
  const clones = new Set((card.shots || []).map((s) => s.clone && path.resolve(s.clone).toLowerCase()).filter(Boolean));
  const scratches = S.listScratch();
  for (const sc of scratches) {
    const matchPort = target.kind === 'http' && sc.port === target.port;
    const matchClone = sc.externalDir && clones.has(path.resolve(sc.externalDir).toLowerCase());
    if (matchPort || matchClone) {
      try {
        await S.stopScratch(sc.id);
        stopped.push({ id: sc.id, port: sc.port });
      } catch {}
    }
  }
  return { stopped };
}
