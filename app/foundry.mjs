#!/usr/bin/env node
// Foundry CLI — local workshop commands for Claude Code and Antigravity agents.
// Same files the window reads. No server needed.
import * as F from './lib.mjs';

const [, , cmd, ...rest] = process.argv;
const opts = {}; const args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { opts[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; }
  else args.push(rest[i]);
}
const by = opts.by || process.env.FOUNDRY_AGENT || 'agent';

const HELP = `The Foundry — local workshop (${F.FOUNDRY})

  foundry context                                     Live context (Focus, Flags by target, Where Things Stand).
  foundry note "what you did" [--path P]              Log a plain-English note.
  foundry pin <path> ["why"]                          Mark a path as Current Focus.
  foundry unpin <path>
  foundry flag <path> "note" [--for <agent|you>] [--tag Review|Fix|Skill|Clean]
  foundry assign <flag-id> <agent>                    Route an existing flag to another agent (<agent>, you).
  foundry flags [--for <agent>]                       List open flags (JSON).
  foundry done <flag-id> ["what you did"]             Close a flag with a short summary.
  foundry status                                      Where every project stands.
  foundry start-core <lab-name>                       Give a lab-only project its first core copy (and tag it).
  foundry trial start <name> [--builds a,b] [--skills x,y] [--goal paired|core-skill|build-only] [--note "..."]
  foundry trial status                                List active trials (JSON).
  foundry trial review <name> [--salvage] [--note "..."]  Flag a trial for review.
  foundry trial land <name> [--note "..."]             The bench joins the lab; the lab before it is kept by name.
  foundry lab back <lab-name>                         The lab returns to before its last landing.
  foundry propose <lab-name> --why "..." [--lived "..."] [--restarts "..."]   Make the case for core. No case, no card.
  foundry withdraw <lab-name>                         Take the case back.
  foundry sign install | foundry sign                 Lab saves ask for an agent's name | who has been saving.
  foundry trial kill <name> [--reason "..."]          Atomically tear down a trial (builds + skills + links).
  foundry backup [--dry-run]                          Outbound-only push of lab + core to private GitHub repos.
  foundry match <core-name> [--dry-run]               Live Match: rebuild and restart what the last move touched, then check it's really running.
  foundry match status                                The last Live Match receipt for each project.
  foundry block list | add <core-name> <version> --files a,b --why "..." | clear <id> ["why"]
                                                      A broken version stays out of core until its files change. Clearing is your call.
  foundry scratch build standalone --dir <clone> [--entry server.mjs] [--page /]
  foundry scratch list | verify <id> | stop <id>

  The Hopper (cards in state/hopper/cards/<id>.json; ids look like h001):
  foundry hopper add "the drop" [--from you|agent] [--hint explore|prototype|upgrade|scout]
  foundry hopper frame <id> --hard "the hard part" --run "run shape" [--mode arena|scout|spike|scratch-fix|craft-lab] [--build <lab-name>]
  foundry hopper next                                           The card the engine should shoot next, or why none.
  foundry hopper shot start <id>                                Snapshot, then mark a shot in flight (2 running at most, 3 shots unless again).
  foundry hopper shot land <id> --branch B --clone PATH ["what it did"] | --failed "why"
                                                                Record it; the tripwire runs by itself. Exit 3 means it tripped.
  foundry hopper bench <id> --bet "..." --weakest "..." --live "..." [--slot 1|2|3] [--itch "..."] [--swing "..."] [--clicks "a||b"] [--screenshots "f1,f2"] [--boot-project P --boot-clone DIR --boot-entry E --boot-page / --boot-seed realistic|empty]
  foundry hopper again <id> ["chop brief"] [--weakest]          One more shot, aimed at the brief or where it's weakest.
  foundry hopper run-now <id>                                   Skip the 60s settle window on a queued card.
  foundry hopper pull <id> [--build <lab-name>] [--shot N]      Pull to Lab: the shot's branch becomes trial hopper-<id>.
  foundry hopper park <id> ["why"]
  foundry hopper nuke <id> "why it died" --reopen "what would reopen it"   Wipes marked engine clones, keeps one line.
  foundry hopper tripwire <id> | show <id> | list [stage] | line | where

  Every command accepts --by <your-name> (or FOUNDRY_AGENT). Paths are relative, e.g. lab/notes-app.`;

