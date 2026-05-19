# Research Brief — Best-Practice-2026 Strategic Cluster (session main-2026-05-19-deep-2)

Shared context for the 5 parallel research agents (Wave 2). Read this before writing your note.

## Scope
5 strategic discovery issues, each → 1 research note (W2) + 1 ADR (W4), file-disjoint:

| Issue | Topic | Research note | ADR |
|---|---|---|---|
| #437 | Native Agent Teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) as wave substrate | docs/research/2026-05-19-agent-teams-evaluation.md | docs/adr/0002-agent-teams-substrate.md |
| #438 | Anthropic Routines (cloud cron) as /autopilot cloud path | docs/research/2026-05-19-routines-evaluation.md | docs/adr/0003-routines-cloud-execution.md |
| #439 | mksglu/context-mode tool-output sandbox for test-runner artifacts | docs/research/2026-05-19-context-mode-evaluation.md | docs/adr/0004-context-mode-tool-output-sandbox.md |
| #440 | EARS notation for /plan (Spec Kit/Kiro/cc-sdd convergence) | docs/research/2026-05-19-ears-evaluation.md | docs/adr/0005-ears-notation-plan.md |
| #447 | prompt-hook continueOnBlock migration path | docs/research/2026-05-19-prompt-hook-migration.md | docs/adr/0006-prompt-hook-continueonblock.md |

## Prior ADRs / research to reference (read if relevant to your topic)
- docs/adr/0001-context-vs-orchestration.md
- docs/adr/2026-05-10-364-remote-agent-substrate.md
- docs/adr/2026-05-10-365-mcp-tool-adapter-debug.md
- docs/adr/2026-05-10-spike-cluster-cross-connections.md
- docs/adr/2026-05-10-spike-cluster-risks.md
- docs/research/2026-05-16-clawpatch-prompt-caching.md

## Decision template (every ADR must end with ONE explicit verdict)
**Decision: Adopt | Adapter | Stay** — with one-paragraph rationale.
- *Adopt* = replace our abstraction with the external primitive.
- *Adapter* = keep ours, add a thin adapter layer; both coexist.
- *Stay* = keep ours private; document why not to adopt.

## Quality bar (anti-echo-stub)
- Every claim about an external tool MUST cite a real source (URL or repo path). No unsourced assertions.
- Verify our own code-state by reading actual files (Grep/Read) — never assume from memory.
- A research note with section headers but no substantive content is a FAIL. Each section needs real findings.
- Use CLAUDE.md/AGENTS.md alias phrasing per the repo doc-consistency rule (never bare "CLAUDE.md" without the alias note when describing the instruction-file system).
