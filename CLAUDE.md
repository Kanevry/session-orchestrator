# Session Orchestrator Plugin

> Project-instruction file resolution: this is `CLAUDE.md` on Claude Code / Cursor IDE; the equivalent file on Codex CLI is `AGENTS.md`. See [skills/_shared/instruction-file-resolution.md](skills/_shared/instruction-file-resolution.md).

> Für Installation, CLI-Nutzung und Architektur siehe [`README.md`](./README.md). Diese Datei enthält nur die runtime-kritischen Abschnitte, die von `skills/_shared/config-reading.md` gelesen werden.

## Structure

See [`README.md`](./README.md#components) for the canonical inventory (36 user-facing skills, 16 commands, 11 agents, 11 hook event matchers / 11 hook handlers). The `skills/_shared/` directory contains internal shared docs and is not counted as a user-facing skill. Runtime layout: `skills/`, `commands/`, `agents/`, `hooks/`, `.orchestrator/policy/`, `.claude/rules/`. Stable product/tech/structure context lives at `.orchestrator/steering/{product,tech,structure}.md` and is injected at session-start Phase 2.6 (when present).

- `hooks/operator-steer.mjs` — mid-wave operator steering via `STEER.md` handshake (#409); fires on every `PostToolBatch` event.
- `agents/security-reviewer.md` — updated with Hard Exclusions list (non-security false-positive patterns to skip, #412).
- `assets/icon.svg` — Codex marketplace plugin icon (#43); referenced by `.codex-plugin/plugin.json` `interface.composerIcon`.

## Destructive-Command Guard

`hooks/pre-bash-destructive-guard.mjs` blocks destructive shell commands in the main session (alongside subagent waves). Policy lives in `.orchestrator/policy/blocked-commands.json` (13 rules). Bypass per-session via Session Config:

```yaml
allow-destructive-ops: true
```

Rule source of truth: [`.claude/rules/parallel-sessions.md`](.claude/rules/parallel-sessions.md) (PSA-003). See README § Destructive-Command Guard for the full narrative.

## Agent Authoring Rules

Agent files live in `agents/` as Markdown with YAML frontmatter. Required fields:

```yaml
---
name: kebab-case-name                # 3-50 chars, lowercase + hyphens only
description: Use this agent when [conditions]. <example>Context: ... user: "..." assistant: "..." <commentary>Why this agent is appropriate</commentary></example>
model: inherit                        # inherit | sonnet | opus | haiku — OR full ID like claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001
color: blue                           # blue | cyan | green | yellow | purple | orange | pink | red | magenta
tools: Read, Grep, Glob, Bash         # comma-separated string OR JSON array (both accepted; we prefer comma-string for consistency)
---
```

**Frontmatter spec source:** https://code.claude.com/docs/en/sub-agents § Supported frontmatter fields. Our local validator (`scripts/lib/validate/check-agents.mjs` + `scripts/lib/agent-frontmatter.mjs`) matches the canonical spec on `tools` (both forms accepted), `color` (canonical 8-color palette + magenta for backward-compat), and `model` (aliases + full IDs).

**Required vs optional:**
- Runtime canonical doc: only `name` + `description` are required.
- Our validator (defensive for plugin-distribution): all four of `name + description + model + color` required; `tools` optional.
- `description` MUST be a single-line inline string, NOT a YAML block scalar (`>` or `|`). Put `<example>` blocks inline.
- `tools` accepts BOTH comma-separated string (`Read, Edit, Write`) and JSON array (`["Read", "Edit", "Write"]`). Anthropic's own reference agents use array form; we use string form for consistency.

**Body conventions** (from Anthropic's `plugins/plugin-dev/agents/*` reference set):
- Sections: `**Your Core Responsibilities:**` → `**[X] Process:**` → `**Quality Standards:**` → `**Output Format:**` → `**Edge Cases:**`.
- Length: 500–3000 words is the recommended range. Below 500 reads as under-specified; above 3000 reads as bloated.
- Read-only reviewer agents: tools `Read, Grep, Glob, Bash` (no Edit/Write). Implementer agents: `Read, Edit, Write, Glob, Grep, Bash`.

**Optional `sandbox-tier:` field (#418):** Agents MAY declare their sandbox permission tier. Valid values:

| Value | Meaning | Typical tools |
|---|---|---|
| `read-only` | observes only; no file writes, no network | `Read, Grep, Glob, Bash` |
| `repo-write` | may create or modify files | `Read, Edit, Write, Glob, Grep, Bash` |
| `network-allowed` | may make outbound network calls (future) | — |
| `dangerous` | may run destructive shell commands (future) | — |

Inference rule (backward-compat): agents without `sandbox-tier:` infer their tier from tools — `Edit` or `Write` present → `repo-write`; only `Read/Grep/Glob/Bash/Skill` → `read-only`. The validator emits **WARN**, not FAIL, when the field is absent, so existing agents continue to work during migration. Bash appears in all tiers — fine-grained Bash control is handled by `hooks/pre-bash-destructive-guard.mjs`, not by tier.

Example:

```yaml
tools: Read, Edit, Write, Glob, Grep, Bash
sandbox-tier: repo-write
output-schema: schemas/code-implementer.schema.json
```

**Optional `output-schema:` field (#417):** Agents MAY declare a JSON-Schema-2020-12 file under `agents/schemas/` that describes the shape of their machine-readable output (the trailing fenced ```json block in the agent's return). Example:

```yaml
tools: Read, Edit, Write, Glob, Grep, Bash
output-schema: schemas/code-implementer.schema.json
```

When present, `scripts/lib/agent-output-schema.mjs#validateAgentOutput()` parses the agent's last fenced ```json block and validates it against the schema (AJV 2020). Agents without `output-schema:` fall through with `mode: 'unvalidated'` (backward-compatible). `scripts/validate-plugin.mjs` Check 7 compiles every declared schema at plugin-distribution time so broken schemas fail fast. Currently declared: `code-implementer`, `db-specialist`, `test-writer`, `ui-developer` (W2 of issue #417); the remaining 7 agents are scoped for a follow-up issue.

Reference: https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/agent-development/SKILL.md

## Operational Rules <!-- consistency:exempt:runtime-only -->

- **CI status MUST be surfaced at session-start** — Local-only test runs are insufficient evidence of CI green. The 8-pipeline silent regression (2026-05-09 deep-3 → 2026-05-10 deep-1, fixed in deep-2) is the cautionary tale. Phase 4 of session-start invokes `scripts/lib/ci-status-banner.mjs` via `checkCiStatus({ repoRoot })` to render a 🚨 banner when CI is red on HEAD. Never assume CI is green from `npm test` results alone.

## Current State

- **Plugin version:** v3.6.0 (released 2026-05-14, GitHub + GitLab tag). Previous releases v3.5.0 (2026-05-09), v3.4.0 (2026-05-08), v3.3.0 (2026-04-30) at https://github.com/Kanevry/session-orchestrator/releases.
- **Active epic:** none — v3.2 Autopilot epic (#271) closed 2026-04-30 (all phases shipped). Sub-issues #297 (calibration, needs ≥10 RUNS) + #298 (evolve type 8, needs runtime data) remain data-gated on autopilot RUN-Volumen, not on code.
- **Stack:** Node 20+, vitest 4.1.5, ESLint 10. Run `npm ci` after cloning. Test: `npm test`. Lint: `npm run lint`. Coverage thresholds 70/65/70/60.
- **Tests:** 5632 passed / 0 failed / 12 skipped (+2 net from 2026-05-18 housekeeping-1 #454 fix). validate-plugin 87/87, typecheck 73/73, lint 0.
- **Backlog:** ~30 open. Closed this session: 6 issues (#415 worker-pool + #416 language-mappers Phase 1 + #417 schema-per-agent-output + #418 sandbox-tier + #419 triage-state + #420 --since flag). Filed: #447 (continueOnBlock prompt-hook migration spike) + #448 (autopilot STALE_SUBAGENT_MIN refactor) + 7 follow-up issues (coord-direct W5). Data-gated: #297 / #298.

### Recent sessions (one-line summaries; long-form in [[01-projects/session-orchestrator/decisions]])

- **2026-05-17 deep-2** — Clawpatch Borrow Cluster #415–#420 shipped. 5W × 22 agents, 0 partial/failed/spiral. **6 features delivered**:
    - **#417 schema-per-agent-output**: NEW `scripts/lib/agent-output-schema.mjs` (163 LOC, lazy AJV 2020) + NEW `scripts/lib/ajv-loader.mjs` shared helper (34 LOC, post-Q2 fold-in) + 4 NEW `agents/schemas/*.schema.json` (Draft 2020-12: `code-implementer`, `db-specialist`, `test-writer`, `ui-developer`) + `output-schema:` frontmatter on 4 implementer agents + "Machine-readable contract" section in 4 agent bodies (post-Q2 HIGH-001 fold-in) + check-agents.mjs Check 7 (+4 PASS lines). Scope reduced from 11 → 4 agents in W2; 7 deferred to follow-up.
    - **#415 worker-pool**: NEW `scripts/lib/wave-executor/pool.mjs` (230 LOC, cursor-based concurrency over Promise.all, reuses aggregator.mjs AbortSignal substrate). Session Config field `worker-pool.{enabled,max-parallel,drain-timeout-ms}`. Backward-compat: `enabled: false` default. `skills/wave-executor/wave-loop.md` + `SKILL.md` + `docs/session-config-reference.md` updated.
    - **#420 --since flag**: NEW `scripts/lib/discovery-helpers.mjs::changedFilesSince(ref)` (119 LOC, execFile-based, no shell-spawn, shell-meta guard) + `commands/{discovery,test}.md` + `skills/{discovery,test-runner}/SKILL.md` Phase wiring. Vault-staleness + harness-audit probes EXEMPT (whole-repo semantics).
    - **#418 sandbox-tier**: NEW `scripts/lib/validate/tier-inference.mjs` (100 LOC, 4-tier vocabulary: `read-only`/`repo-write`/`network-allowed`/`dangerous`) + all 11 `agents/*.md` flagged with `sandbox-tier:` frontmatter + check-agents.mjs Check 8 (+11 PASS lines).
    - **#419 triage-state**: NEW `scripts/lib/discovery/triage-state.mjs` (269 LOC, sha256-16 fingerprint = probe+file+severity+ruleId, 5-state enum, last-writer-wins JSONL append) + `skills/discovery/SKILL.md` Phase 5.0 + new "Discovery Triage State (#419)" subsection. End-to-end smoke validated coord-direct.
    - **#416 Phase 1 language-mappers**: NEW `scripts/lib/language-mappers/{index,typescript,markdown}.mjs` (656 LOC total: index 118, typescript 395, markdown 143). 5 NEW deps (`@babel/parser`, `remark`, `remark-parse`, `unified`, `mdast-util-to-string`) + cache-hoisted dispatcher (post-Q2 MED-005 fold-in). Phase 2 (Swift + Python regex protos) deferred to follow-up.
  - Inter-wave reviews: W2-Q1 security PROCEED-WITH-FOLLOWUPS (1 MED `loadAgentSchema` path-traversal — folded in, 1 LOW ajv-formats unused — removed). W3-Q2 architect PROCEED-WITH-FIXES (HIGH-001 schema-vs-body drift, MED-004 dup-AJV, MED-005 mapper-cache — all 3 folded in). W4-Q3 qa-strategist PROCEED-WITH-FOLDIN (5 HIGH gaps, 3 addressed by T1). W4-Q4 session-reviewer PROCEED — clean for W5 commit.
  - Tests **5421 → 5630p/0f/12s** (+209 net: 141 W2+W3 + 68 W4-T1). validate-plugin **72 → 87** (+15 canaries: 4 Check 7 + 11 Check 8). typecheck 70 → 73 (+3 NEW modules). lint 0. Full Gate GREEN. 7 follow-up issues filed coord-direct in W5.
- **2026-05-17 deep-1** — CC 2.1.x Adoption Cluster + #436 routing-bug + #426 audit-umbrella closure. **10 issues shipped** (#427 monitors + #428 additionalContext-adjusted + #429 terminalSequence + #430 disable-model-invocation × 12 commands + #431 bg-isolation + #432 description-enrichment-adjusted + #433 $schema + #434 model: routing × 36 skills + #435 Skill(*) wildcards × 5 workers + #436 routing table). 5W×6 (5+6+6+5+2 = 24 agents, 0 partial/failed/spiral, ~95min wall). Adjusted scope per W1-D1 platform research (continueOnBlock prompt-hook-only → additionalContext fallback; 0 skills > 1024 chars → enrichment-only). 4 coord-direct fold-ins (Q1 SEC-016 control-char, Q2 canary guard cleanup + 3 lint, Q4 lint + negative-fixture canary, F2 ESC-byte fix). Filed #447 (continueOnBlock prompt-hook migration spike) + #448 (STALE_SUBAGENT_MIN refactor). Tests **5303 → 5421p/0f/11s** (+118). validate-plugin **46 → 72** (+26 canaries). Full Gate GREEN (typecheck 70/70, lint 0). Commit pending user approval.
- **2026-05-16 deep-1** — Anthropic prompt-cache pre-warm cluster shipped across 4 PoC repos (GL #421-#425): `#421` `.claude/rules/prompt-caching.md` NEW (262 LOC, PC-001..PC-007); `#422` `extern/AngebotsChecker` — `instrumentation.ts` NEW + `route.ts`/`CompareStreamContext`/`streamTurnToClient` split for PC-002 two-block correctness + pre-warm hook with usage logging (coord-direct hot-fix per W4-A5 smoke-test); `#423` `Bernhard/buchhaltgenie` — `chat-v2/route.ts` 2-block system + `agentic-loop.ts` providerOptions + `vercel.json` cron + cron route NEW (`*/4 8-18 * * 1-5` business-hours pre-warm), Vercel AI SDK + `@ai-sdk/anthropic@^3.0.64`; `#424` `intern/launchpad-ai-factory` — `adapter.ts` `cacheableSystem?` helper + `types.ts`/`tag-enricher.*`/`synth.ts` SYNTH_SYSTEM_PROMPT_STABLE split; `#425` `extern/wien-forschungsfragen-klima` — `llm-rerank.ts:277` + `llm-translate.ts:205` block-array wrap, raw SDK 0.96.0 `betas:` header OMITTED (graduated to GA). **Live smoke test** (W4-A5, AngebotsChecker, opus ~$0.21): Call 1 `cache_creation=4141` → Call 2/3 `cache_read=4141` — PC-007 PASS. 5W × **16 agents** (3+2+4+5+2), 0 partial/failed/spiral, 1 coord-direct hot-fix. Cross-repo gates GREEN: AngebotsChecker 99/99 (4 test files updated for triggerSystemBlock contract), buchhaltgenie 95p (`reason`→`error` 1-line fix), launchpad-ai-factory 217p, wien-forschungsfragen-klima 2261p. session-orchestrator: no source changes — Tests **5303p/0f/11s** (unchanged), CI GREEN @ `d8b5471`.
- **2026-05-16 deep-4** — Marketplace + SEC cluster closed: GH #44 (`scripts/lib/gitlab-portfolio/cli.mjs:230-246` path-traversal guard via `validatePathInsideProject` against `os.homedir()` — two-phase lexical+symlink, mirrors playwright-driver/runner.mjs:130-142 pattern from #402 deep-5; `skills/gitlab-portfolio/SKILL.md` `### Security` subsection with vault-dir-must-be-child note) + GH #43 (`assets/icon.svg` NEW 998-byte five-wave glyph + `.codex-plugin/plugin.json` `interface.composerIcon` field + version bump 3.5.0→3.6.0 stale-sync) + GH #34 (`docs/marketplace/awesome-codex-plugins-submission.md` + `docs/submissions/awesome-codex-plugins-pr-body.md` NEW — icon-enhancement PR for existing hashgraph-online listing, NOT new-listing per W1 D2 finding) + GL #213 (`docs/marketplace/composio-submission.md` refreshed v3.2.0→v3.6.0 + `docs/submissions/composio-awesome-claude-plugins-pr-body.md` NEW for ComposioHQ/awesome-claude-plugins, "Session & Workflow Orchestration" category proposal + Developer Productivity fallback) + `scripts/lib/validate/check-codex-plugin.mjs` NEW (R6 composerIcon validator: field-presence + file-exists + valid-XML/SVG-root, 3 PASS lines) + `README.md` `### vs. maestro-orchestrate` 5-axis comparison subsection (14 lines). 5W×4-agent parallel ~75min, **14 agents** (3 D + 4 I + 4 P[+1 from W2 BLOCK] + 3 Q + 0 F coord-direct = 14). W2 session-reviewer caught BLOCK (7/15 cli.test.mjs regressed because `/vault` fixtures rejected by new guard) — folded fixture fix into W3 P4 (`/vault` → `TEST_VAULT_DIR = path.join(os.homedir(), '_test-vault-gitlab-portfolio')`). W4 Q1 added 5 traversal integration tests + Q2 added 12 validate-plugin R6 tests. Coordinator inline fix: 1-line lint (Q1's unused `afterEach` import). Tests **5285 → 5303p/0f/11s** (+18 net: 5 Q1 traversal + 12 Q2 R6 + 1 foreign-session port-fix). validate-plugin **43 → 46** (+3 R6 PASS lines). Full Gate GREEN (typecheck 68/68, lint 0). PSA-001 (passive): 4 foreign-session test files modified during W3 (Windows-portability: `node`→`process.execPath`, `:`→`delimiter`); none in our scope, all green, NOT staged. Session-reviewer (full-scope): PROCEED, 0 blocking, 8/8 categories PASS.
- **2026-05-16 deep-3** — Anthropic-adoption cluster closed: GL #409 (`hooks/operator-steer.mjs` NEW + PostToolBatch registration in hooks.json + hooks-codex.json — STEER.md operator handshake from anthropics/cwc-long-running-agents) + GL #410 (`skills/mcp-builder/SKILL.md` 164→250 lines, new "Tool-Hosting Pattern" section with @tool decorator + in-process MCP + readOnlyHint/destructiveHint annotations from anthropics/claude-agent-sdk-python) + GL #411 (`gen_ai.*` OTel aliases additive to `subagents.jsonl` only — events.jsonl deferred, model + finish_reason require upstream harness changes; scope reduced via AUQ) + GL #412 (`agents/security-reviewer.md` Hard Exclusions section, 5 new FP-pattern sub-classes from anthropics/claude-code-security-review claudecode/findings_filter.py:L20-100, ~35%→15% empirical FP reduction) + GL #414 (knowledge-work-plugins submission prep: `docs/marketplace/knowledge-work-plugins-submission.md` + `docs/submissions/knowledge-work-plugins-pr-body.md`, manifest already compliant) + GH #45 (`scripts/lib/gitlab-portfolio/aggregator.mjs` execWithTimeout refactor: promisify(execFile) → spawn() + AbortSignal per playwright-driver/runner.mjs pattern; opts-override rename `execFile`→`spawn`). 5W coord-direct ~95min, **14 agents** (4 D + 4 I + 3 P + 3 Q + 0 F coord-direct = 14). 0 partial/failed/spiral. Tests **5255 → 5285p/0f/12s** (+30 net: 8 operator-steer + 11 OTel-aliases + 11 security-reviewer-exclusions). Full Gate GREEN (typecheck 68/68, lint 0, validate-plugin 43/43). 5 aggregator tests rewrote mocks promisify→EventEmitter-spawn (P3 carryover). Components: 37 skills, 16 commands, 11 agents, 11 hook handlers / 11 matchers (+1 handler operator-steer). Test contention flake observed at session-start (9 Claude processes) — single re-run cleared it per mac-gitlab-runner learning.
- **2026-05-16 deep-2** — Superpowers-adoption cluster closed: GH #35 umbrella + #36 (skills/brainstorm/ NEW + commands/brainstorm.md, HARD-GATE-gated Socratic design dialogue) + #37 (skills/debug/ NEW + commands/debug.md, 4-phase Iron Law systematic debugging with `.orchestrator/debug/` artifact contract) + #38 (.claude/rules/verification-before-completion.md NEW, VBC-001..005, banned phrases + 5-step Gate Function) + #39 (skills/write-executable-plan/ NEW + plan-template.md + docs/plans/2026-05-16-superpowers-cluster.md retrospective dogfood) + #40 (.claude/rules/receiving-review.md NEW, RCR-001..006, forbidden phrases + 6-step pattern). 11 NEW files + 9 cross-ref edits (wave-executor, code-implementer, session-reviewer, plan, session-plan, development.md, testing.md, cli-design.md with bidirectional See-Also). 5W×NA parallel (4+4+3+4+2 = 17 agents). 0 partial/failed/spiral. Tests **5129 → 5256p/0f/11s** (+127 net: 34 brainstorm/debug + 50 VBC/RCR + 42 write-executable-plan + 1 misc). Full Gate GREEN (typecheck 67/67, lint 0, validate-plugin 43/43). Coordinator inline fix: tests/skills/debug.test.mjs removed unused `yaml` import (1-line lint). D4 finding: validate-plugin auto-discovers skills via filesystem — no count-assertion update needed.
- **2026-05-16 deep-1** — GH #42 (echo-stub detector) + GH #41 (gitlab-portfolio skill, 6 files NEW: skills/gitlab-portfolio/SKILL.md + scripts/lib/gitlab-portfolio/{aggregator,markdown-writer,cli,vcs-detect}.mjs + scripts/lib/config/gitlab-portfolio.mjs; commands/portfolio.md NEW; docs/recipes/quality-gate-container-pattern.md NEW; skills/session-end Phase 2.0a + skills/session-start Phase 2.7 wire-up). 5W×NA parallel (4+4+3+4+2 = 17 agents). 0 partial/failed/spiral. Tests **5001 → 5129p/0f/12s** (+128 net). Full Gate GREEN. Q3 security PASS-WITH-FOLLOWUPS: filed GH #44 (MED path-traversal --vault-dir, conf 0.80) + GH #45 (LOW execFile timeout abort, conf 0.75). Coordinator inline fixes: gate-baseline.test.mjs fixtures (4 lines, echo→node-e) + cli.mjs:224 AGENTS.md alias.
- **2026-05-16 housekeeping-1** — Express Path coord-direct CI restore (#408: `apt-get` guard for Mac shell-runner + `vitest.config.mjs` CI `testTimeout` 30s + gitleaks `entrypoint:[""]`) + @lib alias rollout (#407: **124 test files**, 35 → 159 alias adopters; 2 child-spawn-target exemptions: `tests/fixtures/io-driver.mjs` + `tests/unit/rules-sync.test.mjs:20`). 3 commits (`479181c`, `f03cc1e`, `a8a64a9`). Tests **5001p/0f/12s** (zero delta), validate-plugin **43/43** (zero delta). **CI pipeline #4068 GREEN** (5 jobs: gitleaks 4s ✅, npm-audit 5s ✅, test 256s ✅, schema-drift 21s ✅, coverage 25s ✅ retry). PSA-001 parallel-session signal: `3b45e83` `/memory-cleanup` skill landed by separate session (no scope overlap, no pause).
- **2026-05-14 deep-5** — `validatePathInsideProject` helper extraction + @lib alias rollout (33 files) + boundary tests (#402 #404 #405 #406; #407 filed). Tests 4982 → **5001p/0f/12s** (+19). validate-plugin **39 → 43**. Commit `a758fdb`.
- **2026-05-14 deep-4** — /test pipeline housekeeping cluster: Division-of-Responsibility doc-sync, `shared/profiles → profiles/` rename, runDir traversal MED, AbortController tests (#395 #396 #397 #398 #399 #400 #401). validate-plugin **36 → 39**. Commit `522e839`.
- **2026-05-14 deep-3** — /test live-run vs aiat-pmo-module: mechanism proven, reporter-syntax bug fixed inline (`html,json` not Jest-style `html:<path>`) + #390 #391 #393 #394. validate-plugin **34 → 36**. Commit `07d1985`.
- **2026-05-14 deep-2** — /test Track B: `peekaboo-driver` skill + `playwright-driver/runner.mjs` (260 LOC, spawn + AbortSignal) + #385 mechanism-proof (#381). validate-plugin **31 → 34**. Commit `253a4ab`.
- **2026-05-14 deep-1** — CI restore + `/test` command + Track A skeleton (#379–#389). validate-plugin **28 → 31**. Commits `3aee4cc` + `cb3e942`.

For older session narratives (2026-04-27 → 2026-05-12), release histories, and meta-audit fallout see [[01-projects/session-orchestrator/decisions]] in the Meta-Vault. Quick commit index: `a8a64a9` + `f03cc1e` + `479181c` (housekeeping-1 2026-05-16) · `a758fdb` (deep-5) · `522e839` (deep-4) · `07d1985` (deep-3) · `253a4ab` (deep-2) · `3aee4cc` (deep-1 CI restore) · `cb3e942` (deep-1 Track A) · `a5c354e` (#214 stub) · `5cfa469` (#378 PRD) · `7b71573` (#375/376/377) · `abd82aa` (#374) · `eb820ca` (#370/371/373) · `12c0df4` (#364 substrate) · `ed83019` (CI restoration) · `7158b82` (v3.4.0). The PRDs for v3.2 Autopilot live at [[01-projects/session-orchestrator/prd/2026-04-24-state-md-recommendations-contract|Phase A]] / [[01-projects/session-orchestrator/prd/2026-04-25-mode-selector|Phase B]] / [[01-projects/session-orchestrator/prd/2026-04-25-autopilot-loop|Phase C]].

## Session Config

persistence: true
enforcement: warn
recent-commits: 20
test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
stale-branch-days: 7
plugin-freshness-days: 30
plan-baseline-path: ~/Projects/projects-baseline
plan-prd-location: docs/prd
plan-retro-location: docs/retro
plan-default-visibility: internal
vcs: gitlab
auto-skill-dispatch: false               # opt-in; phrase-match meta-skill — see skills/using-orchestrator/SKILL.md
vault-integration:
  enabled: true
  vault-dir: ~/Projects/vault
  mode: warn               # strict | warn | off
docs-orchestrator:
  enabled: false           # opt-in; when true, session-start Phase 2.5 runs + docs-writer agent available
  audiences: [user, dev, vault]
  mode: warn               # warn | strict | off
vault-staleness:
  enabled: false           # opt-in vault-drift probes (runs in /discovery vault)
  thresholds:
    top: 30                # days — tier=top narrative staleness threshold
    active: 60             # days — tier=active
    archived: 180          # days — tier=archived
  mode: warn               # warn | strict | off
persona-reviewers:
  enabled: false           # opt-in inter-wave architecture/QA/PRD audits
  reviewers: []            # ["architect-reviewer", "qa-strategist", "analyst"]
  mode: warn               # warn | strict | off
