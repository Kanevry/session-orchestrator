# Test-audit campaign

A campaign covers a whole repo or subsystem in one draft MR. Everything in [../SKILL.md](../SKILL.md) applies to every lane: the goal, the value bar, the ledger marks, the eight evidence fields, falsification, and the owner list. This file adds the order of work and the measurements. Each phase ends on its done-criterion. P3 may start as soon as the P1 file list exists and the last CI pipeline at the pinned SHA is green; B marks are reconciled when the M0 pass/fail list lands. P5 and later never start before P4 is complete.

## Phases

**P1 Baseline (M0).** Pin a SHA. Record every measurement below and the pass/fail state of every in-scope test file. Baseline-red tests go on their own list as B: they are possible product bugs, not stale tests.
Done when every in-scope test file has a recorded result and the M0 table carries its commands and the SHA.

**P2 Lanes.** Split the tests along production ownership (the module a test protects), not file-name prefixes. Every test file belongs to exactly one lane; the lane file counts add up to the P1 total. Cross-cutting test files (error-path or contract suites spanning several modules) form their own lane, scheduled after the owner lanes. Give each lane a budget (agent runs or hours). Sizing, measured in one TypeScript/vitest campaign (2026-09-24): one read-only agent covers about 1500–2200 test lines (about 100 declarations) in 7–15 min and 250–300k tokens; split lanes above that. Five such agents in parallel hit an account session limit (HTTP 429) there, so plan one retry slot per lane.
Done when the lane table sums to the total.

**P3 Ledger per lane.** One read-only `qa-strategist` per lane, in parallel. It reads every assigned test in full, including parameter tables, plus the production owner, its callers, history, and CI routing, and writes one mark with evidence per declaration. For a duplicate whose twin lies in another lane, the default keeper is the file the production module owns: owner file beats cross-cutting file, real boundary beats mocked collaborator, exact assertion beats `typeof`. Mark the other side C and name the keeper; never mark both sides C. The cross-cutting lane receives the owner lanes' ledgers as input. Agents have no write tool: each returns its ledger as text or writes `/tmp/<campaign>/ledger-<lane>.md`; the coordinator assembles `docs/audits/<date>-test-audit-ledger.md`.
Done when every declaration in the lane has a mark and an evidence line.

**P4 Layer plan.** A different read-only agent (`architect-reviewer`, or a fresh `qa-strategist` that did not write the ledger) takes the ledger as input and looks for redundant layers rather than single tests: which suite is the keeper for each contract, which assertions move into it, which test-only seams become free. Prefer the real boundary with a fake transport over a mocked collaborator. It re-reads at least 15 % of the C and D declarations against the source, the largest and the weakest-argued first, and records every fix in a corrections table (`file:line`, old mark, new mark, evidence); it never edits the lane ledgers in place.
Done when each lane names its retired files, its keeper per contract, the assertions to carry over, and the seams unlocked.

**P5 Falsification.** Before any edit, every C, D, and F gets its targeted mutation (evidence field 8) in the offload worktree, with the mutation log entry and the restore proof.
Done when the mutation log covers every C, D, and F in the plan.

**P6 Cutover.** One `test-writer` per lane with disjoint file scopes. Changes to shared helpers and fixtures go through one owner, serialised. Removing a test-only production seam is a separate `code-implementer` task. Agents never run git write commands (PSA-007); the coordinator commits one commit per lane.
Done when every lane plan is applied and each lane's keepers pass.

**P7 Preservation review.** Independent, read-only, one reviewer per group of lanes (`session-reviewer`, or `pr-review-toolkit:pr-test-analyzer` when installed). It compares deleted coverage against the keepers and looks for contracts that lost their only proof and for new assertions that cannot fail. Each restored contract gets a caught mutation.
Done when every reported gap is restored or rejected with source evidence.

**P8 Final measurement (M1).** Same commands, same gate, same host as M0.
Done when the M0/M1 table is complete and per-file coverage is compared.

