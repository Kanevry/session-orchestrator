# Migrating to Session Orchestrator v4.0.0

v4.0.0 removes public surfaces. Nothing about the core loop changes — `/session`, `/go`,
`/close`, `/plan`, `/discovery`, `/evolve`, `/bootstrap` and the rest of the 25 commands
behave exactly as in 3.x — but five skills, three commands and eight top-level scripts are
gone, two files leave `agents/`, and two telemetry names are deprecated on a dated clock.
This guide is for someone running 3.x today: which invocations break, what replaces them,
what happens to your state, and how to go back.

The removals follow a two-signal rule measured over a 90-day window — **0 telemetry ∧ 0
fleet invocation ∧ no runtime consumer** — not a judgement call. Evidence:
[`docs/audits/2026-09-06-360-audit.md`](./audits/2026-09-06-360-audit.md), per-agent raw
reports under [`audits/2026-09-06-360-audit/w1/`](./audits/2026-09-06-360-audit/w1/). Full
change list: [CHANGELOG.md](../CHANGELOG.md).

## 1. What Changes

| Area | 3.x | 4.0.0 |
|------|-----|-------|
| Skills (`SKILL.md` files) | 49 | 43 — 5 removed, 1 merged into `architecture` |
| Commands | 28 | 25 — `/contract-version-bump`, `/journey-audit`, `/autopilot-multi` removed |
| Top-level scripts | 8 more than today | 8 removed (0 runtime callers each) |
| `agents/*.md` | 16 (2 of them not agents) | 14 — the two non-agents moved to `docs/` |
| `.claude/rules/` | 61 files (43 generated) | 26 files (43 generated → 8 thematic) |
| Turn-stop event | `orchestrator.session.stopped` | `orchestrator.turn.stopped` (both emitted until 2027-03-06) |
| Telemetry field | `fleet` | `fleet_self_declared` (both sent until 2027-03-06) |
| Cross-harness manifest | none | root `AGENTS.md` + root `plugin.json` + `.agents/skills/` |
| Session shapes | `housekeeping` / `feature` / `deep` | unchanged, plus the `ultradeep` PROFILE over `deep` |
| Runtime | Node 24+, npm | unchanged |

### 1a. Invocations that break

| You invoke | Status in 4.0.0 | What to do instead |
|---|---|---|
| `/contract-version-bump` | **removed** | No replacement. Bump the contract's version literal by hand and note it in your CHANGELOG. |
| `/journey-audit` | **removed** | No replacement. It required a journey manifest; zero existed fleet-wide, so it was never runnable. |
| `/autopilot-multi` | **removed** | No replacement. `/autopilot` (single-story) is unaffected and stays. |
| the `daily` skill | **removed** | No replacement. A recurring daily note is a scheduled task / cloud Routine, not a session skill — see `.claude/rules/loop-and-monitor.md` § LM-004. |
| the `skill-creator` skill | **removed** | Anthropic's official `skill-creator` plugin, or `claude plugin init`. |
| the `ubiquitous-language` skill | **removed** | No replacement. |
| the `domain-model` skill | **merged** | `/architecture` — the material now lives at `skills/architecture/references/domain-model.md` (with `ADR-FORMAT.md` and `CONTEXT-FORMAT.md` beside it). |
| `node scripts/autopilot-multi.mjs` | **removed** | No replacement. | <!-- path-check: historical -->
| `node scripts/backfill-learnings.mjs`, `…-expires.mjs` | **removed** | No replacement — one-shot ledger repairs, already applied. | <!-- path-check: historical -->
| `node scripts/migrate-learnings-jsonl.mjs`, `migrate-subagents-jsonl.mjs` | **removed** | No replacement — one-shot format migrations; the target format has been canonical for several releases. | <!-- path-check: historical -->
| `node scripts/fleet-instruction-scan.mjs`, `lifecycle-sim-v6.mjs`, `upload-social-preview.mjs` | **removed** | No replacement. | <!-- path-check: historical -->
| dispatching `AGENTS.md` as an agent | **removed as a dispatch target** | It was never an agent — it is the authoring spec, now [`docs/agent-authoring.md`](./agent-authoring.md). Read it; do not dispatch it. |
| dispatching `memory-proposal-collector` as an agent | **removed as a dispatch target** | Now [`docs/memory-proposal-flow.md`](./memory-proposal-flow.md). |
| citing `skills/_shared/model-selection.md` | **removed** | No replacement; it had zero consumers. |

