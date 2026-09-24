# Test-audit campaign

A campaign covers a whole repo or subsystem in one draft MR. Everything in [../SKILL.md](../SKILL.md) applies to every lane: the goal, the value bar, the ledger marks, the seven evidence fields, falsification, and the owner list. This file adds the order of work and the measurements. Each phase ends on its done-criterion; the next one does not start early.

## Phases

**P1 Baseline (M0).** Pin a SHA. Record every measurement below and the pass/fail state of every in-scope test file. Baseline-red tests go on their own list as B: they are possible product bugs, not stale tests.
Done when every in-scope test file has a recorded result and the M0 table carries its commands and the SHA.

**P2 Lanes.** Split the tests along production ownership (the module a test protects), not file-name prefixes. Every test file belongs to exactly one lane; the lane file counts add up to the P1 total. Give each lane a budget (agent runs or hours).
Done when the lane table sums to the total.

**P3 Ledger per lane.** One read-only `qa-strategist` per lane, in parallel. It reads every assigned test in full, including parameter tables, plus the production owner, its callers, history, and CI routing, and writes one mark with evidence per declaration.
Done when every declaration in the lane has a mark and an evidence line.

**P4 Layer plan.** A different read-only agent (`architect-reviewer`, or a fresh `qa-strategist` that did not write the ledger) takes the ledger as input and looks for redundant layers rather than single tests: which suite is the keeper for each contract, which assertions move into it, which test-only seams become free. Prefer the real boundary with a fake transport over a mocked collaborator. It corrects ledger errors it finds.
Done when each lane names its retired files, its keeper per contract, the assertions to carry over, and the seams unlocked.

**P5 Falsification.** Before any edit, every C, D, and F gets its targeted mutation in the offload worktree, with the mutation log entry and the restore proof.
Done when the mutation log covers every C, D, and F in the plan.

**P6 Cutover.** One `test-writer` per lane with disjoint file scopes. Changes to shared helpers and fixtures go through one owner, serialised. Removing a test-only production seam is a separate `code-implementer` task. Agents never run git write commands (PSA-007); the coordinator commits one commit per lane.
Done when every lane plan is applied and each lane's keepers pass.

**P7 Preservation review.** Independent, read-only, one reviewer per group of lanes (`session-reviewer`, or `pr-review-toolkit:pr-test-analyzer` when installed). It compares deleted coverage against the keepers and looks for contracts that lost their only proof and for new assertions that cannot fail. Each restored contract gets a caught mutation.
Done when every reported gap is restored or rejected with source evidence.

**P8 Final measurement (M1).** Same commands, same gate, same host as M0.
Done when the M0/M1 table is complete and per-file coverage is compared.

**P9 Hand-off.** Draft MR and follow-up issues as listed in the SKILL.md § Output. A campaign that outlives many `main` commits merges `main` instead of rebasing; when `main` changed a file the campaign deleted, the deletion stays and the new contract moves into the keeper.

## Measurements

Every number carries the command that produced it and the SHA it was measured at. Heavy runs (runtime, flakes, coverage) go to the offload host: `offload run <repo> -H <host> -- <command>`.

| Measure | How |
|---|---|
| Test count | the runner's own count (vitest: `--reporter=json`, field `numTotalTests`) |
| Test lines vs production lines | at M0: line totals of tracked test files and of the rest, counted separately; M0 to M1: `git diff --numstat <M0-sha> <M1-sha>` split by the same globs |
| Suite runtime | median of 3 full runs on the offload host |
| Flakes | 5 runs in shuffled order; M1 may not have more than M0 |
| Coverage | total and per production file; thresholds and config unchanged |
| tests:src ratio | only when the recipe knows the stack, otherwise "not measurable" in the report |

`scripts/lib/tests-src-ratio.mjs` counts only `.mjs`/`.js`/`.cjs`, with only `tests/` as the test side, so a TypeScript repo comes out as ratio 0 (or null) and "within corridor". Do not use it for a campaign until that is fixed; report the ratio as not measurable instead.

Stack recipes (check each flag against the installed version before use):

- **TypeScript / vitest:** count `--reporter=json`; flakes `--sequence.shuffle --sequence.seed=$i` for `i` in 1..5; coverage `--coverage --coverage.reporter=json-summary`, per file from the summary JSON.
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
- Production lines and test lines, separately.
- Owner decisions taken during the campaign.
