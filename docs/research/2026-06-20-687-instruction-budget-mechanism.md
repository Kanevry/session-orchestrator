# Instruction-Budget Mechanism — Coordinator-Injection Verdict (#687)

> Status: SHIPPED (directive-budget guard) + verdict recorded (coordinator-injection) + PROPOSED follow-up (rule-tiering). 2026-06-20.
> Companion to: `docs/audit/2026-06-20-instruction-budget-audit.md` (#668/#687).

## TL;DR

The #687 discovery asked whether the repo can shrink the **coordinator** instruction
surface by making the Claude Code harness respect each rule's `globs:` frontmatter at
session-start. **Verdict: NOT in-repo-buildable.** The harness injects ALL
`.claude/rules/*.md` into the coordinator context regardless of `globs:`; `globs:` only
governs the per-wave surface (via `rule-loader.mjs`, which has no runtime caller other
than the new budget guard and the per-wave boundary). The one in-repo, mechanism-over-
discipline lever is a **directive-budget growth-ratchet** — shipped this session — plus
physically trimming rule files (tracked in #688). A backward-compatible `tier:`
frontmatter convention is **proposed** but deliberately not implemented (it would be inert
metadata until the harness honors it).

---

## 1. Coordinator-injection-respects-globs — NOT in-repo-buildable

### Finding

The Claude Code harness injects every `.claude/rules/*.md` file into the coordinator
(top-level session) context at session start, **ignoring** the `globs:` frontmatter on
each rule. The repo cannot intercept or filter that injection — it is an upstream harness
behaviour.

### Evidence (verified against the code this session)

- **`scripts/lib/rule-loader.mjs` governs ONLY the per-wave surface.** Its public entry
  `loadApplicableRules({ rulesDir, scopePaths })` filters rules by `globs:` against a
  wave's `allowedPaths`. Its only non-test runtime caller is the new
  `scripts/lib/instruction-budget-guard.mjs` (and the documented per-wave boundary):

  ```
  $ grep -rln "loadApplicableRules" scripts/ hooks/ skills/ | grep -v test
  scripts/lib/rule-loader.mjs
  scripts/lib/instruction-budget-guard.mjs
  skills/_shared/config-reading.md
  ```

- **`skills/_shared/config-reading.md:133` states the contract verbatim:**
  > "The `loadApplicableRules()` call happens at the wave boundary so that each wave gets
  > a fresh rule set scoped to its `allowedPaths`. It does NOT run at session-start for the
  > coordinator prompt; **the coordinator always receives all always-on rules regardless of
  > scope.**"

- `rule-loader.mjs` frontmatter parsing extracts only `globs:` and explicitly **ignores
  all other keys** (`rule-loader.mjs:178 // Ignore all other keys`). So even a glob-scoped
  rule is loaded for every wave when it lacks `globs:`, and the coordinator gets the
  unfiltered set regardless.

### Consequence

There is **no in-repo lever** that makes the harness respect `globs:` for coordinator
injection — that is an **upstream Claude Code feature request**. The only in-repo way to
shrink the coordinator surface is to **physically trim / merge / delete** always-on rule
files (tracked in #688). The directive-budget guard below makes that growth observable;
it does not (and cannot) change what the harness injects.

---

## 2. Directive-budget guard — SHIPPED (this session)

The buildable, mechanism-over-discipline piece. `scripts/lib/instruction-budget-guard.mjs`:

- `computeInstructionBudget({ repoRoot, rulesDir, ceiling })` — pure; sums structural
  directives across the always-on rules and returns the full shape (never null/throws).
- `checkInstructionBudget({ repoRoot, ceiling })` — banner wrapper wired into session-start
  Phase 4 (`skills/session-start/SKILL.md`); returns `null` when silent, `{ severity:'warn',
  message }` when over the ceiling. Reads `instruction-budget.{enabled,ceiling,mode}` from
  Session Config; `enabled:false` or `mode:off` → silent.

### Structural counting heuristic

Per always-on rule file, count one directive per line matching:

- bullets: `^\s*[-*+]\s`
- ordered items: `^\s*\d+[.)]\s`
- headings depth ≥ 2: `^#{2,}\s`

Fenced code blocks (``` … ```) are excluded entirely, and a leading `---` … `---` YAML
frontmatter block is skipped before counting. Membership (always-on vs glob-scoped) is
delegated to `rule-loader.mjs` — glob-scoped rules are excluded, single SSOT.

### 457-structural vs 271-semantic — why the audit's number is not mechanically reproducible

The #668 audit reported **~271 directives** as a *semantic* estimate — a human reading of
"distinct things the rules tell the agent to do", merging restatements and ignoring
sub-bullets that elaborate a parent. That count is **not mechanically reproducible**: it
depends on judgement about what counts as one directive.

The guard instead uses a **structural** heuristic (every bullet / ordered item / heading
≥ depth 2 is one unit). That yields a **higher, deterministic** number — **~457–460**
across the 11 always-on rules at the time of writing (live: `total=460` on 2026-06-20).
The two numbers measure different things; the guard's value is its **determinism and
monotonicity**, not agreement with the semantic estimate. A structural delta of +1 always
means a real new bullet/heading was added to an always-on rule.

### 480 growth-ratchet ceiling rationale

The default ceiling is **480** — chosen just above the ~457–460 structural baseline. This
is a deliberate **growth ratchet**:

- It is **silent today** (460 < 480) — the operator accepted the current surface.
- It fires **only when NEW always-on directives push the count over 480** — catching
  unchecked growth without churning on the existing surface.
- The ~20-unit headroom absorbs ordinary edits (one rule gaining a few bullets) without a
  false alarm, while still bounding total drift.

The ceiling is config-overridable (`instruction-budget.ceiling`); a value ≤ 0 falls back
to the default. Lowering it after a successful #688 trim re-arms the ratchet at the new,
smaller baseline.

---

## 3. Rule-tiering convention — PROPOSED (follow-up, NOT implemented this session)

A backward-compatible design for a future `tier:` frontmatter key on each rule.

### Design

```yaml
---
tier: coordinator-only   # always | coordinator-only | wave-only
globs:                   # unchanged; orthogonal to tier
  - "src/**"
---
```

- `tier: always` (default when absent) — current behaviour: injected to the coordinator
  AND loaded for every wave.
- `tier: coordinator-only` — high-level policy the coordinator needs but waves do not
  (e.g. AUQ rules, parallel-session discipline).
- `tier: wave-only` — implementation detail relevant only inside a wave (e.g. language
  path-scoped rules), kept OUT of the coordinator surface.

### Why it is backward-compatible TODAY (and therefore safe to land later)

`rule-loader.mjs` frontmatter parsing extracts only `globs:` and **ignores all other
keys** (`rule-loader.mjs:178`). Adding a `tier:` line to any rule is a **no-op** under the
current loader — it neither changes glob matching nor breaks the 30 existing rule-loader
tests. So the convention can be introduced incrementally (annotate rules first, wire the
parser later) with zero risk.

### Why it is NOT implemented now

`tier:` is **advisory metadata only** until/unless a consumer honors it:

- The **coordinator** surface is injected by the harness, which ignores frontmatter
  entirely (§1) — so `tier: coordinator-only` / `wave-only` cannot shrink the coordinator
  surface from in-repo. That is the same upstream limitation as `globs:`.
- The **per-wave** surface *could* honor `tier: wave-only` via a rule-loader change, but
  that is a separate, testable unit of work with its own blast radius on the 30 rule-loader
  tests — out of scope for this polish task.

### Recommendation

File a follow-up issue to:

1. Implement `tier:` parsing in `rule-loader.mjs` (extend the frontmatter parser; add tests).
2. Map each always-on rule to a tier.
3. Make `loadApplicableRules` drop `tier: coordinator-only` rules from the wave surface.

This stays purely in-repo (the per-wave surface IS repo-controlled) and complements #688's
physical trim. It does NOT change the coordinator surface — that remains an upstream ask.

---

## Cross-references

- `docs/audit/2026-06-20-instruction-budget-audit.md` — the #668/#687 audit (semantic count, prune/demote list).
- `scripts/lib/instruction-budget-guard.mjs` — the shipped guard (compute + banner + config read).
- `scripts/lib/rule-loader.mjs` — per-wave membership SSOT; line 178 "Ignore all other keys".
- `skills/_shared/config-reading.md:133` — "the coordinator always receives all always-on rules regardless of scope".
- `skills/session-start/SKILL.md` — Phase 4 banner wiring.
- `docs/session-config-reference.md` — `## Instruction Budget (#687)` doc row.
- Issues: #687 (this guard), #668 (audit), #688 (physical rule trim — the other in-repo lever).
