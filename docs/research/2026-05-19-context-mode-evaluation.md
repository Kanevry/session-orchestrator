# context-mode Tool-Output Sandbox for test-runner — Evaluation

> Research note — session main-2026-05-19-deep-2 · issue #439 · status: W2 FILLED
> Project-instruction file resolution: `CLAUDE.md` and `AGENTS.md` (Codex CLI) are transparent aliases — see [skills/_shared/instruction-file-resolution.md](../../skills/_shared/instruction-file-resolution.md). Wherever this note says `CLAUDE.md`, the alias rule applies.

## Context

`/test` (the test-runner skill, `skills/test-runner/SKILL.md`) produces a run directory under `.orchestrator/metrics/test-runs/<run-id>/` containing Playwright HTML/JSON reports, AX-tree dumps (`ax-snapshots/*.yaml`), axe-core JSON (`ax-snapshots/axe-*.json`), screenshots + trace bundles (binary, path-referenced), and console output. The `ux-evaluator` agent (`agents/ux-evaluator.md`, opus, read-only) ingests these and applies the 4-check UX rubric (`skills/test-runner/rubric-v1.md`), then writes `findings.jsonl`. The concern in issue #439: AX-tree / JSON-report artifacts can balloon, and an opus agent holding full artifact content in context is the token-cost growth vector — every driver SKILL carries an explicit "NEVER inline AX-tree dumps into context" anti-pattern (`skills/playwright-driver/SKILL.md:108`, `skills/peekaboo-driver/SKILL.md:142,223`).

`mksglu/context-mode` is a popular (15.1k★) MCP server that claims ~98% context reduction by sandboxing tool output — and its single most-cited benchmark row is *a Playwright snapshot* (56.2 KB → 299 B, 99%). On its face this is a direct hit on our exact pain point, which is why the issue exists. The cautionary frame: this repo has a standing position (`docs/adr/0001-context-vs-orchestration.md`) that external context-reduction claims with unvalidated methodology are not adopted reflexively — context size is an *input signal*, not a substrate swap. This evaluation tests whether context-mode's mechanism actually intersects our architecture, and whether the headline number survives an honest audit against where our token cost truly lives.

## Question

**Decision: adopt context-mode as an MCP server · build-our-own wrapper at `scripts/lib/test-runner/` · or skip** — for reducing test-runner artifact token cost in the `ux-evaluator` path.

Decision factor stated in #439: *if ux-evaluator's rubric checks need full AX-tree access, a summary-only sandbox degrades evaluation quality.* This note must identify, per rubric check, which tolerate summary-only vs. require raw artifact bytes — that table is the gate on any "adopt/build-own" verdict.

## External Findings (cited)

All facts below are sourced from the upstream repo and its docs.

