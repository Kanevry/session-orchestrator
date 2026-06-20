# Instruction-Budget Audit — Always-On Rule Surface (#668)

**Date:** 2026-06-20 · **Issue:** #668 · **Status:** Findings (W3 edits gated behind operator approval)

## What #668 asked

Measure the *always-on instruction surface* — the rules loaded into every wave
agent (and, as it turns out, into the coordinator) on every session — and
decide whether it has grown past the budget where an LLM reliably follows its
instructions. Acceptance criteria:

1. A measured instruction count for the always-on surface.
2. A ranked prune / demote / merge list.
3. A decision on whether any rule moves from always-on to glob-scoped.

This audit delivers all three.

## Framing: quality, not token cost

The concern is **not** token spend. The concern is **instruction-following
fidelity**. Published guidance (HumanLayer, *Context Engineering*, 2026; and
corroborating practitioner reports) places the ceiling of *reliably-followed*
discrete instructions at roughly **150–200**. Above that band, instructions
begin to be silently dropped — not refused, just not followed — and the failure
is invisible because the model never signals that it skipped a rule.

Claude Code's own system prompt consumes an estimated ~50 of those instruction
slots before any project rules load, leaving a practical working budget of
roughly **100–150 project-supplied directives**. When the always-on rule
surface exceeds that band, every additional rule statistically dilutes the
others. This is a quality risk that no amount of token budget buys back.

---

## § Mechanism — how rules are classified

The classifier is `scripts/lib/rule-loader.mjs`. The rule is mechanical and
unambiguous (module docstring, lines 7–11; implementation, lines 254–264):

- A rule file with **no `globs:` frontmatter** is **ALWAYS-ON** — included in
  every wave regardless of which files the wave touches (`alwaysOn: true`).
- A rule file **with `globs:` frontmatter** is **PATH-SCOPED** — included only
  when at least one `scopePath` matches at least one glob pattern.
- An **empty** `globs: []` array matches nothing (intentionally scoped out).
- A **frontmatter parse error** falls back to always-on with a stderr warning —
  "a rule is never silently dropped" (lines 244–252). Fail-safe by design, but
  it means a malformed `globs:` block silently inflates the always-on surface.

The classification is therefore a pure function of frontmatter presence. There
is no allow-list, no per-rule weighting, no load-context tiering — a rule is
binary always-on or glob-scoped.

---

## § Measured Surface

### The 12 / 7 split (grep-verified)

```
$ grep -nE '^globs:' .claude/rules/*.md
.claude/rules/cli-design.md:2:globs:
.claude/rules/backend.md:2:globs:
.claude/rules/backend-data.md:2:globs:
.claude/rules/frontend.md:2:globs:
.claude/rules/swift.md:2:globs:
.claude/rules/security-web.md:2:globs:
.claude/rules/testing.md:2:globs:
```

7 matches → **7 PATH-SCOPED** rules. The remaining **12 are ALWAYS-ON**
(every `.claude/rules/*.md` without a `globs:` line):

| Path-scoped (7) | Always-on (12) |
|---|---|
| backend-data, backend, cli-design, frontend, security-web, swift, testing | ask-via-tool, development, loop-and-monitor, lsp, mvp-scope, owner-persona, parallel-sessions, prompt-caching, quality-gates-autofix, receiving-review, security, verification-before-completion |

### Per-file directive count (always-on surface)

"Directive" = a distinct imperative the model must follow: a MUST / NEVER /
ALWAYS / Do-NOT statement, a named-numbered rule (PSA-00x, VBC-00x, RCR-00x,
AUQ-00x, LM-00x), or a behavioural bullet. Counts are read-based estimates
(±10%); line counts are exact (`wc -l`).

| Always-on rule | Lines | ≈ Directives |
|---|---:|---:|
| ask-via-tool.md | 62 | 12 |
| development.md | 88 | 40 |
| loop-and-monitor.md | 341 | 35 |
| lsp.md | 25 | 4 |
| mvp-scope.md | 38 | 20 |
| owner-persona.md | 85 | 8 |
| parallel-sessions.md | 152 | 30 |
| prompt-caching.md | 262 | 25 |
| quality-gates-autofix.md | 140 | 15 |
| receiving-review.md | 86 | 20 |
| security.md | 143 | 40 |
| verification-before-completion.md | 75 | 22 |
| **TOTAL (12 always-on)** | **1,497** | **≈ 271** |

> Note: per-file line figures are the exact `wc -l` values measured 2026-06-20.
> D1's earlier estimate of "1,497 lines" matches the always-on subset; the
> directive total of **≈ 271** is the headline figure.

