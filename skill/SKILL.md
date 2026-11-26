---
name: the-foundry
description: Manage local AI builds safely through Bench -> Lab -> Core -> Public using The Foundry CLI and board. Use when starting experiments on an isolated bench, landing into lab, writing plain-English Move to core cases, checking project status, or working with Hopper cards.
---

# The Foundry Skill

**Core rule: nothing moves up just because someone saved.**

Every piece of work moves deliberately so active experiments never break daily apps that already work:

1. **Read live context first:**
   `node "{{FOUNDRY_CLI}}" context`
2. **Start new work on an isolated bench (`lab/_trials/<name>`):**
   `node "{{FOUNDRY_CLI}}" trial start <bench-name> --builds <project> --by <your-name>`
   Save commits on the bench signed with your own name: `git -c user.name=<your-name> commit -m "plain English summary"`.
3. **Land in `lab/` on your person's word (and preview before Core):**
   `node "{{FOUNDRY_CLI}}" trial land <bench-name> --by <your-name>`
   Need to undo the last landing? `node "{{FOUNDRY_CLI}}" lab back <project> --by <your-name>`.
4. **Make a plain-English case for Core (never edit `core/` or `state/` by hand):**
   `node "{{FOUNDRY_CLI}}" propose <project> --why "what it fixes and why" --lived "how it was tested on real screens" --restarts "what restarts" --by <your-name>`
   Moving to `core/` is always your person's click on the Foundry board.
5. **Hopper On Deck studio:**
   - Queue a raw spark: `node "{{FOUNDRY_CLI}}" hopper add "the idea" --hint explore --by <your-name>`
   - Put playable options On Deck with Check-In chips:
     `node "{{FOUNDRY_CLI}}" hopper bench <id> --slot 1 --bet "..." --weakest "..." --live "http://127.0.0.1:<port>/" --options "Option A=/?concept=a||Option B=/?concept=b" --questions "Which felt better?::Option A|Option B" --by <your-name>`
