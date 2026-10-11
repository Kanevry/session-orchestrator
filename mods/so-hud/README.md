# so-hud 0.1.0

A native, read-only Session Orchestrator display for Claude Code (package A, #1508): a status line for the running session, a warning band when something needs attention, and one beacon file per session that other sessions can read through `$.so.beacons()`. The status line shows how many peer sessions are running (from the session registry).

## Requirements

- Claude Code with mod support; tested with **2.1.296**. Claude Code only — Codex, Cursor and Pi do not load this mod.
- **Node.js 24** or later.
- **Session Orchestrator** from the release that ships this mod or later, as the plugin or as a checkout set through `soRoot`: the mod reads all state through its `scripts/so-hud.mjs`, which earlier releases do not have.

## Install

```text
/plugin marketplace add Kanevry/session-orchestrator
/plugin install so-hud@kanevry
```

The mod finds the Session Orchestrator installation in this order: the `soRoot` setting (an absolute path), then the path cached from an earlier lookup, then a root registered with `node scripts/so-hud.mjs --register-root` inside that installation, then `claude plugin list --json`. The first hit is cached, so after a move only `soRoot` replaces it. None of these install actions is run by the development tests. For a local checkout you can also load this directory directly with `claude --plugin-dir ./mods/so-hud`.

Settings: `strictness` is `locker` (relaxed), `ausgewogen` (balanced, the default) or `streng` (strict); it is shown in the status line and returned by `$.so.profile()`, and does not change the warnings yet. `soRoot` is optional.

## What it does

Session Orchestrator state comes only from `scripts/so-hud.mjs`, called as `--json --repo-root <cwd>` every 15 seconds with a 3-second timeout. STATE.md, locks, dispatch and events are never changed. The mod writes only its own beacon file and its install-path cache.

`$.so.version()` is 1; `snapshot()` and `beacons()` are asynchronous engine calls (`await`); `profile()` returns `locker`, `ausgewogen` or `streng`. A cold snapshot is `null`; an old one keeps its measurement time and carries `age_ms`; after a failed refresh it is kept and marked `degraded`.

**Language:** the status texts are German. An English text table is prepared but not selectable yet, because JSON v1 has no field for the owner's language.

Beacons: the `$.fs` API of this Claude Code build offers no rename, chmod or unlink, so `hooks/beacon-io.mjs` is called through `$.process.run` with argv and JSON on stdin: temporary file plus rename, mode 0600, beacon directory 0700, at most 4 KB. The helper's parent PID stands for the starting engine process; that mapping still has to be confirmed in a real engine host. Foreign beacons are validated; one older than 120 seconds whose PID cannot be shown to be alive becomes state unknown. `tool.check: ask` means handing the decision on (also in auto mode), not proof that a dialog was shown. The mod never changes a tool decision.

## Limits

- A status without a session or wave binding is not attributed to the current wave.
- Dispatch records do not always carry agent type or model; those fields stay null.
- Peer scope is unknown when either scope source is missing or the scope signals have gaps.
- Events are read only from the last 512 KB, reported as `events:tail-only`. There is no complete history.

## Checks

`npx vitest --run tests/so-hud` in the Session Orchestrator repo (CI job `test`). The CI job `mods:plugin` runs `claude plugin validate --strict --json` and `claude plugin test` for every mod. Engine integration separately with `claude plugin test mods/so-hud`; under Claude Code 2.1.296 the kit tests pass. `tsconfig.json` follows the header of the type file; the engine creates `.claude-plugin/types` when it loads the mod. No rollout, no gates, no commands from later packages and no second Session Orchestrator state.
