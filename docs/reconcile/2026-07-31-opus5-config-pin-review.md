# Opus-5 Config-Pin Review (GitLab #873)

- **Date:** 2026-07-31
- **Session:** feat/938-panel-follow-ups-tv003 · Wave 3
- **Scope:** review-only report. This agent's write-scope is `docs/reconcile/**` +
  `.orchestrator/runtime/reconcile-candidates.jsonl` only — it applies **no** code fix
  (all code pins live in `agents/`, `skills/`, `scripts/` which are out of this agent's
  file-scope). Every "handle" below is a candidate for the coordinator / a follow-up, not
  a fix landed here.
- **Context (BC-1):** Under Opus 5, extended thinking runs by default without an explicit
  `thinking` field; a hard `max_tokens` then caps thinking PLUS answer jointly. The original
  cost suspicion is refuted (+6.71% total cost at effectively identical work-tokens —
  output 5119 vs 5106). This review therefore hunts two things only: (1) hard version-ID
  pins that stop riding the Opus-5 family upgrade, and (2) any hard `max_tokens` API cap
  that could jointly starve Opus-5 thinking+answer.

## Verdict

**No Opus-5 *incompatibility* found — nothing breaks under Opus 5.** The only genuine handle
is a set of stale `claude-opus-4-7` tier-pins in `persona-panel` that will keep running Opus
4.7 instead of riding the Opus-5 upgrade. **BC-1 risk = NONE** — this repo has no hard
`max_tokens` API cap anywhere; the `budget-tokens` values are prompt-level input hints, not
output caps.

---

## 1. Agent model pins (`agents/*.md`) — W1 `inherit` migration CONFIRMED complete

Evidence — `grep -rn "^model:" agents/*.md` (16 pins):

| pin value | count | agents | Opus-5 verdict |
|---|---|---|---|
| `inherit` | 12 | analyst, architect-reviewer, code-implementer, db-specialist, docs-writer, memory-proposal-collector, qa-strategist, security-reviewer, session-reviewer, test-writer, ui-developer, (AGENTS.md example) | **SAFE** — rides the session model (Opus 5) automatically |
| `haiku` | 3 | dialectic-deriver, eval-judge, skill-applied-judge | **KEEP** — deliberate cost pin (cheap judges); do NOT change |
| `opus` | 1 | ux-evaluator | **SAFE** — alias tier pin, rides the Opus-5 family |

No agent carries a hard version-ID pin. `agents/AGENTS.md:59` lists `claude-opus-4-7,
claude-sonnet-4-6, …` but that is a **documentation comment** enumerating allowed values, not
a live pin. W1's `inherit` migration is complete and Opus-5-safe.

## 2. Remaining hard version-ID strings across the repo

`rg "claude-(opus|sonnet|haiku)-[0-9]"` (raw, redaction-bypassed via node reads):

| location | string | class | Opus-5 verdict | handle |
|---|---|---|---|---|
| `skills/persona-panel/presets/{engineer,designer,pm}-lens.md` | `model: claude-opus-4-7` | **live pin** | SAFE but **STALE** | **CANDIDATE → migrate to alias `opus`** |
| `skills/persona-panel/persona-format.md` | `model: claude-opus-4-7` | live pin (template default) | SAFE but STALE | same |
| `scripts/lib/config/persona-gate-wave.mjs` | `'dispatch-model': 'claude-opus-4-7'` | live config default | SAFE but STALE | same |
| `skills/persona-panel/SKILL.md` | rationale: "`claude-opus-4-7` (empirically validated — Opus finds real problems Sonnet misses)" | prose rationale | — | update alongside the pin |
| `skills/_shared/platform-tools.md` (Cursor column) | `claude-opus-4-6`, `claude-sonnet-4-6` | Cursor-platform map | N/A for Claude Code | Cursor-hygiene, low prio |
| `skills/*/SKILL.md` (~18 files) | `model-preference-cursor: claude-sonnet-4-6` | Cursor-platform pin | N/A for Claude Code | Cursor-hygiene, low prio |
| `.claude/rules/testing.md` | example `claude-sonnet-4-20250514` | prose example for CONSUMER test configs | SAFE | none — it is guidance, not a repo pin |

