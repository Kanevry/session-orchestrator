# Feature: Skill Self-Evolution Foundation (OpenSpace-inspired)

**Date:** 2026-06-14
**Author:** Bernhard Götzendorfer + Claude (AI-assisted planning)
**Status:** Draft
**Appetite:** 6w (Big Batch — epic; individual issues 1–2w each)
**Parent Project:** session-orchestrator

> **Provenance.** This PRD is the output of a cross-analysis of [HKUDS/OpenSpace](https://github.com/HKUDS/OpenSpace) — a self-evolving skill engine (Python + SQLite + MCP) that plugs into any host agent and adds skill auto-evolution (FIX/DERIVED/CAPTURED), per-skill quality monitoring, a cloud skill community, and a GDPVal token benchmark. Six parallel research agents compared OpenSpace against session-orchestrator; a seventh simulated the value on a real consumer repo (`agenticbuilders-site`); an eighth mapped config/baseline propagation. The conclusions below are evidence-based, not aspirational. **We are NOT importing OpenSpace's runtime** — we harvest concepts that fit a markdown-skills + JSONL-metrics + GitLab plugin.

---

## 1. Problem & Motivation

### What
session-orchestrator ships ~70 skills and a mature *session-level* learning stack (`/evolve`, `learnings.jsonl`, `memory.propose`, Dream, `sunset-review`, `harness-audit`). What it lacks is anything that operates at **skill granularity**: there is no telemetry that records when a skill is selected/applied/effective, no per-skill health signal, and no mechanism that turns "this skill keeps misfiring" into an improvement. `sunset-review` itself states the gap out loud: *"there is no skill-invocation or command-invocation event anywhere"* — so today its skill verdicts are static-reference guesses, not usage-driven.

This feature builds the **foundation** for skill self-evolution: (A) skill-invocation + outcome telemetry, (B) read-only per-skill health diagnosis, (C) a blast-radius-gated auto-repair loop, and (D) session-level token-cost visibility. It deliberately stops short of OpenSpace's autonomous in-place skill mutation, its SQLite runtime, and its cloud community.

### Why
Three drivers, all evidence-backed:

1. **The measurement substrate is missing and blocks everything else.** Per-skill quality, token attribution, and any auto-repair are all impossible without a skill-invocation event stream. `subagents.jsonl` records per-*agent* token stubs with **no outcome field** (all 101 records on `agenticbuilders-site` lack `status`/`success`); the funnel's two load-bearing axes (*applied? completed?*) are both unpopulated. This is an instrumentation gap, not a volume gap.

2. **Real, recurring skill misfires already exist and go uncaptured at skill level.** The `agenticbuilders-site` simulation surfaced a concrete case: the `tracker-stale-vs-code` learning (confidence 0.8) — planning built from a stale issue tracker, a discovery wave burning 4 Explore agents to confirm already-shipped work, **recurring across two sessions**. A skill-health → repair path would turn that into a durable plan-gate precondition. The value is real; the loop to capture it is not built.

3. **Token cost is invisible despite the data existing.** Per-subagent tokens are captured (post-#624) but stranded — only 7 of 602 records populated, never rolled up to a session total, never surfaced. The user cannot see what a session costs.

### Who
The **plugin maintainer** (single operator, Bernhard) is the primary user — for skill-quality triage, token-cost visibility, and (opt-in) autonomous self-tuning of a repo's local artifacts. Secondary beneficiaries: every consumer repo in the operator's portfolio (`agenticbuilders-site`, `feedfoundry`, …) gains better-maintained skills and per-session cost signal. No external/community audience — that premise (OpenSpace's network effects) is explicitly rejected (§2 Out-of-Scope).

---

## 2. Solution & Scope

A **value-first**-sequenced foundation (revised after `/grill`). The fast-payoff items that work from *existing* data lead; A's funnel substrate is built at `priority:medium` because its statistical payoff is slow and it is **not** a hard prerequisite for the value-bearing paths (D is independent; C2 is fed by `/evolve` learnings + `claude-md-drift-check`, not by A's funnel). Only **B** strictly needs A.

### In-Scope
- [ ] **A — Skill-invocation telemetry (3-layer, `priority:medium` substrate).** Revised after `/grill`: the full `selected → applied → completed` funnel is **not** mechanically capturable by a hook — only *selection* is.
  - **L1 (always-on, deterministic):** a `PreToolUse` hook on the `Skill` tool emits `skill selected` events to `.orchestrator/metrics/skill-invocations.jsonl` (`{skill, session_id, ts, phase}`). *(Spike: confirm `matcher: "Skill"` fires — see R9.)*
  - **L2 (always-on, deterministic):** join selection events to **existing** outcome signals (`sessions.jsonl` `agent_summary` complete/partial/failed, `/evolve` learnings) → coarse, session/wave-grained health. No new runtime.
  - **L3 (opt-in, default off):** a bounded session-end LLM-judge (Claude: a `haiku` subagent reusing the `dialectic-deriver` dispatch pattern; Codex/Cursor: coordinator-inline) reads the transcript tail and emits per-skill `applied`/`completed` judgments — the rich axes L1/L2 can't reach. **Advisory only — never feeds an auto-action gate.** Gated behind `skill-evolution:` / a `skill-telemetry.judge` flag.
  - Standalone value even at L1/L2: upgrades `sunset-review` from static-ref guessing toward real usage data.
- [ ] **B — Per-skill health surfacing (read-only, `priority:medium`, blocked-by A).** A scoring function over A's data producing per-skill verdicts (e.g. "selected but rarely applied → trigger description unclear"; "applied but low completion → instructions wrong" — the latter two only when L3 is enabled), surfaced as an advisory section in `sunset-review` and/or a new `harness-audit` `category9.mjs`. **Never** auto-edits. **Single-repo-first:** scores from this repo's own stream; cross-repo *pooling* (needed for the ~20–30-samples/skill trust threshold) is a B-follow-up, not built by A. Honors the low-confidence guardrail (downgrade verdicts when coverage < window; below-threshold skills reported as "insufficient signal", not scored).
- [ ] **C1 — `skill-evolution:` Session Config block + bootstrap autonomy question (`priority:medium`).** New config block (`autonomy: off|advisory|autonomous-gated`, `evidence-floor: float`, `judge: off|on` for A's L3), **default `autonomy: off`, `judge: off`** (opt-in, matches `slopcheck`/`verification-auto-fix` precedent). Dedicated parser module, template + reference docs, and a per-repo bootstrap question for the autonomy level (LOCAL artifacts only).
- [ ] **C2 — Tiered auto-repair engine, gate-per-artifact-type (`priority:medium`, blocked-by C1).** Revised after `/grill`: `build/test` validates *code*, not instructions/config — so the gate is chosen per artifact type:
  - **Plugin-skill repairs** (`skills/*`, portfolio-wide blast radius, prose = untestable) → **always open an MR**, never autonomous — regardless of `autonomy` setting.
  - **Local skill-body repairs** (a repo's own `.claude/skills/*`) → also **MR** (prose has no deterministic gate).
  - **Local config repairs** (a repo's own `CLAUDE.md` Session Config) → **autonomous-gated**: apply only when `autonomy: autonomous-gated` AND a deterministic **config-validation** gate passes (`parse-config` + `config-schema` + `claude-md-drift-check` all green) AND evidence ≥ `evidence-floor`. This is the one real autonomous population — narrow but genuinely gate-able.
  - Fed by `/evolve` learnings (the proven actionable feeder — e.g. `tracker-stale-vs-code`) + `claude-md-drift-check` (for config drift) + (later) B's verdicts. Idempotent candidate tracking via a `processed_at` stamp so a repair is acted on exactly once. *(`processed_at`/`superseded_by` track repair-**candidate** supersession — idempotency bookkeeping — NOT skill-version lineage; the lineage concept stays deferred to #625.)*
- [ ] **D — Session-level token rollup (`priority:medium`, independent — value-first lead).** At `session-end`, sum existing `subagents.jsonl` tokens for the session's `parent_session_id`, write `total_token_input`/`total_token_output`/`subagents_with_tokens` (a **coverage ratio**) onto the `sessions.jsonl` record and into the `session_metrics` MCP output. Independent of A — ships value immediately from data that already exists.
- [ ] **F — projects-baseline sync (`priority:low` follow-up).** Add the `skill-evolution:` block to `templates/shared/CLAUDE.md.template` in `projects-baseline` and a companion `.claude/rules/autonomous-agent-safety.md` clause governing `autonomous-gated` behavior. Keeps private-path bootstraps consistent with the plugin.

### Out-of-Scope
- **Cloud skill-sharing community (rejected wholesale).** OpenSpace's `open-space.cloud` SaaS upload/download is a non-fit: single operator → empty network-effects flywheel; whole-dir upload past a 7-regex moderation gate that blocks only one literal string collides directly with SEC-020 (supply-chain) and the owner-leakage pre-commit gate. No cloud, no public/team visibility model.
- **Autonomous in-place mutation of plugin skills.** OpenSpace's `fix_skill()` overwrites `SKILL.md` on disk from LLM output with only a structural validator. Our skills are MR-reviewed, git-versioned source shipped to every consumer repo. Auto-mutating them outside review breaks provenance and is the textbook silent cross-repo regression (the plugin's own "8-pipeline" cautionary tale). Plugin-skill repairs are MR-only, full stop.
- **SQLite SkillStore / Python evolver runtime / embedding skill-ranker.** A parallel runtime duplicating our JSONL+confidence infrastructure with a heavier, harder-to-audit store and a Python dependency the plugin doesn't have. Take concepts, not the engine.
- **GDPVal / ClawWork benchmark import.** Needs litellm, an OpenRouter key, an LLM-judge, and tasks irrelevant to dev-session orchestration. We have no model-calling runtime to instrument.
- **`total_cost_usd` in dollars.** No model-pricing SSOT exists; a hardcoded rate table silently rots. Report tokens truthfully (transcript-derived), leave dollars null — exactly as the schema already does.
- **Skill lineage/versioning + export-import format (Sharing).** No skill-divergence problem exists today (all repos pull one git-versioned plugin). Covered by reference to **#625** (learnings export/import) plus a parked comment; escalate only on a concrete trigger (see §5). Not filed.
- **Statistical per-skill auto-repair before telemetry exists.** A per-skill score with no underlying event stream would be fabricated — `/evolve`'s own rules forbid that. A (telemetry) is a hard prerequisite for any scoring or repair.

---

## 3. Acceptance Criteria

### A — Skill-invocation telemetry (3-layer)
```gherkin
Given a session invokes a skill via the Skill tool (e.g. /discovery)
When the PreToolUse hook fires (L1)
Then .orchestrator/metrics/skill-invocations.jsonl gains a selection record
     {skill, session_id, ts, phase}
And the join to existing sessions.jsonl agent_summary (L2) yields a coarse
     session/wave outcome for that skill — without any new runtime
```
```gherkin
Given skill-telemetry.judge is enabled (L3, opt-in, default off)
When session-end runs
Then a bounded LLM-judge emits per-skill applied/completed judgments
     (haiku subagent on Claude; coordinator-inline on Codex/Cursor)
And those judgments are advisory only and feed no auto-action gate
And with the judge disabled, only L1+L2 records exist (no judgment, no error)
```
```gherkin
Given skill-invocation telemetry exists
When sunset-review runs
Then its skill verdicts use real usage counts, not only static reference scans
And a low coverage window still downgrades any Retire verdict to Investigate
```

### B — Per-skill health surfacing (read-only)
```gherkin
Given skill-invocation telemetry with sufficient samples for a skill
When the health surfacing runs (in sunset-review or a harness-audit category)
Then it emits a per-skill verdict with a diagnosis string
     (e.g. "selected but rarely applied → trigger description unclear")
And it NEVER edits any skill file
And skills below the sample threshold are reported as "insufficient signal", not scored
```

### C1 — skill-evolution config + bootstrap knob
```gherkin
Given a CLAUDE.md with a skill-evolution: block (autonomy, evidence-floor)
When parse-config runs
Then it returns the parsed skill-evolution object with the configured values
And a CLAUDE.md WITHOUT the block parses with autonomy defaulting to "off"
```
```gherkin
Given a new repo is bootstrapped with the autonomy question answered
When the CLAUDE.md Session Config is written
Then skill-evolution.autonomy is written as column-0 nested YAML (never a dash line)
And the default when skipped is "off"
```

### C2 — Tiered auto-repair (gate-per-artifact-type)
```gherkin
Given a repair candidate targeting a PLUGIN skill (skills/*) or a local skill body (.claude/skills/*)
When the repair engine acts
Then it opens an MR with the diff and never applies autonomously
     (prose has no deterministic gate — MR regardless of autonomy setting)
```
```gherkin
Given autonomy: autonomous-gated and a repair candidate targeting a LOCAL config artifact
  (the repo's own CLAUDE.md Session Config)
When the config-validation gate passes (parse-config + config-schema + claude-md-drift-check
  all green) AND evidence ≥ evidence-floor
Then the repair is applied autonomously, scoped to this one repo, and recorded
And a candidate already stamped processed_at is never re-proposed (idempotent)
```
```gherkin
Given autonomy: autonomous-gated, a local config artifact, but the config-validation gate FAILS
When the repair engine acts
Then the autonomous apply is aborted and the candidate falls back to an MR/advisory path
```
```gherkin
Given autonomy: off (the default)
When any repair candidate is produced — local config included
Then no repair is applied and no MR is opened; the candidate is surfaced advisory-only
```

### D — Session-level token rollup
```gherkin
Given subagents.jsonl holds token records for a session's parent_session_id
When session-end runs
Then the sessions.jsonl record gains total_token_input, total_token_output,
     and subagents_with_tokens (a coverage count)
And session_metrics MCP output surfaces the per-session token total
And a low coverage ratio is reported alongside the total so a partially-captured
     session is not misread as cheap
```

## 3.A Acceptance Criteria (EARS)

### Feature Area A — Telemetry
**Ubiquitous:** The telemetry layer shall record a skill-invocation event with `{skill, session_id, ts, phase, outcome}` for every skill selection.
**Event-driven:** When a wave or agent terminates, the system shall write a non-null outcome/status (complete|partial|failed) to its telemetry record.
**Unwanted behaviour:** If outcome cannot be determined, then the system shall record `outcome: unknown` rather than omitting the field (no silent gaps).

### Feature Area B — Health
**Optional feature:** Where per-skill sample count ≥ the trust threshold, the system shall emit a scored verdict; otherwise it shall emit "insufficient signal".
**Unwanted behaviour:** If the coverage window is below the configured minimum, then the system shall downgrade any Retire/auto-action verdict to advisory.

### Feature Area C — Auto-repair
**State-driven:** While `autonomy: off`, the system shall take no repair action of any kind.
**Optional feature:** Where the repair target is a plugin skill, the system shall open an MR and shall not apply autonomously.
**Optional feature:** Where the repair target is a local artifact AND `autonomy: autonomous-gated` AND the deterministic gate passes AND evidence ≥ evidence-floor, the system shall apply the repair autonomously.
**Unwanted behaviour:** If any of those four conditions is unmet, then the system shall not apply autonomously.

---

## 4. Technical Notes

### Affected Files

**A — Telemetry**
- `scripts/emit-event.mjs` / a new emit helper — write `skill-invocations.jsonl`.
- `scripts/lib/subagents-schema.mjs` — add `outcome`/`status` field (schema_version bump).
- `hooks/` — a Pre/Post emit point keyed on skill dispatch (analogous to `subagent-telemetry.mjs`, `SubagentStop`); plus a `_shared` logging convention for skills that can self-report.
- `skills/sunset-review/SKILL.md` + `scripts/lib/sunset/walker.mjs` — consume real usage counts (the gap it documents).

**B — Health**
- New `scripts/lib/skill-health/*.mjs` — scoring/diagnosis over `skill-invocations.jsonl`.
- `skills/sunset-review/SKILL.md` (advisory section) and/or `scripts/lib/harness-audit/categories/category9.mjs` (new category).

**C1 — Config + bootstrap**
- `scripts/lib/config/skill-evolution.mjs` (NEW) — dedicated parser (clone `auto-dream.mjs` single-level pattern + enum-coerce for `autonomy`). **Nested blocks are NOT generic — each needs its own parser module.**
- `scripts/lib/config.mjs` — 3 edits: import, call, add to returned object.
- `docs/session-config-template.md` — a `## Skill Evolution` prose section **and** (decision-gated, see R2) the keys in the consolidated `## Session Config` parity block.
- `docs/session-config-reference.md` — field-reference section.
- `skills/bootstrap/{fast,standard,deep}-template.md` — write `skill-evolution.autonomy` into the new repo's CLAUDE.md. Naming caution: an `evolve:` block already exists — `skill-evolution:` is a distinct sibling.

**C2 — Repair engine**
- New `scripts/lib/skill-evolution/*.mjs` — candidate intake (from `/evolve` learnings + B's verdicts), blast-radius classifier (plugin vs local), deterministic-gate runner (reuse `scripts/lib/quality-gate.mjs`), MR opener (reuse `glab`/gitlab-ops), idempotent candidate stamp.
- `skills/evolve/SKILL.md` — feed actionable learnings into repair candidates.

**D — Token rollup**
- `scripts/lib/session-schema.mjs` — add `total_token_input`/`total_token_output`/`subagents_with_tokens` (schema_version bump).
- `skills/session-end/SKILL.md` — rollup step.
- `scripts/mcp-server.sh` `session_metrics` handler — surface the totals.

**F — Baseline**
- `projects-baseline/templates/shared/CLAUDE.md.template` — add `skill-evolution:` block (column-0 nested YAML; the template is currently dash-list and behind by ~7 blocks).
- `projects-baseline/.claude/rules/autonomous-agent-safety.md` — companion autonomy rule.

### Architecture
Markdown-skills + JSONL-metrics + hooks throughout — **no SQLite, no Python, no LLM-callback layer** (the plugin doesn't make LLM calls; data comes from transcripts/hooks). The repair engine reuses existing plumbing (`quality-gate.mjs`, `glab`, gitlab-ops, the leakage/slopcheck validators) rather than introducing new infrastructure. The defining design principle, validated by the `agenticbuilders-site` simulation: **autonomy is gated by blast radius + deterministic verification + evidence threshold**, not by confidence alone.

### Data Model Changes
- New JSONL: `.orchestrator/metrics/skill-invocations.jsonl` (`{skill, session_id, ts, phase, outcome}`).
- `subagents.jsonl`: + `outcome`/`status` (schema_version bump, backward-compatible).
- `sessions.jsonl`: + token totals + coverage count (schema_version bump).
- Memory-proposal / candidate records: + optional `processed_at` (additive, backward-compatible).

### API Changes
- `session_metrics` MCP tool output gains per-session token totals. No new endpoints. New `skill-evolution:` Session Config block (parser-level "API").

---

## 5. Risks & Dependencies

| Risk | Impact | Mitigation |
|------|--------|------------|
| **R1 — Outcome attribution is noisy.** "Applied/effective" is harder to capture than "started" (mirrors sunset-review's "only start events count" caveat). | Per-skill rates mislead; B over/under-flags. | Start with selection + start counts only; treat applied/completed as best-effort with explicit `unknown`. Require sample thresholds in B. |
| **R2 — Check-6 parity hard-fail.** The moment `skill-evolution:` is a column-0 key in the template's consolidated `## Session Config` block, every repo with `drift-check.mode: hard` lacking it fails session-end. | Portfolio-wide session-end breakage. | Either ship the block into all in-scope CLAUDE.md files in the same wave (the gsd-bundle pattern), OR keep it in a standalone `## Skill Evolution` prose section, deliberately parity-exempt while opt-in. Decide in C1. |
| **R3 — Backward-compat default.** Parser default of `advisory` would change behavior on upgrade for existing repos. | Unwanted silent autonomy. | Parser default **`off`** (opt-in), matching `slopcheck.enabled: false` precedent. |
| **R4 — Statistical signal insufficiency.** Break-even is ~20–30 applications/skill with real failures; a single clean repo yields nothing or over-fits. | B produces noise on low-traffic repos. | Pool telemetry across repos; gate B on sample thresholds; lead value via `/evolve` learnings (actionable at N=3), not raw funnel stats. |
| **R5 — Autonomous repair blast radius.** Auto-applying a plugin-skill edit propagates a silent regression to every repo. | Cross-repo silent failure (the "8-pipeline" class). | Plugin-skill repairs are MR-only, unconditionally. Autonomous path restricted to single-repo local artifacts behind a deterministic gate + evidence floor. |
| **R6 — Plugin/baseline divergence.** No tooling syncs `session-config-template.md` ↔ baseline `CLAUDE.md.template`; they already diverge. | Private-path repos silently never get the block. | Track F as an explicit follow-up issue; note the pre-existing dash-vs-column-0 parity gap as a separate cleanup candidate (don't block on it). |
| **R7 — Bootstrap 2-question cap.** Bootstrap's anti-bureaucracy contract caps interactions at 2 questions. | A 3rd question violates the contract. | Default `off` silently; offer the autonomy choice via a non-counted opt-in step (ecosystem-wizard precedent) or fold into existing tier/archetype questions; adjustable via hand-edit / `/bootstrap --upgrade`. |
| **R8 — Scope/bloat creep.** Self-evolution is a tempting place to over-build. | Plugin bloat; against stated lean value. | Hard Out-of-Scope list (cloud, SQLite, benchmark, in-place mutation). Value-first order (D + learnings/drift-fed C2 lead) ships value incrementally; A's slow-payoff funnel is `priority:medium`, not first. L3 judge opt-in default off. |
| **R9 — L1 hook-match unverified + L3 judge reliability.** (a) Whether `PreToolUse matcher: "Skill"` actually fires is unconfirmed (today's matchers are Write/Edit/Bash only). (b) An LLM judging "was skill X applied" is fallible — noisier than a counter. | (a) A's L1 emit point may not exist. (b) B over/under-flags. | (a) Spike `matcher: "Skill"` first thing in the A issue; if it doesn't fire, fall back to a `UserPromptSubmit`/SlashCommand emit point or skill-self-report convention. (b) L3 is advisory-only, confidence-scored, sample-thresholded; it NEVER feeds C2's gate (the gate stays deterministic config-validation / exit codes). |

### Dependencies
- **#625** (`/evolve` learnings export/import + cross-project promotion): the Sharing theme is covered here — **reference only, no duplicate**. A parked comment captures the OpenSpace lineage/diff idea with an escalation trigger (first time a hand-edited skill is copy-pasted between repos ≥2×).
- **Value-first dependency order (revised after `/grill`):** **D is independent** (ships first, existing data). **C2 is fed by `/evolve` learnings + `claude-md-drift-check`** — it does **not** hard-depend on A. **A blocks only B** (B reads A's stream). **C1 blocks C2** (config gates the engine). **F follows C1.** So the lead items (D, C2-via-learnings) deliver before A's slow-payoff funnel matures.
- Reuses existing: `scripts/lib/quality-gate.mjs`, `glab`/gitlab-ops, `check-owner-leakage.mjs`, `slopcheck.mjs`, `subagent-telemetry.mjs` (#624), `sunset-review`, `harness-audit`.
- **projects-baseline** (`templates/shared/CLAUDE.md.template`, `.claude/rules/autonomous-agent-safety.md`): out-of-band SSOTs, tracked via issue F. Nice-to-have follow-up, not a hard blocker for the plugin-side work.
