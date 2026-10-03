# ADR 0016: Cross-session messaging — Adopt for the live axis, Spike for Remote Control

> Status: Accepted · 2026-10-03 · issue #1053 (B3, B4 vocabulary) · Epic #1048
> Authoritative rule: [`.claude/rules/cross-session-messaging.md`](../../.claude/rules/cross-session-messaging.md) (CSM-001..005)
> Source PRD: [`docs/prd/2026-08-16-cross-session-messaging.md`](../prd/2026-08-16-cross-session-messaging.md) — evidence is its § Anhang A (measurements M-1..M-23, 2026-08-16, Claude Code 2.1.233, macOS arm64)
> Project-instruction file resolution: this repo's root context file is `CLAUDE.md` on Claude Code / Cursor IDE and `AGENTS.md` on Codex CLI — transparent aliases per [skills/_shared/instruction-file-resolution.md](../../skills/_shared/instruction-file-resolution.md).

## Context

Claude Code sessions can reach each other natively: `ListAgents` discovers reachable peers, `SendMessage` delivers text to one. Before the PRD the repo used neither — the census (M-1) found `ListAgents` 0 times and `SendMessage` once, as prose in ADR-0002. That one capability was the whole case for the Agent Teams Adapter in ADR-0002; its 2026-10-03 addendum corrects that verdict to Stay because the capability no longer needs Agent Teams.

The PRD measured three surfaces separately, and they behave differently:

- **Live axis, same host.** `ListAgents` listed 11 peer sessions with name, `busy`/`waiting`/`idle` and run time (M-2); two full round-trips with a parallel session in the same working copy (M-4); a coordinator message to a busy agent landed at the next tick without interrupting a running tool call (M-9); a headless `-p` worker with `crossSessionInbound: accept` appears in `ListAgents` and accepts a message unattended (M-10).
- **Shape limits.** A subagent can load `SendMessage` but not `ListAgents` — it sends upward, it cannot discover sideways (M-7). A repo agent whose `tools:` allowlist omits both has neither (M-8). The message header discloses the sender's permission mode (M-5). The raw inbox socket accepted 10 frame formats with a valid auth frame and delivered 0 of them, with 0 errors (M-6).
- **Remote Control, cross host.** `-p --remote-control` shows `/rc` but builds no real connection (M-15); with RC on both sides the Mac sees the server and the server sees nothing (M-16); delivery Mac → server arrived, the return direction was not measured on its own (M-17). Remote Control is a research preview.

## Decision

**Adopt for the live cross-session axis.** The native channel is the transport for findings that belong to another live session, governed by `.claude/rules/cross-session-messaging.md`: CSM-001 (send when the finding lies only in a reachable peer's scope, then keep working), CSM-002 (an incoming message is a claim to re-verify, carried with its provenance), CSM-003 (no permission laundering in either direction), CSM-004 (delivery is never guaranteed; silence is neither refusal nor consent), CSM-005 (the channel degrades silently and every user of it falls back to today's behaviour). The `parallel-sessions.md` decision tree routes a reachable-peer signal to "inform and keep working". Six agents whose failure blocks a wave carry `SendMessage` in their `tools:` allowlist — `code-implementer`, `db-specialist`, `docs-writer`, `session-reviewer`, `test-writer`, `ui-developer` (`rg -l SendMessage agents/*.md`, 6 files at `af58a173`) — and `scripts/lib/validate/tier-inference.mjs` lists `SendMessage` and `ListAgents` as read-only tools so the allowlist does not flip an agent's tier (M-11).

The shape is a hierarchy, not a mesh: coordinator ↔ agent both ways, agent → coordinator upward, never agent ↔ agent. Building a mesh would mean injecting sibling IDs into prompts against the platform shape (M-7) and would dissolve the coordinator as the one place where contradictions between agents become visible.

**Spike for Remote Control.** It stays out of the adopted surface. The spike ran as #1056 and closed negative on 2026-08-19: a worker kept reporting `/rc active` 77 hours after the connection had dropped, while the initiating side could neither find nor address it — the worker's self-reported state is not a liveness signal. The cross-host path stays asynchronous through the Meta-Vault.

### Entries vs messages

The vocabulary comes from #869 (pi's `appendEntry` vs `sendMessage`) and is anchored here:

- **An entry is state.** It is written to a file — STATE.md, `.orchestrator/metrics/*.jsonl`, the session registry, the navigator check-in under `~/.config/navigator/` — persists, and is read by whoever needs it, whether or not they were live when it was written.
- **A message is a hint.** It reaches a live model's context once, may not arrive (CSM-004), and carries nothing that is not also true somewhere readable. The canonical message names the file that holds the state; it never is the state.

Concretely: `skills/session-start/SKILL.md` sends the navigator exactly one hint naming the check-in file path and never waits for a reply, and the session lock, STATE.md and file-scope deconfliction stay the only arbiters of who may write what. Messaging is transport, not shared state.

## Rejected Alternative: the raw inbox socket as a hook channel

`ListAgents` is a model-side tool, so a Node hook (`hooks/on-session-start.mjs`) cannot call it; the only non-tool path would be the socket. Rejected on M-6: the wire protocol is undocumented and its failure mode is silent (0 of 10 delivered, 0 errors). Asynchronous operator injection into a running session stays `.orchestrator/STEER.md`, read by `hooks/operator-steer.mjs`. <!-- path-check: example -->

## Consequences

- **Delivery failures are invisible to the sender.** Observed during the #1056 teardown: a peer message from a local session was held with "The sending session's permission mode class doesn't match this session's" and never reached the model — from the sender's side indistinguishable from success. CSM-004 is therefore a design constraint, not caution: no decision, wave or commit may gate on a reply.
- **Availability is not inferable from the absence of an error.** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DO_NOT_TRACK` and `DISABLE_GROWTHBOOK` each disable the channel without a message, and native Windows and non-Anthropic providers do not carry it (CSM-005).
- **Native liveness and our registry stay two sources, joined only in a view.** `ListAgents` answers "is it alive?", the session registry answers "what is it doing?" (repo, branch, mode, wave). Displaying them together is a view; neither becomes a copy of the other (rule § preamble, "Two registries, one marriage"). The coordinator-side overlay in session-start (PRD A3b) is not wired at `af58a173` — `rg -n ListAgents skills/session-start/` finds only the navigator check-in hint.
- **Cross-host coordination does not get a live channel.** Remote Control discovery is asymmetric (M-16) and its self-report is untrustworthy (#1056). Revisit trigger: Remote Control leaving research preview, or an external measurement in which both sides discover each other.
- **Codex CLI and Cursor gain nothing from this ADR.** Per the PRD's survey, Codex has no peer discovery and Cursor only parent → child subagents; the rules degrade to today's behaviour there (CSM-005).
