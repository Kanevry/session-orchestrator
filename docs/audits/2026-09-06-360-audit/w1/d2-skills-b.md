# d2 — Skills-Audit B (skills/[n-z]* + _shared) — 2026-09-06 @ e4674109

## Summary
- 24 dirs (not 25): skills/session, skills/test, skills/templates-ack DO NOT exist (they are commands/*.md; the harness lists commands in the skill picker). remote-offload and ubiquitous-language were missing from the task list.
- 1 retire (_shared/model-selection.md: 0 consumers, only docs/changelog/v2.md), 1 deprecate class (skill-creator + ubiquitous-language: 0/0/0, last commit 2026-05-17), 1 merge (_shared/parallel-aware-auq.md + parallel-aware-preamble.md → one file, identical 5-skill consumer set), 4 shrink.
- Over-spec SKILL.md (>500 lines) repo-wide = exactly 6: session-start 1275, session-end 1203, evolve 720, bootstrap 593, discovery 571, session-plan 563. wave-executor/SKILL.md 497 and plan/SKILL.md 498 are compliant, BUT wave-executor/wave-loop.md is 1337 (the real body).
- #1157 is at 0 %: `find skills -type d -name references` → none; the finding grew since filing (session-start 1244→1275).
- using-orchestrator: auto-skill-dispatch:true in 0 of 2 repos carrying the key → keep-dormant.
- vault-sync: 867 files on disk, 32 tracked → 835 untracked vendored deps (.ts/.js) — gitignore or document.
- templates-ack: command + hook bypass (hooks/pre-bash-templates-first.mjs reads the ack marker); command telemetry only instrumented for templates-ack + session → "13 pings all fleet" says nothing about external use.
- PRD contradiction: PRD cites 4,098 tmux-layout.invoked events; grep across fleet events.jsonl → 0.

## Table (SKILL/total lines, files | last commit | telemetry | fleet 90d/30d | consumers | verdict)
_shared –/1605,9 | 09-05 | ref-only | top files: instruction-file-resolution 56 refs, bootstrap-gate 26, config-reading 24, state-ownership 19, platform-tools 15; model-selection.md 1 ref (changelog) → retire; auq+preamble merge | shrink
npm-publish 69 | 08-21 | 0 | 0/0 | scripts/release.mjs, commands/release.md | keep (rare by design)
peekaboo-driver 249/281 | 08-24 | 0 | 2/0 | dispatched by test-runner | keep
persona-panel 367/833,5 | 08-25 | 5 | 5/0 | command, pi, 2 tests | keep
plan 498/1815,9 | 08-22 | 43 | 72/8 | 24 files | keep (compliant)
playwright-driver 226/256 | 05-17 | 0 | 2/0 | test-runner | keep (3.7 months stale)
quality-gates 212 | 07-25 | 0 | 9/0 | 5 skills + 3 docs (reference skill) | keep
reconcile 384 | 09-02 | 10 | 12/5 | 4 scripts, pi, 2 tests | keep
remote-offload 89 | 09-03 | 0 | 0/0 | 2 tests | keep (3 days old, HR-105)
repo-audit 281 | 08-15 | 1 | 4/0 | command, pi, 1 script | keep
session-end 1203/2859,12 | 09-05 | 323 | 713/153 | 74 files | SHRINK (>2× spec)
session-plan 563/603,2 | 08-28 | 212 | 517/86 | 12 files, commands/go.md | shrink (63 lines over)
session-start 1275/2229,8 | 09-05 | 248 | 949/153 | 65 files | SHRINK (>2.5× spec)
skill-creator 168 | 05-17 | 0 | 0/0 | none (docs/components, sunset report, PRD) | deprecate
spinout 80 | 08-15 | 0 | 0/0 | command, pi, development.md | keep (rare)
sunset-review 106 | 08-15 | 0 | 0/0 | command, pi, walker.mjs | keep (quarterly)
test-runner 362/796,3 | 08-22 | 2 | 4/0 | commands/test.md, 1 agent, 3 skills | keep
tmux-layout 109 | 08-15 | 3 | 0/0 | 3 skills, 1 script, 3 tests | keep
ubiquitous-language 97 | 05-17 | 0 | 0/0 | skill-creator xref, 1 test, 1 fixture | deprecate
using-orchestrator 144 | 08-22 | 0 | 1/0 | bootstrap-gate.md prose (gated) | keep-dormant
vault-mirror 243 | 08-15 | 1 | 2/0 | session-end 3.7, 2 scripts | keep
vault-sync 328/852,21 | 09-03 | 2 | 0/0 | 27 files, hard gate session-end Ph.1 | keep + fix untracked tree
wave-executor 497/2030,3 | 09-05 | 243 | 585/110 | 74 files | shrink (wave-loop.md 1337)
write-executable-plan 237/391 | 08-22 | 0 | 2/0 | 1 agent, brainstorm cmd, 4 skills | keep

## Split plan
session-start 1275 → ~380: move Phase 1.1 (76–126), 1.2+1.2.1 (127–262), 1.5 (263–497, 235 lines), 1.7 (506–554), 2.7 (635–705), 4 (724–874, 151), 6.5.1+6.5.2 (917–987), 6.6 (988–1064), 6.7+6.8 (1065–1163) → references/phase-*.md. Tests to keep green: tests/skills/session-start/what-not-to-retry-surface.test.mjs (reads SKILL.md + presentation-format.md), historical-guard-wiring.test.mjs, tests/scripts/validate/check-banner-parity.test.mjs (checks SKILL.md:1).
session-end 1203 → ~330: Phase 1 (64–340, 277) fold into existing plan-verification.md (dedup), Phase 2 (341–429), Phase 3 (504–728, 225), 4a (832–947), 4b (948–1001), 5 (1002–1101), summary template (1107–1162). Keep Phase 4 Commit&Push (753–831) in core. Tests: session-end-cleanup.test.mjs (asserts Phase 4a in SKILL.md → retarget), github-mirror-push.test.mjs (slice in Phase 4, stays), handover-gate-wiring (4×), broken-window-wiring, phase-2-3-vault-staleness. CLAUDE.md gotcha Phase 4a pointer must move.
wave-loop.md 1337 → ~22-line index: Wave Execution Loop (7–542) → references/wave-loop-dispatch.md; Reasoning format (543–1167, 625 lines!) → references/wave-loop-reasoning-format.md; Scope Manifest (1184–1337) → references/wave-loop-scope-manifest.md. HIGHEST RISK: 13 test files read wave-loop.md (materialize-wave-scope 4×, print-learnings-index 3×, scope-baseline 3×, wave-loop-scope-marker 2×, wave-scope-producer 2×, handover-gate-wiring 2×, persona-reviewers 2×, validate-wave-scope, scope-gate, peer-discovery, print-applicable-rules, check-skill-script-paths, wave-scope-commit-guard, quality-gate-shared-lib-touch) + CLAUDE.md gotcha #1020 points at § Scope Manifest 3.1/3.2. Move Scope Manifest LAST, own commit.
_shared: monitor-patterns.md 346 lines, 1 skill consumer but loop-and-monitor.md + check-doc-cli-commands.mjs point at it → keep.

## Recommendations
R1 delete _shared/model-selection.md (S) — rg → 0; lint green.
R2 merge parallel-aware-auq + preamble → parallel-aware.md (S) — 9 refs; tests auq/parse + parallel-detection-e2e green.
R3 deprecate skill-creator + ubiquitous-language (S) — components.md counts; architecture-ddd-trio test adjusted.
R4 session-start split (M) — SKILL.md < 500; vitest session-start + check-banner-parity green.
R5 session-end split (M) — < 500; session-end tests + on-session-end hook test green; CLAUDE.md Phase-4a pointer.
R6 wave-loop.md split (L) — Scope Manifest last, own commit; scope tests green; CLAUDE.md #1020 pointer.
R7 session-plan 563 → < 500 (S).
R8 vault-sync untracked tree (S) — git status clean; check-ignore.
R9 mechanical size gate SKILL.md > 500 as harness-audit check (M) — fails on HEAD with 6, green after R4–R7; should measure skill-dir core, not only entry file.

## Open questions
1. playwright-driver, skill-creator, ubiquitous-language all last touched 2026-05-17 — same commit/batch?
2. DDD trio (architecture, domain-model, ubiquitous-language) bound by architecture-ddd-trio test — decide as one block with d1's domain-model verdict.
3. remote-offload 0/0 at 3 days old — falsify with a real call before any sunset.
4. Is agentskills.io compliance the goal? A line gate on SKILL.md rewards the wave-loop.md pattern; needs a "core vs references" definition.
STATUS: done
