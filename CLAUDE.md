# The Foundry: setup & operating guide for your AI

This file is written for you—the AI (running in **Claude Code** or **Antigravity**) that your person just pointed at this repo. Do the setup yourself so your person never has to touch a terminal or edit JSON by hand. Tell them in one plain sentence what you're doing as you go.

## Why The Foundry exists (hold this lens as you work)

When you build fast with AI, pushing every save straight into the apps your person relies on every day causes instant chaos—half-baked experiments ride along with small fixes and overwrite what worked ten minutes ago.

**The Foundry's one rule: nothing moves up just because someone saved.**
- **Bench (`foundry trial start`)** — every new experiment or risky change starts on an isolated git worktree bench (`lab/_trials/<name>`) so active work stays untouched.
- **Lab (`lab/<project>`)** — active testing ground. A bench joins `lab/` on your person's word (`foundry trial land`), keeping the previous lab snapshot one command back (`foundry lab back`).
- **Core (`core/<project>`)** — quiet daily apps that just work. A `Move to core` card appears on your person's board **only** when you write a plain-English case (`foundry propose <project> --why "..." --lived "..." --restarts "..." --by <your-name>`). The card locks to that exact tested commit, and your person clicks **Move to core**.
- **Public (`public/<project>`)** — scrubbed copies ready to share with strangers when your person asks.

## Setting it up

1. **Clone this repo beside your own folder (never inside another git repo):**
   - PowerShell: `git clone https://github.com/HunterBryson/the-foundry "$env:USERPROFILE\the-foundry"`
   - macOS / Linux: `git clone https://github.com/HunterBryson/the-foundry "$HOME/the-foundry"`
2. **Nothing to npm install.** Pure Node 20+ (zero npm dependencies).
3. **Create `foundry.config.json` from `foundry.config.example.json`:**
   - Set `"home"` to where your person wants their local Foundry workshop folder (for example `"~/Foundry-Workshop"` or `"~/Foundry"`). `check-setup.mjs` will create `lab/`, `core/`, `public/`, `state/`, and `.foundry/` inside it automatically.
   - Set `"human"` (`{ "id": "you", "name": "<their first name>" }`) and `"port"` (default `7988`; pick another free port if `7988` is busy).
   - Customize `"crew"` to match their actual AI setup—even if they start with just **one** Claude or Antigravity agent! Custom square PNG/JPG/WebP/SVG portraits can be set via `"avatar": "C:/path/to/face.png"`.
4. **Run the built-in setup doctor:**
   - `node scripts/check-setup.mjs`
   - Fix anything marked `[FAIL]`.
5. **Install the Foundry skill so you (and any sibling Claude / Antigravity agents) know the commands automatically:**
   - `node tools/install-skill.mjs`
6. **Start The Foundry hidden in the background and open it:**
   - Windows (zero console popup): `powershell -ExecutionPolicy Bypass -File scripts\foundry-restart.ps1`
   - macOS / Linux / foreground: `npm start` (`node app/server.mjs`)
   - Open `http://127.0.0.1:7988` (and `http://127.0.0.1:7988/hub` for the mobile Crew Dock view) in their browser.
7. **Optional — put it on their phone over private Tailscale:**
   - `tailscale serve --bg --https=7988 http://127.0.0.1:7988`
   - If they use Hopper On Deck preview ports (`7991–7993`), expose those on their tailnet too so phone previews open with one tap.
   - Give them their `https://<machine>.<tailnet>.ts.net:7988` link and tell them **Add to Home Screen** installs it as a full-screen dark app.
8. **Plug into Homebase / Monty's Floor (if installed):**
   - If **[Homebase](https://github.com/HunterBryson/the-homebase)** is installed, add `http://127.0.0.1:7988` to Homebase's left rail.
   - If **[Monty's Floor](https://github.com/HunterBryson/monty-floor)** is installed, set `surfaces.floorUrl` in `foundry.config.json` so Crew Dock (`/hub`) and Hopper `Bring to Floor` connect automatically.

## Everyday commands (`node app/foundry.mjs <cmd> --by <your-name>`)

- `context` — read live workshop state (`.foundry/CONTEXT.md`).
- `trial start <bench> --builds <project> --by <you>` — open an isolated bench copy under `lab/_trials/<bench>`.
- `trial land <bench> --by <you>` — land a finished bench into `lab/` on your person's word.
- `lab back <project> --by <you>` — undo the last bench landing in `lab/`.
- `propose <project> --why "..." --lived "..." --restarts "..." --by <you>` — put a plain-English **Move to core** card on your person's board.
- `start-core <project> --by <you>` — create the first `core/` copy of a brand-new `lab/` build when your person asks.
- `hopper add "raw spark" --hint explore --by you` — drop an idea into the Hopper studio queue.

## Troubleshooting

- Run `node scripts/check-setup.mjs` first to check Node 20+, `git`, workshop folders, and config syntax.
- Run `npm test` (`node --test test/*.test.mjs`) to verify benches, proposals, promotions, rollbacks, Hopper Check-In, Crew Dock, and host security guards.
