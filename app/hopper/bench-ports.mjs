// Dedicated Root Bench Ports (:7991-:7993) with Single-Flight Lazy Auto-Reboot,
// SSE/WS Root Proxying, Safe Shadow-DOM Orientation Pill Injection, and Startup Orphan Reconciliation.
// Each of the 3 Bench slots gets its own root HTTP+WS server on 127.0.0.1 so web apps making root
// `/api/*`, asset, SSE, and WebSocket calls work identically on localhost and Tailscale without subpath hacks.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import * as H from './hopper.mjs';
import * as HP from './proxy.mjs';
import * as S from '../scratch.mjs';
import { CONFIG } from '../config.mjs';
import { doorOk } from '../security.mjs';

export const DEFAULT_BENCH_PORTS = CONFIG.benchPorts || [7991, 7992, 7993];
const MAX_PILL_HTML_BYTES = 2 * 1024 * 1024; // 2MB cap for HTML pill injection
const DEFAULT_BOOT_TIMEOUT_MS = 30_000;

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export { doorOk };

export function parseConfiguredPorts(portsOpt) {
  if (Array.isArray(portsOpt)) return portsOpt.map((p) => Number(p));
  const envVal = process.env.HOPPER_BENCH_PORTS;
  if (envVal !== undefined) {
    const trimmed = String(envVal).trim().toLowerCase();
    if (!trimmed || ['off', 'none', 'disabled', 'false'].includes(trimmed)) return null;
    const parsed = trimmed.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 65535);
    if (parsed.length === 3) return parsed;
  }
  return [...DEFAULT_BENCH_PORTS];
}

function atomicWriteJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    for (let i = 0; i < 8; i++) {
      try { fs.renameSync(tmp, file); return; } catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i === 7) {
          try { fs.rmSync(tmp, { force: true }); } catch {}
          return;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + i * 10);
      }
    }
  } catch {}
}

