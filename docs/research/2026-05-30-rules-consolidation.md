# `.claude/rules/` Consolidation — Reshape of #445

**Date:** 2026-05-30
**Issue:** #445 (RESHAPED — the original scope was partly impossible; Discovery
grep-verified the live state and the user approved the narrowed scope below).
**Owner wave:** Wave 2 Impl-Core (sole owner of `.claude/rules/` +
`scripts/validate-plugin.mjs`).

## Why the original issue was reshaped

The original #445 proposed a broad rule-file consolidation including a
three-way `security` merge. Discovery established two facts that made part of
the original scope impossible or unsafe:

1. **`security-compliance.md` does not exist in this plugin.** A "three-way
   security merge" cannot merge a file that was never vendored — the reference
   was baseline-manifest leakage (see Dangling-ref finding below).
2. **Path-scoped vs always-on / glob-scope conflicts.** Rules load via
   `rule-loader.mjs` on a per-wave basis keyed on each file's frontmatter
   `globs` (path-scoped) or always-on status. Merging files with *different
   load triggers* changes *when* a rule loads — a silent behaviour change, not
   a cosmetic edit.

The approved reshape kept only the SAFE, load-trigger-preserving change set.

## 1. Merge executed: `testing.md` ← `test-quality.md`

Both files were **path-scoped** and shared a near-identical glob set, so merging
them does **not** change the load trigger — the only safe merge available.

- **Glob union (no information loss):** `test-quality.md` carried two Swift-test
  globs that `testing.md` lacked — `**/*Tests*` and `**/WalkAITalkieTests/**`.
  Both were added to `testing.md`'s frontmatter. Dropping them would have
  stopped the merged rule from loading for Swift test files — a regression.
  Final `testing.md` globs: `**/*.test.*`, `**/*.spec.*`, `**/*Tests*`,
  `tests/**`, `vitest.config.*`, `playwright.config.*`, `**/WalkAITalkieTests/**`.
- **Body appended verbatim** under a clearly-headed section:
  `## Test Quality — False-Positive Prevention (#445 merged from test-quality.md)`.
  Every anti-pattern (Assert-Nothing, Test-the-Mock, Tautological Computation,
  Implementation Mirror, Overly-Generous Assertion, Getter/Setter, Happy-Path-Only),
  the BE-012 Server Action Envelope Assertions block, and the **Dynamic Artifact
  Counts floor/ceiling carve-out** were preserved.
- **`test-quality.md` removed** via `git rm` after the append.
- **Cross-ref redirects:** every in-body reference that previously pointed at
  `test-quality.md` was redirected to `testing.md` § "Test Quality —
  False-Positive Prevention":
  - `backend.md` (BE-012 cross-reference)
  - `quality-gates-autofix.md` (×2 — fixer-agent prompt + test anti-patterns).
- **See-Also footers:** the `test-quality.md` token was dropped from all
  footers that carried it (`testing.md` itself is already listed in those
  footers, so navigation is unbroken).

Merged file size ≈ 454 LOC, well under the 800-LOC ceiling.

## 2. Dangling-ref finding + remediation

Discovery grep-verified that **four** referenced rule basenames **do not exist**
as files in this plugin — they are pre-existing baseline-manifest leakage
(the rules were authored against a baseline that vendors them, but this plugin
does not):

| Dangling basename | Nature |
|---|---|
| `security-compliance.md` | Compliance + AI/LLM security rules — baseline-only |
| `ai-agent.md` | AI-agent engineering rules — baseline-only |
| `infrastructure.md` | Infra / Docker / tracing-backend rules — baseline-only |
| `observability.md` | Observability rules — baseline-only |

Verification:
```
find . -name security-compliance.md -o -name ai-agent.md \
       -o -name infrastructure.md -o -name observability.md   # → nothing under .claude/rules/
```

Remediation (two loci):

- **See-Also footer tokens** — all four basenames removed from every
  `.claude/rules/*.md` See-Also footer that listed them.
