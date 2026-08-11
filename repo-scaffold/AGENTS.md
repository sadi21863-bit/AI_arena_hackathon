# AGENTS.md — build conventions

Standing rules for every build turn. The turn's task prompt tells you what
to work on; this file is the rules that hold every turn regardless of the
task. Read it before writing anything.

## This repo starts scaffolded — build into it

The arena seeded a working structure before your first turn:

- `README.md` — the idea brief: what you're building and why
- `BACKLOG.md` — the task list you work from (check items off as you go)
- `AGENTS.md` — this file
- `.gitignore`, `.env.example` — repo hygiene
- `.github/workflows/ci.yml` — the product's own CI, runs on every push

The structure already exists. Read existing code before writing new code;
extend what's there instead of recreating it.

## Rules

1. **Keep the build green.** `.github/workflows/ci.yml` fails loudly on any
   push that breaks the build, and the arena's verify step fails the turn if
   the tests fail. A turn that leaves the build red is not done.
2. **Every turn adds or extends at least one test.** Tests are how the
   arena judges your work; a turn with zero test changes is a weak turn.
   Run the tests before finishing so the turn ends green.
3. **Read `VERIFICATION_FAILURE.log` and `VERIFICATION_NOTE.log` at the
   repo root if they exist.** The arena's verify step writes them when a
   turn fails to build/test or ships without tests; the file is committed
   so the NEXT turn must fix what it describes. A note about missing tests
   is a standing debt — repay it by adding a test suite and a test script.
4. **Update BACKLOG.md every turn.** Move finished items to "Done", move
   the item you're working on to "In Progress", and add follow-up items to
   "Todo" as you discover them. The next turn works from your notes.
5. **Commit small, focused changes** with messages that say what changed
   and why — one logical change per commit.
6. **Don't restate the brief — build it.** Write code and files; don't
   write plans about the code.
7. **Never commit real secrets.** Copy `.env.example` to `.env` for local
   values; keep real credentials out of the repository.
8. **Don't touch the arena harness.** `.github/workflows/team-build-turn.yml`,
   `docker/Dockerfile.arena-team-base`, `docker/opencode.json`, and
   `scripts/workers_ai_shim.js` are the arena's plumbing — they're re-synced
   before every turn, so edits get overwritten anyway. `.github/workflows/ci.yml`
   is yours; that one is the product's gate and you may extend it.
9. **Verify the UI in a real browser when the product has one.** The turn
   image ships a headless browser (Playwright tools: `browser_navigate`,
   `browser_snapshot`, `browser_click`, ...). Start the app, exercise the
   primary flow, fix what you find, screenshot to `/tmp/playwright-artifacts`,
   and stop the server before finishing. See the `ui-verify` skill.
10. **Check `.arena/skills/` before starting work.** If the directory exists,
    it holds agent-authored skills from earlier turns that apply to this
    project — read them before writing anything. To author a new one, see the
    `skill-creator` skill; skills committed there persist for all future turns.
