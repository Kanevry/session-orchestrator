---
name: test-audit
description: >
  Use when writing, reviewing, or pruning tests. Three modes, one value bar: a four-question gate
  before any new test is written, a focused audit of one scope, and a campaign over a whole repo or
  subsystem that removes the least useful tests under a coverage guard. Every delete, merge, or
  repair carries written evidence and a caught mutation. Triggered by "audit the tests", "prune the
  test suite", "remove low-value tests", "test diet", "is this test worth adding", /test-audit.
user-invocable: true
argument-hint: "[gate|audit|campaign] [scope] [--goal \"<goal>\"]"
model: inherit
---

# Test Audit

A test earns its place by catching a regression nothing else catches. This skill applies that bar at three depths. It complements `.claude/rules/test-value.md` (TV-001..TV-005) and the repo's test-quality / test-hygiene rules; it replaces none of them.

Rule references below (`test-value.md`, `receiving-review.md`, `parallel-sessions.md`, `bash-harness-pitfalls.md`) name the repo's `.claude/rules/`. A consumer repo often lacks them; then read them from the plugin's `rules/always-on/`.

## Invocation

Invoked as `/test-audit [gate|audit|campaign] [scope] [--goal "<goal>"]` with arguments: **$ARGUMENTS**.

- `gate` — run the write gate on the test about to be written. Default when no mode is given and the conversation is about to add a test.
- `audit <scope>` — one focused pass over a path, glob, or module. Default when a scope is given without a mode.
- `campaign <scope>` — a whole repo or subsystem, split into lanes. Only on the explicit word `campaign`; read [references/campaign.md](references/campaign.md) before starting.
- A missing scope for `audit` or `campaign` is asked for once via `AskUserQuestion`, with the largest test directories as options.

## Set an ambitious goal first (audit and campaign)

State the goal in the first output and repeat it in the report. With no `--goal`, use:

> Remove at least 20% of the least useful tests, measured in test lines. Total coverage stays within 2 percentage points of M0, and no production file drops below its own M0 coverage.

Test lines count only for files the runner actually includes; tracked test files outside its include are dead test files, reported on their own line and never counted toward the goal ([references/campaign.md](references/campaign.md) § Measurements).

The goal exists because a bare "clean up" stops far too early. It never licenses a deletion without evidence. A goal that is only reachable by breaking the evidence rules below is not reached: the report says which rule blocked it and where the audit stopped. An audit that ends with zero changes is valid when the ledger shows why.

## Mode 1: write gate

Before adding any test, answer all four. A missing answer means the test is not written yet.

1. Which observable behaviour, invariant, or independent contract does it protect?
2. Which credible regression turns it red?
3. Why does no existing test catch that regression? Grep first (TV-004); extend a table case or shared fixture instead of adding a near-duplicate.
4. Does it need a production seam (export, flag, hook, injection parameter) that no production caller uses? Then no: move the test to the real boundary.

Then check it against the junk patterns below; a match fails the gate unless the keep list names the contract it alone guards. A regression test must be shown red on the pre-fix code, for the intended reason, before the fix lands; one that never failed proves the mock, not the fix. One regression at the owning boundary covers the bug; do not replay it at every layer. `no-tests-needed: <reason>` is a success outcome (TV-001).

## The value bar

Judge each test by what its assertions can catch, never by its name.

**Junk patterns** (candidates for D, C, or F):

- no assertion, or an assertion that cannot fail (self-comparison, identity copy);
- copied inventories, export lists, manifests, or fixtures that restate the source;
- a test-local copy of another repo's schema or contract, checked against test-local payloads: it proves the copy, not the contract; the keeper is the synced artefact or the other repo's test;
- exact source, import, or string greps where a behavioural check exists;
- the expected value is produced by the helper under test;
- the mock implements the behaviour being asserted, or one mock stands in for different APIs;
- a negative control that passes for an unrelated reason (a different guard rejects first, or the production path never reaches the rejection); for a security check, one that only hits the early exit (wrong length, wrong prefix) and never the comparison itself is usually F;
- the name promises more than the assertion checks;
- prose or structure pinned in a `.md` file (TV-002c);
- the test is the only caller of dead production code.

**Keep list** (the counterweight to TV-002): a test that is the independent proof for a public API, protocol, a config value production reads (a config field whose only reader is the test is a seam, not a contract), migration, storage format, security control, release step, or data-protection rule stays. So do observable call ordering and regressions with a credible failure mode. Static or slow is not a reason to delete. When in doubt, mark R.

## Ledger marks

Every test declaration in scope gets exactly one mark and one evidence line. A parametrised table is one declaration unless its rows need different marks.

| Mark | Meaning | Required note |
|---|---|---|
| R | keep | the contract and the bug it catches |
| F | keep the contract, repair the assertion | what the assertion misses today, and the mutation the repair must catch |
| C | consolidate into a keeper | the keeper test that absorbs it |
| D | delete | the remaining proof, or why no contract exists |
| N | new test | only after passing the write gate |
| B | red on the baseline (from the P1 / M0 pass/fail list only) | possible product bug: never deleted, becomes an issue |

