# d1 — Skills-Audit A (skills/[a-m]*) — 2026-09-06 @ e4674109

## Summary
1 retire (daily), 2 deprecate (contract-version-bump, journey-audit), 1 merge (domain-model → architecture/references), 4 shrink (autopilot 423, bootstrap 593, discovery 571, evolve 720; convergence-monitoring docs). 26 dirs (not 25): domain-model, eli5, journey-audit exist; autopilot-multi has NO skill dir (only command + pi prompt). 13,313 md lines.
Key measurement: 394 of 490 telemetry pings are the operator's M4, 55 the M5; the two external ids used ONLY session-end/wave-executor/session-start/session-plan/plan → no a–m skill has any external signal → "deprecate" (warn external users) is mostly the wrong category here.
Corrections to PRD Verschlankung: convergence-monitoring is NOT dead (scripts/lib/convergence-monitor.mjs registered in monitors/monitors.json on-skill-invoke:wave-executor, hot on every wave-executor run); ecosystem-health has a self-referential dead monitor trigger (on-skill-invoke:ecosystem-health, a skill with 0 invocations anywhere).

## Table (lines(SKILL.md) | files | last commit | telemetry | fleet 30d/90d | invoke | consumers | flags | verdict)
architecture 226(92) 4 07-02 | 3 | 0/10 | skill | discovery/probes-arch cross-ref | keep
autopilot 423 1 08-28 | 0 | 0/4 | skill+/autopilot | scripts 28, hooks, pi | no references/ | shrink
bootstrap 2981(593) 11 08-28 | 3 | 2/4 | skill+/bootstrap | gate hook, scripts 17 | 593>500, 10 flat md | shrink
brainstorm 375(268) 2 08-22 | 0 | 0/0 | skill+/brainstorm | commands, agents 1 | 0 invocations both | keep (command entry)
claude-md-drift-check 194 4 08-26 | 0 | 0/4 | skill | drift-check.enabled true, scripts 6 | keep
contract-version-bump 219 1 09-02 | 0 | 0/0 | skill+cmd | none (1 comment) | 2 death signals | deprecate
convergence-monitoring 625(285) 3 09-05 | 0 | 0/0 | skill | monitors.json on wave-executor (hot) | docs cold | shrink
daily 222 3 05-17 | 0 | 0/0 | skill | none (tests + docs/vault-docs-architecture only) | 2 death signals, no cmd | RETIRE
debug 226(191) 2 08-15 | 16 | 10/155 | skill+/debug | hooks 3, agents 1 | keep
discovery 2809(571) 20 08-22 | 6 | 0/27 | auto | hooks 5, scripts 14, probes/ | 571>500, 14 flat md | shrink
dispatcher 183 1 09-05 | 0 | 0/0 | skill+/dispatcher | scripts 13, commands/autopilot | keep
docs-orchestrator 502(362) 2 05-17 | 3 | 0/6 | auto | agents/docs-writer, hooks 1 | enabled:false | keep (flag-gated)
domain-model 209(85) 3 05-17 | 0 | 0/0 | reference-only (disable-model-invocation) | architecture links + 1 test | merge → architecture/references
ecosystem-health 320(122) 2 09-02 | 0 | 0/0 | auto | monitors.json but trigger dead | config keys absent | keep + fix trigger
eli5 43 1 08-22 | 21 | 1/1 | /eli5 | commands, pi | keep
eval 511(293) 2 07-18 | 2 | 0/4 | skill+/eval | scripts 16, hooks 1, agents/eval-judge | judge off | keep
evolve 720 1 09-03 | 14 | 2/52 | auto+/evolve | scripts 29, hooks 3, agents 4 | 720>500 monolith | shrink
frontmatter-guard 134 1 08-15 | 0 | 0/0 | skill | scripts/lib/frontmatter-guard.mjs + wave-loop pre-dispatch | keep
gitlab-ops 395 1 08-21 | 22 | 6/87 | auto | skills 6, scripts 3 | keep
gitlab-portfolio 205 1 08-15 | 0 | 0/1 | skill+/portfolio | scripts 4, hooks 1 | enabled key absent | keep (flag-gated)
grill 299(185) 2 08-22 | 0 | 0/12 | skill+/grill | commands, scripts 2 | keep
hook-development 413 1 08-03 | 0 | 0/1 | skill | 2 comment citations | keep (authoring ref)
journey-audit 270 1 09-02 | 0 | 0/0 | /journey-audit | commands, pi; 0 manifests fleet-wide | never runnable | deprecate
mcp-builder 260 1 06-27 | 1 | 0/4 | skill | none (ADRs/CHANGELOG) | keep (weakest)
memory-cleanup 323 1 08-22 | 18 | 2/53 | skill+cmd | scripts 8, skills 5 | keep
mode-selector 226 1 07-25 | 0 | 0/0 | auto | session-start Phase 7.5, scripts 5 | keep

## Evidence (verbatim commands in agent transcript): ls -d skills/[a-m]*/ → 26; telemetry byAnon; fleet ledger 40 files / 4101 lines window 2026-06-14..2026-09-06 (30d: debug 10, gitlab-ops 6, memory-cleanup 2, evolve 2, bootstrap 2, eli5 1; 90d: debug 155, gitlab-ops 87, memory-cleanup 53, evolve 52, discovery 27, grill 12, architecture 10, docs-orchestrator 6, mcp-builder 4, eval 4, drift-check 4, bootstrap 4, autopilot 4, hook-development 1, gitlab-portfolio 1, eli5 1; 0/0: brainstorm, contract-version-bump, convergence-monitoring, daily, dispatcher, domain-model, ecosystem-health, frontmatter-guard, journey-audit, mode-selector). walker: coverageDays 0, lowConfidence, reads only local ledger (useless here). monitors/monitors.json: convergence-monitor on-skill-invoke:wave-executor; ecosystem-health on-skill-invoke:ecosystem-health (circular). Config keys ecosystem-health/health-endpoints/gitlab-portfolio absent from CLAUDE.md. journey-manifest.md: 0 fleet-wide. check-skill-script-paths: PASS 1107 citations/259 docs. No skills/[a-m]*/references dir exists.

## Recommendations
1. Remove skills/daily (S) — acceptance: rg -l "skills/daily" --glob '!docs/**' --glob '!tests/**' → 0; check-skill-script-paths PASS. (Test tests/skills/daily/generate.test.mjs goes with it.)
2. Move domain-model into skills/architecture/references/ (S) — acceptance: rg -c domain-model skills/architecture/SKILL.md → 0; architecture-ddd-trio test green after path update.
3. Fix ecosystem-health monitor trigger (S): rehang to on-skill-invoke:session-start and/or gate on health-endpoints; acceptance: watcher events in events.jsonl after a session start.
4. Shrink convergence-monitoring docs (M): keep SKILL.md, fold SIGNALS.md+README.md into references/; acceptance: dir md lines < 400, monitors.json unchanged.
5. Deprecate contract-version-bump + journey-audit (S each): stub + warning one minor cycle.
6. Resolve autopilot-multi inconsistency (S): command+pi prompt without skill dir; registry lists session-orchestrator:autopilot-multi.
7. references/ pattern for evolve/bootstrap/discovery (M): SKILL.md < 500 each; npm test green.

## Open questions
- What feeds the skill registry (plugin.json skills: null; autopilot-multi listed)?
- Does on-skill-invoke:<x> in monitors.json count as a runtime consumer of <x>? (coordinator convention needed)
- brainstorm/dispatcher: 0/0 invocations but command wrappers — policy question whether a wrapper is a life signal.
STATUS: done