- **In-body content cross-refs that promised real content** — softened to
  forward-pointers so navigation is not broken-by-implication. Each now reads
  "the baseline `<name>` rules (not vendored into this plugin)":
  - `security.md` L3 (Compliance/AI rules), L9 (SEC-010..012), L38 (secrets
    rotation schedule), L123 (OWASP A05 row).
  - `backend.md` L134 (structured logging + DSGVO PII), L253 (Grafana Tempo).
  - `backend-data.md` L43 (RLS Performance Checklist).

> Out of scope (left untouched): `skills/bootstrap/_shared-template.md`
> RULES_MANIFEST — its baseline fetch is 404-tolerant by design.

## 3. Rejected merges (with load-trigger rationale)

- **Three-way `security` merge (`security` + `security-compliance` +
  `security-web`).** REJECTED — `security-compliance.md` is a missing
  (baseline-only) file, and `security.md` is **always-on** while
  `security-web.md` is **path-scoped**. Merging an always-on rule with a
  path-scoped rule would either (a) make web-only rules always load (token
  bloat on every wave) or (b) make core security rules load only on web paths
  (a safety regression). The load trigger differs → unsafe to merge.
- **`backend` family merge (`backend` + `backend-data`).** REJECTED — would
  broaden the effective glob scope. Each backend rule loads on its own path
  set; merging them forces both rule bodies to load whenever *either* path
  matches, widening the per-wave context footprint without a correctness gain.

The unifying principle: **a merge is only safe when both files share the same
load trigger.** `testing.md` ← `test-quality.md` was the single pair that met
that bar.

## 4. New CI guard: `check-rules-references.mjs`

`scripts/lib/validate/check-rules-references.mjs` (mirrors the shape of
`check-subagent-types.mjs`) mechanically prevents this dangling-ref class from
recurring:

- **`collectRuleReferences(rulesDir)`** — pure, import-safe; returns
  `Array<{ref, file, line}>`.
- **`runCheckRulesReferences(pluginRoot)`** — emits two-space-prefixed
  `  PASS:` / `  FAIL:` lines (counted by `validate-plugin`'s `runCheck`) plus a
  final `Results: N passed, M failed`.
- **Validates two loci:** (a) See-Also footer tokens, (b) in-body backtick refs
  ``  `name.md`  `` that are NOT path-qualified.
- **Exclusions (must NOT flag):** path-qualified refs (`docs/api.md`,
  `skills/_shared/state-ownership.md`, `templates/...`, `../../...`), uppercase
  / non-rule doc names (`CLAUDE.md`, `SECURITY.md`, `SKILL.md`,
  `MIGRATION-vN.md`), wildcard prose (`*.md`), the file's own name, and any line
  carrying the inline-ignore marker `check-rules-references:ignore`. Rule-style
  basenames are constrained to `^[a-z0-9-]+\.md$` so off-tree docs are never
  flagged.
- **Exit codes** (per `.claude/rules/cli-design.md`): `0` all resolve / `1` ≥1
  dangling / `2` tool error (rules dir unreadable).
- **Wired into `scripts/validate-plugin.mjs`** immediately after the
  `check-subagent-types.mjs` registration (one line). The validate-plugin test
  uses floor assertions (`passed >= 18`, `failed == 0`), so no count edit was
  required; the new check raises the passed total without breaking the floor.

## Verification evidence

```
$ node scripts/lib/validate/check-rules-references.mjs <root>
Results: 15 passed, 0 failed        # exit 0

$ ls .claude/rules/test-quality.md   # → No such file or directory
$ grep -c WalkAITalkieTests .claude/rules/testing.md   # → 1

$ grep -rl "security-compliance.md\|ai-agent.md\|infrastructure.md\|observability.md" .claude/rules/
# → (empty)

$ node scripts/validate-plugin.mjs | tail -1
  Results: 124 passed, 0 failed      # exit 0 (was 109 before the new check)
```