Suspected product bugs found while reading, with no test behind them, go into a separate _Issues_ section of the ledger (`file:line`, expected vs. actual). They become issues, never red tests in the MR.

## Evidence before any C or D

All eight fields, written into the ledger before the edit. A missing field means no deletion.

1. Test location (`file:line`) and exact name.
2. The failure it can actually detect.
3. Non-test callers of the code it covers.
4. The stronger proof that remains (the keeper), or why none is needed.
5. History: `git log -S "<identifier>" -- <file>` and the reason the test or seam exists.
6. What the deletion unlocks (a test-only export, a wrapper, a dead path).
7. Risk and the focused command that re-checks it.
8. The proposed contract mutation (`src/file:line`, one-line diff) under which the keeper must go red; falsification executes it.

## Falsification

For every C, D, and F, make one targeted contract mutation in the production code: flip the condition, drop the field, change the byte the contract names. Replacing a whole function body with `throw` kills every caller and proves nothing; use it at most as a pre-filter. The keeper (for C/D) or the repaired test (for F) must turn red under the mutation.

- Apply the mutation as a patch (`git apply`), run the one test, reverse it (`git apply -R`), then prove the restore byte for byte: `git diff --exit-code -- <prod-file>`, or a checksum taken before the mutation when the file already carried edits. A leftover diff aborts the audit.
- Never mutate a checkout another session or agent is using, and never edit while the test runner is live in that checkout. Run mutations in an offload worktree: `offload run <repo> -H <host> --job <id> -- <command>`, reused with `--no-sync` (hosts come from `remote-hosts:` in Session Config; see the `remote-offload` skill; path and expansion pitfalls in [references/campaign.md](references/campaign.md) § Measurements).
- Log each mutation: `file:line`, the mutation diff, the test that went red, the restore proof.
- Per-file coverage is the mechanical backstop: if a production file's coverage drops after a C or D, the test was not a duplicate. Revert that decision.

Bash harnesses are falsified before their tests are judged: feed a known-broken input and require a non-zero exit and a FAIL in the written artefact, under `bash`, not zsh (`.claude/rules/bash-harness-pitfalls.md`).

## Mode 2: audit

1. Read the project instruction file and the test rules it points at. Record the M0 numbers for the scope at a pinned SHA (recipes in [references/campaign.md](references/campaign.md) § Measurements).
2. Read every test in scope in full, plus the production owner, its entry point, callers, and history. For more than a handful of files, dispatch `qa-strategist` read-only to draft the ledger; it has no write tool, so it returns the ledger as text (or writes under `/tmp/<audit>/`) and the coordinator assembles the ledger file.
3. Write the ledger with marks and evidence. Prefer a few well-proven candidates over a long speculative list.
4. Falsify every C, D, and F before editing.
5. Edit: `test-writer` applies the ledger; removing a test-only production seam is a separate `code-implementer` task. Agents never commit (PSA-007 in `.claude/rules/parallel-sessions.md`).
6. Independent preservation review, read-only (`session-reviewer`, or `pr-review-toolkit:pr-test-analyzer` when installed): contracts that lost their only proof, and new assertions that cannot fail. Every restored contract needs a caught mutation.
7. Measure M1 with the same commands, then report.

## Mode 3: campaign

Phases P1 to P9 with lanes, a separate layer-plan pass, and the full measurement set live in [references/campaign.md](references/campaign.md). Read it completely before P1.

## Never without the owner

Ask via `AskUserQuestion`, and do not work around a refusal:

- changing coverage thresholds, include/exclude lists, or runner config (never `autoUpdate`);
- deleting or skipping e2e, Playwright, or real-database suites;
- editing CI config or git hooks;
- updating snapshots with `-u`;
- adding any dependency, a mutation-testing tool included;
- fixing a product bug found on the way (it becomes an issue);
- removing a seam whose removal changes a public contract (`stop-and-escalate`, RCR-007 in `.claude/rules/receiving-review.md`);
- merging.

## Stop and success

Stop when: a change you did not make, or a lock, appears in scope (PSA-002); a restore leaves a diff; the baseline does not reproduce; two review cycles pass without fewer open findings (RCR-008: land the smallest safe subset); a lane exceeds its budget.

Done when: the gate is green at the MR SHA; flakes and per-file coverage are no worse than M0; every C, D, and F has evidence and a caught mutation; the preservation review has no open gap; the goal is reached, or the report names why it was not.

## Output

- `docs/audits/<date>-test-audit.md` (report) and `docs/audits/<date>-test-audit-ledger.md` (ledger) in the target repo.
- A draft MR titled `test(audit): <scope> Test-Audit <date>` carrying: M0/M1 table, R/F/C/D/N/B counts per lane, the keeper per contract, the mutation table, kept false alarms and why, production and test lines counted separately, owner decisions.
- Commits by the coordinator: one per lane, seam removal separate, the audit documents separate.
- Follow-up issues: every B, every entry of the ledger's _Issues_ section, every flake, every seam whose removal changes a contract, every N gap not implemented.

Inspired by openclaw/openclaw `.agents/skills/test-audit` @ 80930af (MIT, Copyright (c) 2026 OpenClaw Foundation); rewritten for session-orchestrator.