### 1b. Telemetry consumers (dated deprecations, nothing breaks yet)

If you read `.orchestrator/metrics/events.jsonl` or the ingest server, two names change and
**both old and new are emitted for one generation**, so no reader breaks on upgrade day:

- **`orchestrator.session.stopped` → `orchestrator.turn.stopped`.** The emitter always fired
  per assistant TURN, not per session — measured 15,538 records against 2,016 distinct
  `orchestrator.session.started` ids over 90 days, i.e. 7.7 per session, 184 for one id. Any
  "sessions stopped" count you derived from it is a **turn count**, wrong by that factor. Both
  names carry an identical payload from the same object, so they cannot disagree; every record
  under the legacy name additionally carries `deprecated: true`. **Switch the name you match
  on and change nothing else. Removal of the legacy name: 2027-03-06.** To count sessions,
  count `session.started` ids; to count closes, count `sessions.jsonl` records with
  `status: completed`. Unaffected: `orchestrator.agent.stopped`, whose per-agent cardinality
  was always correct.
- **`fleet` → `fleet_self_declared`.** The old name claimed something the client cannot know.
  The new name says what it is, and the authoritative classification is now server-side (an
  anon-id allowlist). `fleet` keeps being sent with an identical value for the whole
  generation so an existing column stays comparable. **Removal: 2027-03-06.** Contract:
  [`docs/telemetry.md`](./telemetry.md).

## 2. Prerequisites

- **Node.js 24 or later** — unchanged from v3. `node --version`.
- **Git** — any recent version.
- **`npm install` after updating.** Still mandatory, and now slightly less punishing: in 3.x,
  4 of 27 hooks died at module-load with `ERR_MODULE_NOT_FOUND: js-yaml` when `node_modules`
  was absent. In 4.0.0 all 27 hooks exit 0 without `node_modules` — but they run degraded, so
  install anyway.
- **`glab` / `gh`** — optional, unchanged.

Nothing new is required. There is no data migration, no schema bump, and no config key you
must add.

## 3. Upgrade Steps

### 3a. Claude Code

```bash
# 1. Update the plugin — run this INSIDE Claude Code, not in a shell:
#      /plugin update session-orchestrator@kanevry
#    A marketplace-installed plugin lives in a managed cache, not a git checkout,
#    so `git pull` does not apply to it.

# 2. Install Node dependencies in the cache copy:
SO_DIR="$(dirname "$(find ~/.claude/plugins/cache -path '*session-orchestrator*' -name package.json 2>/dev/null | head -1)")"
cd "$SO_DIR" && npm install

# 3. Restart Claude Code so hooks.json is re-read.
```

From 4.0.0 on, session-start compares the version that is **running** against the npm
`dist-tags.latest` and prints a one-line banner when they differ. It fails silent: offline, a
non-2xx response, malformed JSON or a timeout each produce no statement — never a false "you
are up to date".

### 3b. Codex CLI

```bash
codex plugin marketplace upgrade kanevry   # omit the name to refresh all marketplaces
codex plugin add session-orchestrator@kanevry
codex plugin list --available --json
```

For the maintainer / local-clone path instead:

```bash
cd ~/Projects/session-orchestrator
git pull && npm install
node scripts/codex-install.mjs
```

New in 4.0.0 and relevant here: this repository now ships a **root `AGENTS.md`**
(byte-identical to `CLAUDE.md`). Before, a Codex-family harness resolving project
instructions from `AGENTS.md` found nothing in this repo. If you keep your own
`AGENTS.md`, nothing changes for you.

### 3c. Cursor IDE

```bash
cd ~/Projects/session-orchestrator
git pull && npm install
node scripts/cursor-install.mjs /path/to/your-project    # re-syncs commands, rules, hooks
# Restart Cursor
```