const csv = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

try {
  switch (cmd) {
    case 'context': console.log(await F.writeContextFile()); break;
    case 'note': F.logActivity({ by, path: opts.path ? F.normRel(opts.path) : '', kind: 'note', text: args.join(' ') }); console.log('logged'); break;
    case 'pin': F.pin(args[0], args.slice(1).join(' '), by); console.log('pinned', args[0]); break;
    case 'unpin': F.unpin(args[0], by); console.log('unpinned', args[0]); break;
    case 'flag': {
      const f = F.addFlag({ path: args[0], note: args.slice(1).join(' '), tag: opts.tag || 'Review', by, for: opts.for || 'breaker' });
      console.log(f.id);
      break;
    }
    case 'assign': F.assignFlag(args[0], args[1], by); console.log('assigned', args[0], '->', args[1]); break;
    case 'flags': {
      const list = F.getFlags().filter((f) => !opts.for || f.for === opts.for);
      console.log(JSON.stringify(list, null, 2));
      break;
    }
    case 'done': F.resolveFlag(args[0], args.slice(1).join(' '), by); console.log('closed', args[0]); break;
    case 'status': {
      for (const s of (await F.standings())) {
        console.log(`${s.name}: ${s.state}${s.ahead ? ` (+${s.ahead})` : ''}${s.changes ? `, ${s.changes} unsaved` : ''}${s.openFlags ? `, ${s.openFlags} flag(s)` : ''} — ${s.lastText}`);
      }
      break;
    }
    case 'start-core': {
      if (!args[0]) throw new Error('Usage: foundry start-core <lab-name>');
      const res = await F.promote(args[0], by);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'propose': {
      if (!args[0]) throw new Error('Usage: foundry propose <lab-name> --why "what it is, what real work it did in the lab" [--lived "..."] [--restarts "..."] [--commit <version>]');
      console.log(JSON.stringify(await F.propose(args[0], { why: opts.why || args.slice(1).join(' '), lived: opts.lived || '', restarts: opts.restarts || '', commit: opts.commit || '', by }), null, 2));
      break;
    }
    case 'withdraw': console.log(F.withdraw(args[0], by, args.slice(1).join(' ')) ? 'taken back' : 'no case was standing'); break;
    case 'proposals': console.log(JSON.stringify(F.getProposals(), null, 2)); break;
    case 'lab': {
      if (args[0] !== 'back' || !args[1]) throw new Error('Usage: foundry lab back <lab-name>   (the lab returns to before its last landing)');
      console.log(JSON.stringify(await F.labBack(args[1], by), null, 2));
      break;
    }
    case 'sign': {
      if (args[0] === 'install') console.log(JSON.stringify(await F.signInstall(by), null, 2));
      else console.log(JSON.stringify(await F.signCheck(Number(opts.days) || 3), null, 2));
      break;
    }
    case 'trial': {
      const sub = args[0];
      if (sub === 'land') {
        console.log(JSON.stringify(await F.landTrial(args[1], { by, note: opts.note || '' }), null, 2));
        break;
      }
      if (sub === 'start') {
        const t = await F.startTrial({
          name: args[1],
          builds: csv(opts.builds || opts.build),
          skills: csv(opts.skills || opts.skill),
          goal: typeof opts.goal === 'string' ? opts.goal : '',
          note: typeof opts.note === 'string' ? opts.note : args.slice(2).join(' '),
          by,
        });
        console.log(JSON.stringify(t, null, 2));
      } else if (sub === 'status' || sub === 'list' || !sub) {
        console.log(JSON.stringify(F.listTrials(), null, 2));
      } else if (sub === 'review') {
        const res = await F.reviewTrial(args[1], {
          salvage: Boolean(opts.salvage),
          note: typeof opts.note === 'string' ? opts.note : args.slice(2).join(' '),
          by,
        });
        console.log(JSON.stringify({ trial: res.trial.name, flagId: res.flag.id, status: res.trial.status }, null, 2));
      } else if (sub === 'kill') {
        const res = await F.killTrial(args[1], {
          reason: typeof opts.reason === 'string' ? opts.reason : args.slice(2).join(' '),
          by,
        });
        console.log(JSON.stringify(res, null, 2));
      } else {
        throw new Error(`Unknown trial subcommand: ${sub}`);
      }
      break;
    }
    case 'backup': {
      const remoteBase = typeof opts['remote-base'] === 'string' ? opts['remote-base'] : '';
      const res = await F.backupRepos({ dryRun: Boolean(opts['dry-run']), by, remoteBase });
      console.log(JSON.stringify(res, null, 2));
      if (!opts['dry-run'] && res.some((r) => r.status !== 'ok')) {
        await F.writeContextFile();
        const bad = res.filter((r) => r.status !== 'ok').map((r) => `${r.project} (${r.status})`).join(', ');
        console.error(`foundry: backup failed for ${bad} — remote history was NOT overwritten. See .foundry/backup-status.json`);
        process.exit(1);
      }
      break;
    }
    case 'match': {
      const LM = await import('./live-match.mjs');
      if (args[0] === 'status') { console.log(JSON.stringify(LM.matchStatus(), null, 2)); break; }
      if (!args[0]) throw new Error('Which project? foundry match <core-name>');
      const res = await LM.matchLastMove(args[0], { dryRun: Boolean(opts['dry-run']) });
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok) process.exit(1);
      break;
    }
    case 'block': {
      const sub = args[0] || 'list';
      if (sub === 'list') console.log(JSON.stringify(F.getBlocks({ includeCleared: Boolean(opts.all) }), null, 2));
      else if (sub === 'add') console.log(JSON.stringify(await F.addBlock({ name: args[1], commit: args[2], files: csv(opts.files), why: typeof opts.why === 'string' ? opts.why : '', by }), null, 2));
      else if (sub === 'clear') console.log(JSON.stringify(F.clearBlock(args[1], args.slice(2).join(' '), by), null, 2));
      else throw new Error('foundry block list | add | clear');
      break;
    }
    case 'hopper': {
      const H = await import('./hopper/hopper.mjs');
      const sub = args[0] || 'list';
      const id = args[1];
      const words = args.slice(2).join(' ');
      const str = (v) => (typeof v === 'string' ? v : undefined);
      let res;
      if (sub === 'add') res = H.add({ drop: args.slice(1).join(' '), from: str(opts.from) || 'you', hint: str(opts.hint) || '', by });
      else if (sub === 'frame') res = H.frame({ id, hard: str(opts.hard), run: str(opts.run), mode: str(opts.mode), build: str(opts.build), by });
      else if (sub === 'shot') {
        // foundry hopper shot <id> | shot start <id> | shot land <id> --branch B --clone PATH ["note"] | shot land <id> --failed "why"
        const mode = ['start', 'land'].includes(id) ? id : 'start';
        const cid = ['start', 'land'].includes(id) ? args[2] : id;
        const note = ['start', 'land'].includes(id) ? args.slice(3).join(' ') : words;
        res = mode === 'start' ? await H.shotStart({ id: cid, by })
          : await H.shotLand({ id: cid, branch: str(opts.branch), clone: str(opts.clone), note, failed: str(opts.failed) || '', by });
        if (res.tripwire && res.tripwire.tripped) process.exitCode = 3;
      }
      else if (sub === 'bench') {
        if (!id) {
          res = H.listCards({ stage: 'bench' });
        } else {
          const hasBoot = Boolean(str(opts['boot-project']) || str(opts['boot-clone']) || str(opts['boot-entry']) || str(opts['boot-page']) || str(opts['boot-seed']));
          const bootRecipe = hasBoot ? {
            project: str(opts['boot-project']) || 'standalone',
            clone: str(opts['boot-clone']) || '',
            entry: str(opts['boot-entry']) || '',
            page: str(opts['boot-page']) || '/',
            seed: str(opts['boot-seed']) || 'realistic',
          } : undefined;
          const parseJsonOrPipe = (raw, kind) => {
            if (!raw) return undefined;
            const trimmed = raw.trim();
            if (!trimmed) return undefined;
            if (trimmed.startsWith('[')) {
              try { return JSON.parse(trimmed); } catch { throw new Error(`Invalid JSON for --${kind}.`); }
            }
            if (kind === 'options') {
              return trimmed.split('||').map((part, idx) => {
                const eq = part.indexOf('=');
                const label = (eq >= 0 ? part.slice(0, eq) : part).trim();
                const optPath = (eq >= 0 ? part.slice(eq + 1) : '/').trim() || '/';
                return { id: `opt-${idx + 1}`, label, path: optPath };
              }).filter((o) => o.label);
            }
            if (kind === 'questions') {
              return trimmed.split('||').map((part, idx) => {
                const sep = part.indexOf('::');
                const text = (sep >= 0 ? part.slice(0, sep) : part).trim();
                const chips = sep >= 0 ? part.slice(sep + 2).split('|').map((s) => s.trim()).filter(Boolean) : [];
                return { id: `q${idx + 1}`, text, chips };
              }).filter((q) => q.text);
            }
            return undefined;
          };
          res = H.bench({
            id,
            bet: str(opts.bet),
            weakest: str(opts.weakest),
            live: str(opts.live),
            slot: str(opts.slot),
            itch: str(opts.itch),
            swing: str(opts.swing),
            firstClicks: str(opts.clicks),
            screenshots: str(opts.screenshots),
            options: parseJsonOrPipe(str(opts.options), 'options'),
            questions: parseJsonOrPipe(str(opts.questions), 'questions'),
            bootRecipe,
            by,
          });
        }
      }
      else if (sub === 'run-now') res = H.markRunNow(id, { by });
      else if (sub === 'steer') res = H.steer({ id, brief: str(opts.brief) || words, by });
      else if (sub === 'again') res = H.again({ id, brief: str(opts.brief) || words, weakest: opts.weakest === true, by });
      else if (sub === 'pull') res = await H.pull({ id, build: str(opts.build), shot: str(opts.shot), by });
      else if (sub === 'park') res = H.park({ id, why: words, by });
      else if (sub === 'nuke') res = H.nuke({ id, why: str(opts.why) || words, reopen: str(opts.reopen), by });
      else if (sub === 'tripwire') { res = await H.tripwire({ id }); if (res.tripped) process.exitCode = 3; }
      else if (sub === 'next') res = H.next();
      else if (sub === 'show') res = H.getCard(id);
      else if (sub === 'list') res = H.listCards({ stage: str(opts.stage) || (id && H.STAGES.includes(id) ? id : undefined) });
      else if (sub === 'line') { console.log(H.benchLine()); break; }
      else if (sub === 'where') { console.log(H.HOPPER_DIR); break; }
      else throw new Error('foundry hopper add | frame | shot | bench | run-now | again | pull | park | nuke | tripwire | next | show | list | line | where');
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'scratch': {
      const S = await import('./scratch.mjs');
      const sub = args[0] || 'list';
      let res;
      if (sub === 'build' || sub === 'start') res = await S.buildScratch(args[1], {
        from: typeof opts.from === 'string' ? opts.from : 'core',
        dir: typeof opts.dir === 'string' ? opts.dir : '',
        entry: typeof opts.entry === 'string' ? opts.entry : '',
        page: typeof opts.page === 'string' ? opts.page : '',
        ...(typeof opts.seed === 'string' ? { seed: opts.seed } : {}),
      });
      else if (sub === 'list') res = S.listScratch();
      else if (sub === 'verify') res = await S.verifyScratch(args[1]);
      else if (sub === 'stop') res = await S.stopScratch(args[1]);
      else throw new Error('foundry scratch build | list | verify | stop');
      console.log(JSON.stringify(res, null, 2));
      if (res && res.ok === false) process.exit(1);
      break;
    }
    default: console.log(HELP);
  }
  if (['note', 'pin', 'unpin', 'flag', 'assign', 'done', 'start-core', 'trial', 'backup', 'propose', 'withdraw', 'lab'].includes(cmd)) await F.writeContextFile();
} catch (e) {
  console.error('foundry:', e.message);
  process.exit(1);
}