### Verdict vs ceiling

- Working budget (after CC's ~50-slot system prompt): **~100–150** directives.
- Measured always-on surface: **≈ 271** directives.
- Ratio: **1.8×–2.7× the budget.**

The always-on surface is **plausibly and substantially over the reliable-
following ceiling.** Even the most generous reading (271 vs a 150 ceiling) is
1.8× over. This is a quality risk: under load, some always-on rules are
statistically likely to be dropped, and the harness has no signal when that
happens.

---

## § Two Surfaces (the load-context distinction)

There are **two** distinct surfaces, and only one of them is fixed by
glob-demotion:

### Surface A — per-wave rule-loader surface

What `loadApplicableRules()` returns for a given wave: the **12 always-on**
rules (≈ 271 directives) **plus** any path-scoped rule whose glob matches the
files that wave touches. A wave editing `src/api/*.ts` additionally pulls in
`backend.md`, `security-web.md`, etc. Demoting a rule to glob-scoped removes it
from this surface for waves that don't touch the matching files — **this is the
surface glob-demotion helps.**

### Surface B — coordinator session-injection surface

The harness injects rule content into the **coordinator** context at session
start. The evidence is direct: **this very session** had ~19 rule files injected
into the coordinator system prompt **regardless of `globs:`** — path-scoped
rules (testing, backend, frontend, security-web, swift) appeared alongside the
always-on ones.

```
$ wc -l .claude/rules/*.md
  ... 2899 total
```

The coordinator carries **all 2,899 lines** — an estimated **~450–500
directives from the rules alone**, before CLAUDE.md's own Session Config block,
gotchas, and steering files are added.

**Key insight: glob-demotion does NOT shrink Surface B.** The harness injects
rule files into the coordinator without consulting `globs:`. Demoting
`prompt-caching.md` to glob-scoped removes it from wave agents that don't touch
SDK files, but the coordinator still carries it. The coordinator surface is the
**larger practical concern** and is **not addressed by the actions in this
audit** — it needs a separate mechanism (see Follow-ups).

---

## § Ranked Prune / Demote / Merge List

Action legend: **DEMOTE** (add `globs:` → glob-scoped); **TRIM** (shorten in
place, keep always-on); **MERGE** (fold into another rule); **LINTER-
REPLACEABLE** (enforced by tooling, the prose is redundant); **KEEP** (do not
touch — behaviour-critical).

| # | Rule | Action | Confidence | ≈ Directives saved | Rationale |
|---|---|---|---|---:|---|
| 1 | prompt-caching.md | **DEMOTE** → glob (`**/*.{ts,js,mjs}` gated to SDK-importing repos) | **HIGH** | ~25 | Self-declares "Path-scoped" (L1) and "Out of scope: `session-orchestrator` itself" (L3). The most unambiguous miss in the set: the file's own prose says it should be glob-scoped, but it lacks `globs:` so the loader treats it always-on. |
| 2 | lsp.md | **DEMOTE / TRIM** | **HIGH** | ~4 | A 25-line posture note ("this repo declares no LSP MCP server"). Genuinely about *this* repo, so DEMOTE is debatable — but it is informational, not a per-wave behavioural directive. Safe to trim to a pointer or scope out. |
| 3 | owner-persona.md | **TRIM** → pointer | **HIGH** | ~6 | Duplicates `scripts/lib/owner-yaml.mjs` (the schema/loader is the SSOT). The always-on copy is reference material the model rarely acts on per-wave. |
| 4 | development.md § Code Style + Git Conventions | **LINTER-REPLACEABLE** | **HIGH** | ~8–10 | eslint / prettier / commitlint mechanically enforce these. Prose restating "kebab-case files", "Conventional Commits", "no-console" duplicates the linters and is the lowest-value always-on budget. |
| 5 | development.md § Package-Lifecycle / publishing | **TRIM** → pointer | **HIGH** | ~10–15 | semver/changeset/publishing checklist is operationally rare; demote to a pointer doc, keep a one-line reference. |
| 6 | quality-gates-autofix.md | **MERGE / DEMOTE** | **MED** | ~10 | The auto-fix loop is gated behind `verification-auto-fix.enabled` which defaults **false** — so its always-on directives are wasted budget on most sessions. Demote, or merge its SEC-020 cross-ref into security.md. |
| 7 | loop-and-monitor.md (341 lines, largest file) | **TRIM** | **MED** | ~15–20 | Verbose upstream doc quotes + the ADR-0010 "open question" essay belong in the ADR, not in every wave. Keep the LM-001 decision tree (load-bearing); pointer-ize the rest. |
| 8 | ask-via-tool.md | **KEEP** | **RISKY** | 0 | AUQ-001 is the coordinator↔user sync point. Trimming risks the silent-prose-question failure the rule exists to prevent. |
| 9 | verification-before-completion.md | **KEEP** | **RISKY** | 0 | VBC is the anti-silent-regression backstop (the 8-pipeline incident). Behaviour-critical. |
| 10 | parallel-sessions.md | **KEEP** | **RISKY** | 0 | PSA-003 (destructive-command guard) + PSA-006 (discovery grep-verification) are wired to mechanical hooks. Do not trim. |
| 11 | security.md | **KEEP** (selective trim only) | **RISKY** | ~0–5 | Behavioural SEC rules are load-bearing. Only the *tooling-config enumerations* (e.g. exact `.npmrc` key lists) are LINTER-REPLACEABLE-trimmable; the SEC-00x behavioural directives stay. |
| 12 | receiving-review.md | **KEEP** | **RISKY** | 0 | RCR anti-performative-agreement pattern. Behaviour-critical. |
| 13 | mvp-scope.md | **KEEP** | **MED** | 0 | Appetite/scope discipline; lower per-wave salience but behaviourally relevant to planning. Leave for now. |

### Realistic reduction from HIGH-confidence trims only

Acting on rows 1–5 (all HIGH-confidence) plus row 6 (MED) yields roughly:

- **≈ 55–75 directives** removed from the always-on surface.
- **≈ 400 lines** removed.
- Always-on surface moves from **≈ 271 → ≈ 200** directives — i.e. **into the
  plausible ceiling band** (150–200) rather than 1.8×–2.7× over it.

This does not "solve" the budget on its own, but it converts a substantial
over-budget condition into a borderline one, using only edits the audit
classifies as HIGH-confidence safe.

---

## § Decision

**Recommended always-on → glob-scoped moves:**

1. **prompt-caching.md → DEMOTE (unambiguous).** The file self-declares
   path-scoped and explicitly excludes `session-orchestrator`. This is the one
   move with zero behavioural risk — the rule was authored as glob-scoped and
   the missing `globs:` frontmatter is effectively a bug. **Recommended.**

2. **lsp.md → DEMOTE / TRIM (candidate).** Lower-confidence than (1) because the
   file is genuinely about *this* repo's posture. Trim-to-pointer is the
   conservative form; full demotion is defensible but optional.

No RISKY-tagged rule (rows 8–12) moves. Those are behaviour-critical and stay
always-on by design.

**Gating:** the *actual edits* to `.claude/rules/*.md`, `CLAUDE.md`, and any
pointer docs are **W3-gated behind explicit operator approval.** This audit
recommends and ranks; it does not edit. The HIGH-confidence rows are flagged so
W3 can act on rows 1–5 with confidence and defer/discuss the MED and RISKY rows.

---

## § Follow-ups

1. **Coordinator-injection-respects-`globs:` investigation (high value).** The
   bigger surface (B, ~450–500 directives) is the coordinator's, and
   glob-demotion does not shrink it because the harness injects rule files
   ignoring `globs:`. Investigate whether the harness can be made to respect
   `globs:` for coordinator injection — or whether a separate
   "coordinator-relevant rules" manifest is warranted. This is the single
   highest-leverage follow-up and is **out of scope for the W3 edits** here.

2. **Tier rules by load-context.** Today a rule is binary always-on /
   glob-scoped. A third tier — "coordinator-only" or "wave-only" — would let
   high-value-but-narrow rules (e.g. owner-persona, lsp) load only where they
   matter, instead of everywhere or nowhere. Worth a design spike before
   adding more always-on rules.

3. **A directive-budget guard.** Consider a lightweight check (session-start or
   CI) that sums always-on directive counts and warns when the surface crosses
   a configured ceiling (e.g. 200). This makes the budget a *measured,
   enforced* constraint rather than a periodic manual audit — the same
   "mechanism over discipline" principle the repo already applies to STATE.md
   locks and the destructive-command guard.

---

*Audit author: Impl-Core (W2). Discovery measurements: D1 (grep-verified).
Spot-checks performed against `scripts/lib/rule-loader.mjs`,
`.claude/rules/prompt-caching.md` (L1/L3), `.claude/rules/lsp.md`, and
`wc -l .claude/rules/*.md`.*
