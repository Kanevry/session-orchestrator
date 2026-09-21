# Close evidence: Codex session entrypoints

Date: 2026-09-19. Implementation commit: `176b605c`. Branch: `codex/session-entrypoints`.

The [integration and release handover](2026-09-19-codex-session-entrypoints.md) is the next session's starting point. Priority carryover **#1391** remains open until merged, released and activated. No release or production plugin update happened in this session.

## Quality and review

The formal full gate ran for 237 seconds and exited 0: typecheck passed with 0 errors, all 17,724 reported tests passed across 692 files, lint passed with 0 warnings. There were no nonempty stubbed checks, failed test files, suite deaths or debug artifacts. This is local evidence, not remote CI.

The post-close instruction correction changes only delegation guidance, and the final pushed tracked tree is checked again by the normal pre-push hook. All four generator checks passed after that correction: portable 80 artifacts, native Codex 79 artifacts, Cursor 27 commands / 50 skills, Pi 27 prompts. The plugin validator passed 230 checks with 0 failures.

Independent branch review found no remaining blocker. Scoped embedded discovery covered seven probes and verified one medium finding: close discovery still forbade delegation categorically on Codex. That sentence now uses available runtime delegation with a sequential fallback. No finding was silently deferred. The scan intentionally excluded unrelated backlog, UI, vault, architecture and portfolio work; it is not a full repository audit.

Separate native/package acceptance used a fresh isolated Codex home, public marketplace/add and plugin/add, native skills/list and plugin/read, eight installed-parser stdin cases and an actual tarball with 13 selected files compared byte-for-byte. The candidate was `5.2.0+codex.20260919063435`; no user's plugin installation, trust setting or model was changed. The actual LLM lifecycle and visible picker remain release acceptance tasks.

## Session finalization

- Recovered this session's own archived plan through the locked STATE writer. Native identity/start time came from the matching Codex session metadata; no foreign lock or STATE was adopted.
- Validated session metrics were appended once through `scripts/emit-session.mjs` (schema version 2), before marking STATE completed. Four waves include the separately requested close wave. Seven unique workers: five complete, two interrupted discovery workers counted partial. Unknown token/cost data remain null.
- The task came directly from the user, so planned issue count is 0; carryover is 1. The deterministic v0 recommendation consequently says `plan-retro` from the zero-denominator completion convention. **The user's explicit next-session instruction and top priority #1391 take precedence: integrate the MR and complete release activation.** Do not misread the numerical issue metric as failed implementation work.
- Session evaluation and its HTML report were emitted. The model field is unknown where the runtime provided no authoritative model ID; no invented model attribution or performance score is used as release evidence.
- Local STATE, metrics and eval files remain in their repository-configured ignored locations. This tracked report and handover preserve portable evidence; the unique session summary was also mirrored to the configured vault and committed there by the normal writer.
- No own lock existed at close; the ownership-aware release returned `no-lock`. No own snapshot refs existed. The worktree is retained for the next session and is not an auto-promoted cleanup candidate.
- A live peer remained in the main checkout. Shared per-project vault board/narrative close and repo-wide snapshot garbage collection were intentionally skipped to avoid replacing that peer's status. The unique session vault note is separate. No peer state was modified.
- Configured archive phases completed: 0 PRDs and 0 plans archived. Existing open-issue, missing declaration and citation-only cases were reported as skips, not guessed closed.
- GitHub mirroring is not enabled by the effective Session Config. Merge and publication are assigned to the next session; #1263/#1266 were not closed without their remaining acceptance evidence.

## Tail phases

- 3.6.3: skipped — proposals empty (queued=0).
- 3.6.4: skipped — learnings.jsonl absent.
- 3.6.5: skipped — retired 2026-09-09 — replaced by session-start maintenance-due probe.
- 3.6.6: skipped — disabled (skill-evolution.judge=false).
- 3.6.7: skipped — retired 2026-09-09 — replaced by session-start maintenance-due probe.
- 3.6.8: skipped — disabled (reconcile.enabled=false).

## Drift check

Status `ok`, mode `warn`: 2 files scanned, 0 errors, 7 warnings, 46 notes. The local learning ledger is absent in this isolated worktree; warnings were not suppressed or reclassified as passes.

### Warnings (non-blocking)

