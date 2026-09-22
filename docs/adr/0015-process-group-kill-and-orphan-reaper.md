# ADR 0015: Kill the process GROUP, and reap what escapes from two hooks — no daemon

> Status: Accepted · 2026-09-22 · session main-2026-09-21-session-4 · Epic #1425 (issues #1426–#1433)
> Authoritative implementation: [`scripts/lib/process-group.mjs`](../../scripts/lib/process-group.mjs) (`spawnInGroup`, `killProcessGroup`, `verifyProcessIdentity`) and [`scripts/lib/orphan-reaper.mjs`](../../scripts/lib/orphan-reaper.mjs) (`decideReapCandidates`, `runOrphanScan`)
> Source PRD: [`docs/prd/2026-09-20-prozessgruppen-kill-und-waisen-waechter.md`](../prd/2026-09-20-prozessgruppen-kill-und-waisen-waechter.md)
> Project-instruction file resolution: this repo's root context file is `CLAUDE.md` on Claude Code / Cursor IDE and `AGENTS.md` on Codex CLI — transparent aliases per [skills/_shared/instruction-file-resolution.md](../../skills/_shared/instruction-file-resolution.md).

## Context

The quality gate spawned its commands with `spawn(cmd, { shell: true })`, which makes the SHELL the child process. `child.kill()` therefore signalled that shell only: its own children — `tsgo --noEmit`, vitest workers — were reparented to PID 1 and kept running. On 2026-09-20 that produced four orphaned `tsgo` processes on this host, two of them at PPID 1, burning 86–588 % CPU and up to 8.0 GB RSS each, with the machine at 13 % free memory and a load average of 67.4.

Two facts made the incident invisible to everything already installed:

- **The existing detector could not see it.** `countZombieProcesses()` (`scripts/lib/resource-probe/parsers.mjs`) would have counted ZERO: its `ps` invocation publishes neither `ppid` nor `rss`, its name filter knows only `claude`/`node`, and it defines a zombie as IDLE (`cpu <= 1.0`) — the exact opposite of a runaway.
- **Gate path B had no ceiling at all.** `scripts/run-quality-gate.mjs` → `scripts/lib/gates/gate-*.mjs` ran unbounded, so a hung command was bounded only by operator patience.

The ad-hoc cleanup that day added a third lesson: the hand-written liveness check reported "still alive" after a successful `kill -9`, because it measured immediately after sending the signal. A sent signal is not an effect — only a re-measurement after a wait is.

## Decision

**Three mechanisms, all host-local, none of them a resident service.**

