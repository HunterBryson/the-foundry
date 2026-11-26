// Runs Live Match on its own, detached from the Foundry window, so the window can be restarted and still get checked.
import { runAfterMove } from './live-match.mjs';
import * as F from './lib.mjs';

const [, , name, from, to, kind] = process.argv;
try {
  const r = await runAfterMove(name, from === '-' ? null : from, to, kind);
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  try {
    F.addFlag({ path: `core/${name}`, tag: 'Live Match', by: 'live-match', for: 'hunter', note: `Live Match itself failed on ${name}, so what's running is unchecked: ${e.message}`.slice(0, 400) });
    await F.writeContextFile();
  } catch {}
  process.exit(2);
}