- [generated-rule-staleness] .claude/rules/guard-design.md:1 — Auto-generated rule references learning-key 'anti-pattern/ein-peer-record-im-selben-allowedpaths-array-das-per-union-eingesammelt-wird-gewaehrt-statt-zu-markieren' which is absent from .orchestrator/metrics/learnings.jsonl, and the rule carries no valid evidence-digest to verify it offline
- [generated-rule-staleness] .claude/rules/identity-and-locks.md:1 — Auto-generated rule references learning-key 'anti-pattern/aufgezeichneter-pid-als-lebendbeweis-wenn-ihn-ein-kurzlebiger-subprozess-schrieb' which is absent from .orchestrator/metrics/learnings.jsonl, and the rule carries no valid evidence-digest to verify it offline
- [generated-rule-staleness] .claude/rules/measurement-discipline.md:1 — Auto-generated rule references learning-key 'anti-pattern/a-git-grep-drift-sweep-cannot-see-untracked-files-so-a-pre-flight-sweep-run-before-the-commit-measures-a-different-tree-than-the-one-being-released' which is absent from .orchestrator/metrics/learnings.jsonl, and the rule carries no valid evidence-digest to verify it offline
- [generated-rule-staleness] .claude/rules/process-contracts.md:1 — Auto-generated rule references learning-key 'anti-pattern/console-log-process-exit-drops-stdout-above-the-pipe-buffer-on-an-exit-0-protocol-that-means-fail-open' which is absent from .orchestrator/metrics/learnings.jsonl, and the rule carries no valid evidence-digest to verify it offline
- [generated-rule-staleness] .claude/rules/review-and-adapter-contracts.md:1 — Auto-generated rule references learning-key 'anti-pattern/eine-dokumentierte-adapter-schnittstelle-die-nur-in-prosa-geprueft-wurde-passte-nicht-zur-echten-aufrufform' which is absent from .orchestrator/metrics/learnings.jsonl, and the rule carries no valid evidence-digest to verify it offline
- [generated-rule-staleness] .claude/rules/test-hygiene.md:1 — Auto-generated rule references learning-key 'anti-pattern/a-file-wide-tocontain-in-a-test-that-judges-one-block-passes-for-states-the-block-never-reaches' which is absent from .orchestrator/metrics/learnings.jsonl, and the rule carries no valid evidence-digest to verify it offline
- [generated-rule-staleness] .claude/rules/toolchain-and-build.md:1 — Auto-generated rule references learning-key 'anti-pattern/a-nul-byte-in-a-tracked-production-file-makes-it-invisible-to-every-grep-based-audit' which is absent from .orchestrator/metrics/learnings.jsonl, and the rule carries no valid evidence-digest to verify it offline

### Notes (informational, not warnings)

- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'special' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'gitlab-host' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'mirror' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'cross-repos' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'cross-repo' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'pencil' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'ecosystem-health' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'health-endpoints' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'issue-limit' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'stale-issue-days' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'ssot-files' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'ssot-freshness-days' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'discovery-on-close' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'discovery-probes' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'discovery-exclude-paths' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'discovery-severity-threshold' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'discovery-confidence-threshold' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'discovery-parallelism' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'memory-cleanup-threshold' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'learning-expiry-days' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'learnings-surface-top-n' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'learning-decay-rate' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'enforcement-gates' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'allow-destructive-ops' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'reasoning-output' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'grounding-check' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'grounding-injection-max-files' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'isolation' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'max-turns' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'auto-commit-per-wave' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'heavy-repo' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'worktree-cleanup' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'worktree-exclude' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'resource-awareness' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'enable-host-banner' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'resource-thresholds' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'baseline-ref' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'baseline-project-id' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'vault-sync' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'gitlab-portfolio' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'persona-gate-wave' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'test' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'events-rotation' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'express-path' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [session-config-parity/opt-in-gap] CLAUDE.md:60 — Session Config omits opt-in top-level key 'agent-mapping' (documented in docs/session-config-template.md's opt-in baseline; not required). Reported, not warned.
- [rule-scoping/fleet-intent-glob] .claude/rules/testing.md:1 — glob '**/*Tests*' matches 0 tracked files here and is declared FLEET INTENT (frontmatter) — it serves consumer repos with a different language convention. Reported, not warned.

### Skipped checks

- project-count-sync: no 01-projects/ directory at vault root
