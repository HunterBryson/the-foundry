import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadConfig, REPO_ROOT } from '../app/config.mjs';

const ok = (msg) => console.log(`  [OK]   ${msg}`);
const warn = (msg) => console.log(`  [WARN] ${msg}`);
const fail = (msg) => console.log(`  [FAIL] ${msg}`);

let failures = 0;
console.log('\n=== The Foundry Setup Check ===\n');

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 20) ok(`Node.js v${process.versions.node} (20+ required)`);
else { fail(`Node.js v${process.versions.node} is too old — install Node 20+`); failures++; }

const gitRes = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
if (gitRes.status === 0) ok(`Git ready: ${(gitRes.stdout || '').trim()}`);
else { fail('Git is not installed or not on PATH'); failures++; }

let cfg;
try {
  cfg = loadConfig();
  if (cfg.hasFile) ok(`Loaded config: ${cfg.configPath}`);
  else warn(`No foundry.config.json yet (using defaults; copy foundry.config.example.json to foundry.config.json to customize)`);
} catch (err) {
  fail(`Invalid foundry.config.json: ${err.message}`);
  process.exit(1);
}

try {
  for (const dir of ['lab', 'core', 'public', 'state', '.foundry']) {
    fs.mkdirSync(`${cfg.home}/${dir}`, { recursive: true });
  }
  ok(`Workshop spine ready at ${cfg.home} (lab/, core/, public/, state/, .foundry/)`);
} catch (err) {
  fail(`Could not create workshop folders at ${cfg.home}: ${err.message}`);
  failures++;
}

ok(`Board address: http://${cfg.host}:${cfg.port}  ·  Crew Dock: http://${cfg.host}:${cfg.port}/hub`);
ok(`Configured crew seats: ${cfg.crew.map((c) => c.name).join(', ')}`);

console.log('');
if (failures === 0) {
  console.log(`All checks passed! Start with \`npm start\` (or \`powershell -ExecutionPolicy Bypass -File scripts\\foundry-restart.ps1\` on Windows) and open http://${cfg.host}:${cfg.port}\n`);
  process.exit(0);
} else {
  console.log(`${failures} check(s) failed. Fix the items marked [FAIL] above and re-run.\n`);
  process.exit(1);
}