function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Build a compact, dismissible Shadow-DOM Caretaker Check-In `M` Tab isolated from host CSS/JS.
// Lets you tap "Love this screen" or drop a 1-line screen-pinned note straight onto the On Deck card.
export function buildOrientationPillSnippet(card, slot, foundryPort = Number(process.env.FOUNDRY_PORT || 7988)) {
  const sr = card?.showroom || {};
  const payload = {
    id: card?.id || '',
    slot,
    title: card?.drop || '',
    itch: sr.itch || '',
    bet: sr.swing || card?.bet || '',
    firstClicks: Array.isArray(sr.firstClicks) ? sr.firstClicks : [],
    weakest: sr.weakestSpot || card?.weakest || '',
    options: Array.isArray(sr.options) ? sr.options : [],
    foundryPort,
  };
  const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `\n<script data-hopper-pill="1">(function(){try{
if(document.getElementById('__hopper-pill-host'))return;
var D=${safeJson};
var key='__hopper_pill_dismissed_'+D.id+'_'+D.slot;
if(sessionStorage.getItem(key)==='1')return;
var host=document.createElement('div');
host.id='__hopper-pill-host';
host.style.cssText='position:fixed;right:0;top:46%;transform:translateY(-50%);z-index:2147483647;pointer-events:none;font-family:system-ui,-apple-system,"Segoe UI",sans-serif';
var sh=host.attachShadow({mode:'open'});
var backUrl=location.hostname.endsWith('.ts.net')?('https://'+location.hostname+':'+D.foundryPort+'/#hopper'):('http://127.0.0.1:'+D.foundryPort+'/#hopper');
var esc=function(s){return String(s||'').replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];});};
function detectScreen(){
  var loc=location.pathname+location.search+(location.hash||'');
  var opts=Array.isArray(D.options)?D.options:[];
  for(var i=0;i<opts.length;i++){
    var op=opts[i];
    if(op&&op.path&&op.path!=='/'&&loc.indexOf(op.path)!==-1)return op.label;
  }
  var q=new URLSearchParams(location.search);
  var c=q.get('concept')||q.get('option')||q.get('view')||q.get('tab');
  if(c)return 'Option '+c.toUpperCase();
  var active=document.querySelector('[aria-selected="true"],[aria-current="page"],.tab.active,.pill.active,.nav-btn.active');
  if(active&&active.textContent&&active.textContent.trim().length<48)return active.textContent.trim();
  if(document.title&&document.title.trim().length<54)return document.title.trim();
  return location.pathname==='/'?'Main screen':location.pathname;
}
var clicksHtml=D.firstClicks&&D.firstClicks.length?('<div class="sec"><div class="lbl">Try First</div><ul class="ul">'+D.firstClicks.map(function(c){return '<li>'+esc(c)+'</li>';}).join('')+'</ul></div>'):'';
var weakHtml=D.weakest?('<div class="sec"><div class="lbl w">Weakest Spot</div><div class="val">'+esc(D.weakest)+'</div></div>'):'';
var itchHtml=D.itch?('<div class="sec"><div class="lbl i">The Itch</div><div class="val">'+esc(D.itch)+'</div></div>'):'';
sh.innerHTML='<style>'
+':host{all:initial;font:13px/1.45 "Segoe UI",system-ui,-apple-system,sans-serif;color:#f5f5f8}'
+'.wrap{display:flex;flex-direction:row;align-items:center;gap:8px;pointer-events:auto}'
+'.pill{display:inline-flex;flex-direction:column;align-items:center;gap:4px;background:rgba(15,15,21,.92);color:#f5f5f8;border:1px solid rgba(168,130,255,.42);border-right:0;border-radius:13px 0 0 13px;padding:8px 7px 8px 9px;font-size:10px;font-weight:750;cursor:pointer;box-shadow:-4px 6px 24px rgba(0,0,0,.55),0 0 18px rgba(168,130,255,.22);backdrop-filter:blur(10px)}'
+'.pill:hover{border-color:rgba(201,178,255,.72);background:#171722}'
+'.m{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#b8f24b,#a882ff);color:#0b0b10;font-weight:850;font-size:12px;box-shadow:0 0 10px rgba(184,242,75,.45)}'
+'.x{background:transparent;border:0;color:#8e8ea4;cursor:pointer;font-size:13px;line-height:1;padding:0 2px}'
+'.x:hover{color:#fff}'
+'.pop{display:none;width:min(324px,calc(100vw - 54px));max-height:78vh;overflow-y:auto;background:linear-gradient(180deg,#15151e 0%,#0d0d13 100%);border:1px solid rgba(168,130,255,.34);border-radius:15px;padding:13px 14px;box-shadow:0 20px 48px rgba(0,0,0,.82),0 0 28px rgba(168,130,255,.14)}'
+'.pop.open{display:block}'
+'.head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}'
+'.title{font-size:13px;font-weight:750;color:#fff;display:inline-flex;align-items:center;gap:6px}'
+'.scr{font-size:11px;font-weight:650;color:#dfd0ff;background:rgba(168,130,255,.16);border:1px solid rgba(168,130,255,.34);border-radius:999px;padding:2px 9px;display:inline-block;margin-bottom:9px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
+'.love{width:100%;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 10px;border-radius:10px;border:1px solid rgba(244,114,182,.42);background:linear-gradient(135deg,rgba(244,114,182,.18),rgba(168,130,255,.14));color:#ffe2f2;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;box-shadow:0 0 14px rgba(244,114,182,.16)}'
+'.love:hover{background:linear-gradient(135deg,rgba(244,114,182,.26),rgba(168,130,255,.22))}'
+'.love.ok{border-color:rgba(61,214,140,.5);background:rgba(61,214,140,.16);color:#baf7d9}'
+'.nrow{display:flex;gap:6px;margin-top:8px}'
+'.nin{flex:1;min-width:0;background:#0a0a0f;border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:7px 9px;color:#f5f5f8;font:inherit;font-size:12.5px;outline:none}'
+'.nin:focus{border-color:rgba(168,130,255,.6)}'
+'.nsend{border:1px solid rgba(168,130,255,.45);background:rgba(168,130,255,.22);color:#fff;border-radius:9px;padding:0 11px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}'
+'.nsend:hover{background:rgba(168,130,255,.32)}'
+'.stat{font-size:11.5px;color:#8ee6b6;min-height:16px;margin-top:6px}'
+'.stat.err{color:#ff9c9c}'
+'.det{margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08)}'
+'.det summary{cursor:pointer;font-size:11.5px;font-weight:650;color:#a1a1b2;user-select:none}'
+'.sec{margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,.07)}'
+'.sec:first-of-type{margin-top:6px;padding-top:0;border-top:0}'
+'.lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.55px;color:#3dd68c;margin-bottom:2px}'
+'.lbl.w{color:#f5b44c}.lbl.i{color:#a882ff}'
+'.val{font-size:12px;color:#d6d6e2;word-break:break-word}'
+'.ul{margin:3px 0 0;padding-left:16px;color:#d6d6e2;font-size:12px}'
+'.ul li{margin:2px 0}'
+'.foot{display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08)}'
+'.back{color:#c9b2ff;text-decoration:none;font-size:12px;font-weight:650}'
+'.back:hover{text-decoration:underline;color:#fff}'
+'</style>'
+'<div class="wrap">'
+'<div class="pop" id="pop">'
+'<div class="head"><span class="title"><span class="m">M</span><span>Caretaker Check-In</span></span><button class="x" id="close" title="Collapse">×</button></div>'
+'<div class="scr" id="scrLbl">Current screen</div>'
+'<button type="button" class="love" id="loveBtn">♥ Love this screen</button>'
+'<div class="nrow"><input class="nin" id="noteIn" type="text" placeholder="Drop a note on this screen…"><button type="button" class="nsend" id="sendBtn">Save</button></div>'
+'<div class="stat" id="stat"></div>'
+'<details class="det"><summary>Build notes</summary>'
+itchHtml
+'<div class="sec"><div class="lbl">The Bet</div><div class="val">'+esc(D.bet||D.title)+'</div></div>'
+clicksHtml
+weakHtml
+'</details>'
+'<div class="foot"><a class="back" href="'+esc(backUrl)+'">← Back to Hopper</a><button class="x" id="dismiss" title="Hide tab">Hide ×</button></div>'
+'</div>'
+'<div class="pill" id="toggle" title="Caretaker Check-In · Slot '+esc(D.slot)+'"><span class="m">M</span><span>S'+esc(D.slot)+'</span><button class="x" id="quickX" title="Dismiss">×</button></div>'
+'</div>';
var scrEl=sh.getElementById('scrLbl');
var statEl=sh.getElementById('stat');
var loveBtn=sh.getElementById('loveBtn');
var noteIn=sh.getElementById('noteIn');
var sendBtn=sh.getElementById('sendBtn');
function syncScreen(){scrEl.textContent='Viewing: '+detectScreen();}
function postReact(kind,text){
  var screen=detectScreen();
  var url=location.pathname+location.search+(location.hash||'');
  statEl.className='stat';statEl.textContent='Saving to card…';
  return fetch('/__hopper_react',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:kind,screen:screen,url:url,text:text||''})})
    .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Failed');return j;});})
    .then(function(){statEl.className='stat';statEl.textContent='Saved to your On Deck card ✓';return true;})
    .catch(function(e){statEl.className='stat err';statEl.textContent=e.message||'Could not save';return false;});
}
sh.getElementById('toggle').addEventListener('click',function(e){if(e.target.id==='quickX')return;syncScreen();sh.getElementById('pop').classList.toggle('open');});
sh.getElementById('close').addEventListener('click',function(){sh.getElementById('pop').classList.remove('open');});
loveBtn.addEventListener('click',function(){
  loveBtn.disabled=true;
  postReact('love','').then(function(ok){
    loveBtn.disabled=false;
    if(ok){loveBtn.classList.add('ok');loveBtn.textContent='♥ Loved this screen';setTimeout(function(){loveBtn.classList.remove('ok');loveBtn.textContent='♥ Love this screen';},2200);}
  });
});
function sendNote(){
  var txt=(noteIn.value||'').trim();
  if(!txt){noteIn.focus();return;}
  sendBtn.disabled=true;
  postReact('note',txt).then(function(ok){
    sendBtn.disabled=false;
    if(ok)noteIn.value='';
  });
}
sendBtn.addEventListener('click',sendNote);
noteIn.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();sendNote();}});
var hide=function(e){e.stopPropagation();sessionStorage.setItem(key,'1');host.remove();};
sh.getElementById('quickX').addEventListener('click',hide);
sh.getElementById('dismiss').addEventListener('click',hide);
document.body.appendChild(host);
}catch(_){}})();</script>\n`;
}