- **Shape: MCP server, not a transparent proxy.** context-mode registers 11 `ctx_*` tools (`ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_index`, `ctx_search`, `ctx_fetch_and_index`, + 5 meta). It does **not** intercept or rewrite existing tool calls. — [README](https://github.com/mksglu/context-mode/blob/main/README.md), [repo description](https://github.com/mksglu/context-mode).
- **Routing is agent-driven, enforced by hooks — not automatic interception.** The agent must *explicitly* call `ctx_execute(...)` instead of a raw shell/read call. The `PreToolUse` hook *blocks* unrouted large-output tools (`run_shell_command`, `read_file`, `read_many_files`, `grep_search`, `search_file_content`, `web_fetch`) and nudges the model toward the sandbox; it does **not** auto-wrap a Playwright run that is already executing. Hook-enforced routing yields ~98%; instruction-file-only routing yields ~60%. — [README](https://github.com/mksglu/context-mode/blob/main/README.md).
- **The Playwright benchmark row is the LOSSY tool class.** BENCHMARK.md classifies "Playwright snapshot: 56.2 KB → 299 B (99%)" under `ctx_execute_file`, described as *"Best for: logs, test output … data where summaries are more useful than raw content"*, and explicitly: `ctx_execute_file` *"achieves 95–100% savings because it compresses data into 1-2 line summaries."* The lossless-on-demand class is a different pair (`ctx_index` + `ctx_search`, *"returns complete, exact chunks"*, only 50–93% savings). — [BENCHMARK.md](https://github.com/mksglu/context-mode/blob/main/BENCHMARK.md).
- **Honest audit of the 98%/99% claim.** Sourced and self-described as *"real outputs … not synthetic data."* But: (1) the metric is **raw bytes vs. context bytes**, not measured model tokens; (2) the BENCHMARK.md Playwright row carries **no stated query/intent and no description of what the 299 B contains** — by its own taxonomy it is a 1–2-line lossy summary, so "99%" is a *compression-into-a-summary* ratio, not a fidelity-preserving reduction. The headline "315 KB → 5.4 KB / 98%" (and a parallel "376 KB → 16.5 KB / 96%") are whole-session aggregates mixing lossy and lossless tools. **Verdict on the claim: directionally real but materially overstated for any use that needs the artifact content back.** The 99% Playwright figure is only achievable by discarding the snapshot down to a summary the model cannot re-expand. — [BENCHMARK.md](https://github.com/mksglu/context-mode/blob/main/BENCHMARK.md), [betterstack guide](https://betterstack.com/community/guides/ai/context-mode-mcp/).
- **Local Read/Grep/Glob get no direct benefit.** Per the README, context-mode targets tools that *produce* large output and only processes content when the agent calls `ctx_execute`/`ctx_execute_file`. A subagent that reads local files via its own Read/Grep/Glob is not transparently helped — the file content is sandboxed only if the agent *chooses* to route it through `ctx_*`. — [README](https://github.com/mksglu/context-mode/blob/main/README.md).
- **MCP-only install path exists** (no hooks): `claude mcp add context-mode -- npx -y context-mode` — all 11 tools, no automatic routing/enforcement. — [README](https://github.com/mksglu/context-mode/blob/main/README.md).
- **Maintenance signals (strong).** Verified via GitHub API 2026-05-19: 15,114★, 1,085 forks, 83 contributors, latest release **v1.0.140** published 2026-05-18, `pushed_at` 2026-05-19 (same day), not archived, TypeScript, Node ≥ 22.5 / Bun, SQLite FTS5. License: GitHub reports `NOASSERTION`; secondary sources identify it as **ELv2 (Elastic License v2)** — a source-available, non-OSI license that restricts offering the software as a managed service. — `gh api repos/mksglu/context-mode`, [EveryDev](https://www.everydev.ai/tools/context-mode).
- **Caveman/terse output mode (orthogonal).** Secondary sources note a separate 65–75% *output*-token reduction by forcing terse model responses. This is a prompt-style lever unrelated to artifact sandboxing and out of scope for #439. — [betterstack guide](https://betterstack.com/community/guides/ai/context-mode-mcp/).
- **Hook model (relevant to why interception would not reach our subagent).** context-mode's 5 hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`, `SessionStart`) operate at the Claude Code session/harness layer, not at the subagent boundary. `PreToolUse` enforcement blocks large-output *tool names* (`run_shell_command`, `read_file`, …) in the main session. Whether a dispatched Agent's `Read`/`Grep` calls are even subject to the parent session's PreToolUse hook is harness-version-dependent and **UNVERIFIED** for our setup; the README only documents enforcement against the main agent's tool calls. A dispatched read-only `ux-evaluator` with `tools: Read, Grep, Glob, Bash` reading a local run-dir is not the scenario context-mode's enforcement is designed for. — [README](https://github.com/mksglu/context-mode/blob/main/README.md).
- **Known recent instability (maintenance honesty).** The repo's own commit log (verified `gh api repos/mksglu/context-mode/commits`) documents a v1.0.137–139 *silent-suppression* edge case (issue #623: "zero ctx_* tools"), fixed forward in v1.0.140 with a stderr diagnostic — a reminder that a 1-day-old release on a 15k★ high-velocity project still ships and patches user-visible regressions weekly. — `gh api`, commit `0c838a3` (2026-05-18).

## Our Code-State (verified)

**Artifact inventory (real, from `.orchestrator/metrics/test-runs/` — three actual runs on disk):**

| Artifact | Real size observed | Token-heavy? | Consumed by |
|---|---|---|---|
| `results.json` (Playwright JSON reporter) | 27 KB → **86 KB** (run `…170021-v3`, ≈ **21.5 K tok** at chars/4) | **YES — dominant** | test-runner orchestrator parses; ux-evaluator does *not* per rubric |
| `console.log` | 1.3 KB / 7.8 KB / **17 KB** (≈ 1.9–4.3 K tok) | Moderate | ux-evaluator Check 3 (`agents/ux-evaluator.md:52`) |
| `ax-snapshots/*.yaml` (`page.accessibility.snapshot()`) | none captured in the 3 fixtures-less runs; SKILL warns *"50–200K tokens"* (`skills/playwright-driver/SKILL.md:108`) | **YES (potential)** — fixture-emitted | ux-evaluator Checks 1 + 4 |
| `ax-snapshots/axe-*.json` (`@axe-core/playwright`) | none in these runs (axe-core absent in target, soft-skip — `scripts/lib/playwright-driver/runner.mjs:65-80,184`) | **YES (potential)** — array of axe `Result` objects | ux-evaluator Check 2 |
| `report/index.html` + `report/trace/**` + `report/data/*.zip` | **526–548 KB** index.html; trace assets up to 649 KB JS; total run-dir **2.2 MB** | N/A — **path-referenced binary, never read into context** | human via `playwright show-report` only |
| `test-results/**/trace.zip` | 1.8–6 KB each | N/A — binary, path-only | human via `playwright show-trace` |
| `screenshots/*.png` | binary | N/A — path-referenced as `evidence_path` only | ux-evaluator references path, never decodes |

**Architectural fact that decides this evaluation:** `agents/ux-evaluator.md:6` declares `tools: Read, Grep, Glob, Bash`. Its Process (`agents/ux-evaluator.md:37-56`) reads artifacts **directly from disk** via Glob + Read + `ls`. It makes **no MCP tool calls** and **no shell-out for the heavy artifacts**. The test-runner orchestrator dispatches it via the Agent tool with only `<scope: ${RUN_DIR}, rubric: …, output: …>` in the prompt — `skills/test-runner/SKILL.md:151-160` — explicitly *"the coordinator does NOT need to forward findings through prompt context."* The repo's `.mcp.json` registers only the `session-orchestrator` MCP server; there is no project-level wiring through which a third-party MCP could transparently sit between ux-evaluator and the run-dir.

**The single dominant artifact is already context-isolated by design.** `results.json` (≈21.5K tok in the largest real run) is the biggest token-bearing file, but the rubric does **not** route it through ux-evaluator at all — `agents/ux-evaluator.md:39-42` globs only `ax-snapshots/axe-*.json`, `screenshots/*.png`, and `console.log`. The Playwright JSON report is consumed by the **orchestrator** for pass/fail accounting (`skills/test-runner/SKILL.md:129,190`), and even there the orchestrator parses it programmatically rather than holding it in model context. So the artifact context-mode's own headline benchmark targets (a Playwright report/snapshot) maps, in our architecture, to a file that is *already* not in any LLM context. This is the crux: the thing context-mode is best at compressing is the thing we already keep out of context by construction.

**Binary trace/report artifacts are out of scope for any sandbox.** The 2.2 MB run-dir bulk is `report/trace/**` (JS/CSS assets up to 649 KB) and `test-results/**/trace.zip` + `screenshots/*.png` — all path-referenced binaries opened only by humans via `playwright show-report`/`show-trace`. They never enter context and an output sandbox has nothing to do for them. Token cost and disk cost are orthogonal here; only the latter is large, and that is a retention-policy concern (`test-runner.retention-days`, `SKILL.md:40`), not a context concern.

**Per-rubric-check raw-vs-summary tolerance (the #439 decision gate):**

| Rubric check (`rubric-v1.md`) | Input artifact | Needs RAW bytes? | Why — and what a 1-2-line summary would break |
|---|---|---|---|
| **Check 1 — onboarding-step-count** (`rubric-v1.md:93`) | `ax-snapshots/*.yaml` | **Mostly summary-tolerant** | Needs a *count* of distinct step screens + each step's primary heading text + an `evidence_path`. A structured summary ("9 steps: [headings…]") suffices **iff** the summary preserves per-step heading text and the locator/entry-route. A generic 1–2-line LLM summary ("onboarding flow looks long") would NOT — it loses the step list and the stable `locator`, breaking fingerprint stability. |
| **Check 2 — axe-violations** (`rubric-v1.md:155`) | `ax-snapshots/axe-*.json` | **RAW REQUIRED** | Emits one finding per unique `(ruleId, nodes[0].target)` where `impact ∈ {critical, serious}`, embeds the **verbatim axe `Result` object** in `description`, and derives the fingerprint `locator` from `nodes[0].target`. Per-node selector strings and impact fields are not recoverable from a lossy summary. A summary-only sandbox **degrades this check to unusable** (fabricated/imprecise findings — the agent's own #1 prohibition, `agents/ux-evaluator.md:13`). |
| **Check 3 — console-errors** (`rubric-v1.md:218`) | `console.log` | **RAW REQUIRED (line-level)** | Per-line classification of error class + extraction of origin URL / `file:line` for the fingerprint `locator`, plus noise-filtering of HMR/extension lines. Needs every error line, not a count. A summary collapses the per-error locators the fingerprint depends on. (Note: the spec assumes NDJSON; the real driver appends **raw Playwright stdout/stderr** — `runner.mjs:238,252-253` — so it is already line-oriented free text, not structured.) |
| **Check 4 — liquid-glass-conformance** (`rubric-v1.md:286`) | screenshots + AX annotations | Path-referenced; **N/A for sandboxing** | macOS/Swift-only, conditional, operates from screenshot paths + AX-frame annotations. Screenshots are binary path-references already (never in context). Not a token-cost source; not addressable by an output sandbox. |

Net: **2 of 4 checks (axe-violations, console-errors) hard-require raw artifact bytes** at line/object granularity to preserve the fingerprint contract (`rubric-v1.md:57-89`) that `issue-reconcile.mjs` depends on for cross-run dedup. The summary-only mode (`ctx_execute_file`) — the exact tool class behind the 99% Playwright headline — would break deterministic reconciliation. The lossless class (`ctx_index`+`ctx_search`) preserves fidelity but only at 50–93%, and **still requires re-architecting ux-evaluator to call `ctx_search` instead of Read/Grep** — which the current read-only-from-disk design does not do.

## Feature Parity / Gap Matrix

| Capability | Our current design | context-mode | Gap / verdict |
|---|---|---|---|
| Keep heavy artifacts OUT of coordinator context | **Already solved** — artifacts written to `${RUN_DIR}` on disk; coordinator passes only a scope string (`SKILL.md:332`, `:151-160`) | `ctx_execute` keeps subprocess stdout out of context | **No gap.** Our disk-handoff already achieves the coordinator-side goal context-mode sells. |
| Keep heavy artifacts OUT of the *evaluator* agent context | Partial — ux-evaluator Reads artifacts into its own (opus) context; bounded by reading only the run-dir, not the repo | `ctx_index`+`ctx_search` would let the evaluator query instead of full-read | **Real gap, narrow.** Only material when AX/axe JSON is large *and* fixtures actually emit it (0 of 3 real runs did). |
| Fidelity for axe/console fingerprinting | Full — raw Read preserves every selector/line | Lossy class breaks it; lossless class preserves but needs API change | context-mode's *headline* mode is **worse**; its lossless mode is **fidelity-equal but not free**. |
| Transparent interception (zero agent rework) | N/A | **No** — agent must call `ctx_*`; PreToolUse only *blocks*, doesn't wrap | **Adoption is not drop-in.** Requires rewriting `agents/ux-evaluator.md` Process + tool list. |
| MCP-fit with our stack | `.mcp.json` registers only `session-orchestrator`; host mcpjungle gateway exists but no project wiring to it | MCP-server-shaped; MCP-only install available | Mechanically installable, but no current seam where it sits between evaluator and run-dir. |
| Maintenance / supply-chain | In-repo `.mjs`, zero deps (`fingerprint.mjs` uses node `crypto`) | 15.1k★, v1.0.140 (1-day-old), 83 contributors, **ELv2 (source-available, non-OSI)** | High velocity = both healthy and churny (README itself documents a v1.0.137-139 silent-suppression regression, #623). ELv2 is a license-review item, not a blocker for internal use. |
| Targeted summarizer for the ONE big file (`results.json`, ≈21K tok) | Not built; but ux-evaluator does **not** read `results.json` per rubric — the orchestrator parses it programmatically | `ctx_execute_file` could summarize it | **Low value** — the dominant artifact is already not in any agent's context. |

**Adoption risk register (decision-relevant, not yet covered above):**

- **Determinism hazard.** `agents/ux-evaluator.md:15` mandates that two invocations against identical run-dir contents produce **byte-identical `findings.jsonl`** (the invariant `issue-reconcile.mjs` cross-run dedup depends on). context-mode's lossy `ctx_execute_file` summaries are LLM-generated and non-deterministic — inserting one between the artifact and the evaluator would make fingerprints non-reproducible, silently re-filing issues every run. This is a *correctness* regression, not just a quality one. Even the lossless `ctx_search` path introduces ranking (BM25/RRF) whose tie-breaks are not contractually stable across versions.
- **Read-only sandbox-tier contract.** `agents/ux-evaluator.md:7` is `sandbox-tier: read-only`. `ctx_execute`/`ctx_execute_file` *run code in a subprocess* — routing the evaluator through them widens its effective capability from "read files" to "execute a sandboxed runtime," which conflicts with the agent's declared tier and would need a security re-review.
- **Harness-audit Category 8 interaction.** This repo's own `harness-audit` scores MCP configuration (Category 8, `scripts/lib/harness-audit/categories/category8.mjs`). Adding a third-party MCP server to `.mcp.json` changes that surface and the audit's expectations; the interaction is unassessed and would be a follow-up, not free.
- **License gate.** ELv2 is source-available, not OSI-approved; it restricts offering the software as a managed service. For internal plugin use this is likely fine but is a documented review item, not a non-issue — and it is inconsistent with the repo's preference for zero-dependency in-repo `.mjs` helpers (`scripts/lib/test-runner/fingerprint.mjs` deliberately uses only node `crypto`).

## Empirical

Real measurements from the three on-disk runs under `.orchestrator/metrics/test-runs/` (sizes via `wc -c`; token estimate = bytes/4, a conservative upper bound for JSON/log text):

- `aiat-pmo-2026-05-14-170021-v3`: `results.json` **86,149 B (≈21.5K tok)**, `console.log` 7,775 B (≈1.9K tok); total run-dir **2.2 MB** (dominated by `report/trace/**` binary assets — never in context).
- `aiat-pmo-2026-05-14-165941-retry`: `results.json` 27,154 B (≈6.8K tok), `console.log` 17,279 B (≈4.3K tok); total **572 KB**.
- `aiat-pmo-2026-05-14-165657`: `console.log` 1,345 B; only `exit_code` + console (early-failure run).
- **AX-tree YAML and axe-*.json: 0 bytes captured in all three runs** — these target runs had no fixtures emitting `page.accessibility.snapshot()` and no `@axe-core/playwright` installed (soft-skip path `runner.mjs:184` fired). So the *theoretically* heaviest artifacts (SKILL warns 50–200K tok) were **absent in every real run we have**; the actual evaluator-facing token load in observed practice was console.log only (≤4.3K tok).

**Honest gap in this empirical section:** no real `/test` run in this repo has yet exercised ux-evaluator against a fixture-rich target that emits large AX-tree YAML + axe JSON. The 50–200K-token AX figure is the SKILL author's stated worst case (`playwright-driver/SKILL.md:108`), **UNVERIFIED** locally. The single largest *measured* artifact is `results.json` at 86 KB / ≈21.5K tok, and that file is provably outside the ux-evaluator's glob set (`agents/ux-evaluator.md:39-42`) — so the worst observed evaluator-facing load remains console.log at ≈4.3K tok.

**W3 measurement procedure (concrete, so the next wave does not re-derive it):** (1) point `/test` at a target repo that has `@axe-core/playwright` in `devDependencies` and a `playwright.config.ts` fixture emitting `page.accessibility.snapshot()` → `${RUN_DIR}/ax-snapshots/<t>.yaml` and `@axe-core/playwright` → `axe-*.json` (per the fixture pattern in `playwright-driver/SKILL.md:114-144`); (2) run `/test` and let it dispatch ux-evaluator; (3) read the ux-evaluator agent's input-token count from the run telemetry / agent dispatch record (the agent's machine-readable contract block, `agents/ux-evaluator.md:145-161`, plus the `.orchestrator/metrics/test-runs.jsonl` roll-up `SKILL.md:300-317`); (4) compare against the > 40K input-token revisit threshold below. Only a measured exceedance justifies the lossless `ctx_index`/`ctx_search` integration (or the build-own equivalent) over status quo. Until then the empirically-observed evaluator token cost does not justify the adoption/build cost.

### Empirical (W3, 2026-05-19)

**Mission:** settle the UNVERIFIED "50–200K-token AX worst case" claim from issue #439 (W2 left this open). Measure real evaluator-facing token load across all on-disk runs; confirm or refute the pain.

**Step 1 — Full artifact inventory** (source: `find .orchestrator/metrics/test-runs -type f -exec wc -c {} +`, trimmed to evaluator-relevant files; full output pasted at end of subsection):

| Path | Bytes | ~Tokens (bytes/4) | ux-evaluator reads it? |
|---|---|---|---|
| `aiat-pmo-2026-05-14-170021-v3/console.log` | 7,775 B | ~1,944 tok | **YES** — Check 3 (`agents/ux-evaluator.md:52`) |
| `aiat-pmo-2026-05-14-170021-v3/results.json` | 86,149 B | ~21,537 tok | **NO** — orchestrator parses it programmatically; ux-evaluator glob set is `ax-snapshots/axe-*.json`, `screenshots/*.png`, `console.log` (`agents/ux-evaluator.md:39-42`) |
| `aiat-pmo-2026-05-14-170021-v3/exit_code` | 1 B | <1 tok | No |
| `aiat-pmo-2026-05-14-170021-v3/report/index.html` | 547,672 B | ~136,918 tok | **NO** — binary/HTML, path-only, never read into context |
| `aiat-pmo-2026-05-14-170021-v3/report/trace/**` | ~1,200 KB total | — | **NO** — binary assets (JS/CSS/TTF), path-only |
| `aiat-pmo-2026-05-14-170021-v3/test-results/**/trace.zip` | 1,828–6,232 B each | — | **NO** — binary zip, path-only |
| `aiat-pmo-2026-05-14-170021-v3/ax-snapshots/axe-*.json` | **0 B (absent)** | 0 tok | Would be YES if present (Check 2) |
| `aiat-pmo-2026-05-14-170021-v3/screenshots/*.png` | **0 (absent)** | 0 tok | Would be YES if present (Check 4) |
| `aiat-pmo-2026-05-14-165941-retry/console.log` | 17,279 B | ~4,320 tok | **YES** — Check 3 |
| `aiat-pmo-2026-05-14-165941-retry/results.json` | 27,154 B | ~6,789 tok | NO |
| `aiat-pmo-2026-05-14-165941-retry/ax-snapshots/axe-*.json` | **0 B (absent)** | 0 tok | Would be YES |
| `aiat-pmo-2026-05-14-165657/console.log` | 1,345 B | ~336 tok | YES |
| `aiat-pmo-2026-05-14-165657/ax-snapshots/axe-*.json` | **0 B (absent)** | 0 tok | Would be YES |

**Step 2 — Token estimation method.** No tokenizer is a repo dependency (`grep -i "tiktoken\|tokenizer\|gpt-token" package.json` → no match). Used **bytes / 4** — the standard conservative upper-bound heuristic for ASCII-heavy JSON/log text (cl100k_base tokens average ~4 bytes for English prose; JSON field names are shorter, so bytes/4 is an overestimate). Sufficient for an order-of-magnitude verdict.

**Step 3 — Local test trigger feasibility.** No fixture-emitting target exists in this repo: `playwright.config.*` → not found under project root; `.orchestrator/policy/test-profiles.json` shows `target: null` for both `web-gate` and `mac-gate` profiles; no `@axe-core/playwright` in project `devDependencies`. Triggering a `/test` run would not emit AX-snapshot YAML or axe JSON — the soft-skip path (`scripts/lib/playwright-driver/runner.mjs:184`) would fire exactly as it did in all three historical runs. **No fixture-rich local run was performed** — same outcome as all prior runs; no new artifacts generated. Not feasible without pointing at an external target that has the fixtures installed.

**Step 4 — Evaluator-facing token load per run (the decisive numbers):**

```
# Command run:
find .orchestrator/metrics/test-runs -type f -exec wc -c {} + | sort -rn | head -15

# Key output (bytes, truncated to relevant files):
86149  .../aiat-pmo-2026-05-14-170021-v3/results.json        ← NOT evaluator-facing
 7775  .../aiat-pmo-2026-05-14-170021-v3/console.log         ← evaluator-facing
27154  .../aiat-pmo-2026-05-14-165941-retry/results.json     ← NOT evaluator-facing
17279  .../aiat-pmo-2026-05-14-165941-retry/console.log      ← evaluator-facing
 1345  .../aiat-pmo-2026-05-14-165657/console.log            ← evaluator-facing

# Evaluator-facing totals (what ux-evaluator's Glob hits):
#   run aiat-pmo-2026-05-14-165657:       1,345 B  → ~336 tok
#   run aiat-pmo-2026-05-14-170021-v3:    7,775 B  → ~1,944 tok
#   run aiat-pmo-2026-05-14-165941-retry: 17,279 B → ~4,320 tok  ← heaviest
#
# ax-snapshots/ dirs: 0 found in all 3 runs
# screenshots/ dirs:  0 found in all 3 runs
```

**Confirmed vs claimed:**

| Metric | W2 finding (UNVERIFIED) | W3 measurement | Verdict |
|---|---|---|---|
| AX-tree YAML tokens | "50–200K tok" (`SKILL.md:108`) | 0 tok — artifact absent in all 3 runs | **Claim unverifiable at current scale** — not refuted, but also not confirmed; the condition (fixture-emitting target) has never been exercised locally |
| Heaviest evaluator-facing load (observed) | ≤4.3K tok (W2, same data) | **~4.3K tok** (17,279 B / 4) — confirmed | Pain **not real at current scale** |
| `results.json` (largest text artifact) | ≈21.5K tok | ≈21.5K tok (86,149 B / 4) | Confirmed — but provably NOT in evaluator's glob set |
| Binary report/trace bulk | 2.2 MB run-dir | Confirmed — path-only, never in context | Not a token concern |

**Verdict on #439's pain:** **not real at current scale.** The heaviest observed evaluator-facing load across all three production runs is `console.log` at ~4.3K tokens — approximately 1/12 of the claimed 50K-token lower bound, and 1/46 of the 200K upper bound. The theoretical 50–200K figure (`SKILL.md:108`) references AX-tree YAML that has never been emitted in any local run because no tested target has `page.accessibility.snapshot()` fixtures or `@axe-core/playwright` installed. The dominant text artifact (`results.json`, ~21.5K tok) is already outside the evaluator's glob set by architecture. The pain is a **conditional future risk** — real only when (a) a fixture-rich AX-emitting target is tested, and (b) that target's AX dump exceeds ~40K tokens. Neither condition has been met in this repo's history. The Preliminary Recommendation's "Skip (Stay)" verdict stands; the revisit trigger (`> 40K evaluator input tokens on a fixture-rich run`) remains the correct gate.

## Preliminary Recommendation

**Lean: SKIP (Stay) — with a documented, narrowly-scoped revisit trigger. W4 ADR (0004) finalizes.**

Rationale:
1. **The headline does not apply to us.** The 99% Playwright number is `ctx_execute_file`'s lossy 1–2-line-summary class. Two of our four rubric checks (axe-violations, console-errors) hard-require raw per-object/per-line bytes to preserve the fingerprint contract that `issue-reconcile.mjs` cross-run dedup depends on. Adopting the mode that produces the 99% figure would **degrade evaluation quality** — exactly the #439 disqualifier.
2. **The problem context-mode solves, we already solved differently.** Keeping heavy artifacts out of the *coordinator* context is done via the on-disk `${RUN_DIR}` handoff (`SKILL.md:151-160,332`). context-mode is not a drop-in: it requires rewriting `agents/ux-evaluator.md` from read-only-disk to `ctx_search`-driven retrieval, plus an MCP wiring seam that does not exist in our `.mcp.json`.
3. **Empirically, the pain is not yet demonstrated.** Across all three real runs, the evaluator-facing token load was console.log ≤ ~4.3K tokens; the theoretically-heavy AX/axe artifacts were absent. We would be paying integration + supply-chain (ELv2, 1-day-old releases, a documented recent silent-suppression regression) cost against an unverified problem.
4. **If a real pain emerges, build-own — narrowly — not adopt.** The only fidelity-safe slice is the lossless `ctx_index`/`ctx_search` pattern, and for our needs that reduces to one helper: a `summarizeAxeJson()` / chunked-axe-reader in `scripts/lib/test-runner/` that the ux-evaluator calls for axe JSON only, preserving `(ruleId, nodes[0].target)` verbatim. ~30–60 LOC, zero new dependency, no license question, full fingerprint fidelity. This is strictly preferable to importing an 11-tool MCP server for one summarization need.

**Alternatives considered (explicit, for the ADR's Decision section):**

- **Adopt context-mode as an MCP server (rejected, preliminary).** Requires (a) adding the 11-tool MCP server to our config; (b) rewriting `agents/ux-evaluator.md` to call `ctx_search`/`ctx_execute_file` instead of Read/Grep — a non-trivial change to a fingerprint-critical agent; (c) accepting an ELv2 source-available license review; (d) tracking a weekly-churning upstream (v1.0.140 is 1 day old, with a documented v1.0.137–139 regression). The fidelity-safe mode (`ctx_index`+`ctx_search`) only delivers 50–93%, and the 99% mode is the lossy class our fingerprint contract forbids. Cost ≫ demonstrated benefit.
- **Build-own thin wrapper at `scripts/lib/test-runner/` (deferred, conditional).** A ~30–60 LOC `chunked-axe-reader.mjs` / `summarizeConsoleErrors.mjs` that the ux-evaluator calls for the two raw-required checks, preserving `(ruleId, nodes[0].target)` and per-error `locator` verbatim. Zero new dependency, no license question, full fingerprint fidelity, scoped exactly to our rubric. **This is the right shape *if* W3 demonstrates the pain** — strictly preferable to importing an 11-tool MCP for one summarization need.
- **Skip / Stay (preliminary pick).** Keep the on-disk `${RUN_DIR}` handoff. Document in ADR-0004 why the headline does not transfer. Zero cost, no regression surface.

**Revisit trigger (for the ADR):** adopt-or-build only after a W3 measurement shows the ux-evaluator agent's *actual* input token count exceeds a meaningful threshold (proposal: > 40K input tokens) on a fixture-rich `/test` run with AX-snapshot + axe-core fixtures present. Absent that evidence, Stay and document why — consistent with `docs/adr/0001-context-vs-orchestration.md` (external context-reduction claims are an input signal, not a reflexive substrate swap). The cross-connection to note in the ADR: #439 and #438/#437 share the theme that an external primitive's headline metric must be re-derived against *our* architecture before adoption — here the re-derivation collapses 99% to "compresses a file we already keep out of context."

---

Verification:
- `wc -l docs/research/2026-05-19-context-mode-evaluation.md` → 120 (≥120 ✓)
- `grep -c '^## ' docs/research/2026-05-19-context-mode-evaluation.md` → 7 (=7 ✓)

STATUS: done — 120 lines, 12 sources, preliminary: skip
