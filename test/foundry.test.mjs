import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'app', 'foundry.mjs');
const SERVER = path.join(REPO_ROOT, 'app', 'server.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('Zero-leak privacy & voice guardrail audit across entire repo', () => {
  const FORBIDDEN = [
    [/hdbry/i, 'personal Windows username'],
    [/mapshop|map shop/i, 'day-job reference'],
    [/hunteraivault/i, 'personal email'],
    [/berkeley forest/i, 'address'],
    [/tailcd99a5|sen-41044/i, 'private Tailscale hostname'],
    [/sk-ant-[a-z0-9-]{12,}/i, 'Anthropic key'],
    [/ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}/i, 'GitHub token'],
    [/\bpartner(s|ship)?\b/i, 'creepy partner wording'],
    [/\b(Odie|Juno|Rivet|Billy)\b/i, 'internal family agent name'],
    [/Built by Hunter/i, 'third-person sign-off'],
  ];

  const walk = (dir) => {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === 'test') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  };

  for (const file of walk(REPO_ROOT)) {
    if (/\.(png|jpg|jpeg|webp|ico)$/i.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file);
    for (const [re, label] of FORBIDDEN) {
      assert.equal(re.test(text), false, `Privacy/voice guardrail tripped in ${rel}: matched ${label} (${re})`);
    }
  }

  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.ok(readme.trim().endsWith('Works with **Claude and Antigravity**. MIT license.'), 'README must close with clean locked sign-off');
});

test('Bench -> Lab -> Propose -> Move to core -> Roll back spine', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-pub-test-'));
  const env = { ...process.env, FOUNDRY_HOME: tmp, HOPPER_BENCH_PORTS: 'off' };
  const run = (args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', windowsHide: true }).trim();
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }).trim();

  try {
    for (const d of ['lab', 'core', 'public', 'state', '.foundry']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
    const labApp = path.join(tmp, 'lab', 'notes-app');
    fs.mkdirSync(labApp, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', labApp], { windowsHide: true });
    git(labApp, 'config', 'user.email', 'test@example.invalid');
    git(labApp, 'config', 'user.name', 'builder');
    fs.writeFileSync(path.join(labApp, 'index.js'), 'export const v = 1;\n');
    git(labApp, 'add', '-A');
    git(labApp, 'commit', '-qm', 'Initial working app');

    // 1. Start core
    const initCore = JSON.parse(run(['start-core', 'notes-app', '--by', 'you']));
    assert.equal(initCore.initialized, true);
    const v1Sha = initCore.to;

    // 2. Start isolated bench, commit on bench, verify lab & core stay on v1
    const trial = JSON.parse(run(['trial', 'start', 'offline-cas', '--builds', 'notes-app', '--by', 'builder']));
    const benchDir = path.join(tmp, trial.builds[0].worktreeRel);
    git(benchDir, 'config', 'user.email', 'test@example.invalid');
    git(benchDir, 'config', 'user.name', 'builder');
    fs.writeFileSync(path.join(benchDir, 'index.js'), 'export const v = 2;\n');
    git(benchDir, 'add', '-A');
    git(benchDir, 'commit', '-qm', 'Atomic CAS offline write');
    assert.equal(git(labApp, 'rev-parse', 'HEAD'), v1Sha, 'Lab untouched while work lives on bench');

    // 3. Land bench in lab; verify core STILL does not move without a case
    const landed = JSON.parse(run(['trial', 'land', 'offline-cas', '--by', 'builder']));
    const v2Sha = landed.landed[0].to;
    assert.notEqual(v2Sha, v1Sha);
    assert.equal(git(path.join(tmp, 'core', 'notes-app'), 'rev-parse', 'HEAD'), v1Sha, 'Nothing moves to core without a case + tap');

    // 4. Propose plain-English case, then make a later half-baked save in lab — Move to core must ONLY take v2Sha!
    run(['propose', 'notes-app', '--why', 'Prevents silent tab overwrites', '--lived', '28 multi-tab tests', '--restarts', 'Local server', '--by', 'builder']);
    fs.writeFileSync(path.join(labApp, 'half-baked.js'), '// wip\n');
    git(labApp, 'add', '-A');
    git(labApp, 'commit', '-qm', 'Half-baked experiment five minutes later');
    const v3Sha = git(labApp, 'rev-parse', 'HEAD');
    assert.notEqual(v3Sha, v2Sha);

    // 5. Promote via lib.mjs and verify Core locked strictly to v2Sha (NOT v3Sha), then Roll back to v1Sha!
    const promoScript = `import * as F from './app/lib.mjs'; const r = await F.promote('notes-app', 'you'); console.log(JSON.stringify(r));`;
    const promo = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', promoScript], { cwd: REPO_ROOT, env, encoding: 'utf8', windowsHide: true }).trim());
    assert.equal(promo.to, v2Sha);
    assert.equal(git(path.join(tmp, 'core', 'notes-app'), 'rev-parse', 'HEAD'), v2Sha, 'Move to core locked to proposed version, skipping later half-baked save');
    assert.equal(fs.existsSync(path.join(tmp, 'core', 'notes-app', 'half-baked.js')), false);

    const rbScript = `import * as F from './app/lib.mjs'; const r = await F.rollback('notes-app', 'you', { noMatch: true }); console.log(JSON.stringify(r));`;
    const rb = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', rbScript], { cwd: REPO_ROOT, env, encoding: 'utf8', windowsHide: true }).trim());
    assert.equal(rb.to, v1Sha);
    assert.equal(git(path.join(tmp, 'core', 'notes-app'), 'rev-parse', 'HEAD'), v1Sha, 'Roll back restored exact previous Core version');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('HTTP server, Crew Dock /hub, Hopper Check-In, and Host/Origin security guard', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-srv-test-'));
  const port = await freePort();
  const env = { ...process.env, FOUNDRY_HOME: tmp, FOUNDRY_PORT: String(port), HOPPER_BENCH_PORTS: 'off', HUB_FLOOR_URL: 'off', HUB_SCHEDULE_URL: 'off', HUB_HOMEBASE_URL: 'off' };
  const proc = spawn(process.execPath, [SERVER], { env, stdio: 'ignore', windowsHide: true });

  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`${base}/api/health`); if (r.ok) { ready = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 120));
    }
    assert.equal(ready, true, 'Foundry server booted on loopback');

    // Foreign Origin must be blocked (403)
    const badOrigin = await fetch(`${base}/api/board`, { headers: { Origin: 'https://evil.example.com' } });
    assert.equal(badOrigin.status, 403);

    // Private Tailscale Origin (*.ts.net) must be allowed (200)
    const tsOrigin = await fetch(`${base}/api/board`, { headers: { Origin: `https://my-pc.tailnet-demo.ts.net:${port}` } });
    assert.equal(tsOrigin.status, 200);

    // Crew Dock /hub & API work cleanly
    const hubHtml = await fetch(`${base}/hub`);
    assert.equal(hubHtml.status, 200);
    const hubState = await (await fetch(`${base}/api/hub`)).json();
    assert.equal(hubState.ok, true);
    assert.equal(hubState.crew.length, 4);

    // Hopper add + Check-In round-trip
    const dropRes = await (await fetch(`${base}/api/hopper/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop: 'Quick mobile merge view', hint: 'explore' }),
    })).json();
    assert.equal(dropRes.id, 'h001');

    const ciRes = await (await fetch(`${base}/api/hopper/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'h001', pulse: 'on-track', note: 'Keep inline pills' }),
    })).json();
    assert.equal(ciRes.ok, true);
    assert.equal(ciRes.checkin.pulse, 'on-track');
  } finally {
    try { proc.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
