# EARS Notation for /plan — Evaluation

> Research note — session main-2026-05-19-deep-2 · issue #440 · status: COMPLETE (W2)
> Project-instruction file resolution: `CLAUDE.md` and `AGENTS.md` (Codex CLI) are transparent aliases — see `skills/_shared/instruction-file-resolution.md`. References to `CLAUDE.md` below resolve via that precedence rule.

## Context

Spec-Driven Development (SDD) is the second-largest 2026 community trend. The premise it inverts: specifications are not a guide *for* code, they are the source that *generates* code and tests ("User stories become API endpoints. Acceptance scenarios become tests." — [github/spec-kit `spec-driven.md`](https://github.com/github/spec-kit/blob/main/spec-driven.md)). Three reference implementations drive the trend:

- **GitHub Spec Kit** — MIT toolkit, four-phase Specify → Plan → Tasks → Implement loop, 20+ agents ([github/spec-kit](https://github.com/github/spec-kit), [docs](https://github.github.com/spec-kit/)).
- **AWS Kiro** — agentic IDE (Claude Sonnet 4.5) with a three-file spec: `requirements.md` (user stories + EARS acceptance criteria) → `design.md` → `tasks.md` ([kiro.dev/docs/specs](https://kiro.dev/docs/specs/)).
- **gotalab/cc-sdd** — SDD harness exposing Kiro's loop as Agent Skills (`/kiro-spec-requirements`, `/kiro-spec-design`, `/kiro-spec-tasks`, `/kiro-impl`) across 8 agents; turns approved specs into long-running autonomous implementation ([github/gotalab/cc-sdd](https://github.com/gotalab/cc-sdd)).

EARS (Easy Approach to Requirements Syntax) is the requirement micro-syntax these tools point at for machine-checkable acceptance criteria. The cautionary framing: our `/plan feature` and `/brainstorm` emit freeform Gherkin Markdown. If the SDD-tool ecosystem standardises on a parseable requirement grammar and we stay un-parseable, our PRDs cannot be consumed by an external spec→test→impl pipeline without a lossy re-derivation step. The counter-risk: EARS is a constrained grammar that could flatten our novel `appetite:` (Shape-Up) + `MVP-XXX` traceability constructs if it *replaces* rather than *augments*.

A correction to the issue framing surfaced during research and is load-bearing for the recommendation (see External Findings): **Spec Kit itself does not use EARS** — it uses Given/When/Then + numbered `FR-NNN` MUST-statements, and EARS is an *open, un-triaged feature request* there. Only Kiro (and cc-sdd, which wraps Kiro) genuinely emit EARS today.

## Question

Should `/plan feature` (and the `/brainstorm` design-spec follow-up) emit EARS-formatted acceptance criteria? Three options from issue #440:

1. **Add EARS section** — keep the existing freeform/Gherkin plan, append a machine-parseable EARS acceptance-criteria block. Modest cost; opens machine-parsing and EARS→vitest stub generation later; preserves `appetite:`/`MVP-XXX`.
2. **Replace freeform** — swap Gherkin Given/When/Then for EARS as the sole acceptance-criteria format. Bigger change; risks reduced expressiveness and breaks the existing PRD-reviewer "Given/When/Then with concrete values" check (`prd-reviewer-prompt.md:31`).
3. **Stay freeform** — keep Gherkin only; document why not to adopt. Preserves flexibility and our novel constructs; forfeits a low-cost interop + test-stub-generation opportunity that the trend is converging on.

ADR `0005-ears-notation-plan.md` (W4) finalises the verdict using the Adopt | Adapter | Stay vocabulary from the session brief.

## External Findings (cited)

**EARS — canonical definition.** Created by Alistair Mavin and a Rolls-Royce team, introduced at RE'09 (2009). Generic syntax: *"While `<optional pre-condition>`, when `<optional trigger>`, the `<system name>` shall `<system response>`"*. Ruleset: zero-or-many preconditions, zero-or-one trigger, one system name, one-or-many system responses. Used by Airbus, Bosch, Dyson, Honeywell, Intel, NASA, Rolls-Royce, Siemens. Five templates ([alistairmavin.com/ears](https://alistairmavin.com/ears/)):

| Template | Keyword | Form (verbatim) |
|---|---|---|
| Ubiquitous | (none) | `The <system name> shall <system response>` |
| State-driven | `While` | `While <precondition(s)>, the <system name> shall <system response>` |
| Event-driven | `When` | `When <trigger>, the <system name> shall <system response>` |
| Optional feature | `Where` | `Where <feature is included>, the <system name> shall <system response>` |
| Unwanted behaviour | `If`/`Then` | `If <trigger>, then the <system name> shall <system response>` |

Requirements combining >1 keyword are **Complex** requirements, e.g. `While <precondition>, When <trigger>, the <system> shall <response>` ([alistairmavin.com/ears](https://alistairmavin.com/ears/)). Concrete examples per template ([ParamTech / Medium](https://medium.com/paramtech/ears-the-easy-approach-to-requirements-syntax-b09597aae31d)): Ubiquitous — *"The software shall be written in Python."*; Event-driven — *"When the money is received, then the app should send a notification."*; Unwanted — *"If the password is entered incorrectly, then the app shall display error message."*; State-driven — *"While in Do Not Disturb mode, the software shall silence incoming calls."*; Optional — *"Where the DP port is present, the software shall allow user to display maximum supported refresh rate."*

**GitHub Spec Kit — does NOT use EARS (issue framing correction).** The actual `spec-template.md` uses Given/When/Then acceptance scenarios and numbered functional requirements, *not* EARS: acceptance format `1. **Given** [state], **When** [action], **Then** [outcome]`; requirement format `**FR-001**: System MUST [capability]` ([spec-kit/templates/spec-template.md](https://github.com/github/spec-kit/blob/main/templates/spec-template.md)). `spec-driven.md` never mentions EARS; it states "Acceptance scenarios become tests … test scenarios aren't written after code, they're part of the specification" but describes a *conceptual* mapping, not a mechanical generator ([spec-driven.md](https://github.com/github/spec-kit/blob/main/spec-driven.md)). EARS support in Spec Kit is **issue #1356**, opened 2025-12-20, **state: open, no assignee, no labels, no maintainer triage** — proposing exactly the three options #440 asks (optional section / linting / `/speckit.ears` command) ([spec-kit#1356](https://github.com/github/spec-kit/issues/1356)).

**AWS Kiro — genuinely uses EARS.** Kiro's agent produces three documents before code: `requirements.md` = user stories with EARS-notation acceptance criteria, `design.md`, `tasks.md` ([kiro.dev/docs/specs](https://kiro.dev/docs/specs/), [TeachMeIDEA](https://teachmeidea.com/kiro-ai-ide-spec-driven-development/)). EARS "captures preconditions, triggers, and expected system responses, including edge cases that would otherwise surface during implementation." Kiro supports a Requirements-First iteration loop (requirements/design can be edited iteratively). Note: Kiro's public docs/blog *describe* the EARS format but do not display a verbatim generated EARS block — UNVERIFIED whether Kiro emits pure-Mavin EARS or a Given/When/Then-flavoured hybrid; multiple third-party write-ups call it "user stories + EARS acceptance criteria," implying a story header *plus* EARS clauses.

**gotalab/cc-sdd — EARS via Kiro lineage.** README states `requirements.md` outputs feature "EARS-format requirements with acceptance criteria." Workflow: `/kiro-discovery` → `/kiro-spec-init` → `/kiro-spec-requirements` → `/kiro-spec-design` → `/kiro-spec-tasks` → `/kiro-impl` (autonomous, TDD + independent review + auto-debug). Stable on Claude Code + Codex; beta on Cursor/Copilot/Windsurf/OpenCode/Gemini/Antigravity. "Boundary-first spec discipline emphasising contracts between system parts" ([github/gotalab/cc-sdd](https://github.com/gotalab/cc-sdd)).

**Synthesis.** Two of three flagship tools (Spec Kit's *current* shipped behaviour, and our own `/plan`) already use Given/When/Then; EARS is the *trajectory* (Kiro live, cc-sdd live, Spec Kit pending #1356) rather than today's universal standard. The trend signal is real but not yet a settled de-facto format — which materially lowers the urgency of *replacing* and raises the attractiveness of *augmenting*.

## Our Code-State (verified)

**Acceptance-criteria format today = Gherkin Given/When/Then (freeform Markdown).**

- `skills/plan/prd-feature-template.md:39-60` — Section 3 "Acceptance Criteria" emits fenced ` ```gherkin ` blocks: `Given {{precondition}}` / `When {{action}}` / `Then {{expected result}}`, one block per Feature Area plus an Edge Case / Error Handling block.
- `skills/plan/mode-feature.md:86` — Phase 2 mapping: *"3. Acceptance Criteria | Derive Given/When/Then scenarios from Wave 1 answers. Each sub-feature produces 1-3 Gherkin scenarios."*
- `skills/plan/SKILL.md:267` — Phase 6.1 issue derivation: *"`/plan feature` — derive from PRD Section 3 (Acceptance Criteria). Each Given/When/Then block becomes a sub-issue."* (Confirms the AC format is already the issue-decomposition seam.)
- `skills/plan/prd-reviewer-prompt.md:31` — reviewer Clarity criterion: *"Acceptance criteria are testable (Given/When/Then with concrete values)"* — a hard-coded dependency on the Gherkin shape; Option 2 (replace) would require editing this check.
- `skills/brainstorm/SKILL.md:144-181` — `/brainstorm` design spec has **no acceptance-criteria section at all**: it emits Problem / Chosen Approach / Trade-offs / Open Questions / Out of Scope / Hand-off. AC is deferred to the `/plan feature` hand-off. An EARS block in `/brainstorm` would be net-new, not a replacement.
- `skills/write-executable-plan/SKILL.md:60-126` — consumes "Acceptance criteria or equivalent (drives Task decomposition)" from the PRD/spec; Step 1 of every Task is "Write the failing test" with complete runnable test code. **This is the natural EARS→vitest seam**: today the executor *manually* derives a test from prose AC; an EARS clause is a deterministic test-stub template.

**`appetite:` + `MVP-XXX` constructs (EARS-compatibility check).**

- `.claude/rules/mvp-scope.md:3-7` — Shape-Up appetite: Small 1w / Medium 2w / Big 6w batches. Surfaced as PRD frontmatter `**Appetite:** {{1w|2w|6w}}` (`prd-feature-template.md:13`, `prd-full-template.md:14`) and as the `appetite:1w|2w|6w` issue label (`mode-feature.md:120`, `SKILL.md:285`).
- `.claude/rules/mvp-scope.md:24-26` — `MVP-XXX` commit traceability: `feat(auth): add login flow — MVP-001`, mapping a commit to the scope-item number in the `MVP.md` IN list. Recommendation, not commitlint-enforced.
- **These are orthogonal axes to EARS.** `appetite:` is a *time-box on the whole feature* (frontmatter/label). `MVP-XXX` is a *commit↔scope-item link*. EARS is a *per-acceptance-criterion sentence grammar*. None of the three occupy the Section-3 acceptance-criteria slot that EARS would. Verified: no construct in `mvp-scope.md` or the PRD templates writes into the Gherkin block. Adding EARS does not touch `appetite:`/`MVP-XXX`; replacing Gherkin with EARS still does not touch them (they live in frontmatter and commit messages, not the AC body). **No conflict on any of the three options.**

**Issue-creation flow fit.** `SKILL.md:267` already treats each AC block as a sub-issue seam. An EARS requirement is *more* atomic than a multi-line Gherkin scenario (one `shall` clause = one testable assertion), so EARS→issue and EARS→vitest mapping is a *tighter* fit for the existing decomposition than Gherkin, not a disruption — confirmed against `mode-feature.md:99-103` ("one issue per acceptance criterion group … do not create one issue per individual scenario").

## Feature Parity / Gap Matrix

| Dimension | Our `/plan` today (Gherkin) | EARS (Kiro/cc-sdd) | Gap / Compat |
|---|---|---|---|
| AC grammar | Freeform `Given/When/Then` fenced block (`prd-feature-template.md:42`) | 5 constrained `shall` templates + Complex (`alistairmavin.com/ears`) | EARS is stricter → more machine-parseable; Gherkin is more narrative |
| Edge / unwanted cases | One ad-hoc "Edge Case / Error Handling" Gherkin block (`prd-feature-template.md:55`) | First-class **Unwanted** (`If…Then…shall`) + **Optional** (`Where`) templates | EARS *forces* edge-case enumeration; ours is optional/ad-hoc — EARS is stronger here |
| State vs event distinction | Not expressible (Gherkin conflates) | Explicit `While` (state) vs `When` (event) keywords | EARS adds modelling fidelity ours lacks |
| `appetite:` (Shape-Up) | Frontmatter + `appetite:N w` label (`mode-feature.md:120`) | No equivalent concept | **Orthogonal** — EARS does not touch it; preserved under all 3 options |
| `MVP-XXX` traceability | Commit-message convention (`mvp-scope.md:25`) | No equivalent concept | **Orthogonal** — lives in commits, not AC body; preserved under all 3 options |
| Issue decomposition | Per-Gherkin-block → sub-issue (`SKILL.md:267`) | Per-`shall` clause → finer-grained issue | Compatible; EARS is a *tighter* seam |
| Test-stub generation | Manual derivation in `write-executable-plan` Step 1 | Deterministic: each template → one vitest case | **Largest win** — EARS→vitest is mechanical; see mapping below |
| Reviewer check | Hard-codes "Given/When/Then" (`prd-reviewer-prompt.md:31`) | Would need an EARS-shape check | Option 2 (replace) breaks this; Option 1 (add) needs an *additional* check, not a rewrite |
| `/brainstorm` AC | None (deferred to `/plan`) (`brainstorm/SKILL.md:144-181`) | N/A | Net-new section if added; no replacement risk |
| Ecosystem interop | Not consumable by Kiro/cc-sdd without re-derivation | Native input to cc-sdd `/kiro-spec-requirements` | EARS unlocks external SDD-pipeline interop |
| Flexibility / narrative richness | High (free prose in Given/When/Then) | Lower (constrained grammar) — but Complex template recovers most | Mild expressiveness cost; mitigated by keeping Gherkin alongside (Option 1) |

**EARS → vitest mapping feasibility (the load-bearing assessment):** mechanical and high-confidence. Each template has a 1:1 test skeleton:

| EARS template | vitest stub skeleton |
|---|---|
| Ubiquitous `The S shall R` | `it('S shall R', () => { /* assert invariant R holds */ })` |
| Event-driven `When E, the S shall R` | `it('when E, S shall R', () => { /* arrange; trigger E; expect R */ })` |
| State-driven `While St, the S shall R` | `describe('while St', () => it('S shall R', () => { /* enter St; expect R */ }))` |
| Unwanted `If C, then the S shall R` | `it('if C then S shall R', () => { /* induce C; expect R (error path) */ })` |
| Optional `Where F, the S shall R` | `it.skipIf(!F)('where F, S shall R', () => { /* expect R when F enabled */ })` |

This slots directly into `write-executable-plan` Step 1 ("Write the failing test … complete runnable test code", `write-executable-plan/SKILL.md:92-98`) and aligns with `.claude/rules/test-quality.md` (one meaningful assertion, behaviour not implementation, no branching) — the EARS clause *is* the behavioural contract a test-quality-compliant test asserts.

## Empirical

N/A — docs+code-analysis only per session-start AUQ. No `/plan feature` run, no EARS→vitest generator prototype, and no Kiro/cc-sdd live-tool execution were performed. The worked example below is a hand-conversion of a real shipped issue's acceptance criterion, not generator output; mechanical validation of an EARS→vitest emitter is deferred to the W4 ADR follow-up.

## Preliminary Recommendation

**Lean: Option 1 — Add EARS section (ADR vocabulary: Adapter).**

Rationale: (a) the orthogonality check is clean — EARS does not touch `appetite:`/`MVP-XXX` under *any* option (they live in frontmatter and commit messages, not the AC body), so the "preserve our novel constructs" concern in #440 is **not a blocker for adoption**, only an argument against a *careless replace*; (b) the trend is real but not settled — Spec Kit, the 71k-star flagship, still ships Given/When/Then and has EARS only as an un-triaged feature request (#1356), so *replacing* (Option 2) would chase a format the largest tool hasn't itself committed to, while *staying* (Option 3) forfeits the one mechanical win — EARS→vitest — that maps perfectly onto our existing `write-executable-plan` Step-1 seam; (c) Option 1 keeps the narrative Gherkin block (so `prd-reviewer-prompt.md:31` and existing PRDs need no rewrite) and adds an `## Acceptance Criteria (EARS)` companion block that becomes the parseable contract for external SDD interop and test-stub generation; (d) `/brainstorm` gains EARS as a *net-new* section (it has none today), zero replacement risk.

**Worked example — real recent issue #458** (`[wave-executor] Persona-gate wave`, shipped 2026-05-19 deep-1, `appetite:1w`). One of its checklist acceptance criteria, verbatim:

> "`mode: warn` → Findings in wave-progress surfacen, weitermachen; `mode: strict` → AskUserQuestion mit 3 Optionen (proceed-as-is / revise-remaining-waves / abort-session); `mode: off` → wave-loop ignoriert das Feld komplett (no-op, backward-compat)"

Converted to EARS (Event-driven + Unwanted + Optional templates), this becomes three atomic, test-mappable clauses:

- **Event-driven:** *When the persona-gate wave fails and `mode` is `warn`, the wave-executor shall surface the dissenting findings in wave-progress and continue the session.*
- **Event-driven:** *When the persona-gate wave fails and `mode` is `strict`, the wave-executor shall present an AskUserQuestion with exactly three options (proceed-as-is, revise-remaining-waves, abort-session).*
- **Unwanted:** *If `persona-gate-wave.enabled` is true but `mode` is `off`, then the wave-executor shall treat the field as a no-op and preserve backward-compatible behaviour.*

Assessment: EARS feels **natural and clarifying** for our domain. The original prose bundled three behaviours behind arrows; EARS split them into one-assertion-each clauses that map 1:1 onto `tests/lib/wave-executor/persona-gate-hook.test.mjs` (the #481 hook test shipped this session) — exactly the `mode=off`/`mode=warn`/`mode=strict` test cases the issue specified, now derivable mechanically instead of by re-reading prose. The Shape-Up `appetite:1w` label and any `MVP-XXX` commit ref are untouched and live exactly where they did before. This worked example supports Option 1: the EARS block is additive value (sharper test seam + interop) with no cost to the constructs #440 was protecting.

W4 ADR `0005-ears-notation-plan.md` finalises; if it concurs, the follow-up issue is a `/plan feature` + `/brainstorm` template change adding the `## Acceptance Criteria (EARS)` companion section plus an EARS-shape check in `prd-reviewer-prompt.md` (additive, not replacing the Given/When/Then check), and an optional EARS→vitest stub emitter wired into `write-executable-plan` Step 1.

---

### Verification

- `wc -l docs/research/2026-05-19-ears-evaluation.md` → **126** (≥120 required).
- `grep -c '^## ' docs/research/2026-05-19-ears-evaluation.md` → **7** level-2 sections (Context, Question, External Findings (cited), Our Code-State (verified), Feature Parity / Gap Matrix, Empirical, Preliminary Recommendation).