**Re-running the installer is required, not optional, on this upgrade.** The 3.x generator
wrote a malformed `argument-hint` into 24 of 28 command files (GH#54); the fix is in the
generator, so your project's `.cursor/commands/` only picks it up when regenerated. The three
removed commands disappear from `.cursor/commands/` in the same pass.

A root `plugin.json` following the [agent-plugins.org](https://agent-plugins.org) 1.0.0
schema now ships as well, for Cursor's plugin system.

### 3d. Pi

```bash
pi install npm:session-orchestrator
```

Or against a local checkout:

```bash
cd ~/Projects/session-orchestrator
git pull && npm install
node scripts/pi-install.mjs /path/to/your-project --settings-only
```

`pi/prompts/` drops from 28 to 25 files, matching `commands/`.

### 3e. Verify

Run `/session housekeeping` in any configured repo. You should see the session-start banner;
`/contract-version-bump`, `/journey-audit` and `/autopilot-multi` should no longer be offered.
Then:

```bash
node scripts/parse-config.mjs --json     # now works — in 3.x this failed with "File not found: --json"
node scripts/validate-plugin.mjs
```

## 4. What Stays the Same

**Your state is untouched. There is no migration step and no format change.**

- **`.orchestrator/` in every repo** — `metrics/sessions.jsonl`, `metrics/learnings.jsonl`,
  `metrics/events.jsonl`, `current-session.json`, `session.lock`, `state.lock`, filescopes and
  wave-scope manifests are all read-write compatible in both directions. Nothing is rewritten
  on upgrade, and nothing 4.0.0 writes is unreadable by 3.24.0.
- **`STATE.md`** — same frontmatter schema. 4.0.0 adds ONE optional scalar,
  `session-profile`, and absent is not empty: a STATE.md without it behaves exactly as before.
  A 3.x build reading a 4.0.0 STATE.md simply ignores the extra key.
- **Session Config in `CLAUDE.md` / `AGENTS.md` / Cursor rules** — no key is removed, renamed
  or given a new default. If you configured this plugin in 3.x, that block is still correct.
- **Session memory** (`~/.claude/projects/<project>/memory/`) — untouched.
- **`session-type`** — still the closed set `housekeeping` / `feature` / `deep`. `ultradeep`
  is an argument ALIAS that resolves to `session-type: deep` plus
  `session-profile: ultradeep`; it is deliberately not a fourth type, because a fourth member
  would degrade silently in the telemetry mapper and the close-backfiller.
- **The whole core loop** — `/session`, `/go`, `/close`, `/plan`, `/discovery`, `/evolve`,
  `/bootstrap`, `/debug`, `/autopilot` and the other remaining commands take the same
  arguments and run the same flow.
- **VCS integration** — `glab` / `gh` commands, label taxonomy, issue and MR templates.

## 5. Known Issues & Workarounds

### Your CLAUDE.md cites a removed skill

**Nothing breaks at runtime.** A citation in a consumer repo's `CLAUDE.md` (or `AGENTS.md`) to
`daily`, `skill-creator`, `ubiquitous-language`, `contract-version-bump`, `journey-audit`,
`domain-model` or `skills/_shared/model-selection.md` is prose. No loader resolves it, no hook
reads it, and the session starts normally.

**But `claude-md-drift-check` may flag it** as a dangling citation, and if you run it with
`enforcement: strict` that finding is an error rather than a warning. Two ways out, both fine:

1. Delete or rewrite the citation. `domain-model` becomes
   `skills/architecture/references/domain-model.md`; the other five have no successor, so the
   sentence usually goes away with the skill.
2. Leave it and accept the warning until your next docs pass. It is a documentation-parity
   finding, not a functional one.

Same story for a rule file or ADR that names one of the removed scripts.

### A wrapper script or Routine calls a removed top-level script

`node scripts/<name>.mjs` on any of the eight removed scripts now exits with a Node
`ERR_MODULE_NOT_FOUND`-class failure — a loud error, not a silent no-op. If a cron job,
Routine or CI step calls one, delete that step: the two `migrate-*` scripts had already
completed their one-shot migration, and the two `backfill-learnings*` scripts their one-shot
repair, before this release.

### A dashboard suddenly reports far fewer "sessions stopped"

Expected, and it was wrong before, not now. See § 1b — you were counting turns. Match on
`orchestrator.turn.stopped`, or better, count `session.started` ids for sessions and
`sessions.jsonl` records with `status: completed` for closes.

### `npm install` fails with `ERESOLVE` or peer-dep warnings

Use Node 24 or later, matching `engines.node: ">=24.0.0"`. If it persists:
`npm install --legacy-peer-deps`.

### Hooks silently no-op after the update

Node must be on `PATH` inside the **editor** process, not only in your terminal. Verify from
inside Claude Code with `!node --version`. This is unchanged from v3.

### Cursor still shows the removed commands

Re-run `node scripts/cursor-install.mjs /path/to/your-project` and restart Cursor. The
installer writes into your project; a plugin update alone does not touch it.

## 6. Rollback

4.0.0 removes surfaces; it does not migrate data. **Rolling back is therefore a plain version
switch — no state has to be converted, and nothing you wrote under 4.0.0 becomes unreadable.**

**Claude Code / plugin cache.** A marketplace install tracks the marketplace's current
version; this repo documents no version-pin flag for `/plugin install`, so do not guess one.
Roll back by pointing Claude Code at a local clone parked on the old tag:

```bash
git clone https://github.com/Kanevry/session-orchestrator ~/so-3.24.0
cd ~/so-3.24.0 && git checkout v3.24.0 && npm install
```

Then, inside Claude Code, remove the marketplace-installed copy and add the clone as the
plugin source (`/plugin marketplace add ~/so-3.24.0`, then install from it) and restart the
editor. If you are unsure of the exact `/plugin` subcommands on your build, run `/plugin`
with no arguments — it lists them.

**Local checkout (Codex / Cursor / Pi / maintainer):**

```bash
cd /path/to/session-orchestrator
git fetch --tags
git checkout v3.24.0
npm install                       # the 3.24.0 lockfile, not the 4.0.0 one
node scripts/codex-install.mjs    # or cursor-install.mjs / pi-install.mjs, per platform
# Restart your editor
```

**npm consumers:** `npm install session-orchestrator@3.24.0`.

What you get back, and what you do not:

- **Your state survives in both directions.** `sessions.jsonl`, `learnings.jsonl`,
  `events.jsonl` and `STATE.md` written by 4.0.0 are readable by 3.24.0. The one 4.0.0
  addition to STATE.md, `session-profile`, is an unknown key to 3.24.0 and is ignored, not
  rejected.
- **`orchestrator.turn.stopped` records written under 4.0.0 stay in your `events.jsonl` after
  a rollback.** 3.24.0 does not know the name and will not count them; the
  `orchestrator.session.stopped` twin of every one of those records is right beside it, so no
  data is lost — only a 3.x reader sees each turn once instead of twice.
- **The removed skills, commands and scripts come back with the checkout.** They were deleted
  from the repository, not from your disk history.
- **What does NOT roll back automatically** is anything an installer wrote into YOUR project:
  `.cursor/commands/`, `.cursor/hooks.json`, Pi settings. Re-run the platform installer from
  the 3.24.0 checkout, as shown above.

If 4.0.0 blocks you, please open an issue describing the blocker before rolling back — a
removal we got wrong is fixable in a 4.0.x patch.

## 7. Support

- **GitHub:** [Kanevry/session-orchestrator/issues](https://github.com/Kanevry/session-orchestrator/issues)
  — preferred for bugs and feature requests.
- **Homepage:** [session-orchestrator.com](https://session-orchestrator.com)

When filing a bug, include `node --version`, your OS and arch, the harness (Claude Code /
Codex CLI / Cursor / Pi), the plugin version actually running (the session-start banner prints
it), and a minimal reproduction. For hook failures, attach the relevant entries from
`.orchestrator/metrics/events.jsonl`.