export function injectPillIntoHtml(html, card, slot, foundryPort) {
  const str = String(html || '');
  const idx = str.toLowerCase().lastIndexOf('</body>');
  if (idx < 0) return null;
  const snippet = buildOrientationPillSnippet(card, slot, foundryPort);
  return str.slice(0, idx) + snippet + str.slice(idx);
}

export function createBenchPorts(opts = {}) {
  const hopperDir = opts.hopperDir || H.HOPPER_DIR;
  const runtimeFile = () => path.join(hopperDir, 'bench-runtime.json');
  const listCardsFn = opts.listCards || H.listCards;
  const buildScratchFn = opts.buildScratch || S.buildScratch;
  const stopScratchFn = opts.stopScratch || S.stopScratch;
  const listScratchFn = opts.listScratch || S.listScratch;
  const reconcileOrphansFn = opts.reconcileScratchOrphans || ((ids) => (
    typeof S.reconcileScratchOrphans === 'function' ? S.reconcileScratchOrphans(ids) : { skipped: true }
  ));
  const probePortFn = opts.probePort || HP.probePort;
  const cleanupCardLiveFn = opts.cleanupCardLive || HP.cleanupCardLive;
  const addReactionFn = opts.addReaction || H.addReaction;
  const bootTimeoutMs = Number.isFinite(Number(opts.bootTimeoutMs)) ? Number(opts.bootTimeoutMs) : DEFAULT_BOOT_TIMEOUT_MS;
  const foundryPort = Number.isFinite(Number(opts.foundryPort)) ? Number(opts.foundryPort) : Number(process.env.FOUNDRY_PORT || 7988);

  const slots = new Map();
  for (let s = 1; s <= H.LIMITS.bench; s++) {
    slots.set(s, {
      slot: s,
      epoch: 0,
      active: null,   // { cardId, scratchId, port, pid }
      booting: null,  // { cardId, epoch, promise }
      server: null,
      boundPort: null,
      bindError: null,
    });
  }

  function persistRuntime() {
    const out = {};
    for (const [s, st] of slots.entries()) {
      out[String(s)] = st.active ? { ...st.active } : null;
    }
    atomicWriteJson(runtimeFile(), { updatedAt: new Date().toISOString(), slots: out });
  }

  function mapBenchSlots() {
    const bench = listCardsFn({ stage: 'bench' }).slice(0, H.LIMITS.bench);
    const assigned = new Map();
    const unslotted = [];
    for (const c of bench) {
      if (Number.isInteger(c.benchSlot) && c.benchSlot >= 1 && c.benchSlot <= H.LIMITS.bench && !assigned.has(c.benchSlot)) {
        assigned.set(c.benchSlot, c);
      } else {
        unslotted.push(c);
      }
    }
    for (const c of unslotted) {
      for (let s = 1; s <= H.LIMITS.bench; s++) {
        if (!assigned.has(s)) { assigned.set(s, c); break; }
      }
    }
    return assigned;
  }

  function findCardForSlot(slot) {
    return mapBenchSlots().get(slot) || null;
  }

  function findScratchMetaByPort(port) {
    try {
      return (listScratchFn() || []).find((sc) => sc.port === port && sc.running) || null;
    } catch { return null; }
  }

  async function ensureSlotRunning(slot) {
    const st = slots.get(slot);
    if (!st) return { kind: 'empty', slot };

    const card = findCardForSlot(slot);
    if (!card) return { kind: 'empty', slot };

    const target = HP.parseLiveTarget(card);
    const recipe = card.showroom?.bootRecipe || null;

    if (!recipe && target.kind === 'blocked') {
      return { kind: 'blocked', card, target };
    }
    if (!recipe && target.kind !== 'http') {
      return { kind: 'read', card, target };
    }

    // Fast path 1: existing active mapping for this exact card
    if (st.active && st.active.cardId === card.id && st.active.port && !HP.isLivePort(st.active.port)) {
      if (await probePortFn(st.active.port, 300)) {
        return { kind: 'http', card, port: st.active.port, basePath: recipe?.page || target.basePath || '/' };
      }
      // Scratch died overnight or stopped — clear stale active mapping
      st.active = null;
      persistRuntime();
    }

    // Fast path 2: adopt card.live HTTP port if still running on loopback
    if (target.kind === 'http' && !HP.isLivePort(target.port)) {
      if (await probePortFn(target.port, 300)) {
        const sc = findScratchMetaByPort(target.port);
        st.active = {
          cardId: card.id,
          scratchId: sc?.id || null,
          port: target.port,
          pid: sc?.pid || null,
        };
        persistRuntime();
        return { kind: 'http', card, port: target.port, basePath: target.basePath || '/' };
      }
    }

    // Cold / overnight boot path requires a bootRecipe
    if (!recipe) {
      return {
        kind: 'error',
        status: 503,
        card,
        reason: `Scratch server for ${card.id} is offline and no bootRecipe is stored for auto-reboot.`,
      };
    }

    // Single-flight mutex: coalesce concurrent requests onto one boot promise
    if (st.booting && st.booting.cardId === card.id) {
      return await st.booting.promise;
    }

    const myEpoch = st.epoch;
    let timedOut = false;

    const bootPromise = (async () => {
      const rawBuild = Promise.resolve().then(() => buildScratchFn(recipe.project || 'standalone', {
        dir: recipe.clone || '',
        entry: recipe.entry || '',
        page: recipe.page || '/',
        seed: recipe.seed || 'realistic',
      }));

      // Guard late completion: if slot was released or boot timed out, stop the late scratch immediately.
      const guarded = rawBuild.then(async (built) => {
        if (timedOut || myEpoch !== st.epoch) {
          if (built?.id) await stopScratchFn(built.id).catch(() => {});
          return { stale: true, built };
        }
        return { stale: false, built };
      });

      let timer;
      const timeoutP = new Promise((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve({ timeout: true }); }, bootTimeoutMs);
        timer.unref?.();
      });

      const outcome = await Promise.race([guarded, timeoutP]);
      clearTimeout(timer);

      if (outcome.timeout) {
        guarded.catch(() => {});
        return {
          kind: 'error',
          status: 503,
          card,
          reason: `Scratch auto-reboot for ${card.id} timed out after ${Math.round(bootTimeoutMs / 1000)}s.`,
        };
      }
      if (outcome.stale || myEpoch !== st.epoch) {
        if (outcome.built?.id) await stopScratchFn(outcome.built.id).catch(() => {});
        return {
          kind: 'error',
          status: 503,
          card,
          reason: `Bench Slot ${slot} changed while ${card.id} was booting.`,
        };
      }

      const built = outcome.built;
      if (!built || !built.ok || !built.port || HP.isLivePort(built.port)) {
        if (built?.id) await stopScratchFn(built.id).catch(() => {});
        return {
          kind: 'error',
          status: 503,
          card,
          reason: built?.error || `Scratch auto-reboot failed for ${card.id}.`,
        };
      }

      st.active = {
        cardId: card.id,
        scratchId: built.id || null,
        port: built.port,
        pid: built.pid || null,
      };
      persistRuntime();
      return { kind: 'http', card, port: built.port, basePath: recipe.page || '/' };
    })().catch((err) => ({
      kind: 'error',
      status: 503,
      card,
      reason: err?.message || `Scratch auto-reboot error for ${card.id}.`,
    })).finally(() => {
      if (st.booting && st.booting.promise === bootPromise) {
        st.booting = null;
      }
    });

    st.booting = { cardId: card.id, epoch: myEpoch, promise: bootPromise };
    return await bootPromise;
  }

  async function handleSlotRequest(slot, req, res) {
    if (!doorOk(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not from here.');
    }

    const reqUrlObj = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && reqUrlObj.pathname === '/__hopper_react') {
      const card = findCardForSlot(slot);
      if (!card) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ error: `Bench Slot ${slot} is empty.` }));
      }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 16_384) break;
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      try {
        const saved = await Promise.resolve(addReactionFn({
          id: card.id,
          kind: body.kind === 'love' ? 'love' : 'note',
          screen: body.screen || '',
          url: body.url || '',
          text: body.text || '',
          by: 'you',
        }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: true, reaction: saved.reaction, checkin: saved.card?.checkin || null }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ error: err?.message || 'Could not save reaction.' }));
      }
    }

    const resolved = await ensureSlotRunning(slot);

    if (resolved.kind === 'empty') {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(HP.renderDarkShell({
        title: `Bench Slot ${slot} is empty`,
        kicker: `Bench Slot ${slot}`,
        card: null,
        bodyHtml: `<div class="msg"><b>Bench Slot ${slot} is empty.</b> Nothing is benched here right now.</div>`,
      }));
    }

    if (resolved.kind === 'blocked') {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(HP.renderDarkShell({
        title: `${resolved.card.id} blocked`,
        kicker: 'Port Guard',
        card: resolved.card,
        bodyHtml: `<div class="msg">${esc(resolved.target.reason)}</div>`,
      }));
    }

    if (resolved.kind === 'read') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(HP.renderCraftReadView(resolved.card, resolved.target));
    }

    if (resolved.kind === 'error') {
      res.writeHead(resolved.status || 503, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': '3',
      });
      return res.end(HP.renderDarkShell({
        title: `Bench Slot ${slot} booting`,
        kicker: 'Bench Slot Unavailable',
        card: resolved.card || null,
        bodyHtml: `<div class="msg"><b>Could not reach Bench Slot ${slot}.</b><br><br>${esc(resolved.reason)}</div>`,
      }));
    }

    const { card, port: upstreamPort, basePath } = resolved;

    // If the build's landing page is a subpath like `/den/`, redirect bare `/` to `/den/` at root.
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && urlObj.pathname === '/' && basePath && basePath !== '/') {
      const dest = basePath + (urlObj.search || '');
      res.writeHead(302, { Location: dest, 'Cache-Control': 'no-store' });
      return res.end();
    }

    const headers = { ...req.headers };
    headers.host = `127.0.0.1:${upstreamPort}`;
    // Strip accept-encoding ONLY on GET requests whose accept includes text/html
    const isHtmlGet = req.method === 'GET' && String(req.headers.accept || '').toLowerCase().includes('text/html');
    if (isHtmlGet) delete headers['accept-encoding'];

    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: upstreamPort,
      path: req.url || '/',
      method: req.method,
      headers,
      timeout: 15_000,
    }, (proxyRes) => {
      // Fix SSE timeout bug: once upstream answers, disable idle timeout so SSE streams stay open indefinitely.
      proxyReq.setTimeout(0);
      req.setTimeout?.(0);
      res.setTimeout?.(0);

      const status = proxyRes.statusCode || 200;
      const outHeaders = { ...proxyRes.headers };
      const ctype = String(outHeaders['content-type'] || '');
      const hasEncoding = Boolean(outHeaders['content-encoding']);
      const eligibleForPill = req.method === 'GET' && status >= 200 && status < 300 && /^text\/html\b/i.test(ctype) && !hasEncoding;

      if (eligibleForPill) {
        const chunks = [];
        let totalBytes = 0;
        let overflowed = false;

        proxyRes.on('data', (chunk) => {
          if (overflowed) {
            res.write(chunk);
            return;
          }
          totalBytes += chunk.length;
          if (totalBytes > MAX_PILL_HTML_BYTES) {
            overflowed = true;
            res.writeHead(status, outHeaders);
            for (const c of chunks) res.write(c);
            chunks.length = 0;
            res.write(chunk);
            return;
          }
          chunks.push(chunk);
        });

        proxyRes.on('end', () => {
          if (overflowed) {
            res.end();
            return;
          }
          const rawBuf = Buffer.concat(chunks);
          const html = rawBuf.toString('utf8');
          const injected = injectPillIntoHtml(html, card, slot, foundryPort);
          if (injected === null) {
            res.writeHead(status, outHeaders);
            res.end(rawBuf);
            return;
          }
          delete outHeaders['etag'];
          delete outHeaders['transfer-encoding'];
          outHeaders['cache-control'] = 'no-store';
          outHeaders['content-length'] = String(Buffer.byteLength(injected, 'utf8'));
          res.writeHead(status, outHeaders);
          res.end(injected);
        });

        proxyRes.on('error', () => {
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
          try { res.end(); } catch {}
        });
        return;
      }

      res.writeHead(status, outHeaders);
      if (ctype.toLowerCase().includes('text/event-stream')) {
        res.flushHeaders?.();
      }
      proxyRes.pipe(res);
    });

    const abortUpstream = () => {
      if (!res.writableEnded && !proxyReq.destroyed) proxyReq.destroy();
    };
    req.on('aborted', abortUpstream);
    res.on('close', abortUpstream);

    proxyReq.on('error', (err) => {
      if (res.headersSent) { try { res.end(); } catch {} return; }
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '3' });
      res.end(HP.renderDarkShell({
        title: `Bench Slot ${slot} error`,
        kicker: 'Upstream Offline',
        card,
        bodyHtml: `<div class="msg">Upstream on port <code>${upstreamPort}</code> failed: ${esc(err.message)}</div>`,
      }));
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
    });

    req.pipe(proxyReq);
  }

  async function handleSlotUpgrade(slot, req, socket, head) {
    socket.on('error', () => {});
    if (!doorOk(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Pause socket BEFORE awaiting lazy boot so initial WS frames aren't lost during cold start.
    socket.pause();

    let resolved;
    try {
      resolved = await ensureSlotRunning(slot);
    } catch {
      resolved = { kind: 'error', status: 503 };
    }

    if (socket.destroyed) return;

    if (resolved.kind !== 'http') {
      const line = resolved.kind === 'empty'
        ? 'HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'
        : 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 3\r\nConnection: close\r\n\r\n';
      try { socket.write(line); } catch {}
      socket.destroy();
      return;
    }

    const upstreamPort = resolved.port;
    const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
      const reqLine = `${req.method} ${req.url || '/'} HTTP/${req.httpVersion}\r\n`;
      const hdrLines = [];
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        const val = k.toLowerCase() === 'host' ? `127.0.0.1:${upstreamPort}` : v;
        if (Array.isArray(val)) {
          for (const item of val) hdrLines.push(`${k}: ${item}`);
        } else {
          hdrLines.push(`${k}: ${val}`);
        }
      }
      upstream.write(`${reqLine}${hdrLines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      socket.resume();
    });

    const teardown = () => {
      if (!upstream.destroyed) upstream.destroy();
      if (!socket.destroyed) socket.destroy();
    };
    upstream.on('error', teardown);
    upstream.on('close', teardown);
    socket.on('error', teardown);
    socket.on('close', teardown);
  }

  async function releaseSlot(slot) {
    const st = slots.get(slot);
    if (!st) return { released: false };
    st.epoch++;
    const prev = st.active;
    st.active = null;
    st.booting = null;
    persistRuntime();
    let stopped = false;
    if (prev?.scratchId) {
      try {
        await stopScratchFn(prev.scratchId);
        stopped = true;
      } catch {}
    }
    return { released: true, slot, prev, stopped };
  }

  async function releaseCard(card) {
    if (!card || !card.id) return { released: [], cleaned: { stopped: [] } };
    const released = [];
    for (const [s, st] of slots.entries()) {
      if (st.active?.cardId === card.id || st.booting?.cardId === card.id || card.benchSlot === s) {
        released.push(await releaseSlot(s));
      }
    }
    const cleaned = await cleanupCardLiveFn(card).catch(() => ({ stopped: [] }));
    return { released, cleaned };
  }

  async function reconcileOnStartup() {
    const saved = readJsonSafe(runtimeFile(), null);
    const savedSlots = saved?.slots && typeof saved.slots === 'object' ? saved.slots : {};
    const assigned = mapBenchSlots();
    const keepIds = [];
    const scratches = (() => { try { return listScratchFn() || []; } catch { return []; } })();

    for (const [slot, card] of assigned.entries()) {
      const st = slots.get(slot);
      if (!st) continue;
      const savedEntry = savedSlots[String(slot)];
      let adopted = null;

      if (savedEntry && savedEntry.cardId === card.id && savedEntry.port && !HP.isLivePort(savedEntry.port)) {
        if (await probePortFn(savedEntry.port, 300)) {
          adopted = { ...savedEntry };
        }
      }

      if (!adopted) {
        const target = HP.parseLiveTarget(card);
        const cloneLow = card.showroom?.bootRecipe?.clone ? path.resolve(card.showroom.bootRecipe.clone).toLowerCase() : '';
        const match = scratches.find((sc) => sc.running && (
          (target.kind === 'http' && sc.port === target.port) ||
          (cloneLow && sc.externalDir && path.resolve(sc.externalDir).toLowerCase() === cloneLow)
        ));
        if (match && !HP.isLivePort(match.port) && await probePortFn(match.port, 300)) {
          adopted = { cardId: card.id, scratchId: match.id, port: match.port, pid: match.pid || null };
        }
      }

      if (adopted) {
        st.active = adopted;
        if (adopted.scratchId) keepIds.push(adopted.scratchId);
      } else {
        st.active = null;
      }
    }

    persistRuntime();
    let orphans = { skipped: true };
    try {
      // Async non-blocking sweep so startup health/Live Match probes never stall.
      orphans = await Promise.resolve(reconcileOrphansFn(keepIds));
    } catch (e) {
      orphans = { error: e.message };
    }
    return { keepIds, orphans };
  }

  async function start(startOpts = {}) {
    const ports = parseConfiguredPorts(startOpts.ports ?? opts.ports);
    if (!ports) return { started: false, disabled: true, slots: {} };

    const results = {};
    await Promise.all([1, 2, 3].map((slot, idx) => new Promise((resolve) => {
      const st = slots.get(slot);
      if (st.server) {
        results[slot] = { bound: true, port: st.boundPort };
        return resolve();
      }
      const desiredPort = ports[idx] ?? DEFAULT_BENCH_PORTS[idx];
      const srv = http.createServer((req, res) => {
        handleSlotRequest(slot, req, res).catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Bench Slot ${slot} error: ${err.message}`);
          }
        });
      });
      srv.on('upgrade', (req, socket, head) => {
        handleSlotUpgrade(slot, req, socket, head).catch(() => { try { socket.destroy(); } catch {} });
      });

      const onStartupError = (err) => {
        st.bindError = err.code || err.message;
        st.boundPort = null;
        st.server = null;
        if (err.code === 'EADDRINUSE') {
          console.warn(`[bench-ports] Slot ${slot} port ${desiredPort} already in use (EADDRINUSE); continuing without crashing :7988.`);
        } else {
          console.warn(`[bench-ports] Slot ${slot} failed to bind port ${desiredPort}: ${err.message}`);
        }
        results[slot] = { bound: false, port: desiredPort, error: st.bindError };
        resolve();
      };

      srv.once('error', onStartupError);
      srv.listen(desiredPort, '127.0.0.1', () => {
        srv.removeListener('error', onStartupError);
        srv.on('error', (err) => console.error(`[bench-ports] Slot ${slot} error:`, err.message));
        st.server = srv;
        st.boundPort = srv.address().port;
        st.bindError = null;
        results[slot] = { bound: true, port: st.boundPort };
        resolve();
      });
    })));

    return { started: true, slots: results };
  }

  async function stop() {
    await Promise.all([...slots.values()].map((st) => new Promise((resolve) => {
      if (!st.server) return resolve();
      const srv = st.server;
      st.server = null;
      st.boundPort = null;
      try {
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      } catch { resolve(); }
    })));
    return { stopped: true };
  }

  function status() {
    const out = {};
    for (const [s, st] of slots.entries()) {
      out[s] = {
        slot: s,
        boundPort: st.boundPort,
        bindError: st.bindError,
        epoch: st.epoch,
        active: st.active ? { ...st.active } : null,
        booting: st.booting ? { cardId: st.booting.cardId, epoch: st.booting.epoch } : null,
      };
    }
    return out;
  }

  return {
    start,
    stop,
    ensureSlotRunning,
    releaseSlot,
    releaseCard,
    reconcileOnStartup,
    findCardForSlot,
    status,
    slots,
  };
}

// Default singleton used by server.mjs
const defaultBenchPorts = createBenchPorts();
export const start = (o) => defaultBenchPorts.start(o);
export const stop = () => defaultBenchPorts.stop();
export const ensureSlotRunning = (slot) => defaultBenchPorts.ensureSlotRunning(slot);
export const releaseSlot = (slot) => defaultBenchPorts.releaseSlot(slot);
export const releaseCard = (card) => defaultBenchPorts.releaseCard(card);
export const reconcileOnStartup = () => defaultBenchPorts.reconcileOnStartup();
export const status = () => defaultBenchPorts.status();
export const findCardForSlot = (slot) => defaultBenchPorts.findCardForSlot(slot);