**P9 Hand-off.** Draft MR and follow-up issues as listed in the SKILL.md § Output. A campaign that outlives many `main` commits merges `main` instead of rebasing; when `main` changed a file the campaign deleted, the deletion stays and the new contract moves into the keeper.

## Measurements

Every number carries the command that produced it and the SHA it was measured at. Heavy runs (runtime, flakes, coverage) go to the offload host: `offload run <repo> -H <host> --job <id> -- <command>`, then `--job <id> --no-sync` for the remaining runs on the same worktree (`--rm` removes it only after a successful run).

- The command is not shell-expanded on the host: `~` and `$HOME` resolve locally or not at all. Pass literal remote paths, or wrap in `bash -c '…'`.
- Record both SHAs the host prints (`SHA=… SNAPSHOT=…`). The snapshot SHA differs from the pinned one; the tracked tree must not (`FILES=` lists only untracked files).
- A suite under about 60 s per run may be measured locally instead, sequentially, under `nice -n 10` and `timeout -k 5 600`: for short suites, offload sync and install cost more than the runs (measured once: 13 min waiting for 3.7 min of runs). M0 and M1 still run on the same host. Mutations (P5) always go to the offload worktree.

| Measure | How |
|---|---|
| Test count | the runner's own count (vitest: `--reporter=json`, field `numTotalTests`) |
| Test lines vs production lines | at M0: line totals of the tracked test files the runner actually includes (vitest `include`, pytest `testpaths`, …) and of the rest, counted separately. Tracked test files outside the include are listed as _dead test files_ with their own line total; they count neither in M0 nor toward the goal, and their removal is reported on its own line. M0 to M1: `git diff --numstat <M0-sha> <M1-sha>` split by the same globs |
| Suite runtime | median of 3 full runs on the measuring host |
| Flakes | 5 runs in shuffled order; M1 may not have more than M0 |
| Coverage | total and per production file; thresholds and config unchanged |
| tests:src ratio | per TV-003 (`test-value.md`); by hand when the script below does not know the stack |

`scripts/lib/tests-src-ratio.mjs` counts only `.mjs`/`.js`/`.cjs`, with only `tests/` as the test side, so a TypeScript repo comes out as ratio 0 (or null) and "within corridor". Until that is fixed, compute the ratio by hand with the TV-003 recipe: numerator the physical lines of `git ls-files '<testdir>/**'` (code files), denominator every other tracked code file. State both numbers and the globs.

Stack recipes (check each flag against the installed version before use):

- **TypeScript / vitest:** count `vitest run --reporter=json --outputFile=<dir>/count.json` (without `--outputFile` the JSON mixes into stdout; fields `numTotalTests`, per file `testResults[].status`); flakes the same with `--sequence.shuffle --sequence.seed=$i` for `i` in 1..5; coverage `vitest run --coverage --coverage.reporter=json-summary` → `coverage/coverage-summary.json`. Its keys are absolute paths: strip the worktree prefix before comparing M0 and M1. Thresholds stay enforced, so a red threshold fails the run.
- **Python / pytest:** count `--collect-only -q`; coverage `--cov --cov-report=json`; leave `fail_under` as it is. Shuffle only with a plugin that is already installed; otherwise 5 plain runs.
- **Swift / XCTest:** count `swift test list`; coverage via `swift test --enable-code-coverage` and `xcrun xccov`.
- **Bash harness:** falsify the harness first (known-broken input, non-zero exit, FAIL in the artefact), under `bash`, then count and time it.

## MR body

- Goal as stated at the start, and reached or not with the reason.
- M0/M1 table with command and SHA per row.
- R/F/C/D/N/B counts per lane.
- Keeper per contract, and the retired layers.
- Mutation table: `file:line`, mutation, red test, restore proof.
- Kept false alarms: tests that looked like junk and stayed, with the contract they guard.
- Production lines and test lines, separately; dead test files on their own line.
- The P4 corrections table and the ledger's _Issues_ section.
- Owner decisions taken during the campaign.
