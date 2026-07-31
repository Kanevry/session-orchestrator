# Reconcile Candidate Analysis (Candidate Mode — NO Apply)

- **Date:** 2026-07-31
- **Session:** feat/938-panel-follow-ups-tv003 · Wave 3
- **Mode:** `runReconcile({ dryRun: true })` — engine touches **no** disk (no idempotency
  sidecar write, never `.claude/rules/`). Candidate JSONL written by this agent to
  `.orchestrator/runtime/reconcile-candidates.jsonl` (gitignored).
- **Apply owner:** the **coordinator** applies the reviewed subset via `/reconcile` (AUQ) —
  this agent writes NO rule. Reason: avoid collisions with parallel `.claude/rules/`-editing
  wave-agents in this same wave.

## Engine run — verified output

`runReconcile({ repoRoot, minRuleDays:7, minInsightChars:24, maxProposalsPerRun:1000,
dryRun:true })` (volume brake lifted from the default 10 → 1000 so ALL eligible surface for
ranking):

```
summary = { totalLearnings: 128, eligible: 16, proposed: 16, rejected: 112, capped: 0, written: false }
```

- `written: false` confirms the dry-run path skipped the sidecar merge — no disk write.
- 112 rejected: dominant reasons are `type not in convert allow-list` (~46) and
  `eligible type but empty file_paths[]` (~66, e.g. anti-pattern×27, proven-pattern×22,
  recurring-issue×8) — these lack a `file_paths[]` axis so the emitter cannot scope them.
- **All 16 surfaced are `alwaysApply: false` + glob-scoped.** None is always-on. This is
  structurally guaranteed by the emitter/renderer "never-always-on brandmauer"
  (`renderer.mjs` throws on empty-globs + no host-class).

## The load-bearing finding for the W2 directive-ceiling gain

**Reconcile-generated rules cannot eat the W2 always-on headroom (~40).** Every candidate
carries `alwaysApply: false` and a `globs:` block, so it loads **only** when a wave touches a
matching path and counts **0** against the always-on directive ceiling. The W2 reduction
(471 → ~440/480) is structurally protected regardless of which candidates the coordinator
applies. The only real cost of an applied rule is (a) scoped-load token cost when its globs
match, and (b) file-count proliferation under `.claude/rules/`.

## Already-on-disk vs NEW (critical for the apply decision)

Cross-referenced each candidate's `learning-key` against `learning-key:` frontmatter of the
11 existing auto-generated rule files. **9 of 16 already exist on disk** (idempotent
re-writes — applying them only refreshes `expires-at`); **7 are genuinely NEW.** The
coordinator's real apply decision is about the 7 NEW candidates.

### The 9 ON-DISK candidates (idempotent — default SKIP)

console-log-process-exit · agents-md-description · validate-config-cli · prose-presence-pin ·
a-protocol-migration · a-nul-byte-in-tracked · moving-a-guard · vi-restoreallmocks ·
nul-byte-corruption.

- **Default: SKIP** (already present; re-apply is a no-op overwrite).
- **Exception worth a re-apply:** `agents-md-description…` expires **2026-08-21** (~3 weeks).
  Re-applying it refreshes the TTL. The other 8 expire Oct 2026 — no urgency.

### The 7 NEW candidates — ranked apply recommendation

All are `alwaysApply:false` / glob-scoped → **directive-ceiling cost = 0** for every one.
Ranking is therefore by rule-worthiness (recurring + mechanical) and scope tightness, not by
directive cost.

