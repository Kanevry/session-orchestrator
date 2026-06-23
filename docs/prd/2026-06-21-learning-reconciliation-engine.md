# Feature: Learning-Driven Reconciliation Engine (Auto-Rules from Session Signals)

**Date:** 2026-06-21
**Author:** Bernhard Götzendorfer + Claude (AI-assisted planning)
**Status:** Shipped (v1 — #694/#695/#693 closed 2026-06-22)
**Appetite:** Epic — phased; v1 ≤ 2 weeks (Medium), v2/v3 each ≤ 2 weeks
**Parent Project:** session-orchestrator (self-evolution surface)

> **Epic framing.** This PRD defines an Epic and scopes **v1** in full. v2 (Steering + Vault-Readback) and v3 (Skills/Agents MR-only) are sketched in §2 Out-of-Scope and tracked as separate phases. Each phase is independently shippable and ≤ 2 weeks.

## 1. Problem & Motivation

### What
The plugin already **captures** session signal (`/evolve` → `learnings.jsonl`, `dialectic-deriver` → peer cards, `vault-mirror` → vault archive) and **surfaces** it (session-start Phase 6.6 "Project Intelligence" banner). It does **not** close the loop: no mechanism turns a recurring learning into a durable, *conditionally-loaded* `.claude/rules/*.md` entry. The learning lifecycle today is **COLLECT → SURFACE → ARCHIVE**, never **REFINE → ENFORCE**.

This Epic adds a **Reconciliation Engine**: at session-end (and on-demand via `/reconcile`), eligible learnings are distilled into **proposals** for rule files. The engine is **advisory** (never blind-writes prose), **repo-local in v1**, and — the load-bearing constraint — every generated rule is **conditionally activated**, never `always-on`. It rides on a prerequisite **Rule Activation Foundation** that wires the currently-dormant glob loader and extends the rule frontmatter to express richer activation conditions.

### Why
- **The loop is open and nobody has closed it.** Across ~45 repos (26 mirror to the vault), *no* repo generates rules/skills/agents from learnings. First-mover, high leverage.
- **Instruction-budget is already a flagged concern (#668).** Auto-generating rules naïvely would make every learning a permanent always-on token tax in every session, in every adopting repo — the opposite of what we want. The feature must be *budget-reducing by construction*, not budget-inflating.
- **The conditional-loading machinery is built but dormant.** `scripts/lib/rule-loader.mjs` (glob-scoping, #336) is implemented and fully tested but **not wired into the wave-executor** — today all 18 rules inject into every agent (~7.1k tokens, zero savings materialised). The Foundation phase activates this dormant value *and* extends it.
- **Best-practice 2026 is unambiguous.** Anthropic's "agents create/edit/evaluate skills" is roadmap, not shipped; the misevolution literature (capability collapse, safety regression, self-reinforcing error) mandates advisory-only + human gate + expiry + audit backlink. Cursor's 4-type activation model (Always / Auto-Attached / Agent-Requested / Manual) + Anthropic Skills' metadata-first/body-lazy disclosure are the proven patterns we adopt.

### Who
- **Primary: the operator (Bernhard)** running housekeeping/deep sessions across the repo fleet — wants learnings to *durably shape future sessions* without manually authoring rule files, and without paying a context-bloat tax.
- **Secondary: every repo consuming the session-orchestrator plugin** (~44 with `.claude/`) — inherits the Foundation's conditional-loading budget savings immediately, and the reconciliation engine when opted in.
- **Tertiary: wave-executor subagents** — receive *only* situationally-relevant rules, improving signal-to-noise per the lost-in-the-middle / context-rot evidence.

## 2. Solution & Scope

### In-Scope (v1)

**FA1 — Rule Activation Foundation (the prerequisite "clean foundation")**
- [ ] Wire the dormant `loadApplicableRules()` (#336) into the wave-executor so glob-scoped rules actually load conditionally per wave.
- [ ] Extend `rule-loader.mjs` frontmatter parsing beyond `globs:` to: `description`, `mode`, `host-class`, `alwaysApply`, `expires-at`, `learning-key`, `auto-generated`, `confidence`.
- [ ] Add two deterministic gating axes: **mode-gating** (`mode: housekeeping|feature|deep|any`, matched against the session mode known at session-start) and **host-class-gating** (`host-class: <class>|any`, matched against `.orchestrator/host.json`).
- [ ] Add **expiry**: rules past `expires-at` are excluded at load time (with a stderr WARN), never silently kept.
- [ ] Add an **Agent-Requested / description-catalog** path: name + `description` + `learning-key` injected cheaply as a catalog; the full rule body is loaded on glob/mode/host match OR explicit coordinator request. *(Highest-complexity item — see §5 spike risk.)*
- [ ] Author a canonical **rule-frontmatter authoring spec** (no spec exists today) documenting every valid field and the activation precedence.

**FA2 — Reconciliation Engine (learning → proposal)**
- [ ] Learning **eligibility filter**: only the rule-mappable learning types convert; non-keyable types are rejected (stay banner/config). Reuse the `scripts/lib/skill-evolution/` candidate-intake + blast-radius-classifier scaffolding rather than rebuild.
- [ ] **Activation-metadata emitter**: derive `globs` from `files[]`; `mode`/`host-class` from the learning's mode/host_class; `description` from the insight; always set `alwaysApply: false`, `auto-generated: true`, `learning-key`, `confidence`, `expires-at`.
- [ ] **Rule renderer**: produce a well-formed `.claude/rules/<slug>.md` body (insight + evidence + provenance block) from the learning.

**FA3 — Advisory delivery (the "automatic reconciliation at session-end")**
- [ ] New **session-end Phase 3.6.8** (opt-in), after auto-dialectic (3.6.7), before metrics write (3.7): runs the engine, writes a proposal sidecar, renders an AUQ batch (reuse the memory-proposals AUQ pattern).
- [ ] New **`/reconcile` command + skill** for standalone, on-demand invocation (manual control, same engine).
- [ ] Approved proposals are written to `.claude/rules/`; rejected ones archived to a sidecar. No proposal is ever applied without operator approval.

**FA4 — Guardrails (the brandmauer)**
- [ ] **Never always-on**: the emitter MUST NOT set `alwaysApply: true`; a CI/validate check rejects any auto-generated rule (`auto-generated: true`) that is always-on.
- [ ] **Reject non-keyable**: learnings with no clean activation key do not become rules.
- [ ] **Audit backlink + expiry**: every generated rule carries `learning-key` (traceable to its origin learning) and `expires-at`; `claude-md-drift-check` is extended to flag generated rules whose learning has decayed/expired.
- [ ] **Opt-in + kill-switch**: a new `reconcile:` Session Config block (`enabled: false` default), parsed with parity into `docs/session-config-template.md` (drift-check Check 6).

### Out-of-Scope (deferred to later phases — explicit)
- **Vault-Readback (v2)** — seeding proposals from high-confidence learnings aggregated across the 26 vault repos. *Why deferred:* no reverse-flow exists today; cross-repo trust is the hardest/riskiest layer and must sit on a stable repo-local v1.
- **Steering-doc reconciliation (v2)** — proposing updates to `.orchestrator/steering/{product,tech,structure}.md`. *Why deferred:* lower frequency, benefits from the v1 activation model being proven first.
- **Skills/Agents generation (v3, MR-only)** — `skills/*/SKILL.md` and `agents/*.md` proposals. *Why deferred:* triggering-descriptions + plugin surface are fragile, need test-gates (MUSE/EvoSkill pattern); always MR, never sidecar-apply.
- **Baseline-Promotion (later)** — reverse-pushing refined rules to `projects-baseline`. *Why deferred:* 44-repo blast radius; needs v1+v2 stable.
- **Auto-apply of rule prose** — explicitly rejected by the chosen posture; only the existing C2 `command-count` shape ever auto-applies to the root instruction file.
- **Semantic/embedding RAG retrieval of rules** — beyond the description-catalog; not 2026-standard, deferred.

## User Stories

> Intent layer (Wave-1 toggle = yes). Stories are the "who/why"; §3/§3.A acceptance criteria are the "verify".

### US-1 (→ FA3 Advisory delivery)
**Als** Operator **möchte ich**, dass am Ende einer Housekeeping-Session aus wiederkehrenden Learnings automatisch Rule-Vorschläge entstehen, die ich per AUQ annehmen/ablehnen kann, **damit** durabler Nutzen entsteht, ohne dass ich Rule-Dateien von Hand schreibe.
- ↳ AC: §3 FA3, §3.A FA3 (Event-driven)

### US-2 (→ FA1 + FA4 conditional activation)
**Als** Operator **möchte ich**, dass jede auto-generierte Rule nur dann geladen wird, wenn ihre Situation zutrifft (passende Dateien / Mode / Host), **damit** mein Instruction-Budget nicht mit jedem neuen Learning dauerhaft wächst.
- ↳ AC: §3 FA1, §3.A FA1 (Unwanted behaviour), §3.A FA4 (Unwanted behaviour)

### US-3 (→ FA2 + FA4 eligibility filter)
**Als** Operator **möchte ich**, dass Learnings ohne sauberen Aktivierungs-Schlüssel (Sizing, Scope-Guidance, Prozess-Patterns) *nicht* zu Rules werden, **damit** keine vagen, immer-aktiven Pseudo-Rules entstehen, die nur Rauschen erzeugen.
- ↳ AC: §3 FA2, §3.A FA2 (Unwanted behaviour)

### US-4 (→ FA1 dormant-loader wiring)
**Als** Operator jedes Repos, das das Plugin nutzt, **möchte ich**, dass glob-scoped Rules tatsächlich pro Welle konditional geladen werden (nicht alle 18 in jeden Agenten), **damit** ich die bereits gebaute, aber schlafende #336-Token-Ersparnis sofort bekomme.
- ↳ AC: §3 FA1, §3.A FA1 (State-driven)

### US-5 (→ FA4 audit backlink)
**Als** Operator **möchte ich** zu jeder generierten Rule den Ursprungs-Learning (`learning-key`) und ein Ablaufdatum sehen, **damit** ich Drift erkennen und veraltete Rules zurückrollen kann.
- ↳ AC: §3 FA4, §3.A FA4 (Ubiquitous)

## 3. Acceptance Criteria

### FA1 — Rule Activation Foundation
```gherkin
Given a wave whose allowedPaths contain only "src/app/HomeView.tsx"
And .claude/rules/ contains backend.md (globs: src/services/**) and frontend.md (globs: src/**/*.tsx)
When the wave-executor assembles the subagent prompt via loadApplicableRules()
Then frontend.md is injected and backend.md is NOT injected
And the always-on rules (no globs) are still injected
```
```gherkin
Given an auto-generated rule with frontmatter "mode: deep" and no globs
When a session runs in mode "feature"
Then the rule is excluded from every prompt that session
When a session runs in mode "deep"
Then the rule is eligible for loading
```
```gherkin
Given an auto-generated rule with "expires-at: 2026-01-01"
When loadApplicableRules() runs on 2026-06-21
Then the rule is excluded and a stderr WARN names the expired rule
```

### FA2 — Reconciliation Engine (eligibility + emit)
```gherkin
Given a fragile-file learning with files: ["hooks/post-tool-use.mjs"] and confidence 0.9
When the reconciliation engine processes it
Then it emits a rule proposal with globs: ["hooks/post-tool-use.mjs"], alwaysApply: false,
  auto-generated: true, learning-key set to the learning id, and expires-at populated
```
```gherkin
Given an effective-sizing learning (subject "deep-session-sizing", no files[])
When the reconciliation engine processes it
Then NO rule proposal is produced
And the learning remains available to the Project Intelligence banner / mode-selector
```

### FA3 — Advisory delivery (session-end + /reconcile)
```gherkin
Given reconcile.enabled is true and the session produced 2 rule-eligible learnings
When session-end reaches Phase 3.6.8
Then a proposal sidecar is written and an AUQ presents the 2 proposals
And only operator-approved proposals are written to .claude/rules/
And rejected proposals are archived to the sidecar, never to .claude/rules/
```
```gherkin
Given reconcile.enabled is false (default)
When session-end runs
Then Phase 3.6.8 is a silent no-op and no proposal sidecar is written
```

### FA4 — Guardrails
```gherkin
Given the reconciliation engine attempts to emit a rule
When the emitter runs
Then alwaysApply is never set to true for any auto-generated rule
```
```gherkin
Given a committed .claude/rules/<slug>.md with auto-generated: true and no globs/mode/host-class/description
When the validate gate (check-rules) runs in CI
Then the gate fails, naming the always-on auto-generated rule as a budget violation
```

### Edge Case / Error Handling
```gherkin
Given a learning whose files[] reference a path that no longer exists in the repo
When the engine emits a proposal
Then the proposal is flagged "stale-target" and routed to advisory-only (not auto-written on approval without a re-confirm)
```
```gherkin
Given two sessions run concurrently and both reach Phase 3.6.8
When each writes the proposal sidecar
Then writes are serialised (reuse withFileLock / state-md-lock pattern) and neither proposal set is lost
```

## 3.A Acceptance Criteria (EARS)

### FA1 — Rule Activation Foundation
**Ubiquitous:** The rule-loader shall parse `globs`, `description`, `mode`, `host-class`, `alwaysApply`, `expires-at`, `learning-key`, `auto-generated`, and `confidence` from rule frontmatter, ignoring unknown keys without error. (The `auto-generated` + `confidence` parse paths are required so the FA4 validate gate, which keys on `auto-generated: true`, has a guaranteed input.)
**State-driven:** While a wave's allowedPaths do not match a rule's globs (and no other activation axis matches), the loader shall exclude that rule from the subagent prompt.
**Event-driven:** When the session mode is known at session-start, the loader shall exclude any rule whose `mode` is set and does not equal the session mode or `any`.
**Optional feature:** Where a rule declares `host-class`, the loader shall load it only when it matches the resolved host class or is `any`.
**Unwanted behaviour:** If frontmatter parsing fails, then the loader shall fail open (treat the rule as always-on) and emit a stderr WARN — never silently drop a rule.

### FA2 — Reconciliation Engine
**Ubiquitous:** The engine shall classify each learning as rule-eligible or rejected using a documented type→activation map.
**Event-driven:** When a rule-eligible learning carries `files[]`, the engine shall emit `globs` derived from those paths.
**Unwanted behaviour:** If a learning has no clean activation key, then the engine shall NOT emit a rule and shall record the rejection reason in the sidecar.

### FA3 — Advisory delivery
**State-driven:** While `reconcile.enabled` is false, session-end Phase 3.6.8 shall be a no-op.
**Event-driven:** When Phase 3.6.8 runs with eligible proposals, the engine shall render an AUQ and write only approved proposals to `.claude/rules/`.
**Optional feature:** Where `/reconcile` is invoked manually, the engine shall run the same pipeline independent of session-end.

### FA4 — Guardrails
**Ubiquitous:** Every auto-generated rule shall carry `auto-generated: true`, a `learning-key`, and an `expires-at`.
**Unwanted behaviour:** If an auto-generated rule is always-on (no activation axis and `alwaysApply` not false), then the validate gate shall fail in CI.

## 4. Technical Notes

### Affected Files
- `scripts/lib/rule-loader.mjs` — extend frontmatter parsing (new fields); add mode/host-class/expiry gating + description-catalog path. **Preserve** existing always-on (no-globs) and glob behaviour byte-for-byte for hand-authored rules.
- `skills/wave-executor/SKILL.md` — wire `loadApplicableRules({ rulesDir, scopePaths })` into per-wave prompt assembly (the dormant #336 integration). `skills/_shared/config-reading.md` already documents the intended call.
- `scripts/lib/reconcile/` (NEW) — `eligibility.mjs` (type→activation map + filter), `emit.mjs` (activation-metadata emitter), `render.mjs` (rule-body renderer). Reuse `scripts/lib/skill-evolution/{candidate-intake,blast-radius-classifier}.mjs` patterns; do not duplicate the MR-opener.
- `skills/reconcile/SKILL.md` + `commands/reconcile.md` (NEW) — standalone `/reconcile`.
- `skills/session-end/SKILL.md` — new **Phase 3.6.8** (opt-in, after 3.6.7, before 3.7).
- `docs/rule-authoring.md` (NEW) — canonical frontmatter spec; cross-link from `agents/AGENTS.md` and `CLAUDE.md` Layered-Instruction table.
- `scripts/lib/validate/check-rules.mjs` (NEW) — CI gate: auto-generated rule must not be always-on; `learning-key`/`expires-at` present.
- `skills/claude-md-drift-check/` — extend to flag generated rules whose `learning-key` learning is expired/absent (new check, warn-mode).
- `CLAUDE.md` `## Session Config` + `docs/session-config-template.md` + `docs/session-config-reference.md` — new `reconcile:` block (parity for drift-check Check 6).
- `.orchestrator/metrics/reconcile-pending.md` (proposal sidecar) + `.orchestrator/runtime/reconcile-candidates.jsonl` (idempotency sidecar, mirroring the actual C2 store `.orchestrator/runtime/repair-candidates.jsonl` from `scripts/lib/skill-evolution/idempotency.mjs` — same `runtime/` tree, not `metrics/`, to stay consistent with C2).

### Architecture
Reuse the proven **C2 skill-evolution scaffolding** (intake → classify → gate → deliver) rather than a parallel engine. The reconciliation engine is a *new delivery target* (rule proposals, advisory) plugged into the same intake/classifier shape. Delivery reuses the **memory-proposals AUQ** flow (collect → batch AUQ → write approved / archive rejected). The Activation Foundation extends one module (`rule-loader.mjs`) and wires one call site (wave-executor); it ships independently and benefits all repos before the engine exists.

**Activation precedence (loader):** `alwaysApply:true` → load always · else if any of {globs match, mode match, host-class match} → load body · else if `description` present → catalog-only (body on explicit request) · else (no axis) → for hand-authored rules: always-on (legacy); for `auto-generated:true`: **rejected by validate gate**.

**Generated-rule frontmatter (emitter output):**
```yaml
---
description: "<one-line, ≤25 words, derived from learning insight>"
globs: ["<from learning.files[] when present>"]
mode: any            # or housekeeping|feature|deep when the learning is mode-keyed
host-class: any      # or <class> for hardware-pattern learnings
alwaysApply: false   # auto-generated rules: NEVER true
auto-generated: true
learning-key: "<learning id>"
confidence: 0.0-1.0  # copied from learning
expires-at: "<created_at + reconcile.rule-expiry-days>"
---
```

**Learning type → activation (engine map):**
| Learning type | v1 outcome | Activation axis |
|---|---|---|
| fragile-file, stagnation-class-frequency | rule | globs (from files[] / `file:class` subject) |
| recurring-issue | rule | globs (tests/** heuristic) or reject if generic |
| anti-pattern, architecture-pattern, convention, design-pattern | rule **iff** files[] present | globs; else reject |
| hardware-pattern | rule | host-class gating (never always-on) |
| effective-sizing, scope-guidance, autopilot-effectiveness, mode-selector-accuracy, process-pattern, agent-effectiveness, domain-regression | **reject** → banner/config | — |

### Data Model Changes
None (no DB). New artifacts: rule-frontmatter fields (additive, backward-compatible), `reconcile-pending.md` + `reconcile-candidates.jsonl` sidecars, `reconcile:` Session Config block.

### API Changes
None (no HTTP). New CLI surface: `/reconcile` skill/command; `reconcile:` config keys. Session Config `*-command` trust model unchanged (no new command-bearing key).

## 5. Risks & Dependencies

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Agent-Requested / description-catalog loading is non-trivial in a prompt-injection harness** (vs Cursor's native support) | Could over-run the v1 appetite | Time-box a **spike** in FA1 first; if integration proves heavy, ship v1 with globs+mode+host-class+expiry and defer the catalog to v1.1 — the deterministic axes already satisfy US-2/US-4. |
| **Wiring the dormant #336 loader changes behaviour for all repos** (rules that were always-injected now scope out) | A previously-seen rule could vanish from a wave and surprise an agent | Only *glob-scoped* rules change; always-on (no-globs) rules stay always-on. Add a one-time session-start NOTE when wiring lands; ship behind a config flag for one release if needed. |
| **Self-reinforcing error**: a false/early learning → a bad rule | Wrong rule subtly steers future sessions | Advisory-only + operator AUQ gate + `expires-at` + `learning-key` audit; drift-check flags decayed origins. Matches misevolution-research guardrails. |
| **Always-on bloat slips in** despite intent | The exact problem the feature exists to prevent | Emitter hard-codes `alwaysApply:false`; `check-rules` CI gate fails any always-on `auto-generated` rule; #668 budget audit cross-references. |
| **Over-conversion** (too many learnings become rules) | Rule directory churn, review fatigue | Eligibility filter + `reconcile.confidence-floor` + per-session proposal cap (reuse memory-proposals quota pattern). |
| **Vault-Readback (v2) cross-repo trust** | Highest-risk layer | Explicitly deferred to v2 on a stable v1; not in this scope. |

### Dependencies
- **#668 instruction-budget audit** — this feature is the durable fix for the rule half; coordinate, don't duplicate.
- **#336 glob-scoped rules (dormant)** — hard dependency: FA1 wires it. Verify its test suite stays green after the wire-up.
- **skill-evolution C2 scaffolding** (`scripts/lib/skill-evolution/*`, `scripts/lib/config/skill-evolution.mjs`) — reused for intake/classify; engine must not regress it.
- **memory-proposals AUQ flow** (`scripts/lib/memory-proposals/*`, `agents/memory-proposal-collector.md`) — reused for advisory delivery.
- **claude-md-drift-check Check 6 (session-config-parity)** — new `reconcile:` keys must be added to `docs/session-config-template.md` in the same change.
- **`.orchestrator/host.json` + resource-probe** — source for host-class gating.
- **Session-mode + host-class provenance** — session mode is read at session-start (mode-selector / STATE.md frontmatter). `learnings.jsonl` records `host_class` (e.g. the `mac-gitlab-runner-cpu-starvation` hardware-pattern entry) but **not** a `mode` field, so the engine derives `mode` from the learning's `source_session` suffix (e.g. `…-deep`) or subject when mode-scoping is warranted. Note: most mode-keyed learning types (effective-sizing, scope-guidance, autopilot-effectiveness) are **reject-listed** in v1, so `mode:` emission is rare — the axis primarily serves hand-authored rules and v2; FA1 still ships the loader-side gating so the capability exists.
