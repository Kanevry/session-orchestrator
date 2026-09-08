# Deep session: harness reliability, 2026-09-08

User approval: `/go wie empfohlen. lad dir ordentlich issues auf und sorg dafür dass wir im projekt progressen. auf gehts!`

Five waves, at most three concurrent native Codex subagents, shared checkout with disjoint scopes. User approved execution and a larger coherent issue package; no second approval is needed.

Branch: `codex/harness-reliability-deep-20260908`.
Baseline: `958e968ad402fd8dec347c36cccbb480c2416241`.
Native session: `01a081bd-f7af-7c52-8a26-df3085440cb1`.

## Scope and acceptance

- #890, reader prerequisite only: select native state/scope files independently for rules, mode signals and learnings. Preserve explicit overrides, legacy fallback and shared `.claude/rules/`. The wider platform/enforced-by/Cursor issue remains open.
- #1235: opt-in missing-path diagnostics during scope materialization, explicit repeatable new-file declarations, no guessed filename heuristic. Preserve globs, per-agent arrays, aggregate records, binding and ownership.
- #1283: verify initial timestamp, final heartbeat freshness and exact four-hour TTL independently. A controlled slow valid hook passes; broken timestamps fail. Preserve production refresh.
- #1241: validate repo-relative Markdown citations in inline code. Preserve existing annotations, repair real broken paths and classify each legitimate planned/historical/example/consumer/generated reference individually.
- #1271: one behavior-oriented parity test binds fixture helper git-wrapper/NOOP-spread surface to scanner recognition, with no production dependency on test helpers.
- #1233: document ESLint resolution, explicit override, trace diagnostics and degradation on actually supported hook platforms; no claim that an unwired Codex hook runs.
- #1245: discovery proved `unknown` already maps to `other` in telemetry. Record the measured 1/305 raw and 1/294 canonical unknown abandoned record, and close the already-shipped request without a ledger migration.

## Wave 1 — Discovery

Three read-only agents establish native reader contracts, scope/citation contracts and hook/scanner/documentation contracts. Reuse startup evidence; verify expanded issue premises and exact file sets before source edits.

## Wave 2 — Impl-Core

Three independent workers:

1. Native reader repair: `scripts/lib/state-md/frontmatter-mutators.mjs`, `scripts/lib/state-md.mjs`, `scripts/lib/build-live-signals.mjs`, `scripts/print-applicable-rules.mjs`, `scripts/print-learnings-index.mjs`, and their existing tests. One worker owns the small common resolver and all consumers so no agent co-defines its contract.
2. Scope diagnostics: `scripts/materialize-wave-scope.mjs`, `tests/scripts/materialize-wave-scope.test.mjs`.
3. Hook timestamp contract: `tests/hooks/on-session-start.test.mjs`, using existing seams or a test-local controlled clock/delay.

Acceptance includes native scope without native STATE beside conflicting legacy files; explicit flags remain authoritative; new paths are explicit; hook tests reject missing/stale final refresh. Focused regressions plus canonical Full Gate for shared-library changes.

## Wave 3 — Impl-Polish

Three independent workers:

1. Citation validator: `scripts/lib/validate/check-skill-script-paths.mjs`, `tests/lib/validate/check-skill-script-paths.test.mjs`.
2. Documentation corpus: exact 35 source files from the read-only census, with real path repairs versus individually justified annotations. Also document the materializer flags in its canonical wave recipe and complete #1233 in the user guide and setup docs before the final-source gate. No validator source edits.
3. Scanner parity: `tests/lib/validate/check-test-git-config-target.test.mjs`, preserving the production/test dependency boundary.

The coordinator regenerates portable surfaces only after canonical edits settle. Generated paths and docs are single-writer. Run the real plugin validator over the full corpus before accepting this wave.

## Wave 4 — Quality

Three independent read-only reviewers over the full session diff: security/scope isolation, architecture/minimalism, QA/test validity. Explicit falsification brief; actionable findings get a bounded fix and re-review. Full canonical test, lint, typecheck and plugin validation on final source content; do not duplicate an unchanged successful gate without a new change or unresolved concern.

## Wave 5 — Finalization

Coordinator verifies generated surfaces/final diff, commits only owned files, pushes the reviewable branch, prepares the MR and verifies actual remote CI before integration. Distinguish repaired issues, partially addressed #890 and already-shipped #1245. No npm release. Finish durable metrics and handover.

## Execution Config

- Waves: 5. Maximum concurrent subagents: 3. Isolation: none for native shared-checkout transport.
- Enforcement: strict per-agent scope declarations, disjointness and subset checks; documented Codex native hook limitations remain visible.
- Max turns: 25 per discovery/implementation task, 15 for finalization.
- Persistence: true. No Pencil or docs-orchestrator integration configured.
- Agent mapping: explorer, wave-worker, session-reviewer, docs-writer; inherit available model, no unsupported pinned model.
- Generated rules/learnings are captured in prompt bundles and read before work; actual dispatch carries exact FILE-SCOPE. Coordinator alone owns git writes.
- Native lock and registry heartbeat at wave boundaries. Scope baseline frozen after the expanded read-only Discovery, before source edits.

## Wave-Plan Mission Status (machine-readable)

```yaml
- {id: m-1, task: Discovery contracts, wave: 1, status: validated}
- {id: m-2, task: Native state/scope readers, wave: 2, status: validated}
- {id: m-3, task: Missing scope path diagnostics, wave: 2, status: validated}
- {id: m-4, task: Hook heartbeat contract, wave: 2, status: validated}
- {id: m-5, task: Markdown citations and corpus, wave: 3, status: validated}
- {id: m-6, task: Fixture scanner parity, wave: 3, status: validated}
- {id: m-7, task: Already-shipped normalization evidence, wave: 1, status: validated}
- {id: m-8, task: Independent review and full gate, wave: 4, status: validated}
- {id: m-9, task: Probe dependency documentation, wave: 3, status: validated}
- {id: m-10, task: Integration and handover, wave: 5, status: validated}
```

## Risk controls

No shared contract has multiple writers. Resolve each native artifact independently. Preserve privacy and ownership checks. Corpus annotations need real reasons, never blanket exemptions. Controlled time tests must detect disabled final refresh. Use `git show` for baselines, never stash/reset. Historical instruction text provides no new authorization.