1. **Kill the GROUP, not the shell.** `spawnInGroup()` spawns with `detached: true`, which makes the shell a process-group LEADER (`child.pid === pgid`, `setsid`), so `process.kill(-pgid, sig)` reaches every descendant that did not `setsid` away. The kill is a ladder — SIGTERM → grace → SIGKILL, the grace being `DEFAULT_KILL_GRACE_MS` re-exported from `wave-executor/dispatch-common.mjs` rather than re-invented. The ladder is required, not defensive: a grandchild installing `trap "" TERM` survives the group SIGTERM and only dies on the group SIGKILL (measured on this host, Darwin 25.6.0, 2026-09-21). Both gate paths use it — path A (`scripts/lib/quality-gate.mjs`, #1427) and the previously uncapped path B (#1428), which now carries a 900 000 ms ceiling and reports exit 124 on expiry.

2. **A host-local ancestry register, not a heuristic.** Every gate process this repo starts itself is recorded with pid, pgid, start time and command signature in `.orchestrator/runtime/gate-processes.jsonl` (#1425 A4). That file — not a name match, not a CPU threshold — is what makes a later process attributable to us.

3. **Fire-and-forget reaping from two hooks that already fire.** `hooks/post-tool-batch-wave-signal.mjs` (PostToolBatch, the only hook with measurably high frequency *during* a wave) and `hooks/on-stop.mjs` (Stop + SubagentStop, which lands exactly when gate children have just finished) each do one config read plus one `stat` of the shared throttle marker `.orchestrator/tmp/reaper-last-scan`, then hand the scan to a detached, `unref()`-ed child (#1432 B4).

**The orphan condition is a CONJUNCTION**, evaluated in `decideReapCandidates()` — a pure function with no I/O and no signal, testable from `ps` text fixtures: (1) the pid is in this host's own ancestry register, (2) `ppid == 1`, (3) age above `reaper.min-age-seconds`, (4) the command signature is read-only, (5) an identity re-check passes **immediately before every signal** — before SIGTERM and again before SIGKILL, so a recycled pgid aborts the ladder instead of being signalled (#1431). Effect is read back after `verify-wait-ms`; `survived_sigkill` is never booked as success (#1433, PRD B6).

**Arming is gated on calibration, not on confidence.** Stufe 1 ships `reaper.enabled: false` and `reaper.mode: report` (an unrecognised mode falls back to `report`, never to `kill`). Every decision, including a withdrawn one, is appended to `.orchestrator/metrics/reaper-audit.jsonl`; `falseAlarmRate()` judges the instrument over a rolling window of `reaper.false-alarm-window` DECISIONS (not calendar time, so quiet hosts still have a population) and reports `instrument_suspect` above the 10 % ceiling without acting on it. `mode: kill` is Stufe 2 and requires the C1 calibration dataset first. `.claude/rules/host-resources.md` HR-101 and HR-105 own that ordering; HR-107 (added in the same change) states the orphan condition itself as a rule.

## Rejected Alternative: A resident watchdog (daemon / `launchd` agent)

A long-running supervisor is the textbook answer and was rejected on this repo's own terms. It is a second lifecycle to install, start, update and debug on every host — including hosts where the plugin is merely `npm`-installed — and it observes processes it did not start, which puts it on the wrong side of the ancestry register: a daemon's authority to kill would have to come from a heuristic rather than from "I started this". The hook route needs no installation, runs only while the harness runs (exactly the window in which gate children exist), and inherits the harness's own kill switches. The cost is honest and named under Consequences: no reaping happens while no session runs.

## Rejected Alternative: `execa` / `tree-kill` instead of hand-rolled group handling

Rejected per `.claude/rules/build-value.md` BV-001.3/BV-001.5 — a new runtime dependency for what `node:child_process` already does. `detached: true` plus `process.kill(-pgid)` is the whole mechanism; the parts that actually needed writing (the identity gate before each signal, the ancestry register, the byte cap) are precisely the parts no such library ships, because they are specific to this repo's ledger and trust model.

## Rejected Alternative: PPID 1 as the orphan criterion

Rejected on measurement, 2026-09-21: **538 of 784 processes on this host (68.6 %) have PPID 1** — on macOS `launchd` is the parent of nearly everything. A reaper keyed on PPID 1 alone is a weapon pointed at the operating system, and the ~10 % firing-rate ceiling of HR-101 rules it out by an order of magnitude before any ethics argument is needed. PPID 1 stays in the conjunction as one necessary term.

## Consequences

- **`detached: true` removes the child from the terminal's signal group**, so Ctrl-C no longer reaches it via the terminal. `installExitHandler()` exists for exactly that: it kills the live groups when the parent exits, because a detached child otherwise survives its parent at PPID 1.
- **`maxBuffer` does not exist on async `spawn`** (22 MB ran through unbounded in the measurement). The byte cap is hand-rolled to reproduce the `spawnSync`/ENOBUFS contract the existing gate tests pin, so the migration did not change the gate's exit-code semantics.
- **`close` fires only once every group member has closed the shared pipe**, so one surviving grandchild would hang the promise. Hence the hard deadline rather than waiting on `close` alone.
- **One `ps` round-trip out of Node costs ~47 ms**, alone over the 50 ms `reaper.max-hook-latency-ms` budget — which is why the hooks spawn detached instead of scanning inline (steady-state hook latency with the trigger in place: 0.15 ms).
- **Nothing is reaped while no session runs.** The daemon's one genuine advantage is the cost accepted here. An orphan created by a hard crash survives until the next PostToolBatch or Stop in any session in that working copy.
- **The trigger is duplicated in two hook files on purpose.** A shared `hooks/_lib/reaper-trigger.mjs` would be a third file in the import set both hooks already declare. Revisit trigger (BV-004): a third trigger site, or any divergence between the two copies, promotes the duplication to a shared module.
- **Stufe 1 joins the ledger by `pid` only**, because the binding `ps` format publishes no `pgid` column. Revisit trigger: a `ps` format that carries `pgid`, or the first audit record whose rejection reason is a pid/pgid mismatch.

**No collision with ADR-0011 or ADR-0006.** Reviewed in the same wave: the reaper trigger is purely observational inside the hook — it decides nothing about the tool call, blocks nothing, and returns no verdict — so it neither participates in the guard-degradation semantics of ADR-0011 nor in the prompt-hook `continueOnBlock` contract of ADR-0006.

## Open Question

**Does `reaper.enabled` belong in the kill-switch list?** It is the only guard in this repo that can send a signal to a process, and the kill-switch inventory (`SO_DISABLED_HOOKS`, the autopilot switches) is the place an operator looks to disarm things in a hurry. Against: `enabled: false` is already the default and the switch is per-repo committed config, so it is not the same kind of object as an env-var escape hatch. Unresolved — decide when the first repo arms `mode: kill`.

## References

- Epic #1425 — Prozessgruppen-Kill und Waisen-Wächter (issues #1426–#1433)
- PRD [`docs/prd/2026-09-20-prozessgruppen-kill-und-waisen-waechter.md`](../prd/2026-09-20-prozessgruppen-kill-und-waisen-waechter.md) — Stufe 1 / Stufe 2 split, parameter table, acceptance criteria
- `.claude/rules/host-resources.md` § HR-107 (the orphan condition as a rule), § HR-101 (firing-rate ceiling), § HR-104 (report-never-count), § HR-105 (a rule you cannot falsify), § HR-106 (the banner reports what the rule judged)
- `docs/events-schema.md` § `orchestrator.reaper.scan_completed`
- `docs/session-config-reference.md` § `reaper:` and § `gate:`
- [ADR 0011 — Guard degradation semantics](0011-guard-degradation-semantics.md) and [ADR 0006 — Prompt-hook `continueOnBlock`](0006-prompt-hook-continueonblock.md) — checked for overlap, none found (see Consequences)