### 2a. The persona-panel `claude-opus-4-7` pins — the one real handle

- **Why it is stale, not broken:** `claude-opus-4-7` remains a valid model ID; it will not
  error under Opus 5. But it pins the personas to Opus **4.7** and trades away the automatic
  upgrade to Opus 5.
- **Why the pin is not justified:** per `agents/AGENTS.md`, a full-ID pin is warranted only
  by a *demonstrated version dependency* (dated-snapshot reproducibility, or a known
  regression on newer models for this exact prompt). The persona-panel rationale is a **tier**
  argument ("Opus finds real problems Sonnet misses"), NOT a version argument ("4-7
  specifically beats 4-8/5"). The alias `opus` expresses that tier intent AND rides the
  upgrade.
- **Recommendation:** migrate the 4 `.md` pins + the `persona-gate-wave.mjs` default from
  `claude-opus-4-7` → `opus`, and update the SKILL rationale to speak of the Opus *tier*, not
  the 4-7 snapshot. **Out of this agent's file-scope** (`skills/`, `scripts/`) → coordinator
  or a follow-up issue. Low risk, no behavioural break either way.
- **Guard note:** `MODEL_ID_RE` + `ALLOWED_MODEL_ALIASES` (agent-frontmatter.mjs,
  persona catalog-loader.mjs, check-agents.mjs) accept BOTH the alias and the full ID, so the
  migration does not fight any validator.

## 3. BC-1 — `max_tokens` / `budget-tokens` joint-cap assessment

`rg "max_tokens|budget-tokens|budget_tokens|maxTokens"` across config/skills/scripts:

- **No hard `max_tokens` API parameter is set anywhere** that would cap Opus-5
  thinking+answer jointly. Grep hits are all `budget-tokens` / `judge-budget-tokens` /
  `dialectic.budget-tokens` (`CLAUDE.md dialectic.budget-tokens: 32000`; defaults 8000).
- **These are prompt-level INPUT-budget hints, not output caps.** `skills/evolve/SKILL.md`
  documents it explicitly: *"the Claude Code harness `Agent()` tool does not currently accept
  a `maxTokens` parameter. Output-token budget is therefore enforced via prompt text
  (…'with budget ${budget-tokens} input + 4000 output tokens')."* So no API-level
  `max_tokens` reaches the model to squeeze thinking+answer.
- **The agents that carry these budgets run on `haiku`** (dialectic-deriver, eval-judge,
  skill-applied-judge) — not the Opus-5 default-thinking tier — so the BC-1 mechanism does
  not even engage for them.
- **Verdict: BC-1 poses no risk in this repo.** If the harness ever adds a real `maxTokens`
  hint (evolve SKILL flags this as the single future update point), re-audit the 8000/32000
  values then — but today they are advisory input hints.

## 4. Actionable summary for the coordinator

| # | finding | Opus-5 risk | action | owner |
|---|---|---|---|---|
| A | 12 agents `inherit`, 1 `opus`, 3 `haiku` | none | none — confirmed safe | — |
| B | persona-panel `claude-opus-4-7` (4 `.md` + persona-gate-wave.mjs default + SKILL rationale) | stale (misses upgrade, no break) | migrate → alias `opus` | coordinator / follow-up (out of W3 scope) |
| C | `model-preference-cursor: claude-*-4-6` (~18 skills) + platform-tools Cursor column | none (Cursor-only) | optional Cursor-hygiene refresh | low-prio follow-up |
| D | `budget-tokens` 8000/32000 | none (prompt hints, not `max_tokens`) | none now; re-audit if harness adds `maxTokens` | — |
| E | `.claude/rules/testing.md` example `claude-sonnet-4-20250514` | none (consumer guidance) | none | — |

**Bottom line for #873:** close as *reviewed, no Opus-5 incompatibility*; spin finding **B**
(persona `claude-opus-4-7` → `opus`) into a small follow-up so the personas ride the Opus-5
upgrade. Everything else is safe as-is.