| rank | learning-key (abbrev) | conf | globs (scope) | apply? | rationale |
|---|---|---|---|---|---|
| 1 | `anti-pattern/a-green-quality-gate-…-not-evidence-the-tree-builds-on-ci` | 0.90 | `tests/hooks/**`, `tests/lib/**`, `tests/fixtures/**` | **YES** | Recurring CI-vs-local divergence class (macOS TMPDIR-trailing-slash + ARG_MAX; 2026-07-30-deep-1 reproduced it across 4/5 waves). Mechanical, high conf, scoped to the exact dirs where platform-sensitive tests live. |
| 2 | `anti-pattern/a-file-wide-tocontain-…-judges-one-block-passes-for-states-…never-reaches` | 0.90 | `tests/ci/**`, `tests/lib/**` | **YES** | Sharp test-quality anti-pattern (file-wide `toContain` green for a state the block never reaches) — the #906 deny-contract class. Scoped. Minor overlap with `testing.md` false-positive section — apply as the *mechanical* scoped complement; note overlap. |
| 3 | `anti-pattern/bash-3-2-breaks-case-patterns-inside-…-and-bash-n-cannot-see-it` | 0.70 | `.husky/**` | **YES (prefer FOLD)** | Sharp mechanical gotcha, tightest possible scope (`.husky/` only). Ideal — but consider **folding into existing `bash-harness-pitfalls.md`** (already glob-scoped to shell) instead of a new file, to curb `.claude/rules/` proliferation. |
| 4 | `proven-pattern/verify-issue-premises-with-one-executed-command-each-before-planning` | 0.85 | `skills/session-start/**` | **CONDITIONAL** | Tightly scoped + valuable, BUT overlaps heavily with **PSA-006** (`parallel-sessions.md`, always-on) which already mandates executed-command verification of distributional/premise claims. Apply ONLY if it adds a session-start-premise angle PSA-006 lacks; otherwise redundant. |
| 5 | `proven-pattern/wave-scope-union-must-pre-include-every-fix-pass-target-…coordinator-too` | 0.60 | `skills/wave-executor/**` | **DEFER** | Lowest conf (at the 0.5 floor), tightly scoped, but reads as process narrative. Real (enforce-scope gates the coordinator too) — let it accrue confidence before it earns a rule file. |
| 6 | `proven-pattern/need-gated-test-writing-named-bug-caught-fake-regression-proof-per-test` | 0.80 | `agents/**`, `.claude/rules/**` | **NO** | Duplicates `test-value.md` TV-001 (name the bug) + TV-002 + `testing.md` fake-regression check — all already ALWAYS-ON. A scoped copy adds a maintenance surface without new coverage. |
| 7 | `anti-pattern/a-session-repairing-a-defect-class-reproduces-that-same-class-…budget-a-review-pass` | 0.85 | `docs/**`, `skills/wave-executor/**`, `scripts/lib/**` | **NO / DEFER** | Genuine recurring meta-pattern, but the globs are broad/loose and the insight is process wisdom ("budget a review pass"), not a mechanical file-scoped check. Better as a `wave-executor` SKILL note than a `.claude/rules/` entry. |

## Apply recommendation for the coordinator (one line)

- **APPLY (3):** rank 1 (`a-green-quality-gate`), rank 2 (`a-file-wide-tocontain`), rank 3
  (`bash-3-2-case` — prefer folding into `bash-harness-pitfalls.md`).
- **CONDITIONAL (1):** rank 4 (`verify-issue-premises`) — only if it beats PSA-006 overlap.
- **DEFER/NO (3):** rank 5 (low conf), rank 6 (dup of test-value.md), rank 7 (loose scope).
- **SKIP the 9 on-disk** (idempotent); optionally re-apply `agents-md-description…` to refresh
  its near-term 2026-08-21 TTL.
- **Zero directive-ceiling impact** either way — every candidate is glob-scoped.

## Provenance & scope guarantee

- Candidate JSONL: `.orchestrator/runtime/reconcile-candidates.jsonl` (16 lines, all valid
  JSON; gitignored — expected, so `git status` shows it as untracked-ignored).
- **No `.claude/rules/` file was written or modified by this run.** The engine's dry-run path
  skips the merge; this agent's only writes are the two `docs/reconcile/*.md` reports + the
  gitignored candidate JSONL.
- Any ` M .claude/rules/receiving-review.md` (and a warn-only `scripts/lib/scope-baseline.mjs`
  bash-write-verify notice) observed during this run belong to **sibling wave-agents'**
  declared file-scopes (PSA-001 in-run signal), not to this agent.
