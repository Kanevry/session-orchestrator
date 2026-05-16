# 2026-05-16 Research — Clawpatch & Anthropic Prompt-Cache Pre-Warming

> **Session:** `main-2026-05-16-feature-1` (feature, coord-direct, 1 wave).
> **Branch:** `main` @ `24aaed0` (post-pull from origin).
> **Scope:** Survey two external patterns and produce concrete adoption proposals for (a) our wave system + subagent orchestration and (b) AI-touching repos under `/Users/bernhardg./Projects/`.
> **Deliverable:** This document + 11 follow-up issues filed in `infrastructure/session-orchestrator`.

## TL;DR

Two independent research streams, run in parallel.

1. **Clawpatch** (`openclaw/clawpatch`, MIT, 1-day-old, 223⭐) — single-coordinator TypeScript code-review CLI, Codex-only provider, no parallel waves. **6 borrowable mechanics**, top two are net-new for us: per-agent **output-schema contracts** (Zod-validated, exit-code-fail on mismatch) and a **worker-pool cursor** (pull-model agent dispatch). The other four are speculative.

2. **Anthropic prompt-cache pre-warming** — `max_tokens: 0` requests fill the cache at every `cache_control` breakpoint, so the first real user turn pays a cache-read (0.1×) instead of a cache-write (1.25× / 2×). Surveyed 22 repos under `/Users/bernhardg./Projects/`; **4 qualify** for adoption (2 STRONG, 2 MEDIUM). Recommendation: ship a `.claude/rules/prompt-caching.md` rule doc in `session-orchestrator` documenting the placeholder-trap; each consumer repo adopts independently in <30 LOC. No shared package warranted.

3. **Cross-reference:** the recent `f617d20` "anthropic-adoption cluster" (#409 #410 #411 #412 #414) on origin/main already shipped 6 Anthropic-ecosystem patterns (operator-steer hook, mcp-builder tool-hosting, `gen_ai.*` OTel aliases, security-reviewer hard-exclusions, marketplace submission docs, spawn-AbortSignal refactor). **Prompt-caching pre-warming is NOT in that cluster — net new.**

---

## Part 1 — Clawpatch (openclaw/clawpatch)

### Snapshot

One-day-old (created 2026-05-15), TypeScript CLI by OpenClaw. Purpose per `README.md`: *"maps a repo into semantic feature slices, reviews each slice with a provider, persists findings, and can run an explicit fix loop."* Single coordinator, single provider (Codex CLI), no multi-agent waves. Workflow: `init → map → review → fix → revalidate`. v0.1.0.

### Where it overlaps us (non-actionable)

| Mechanism | Clawpatch | Ours |
|---|---|---|
| Resumable JSON state | `.clawpatch/` | `.orchestrator/` + `<state-dir>/STATE.md` |
| Workspace locks | `paths.locks` | `wave-scope.json` + coordinator snapshots |
| Schema-validated provider IO | Zod on every verb | JSONL telemetry contracts |
| Loud fail on malformed output | Exit code 8 | Wave-executor schema checks (partial coverage) |
| Destructive ops gated | `fix` opt-in | Destructive-command guard + PSA-003 |
| CLI exit-code contract | Pinned | Pinned (per `cli-design.md`) |

### Borrowable patterns

#### Borrow 1 (⭐ TOP) — Strict per-call JSON-schema contracts on agent output

**Source:** `src/provider.ts` (Clawpatch). Snippet (paraphrased): every provider verb (`review`, `fix`, `revalidate`) is invoked with `--output-schema <path>` passed to `codex exec`, and the raw response is parsed through `reviewOutputSchema.parse(output)` (Zod). Schema-mismatch yields exit code 8 ("malformed provider output").

**Gap it fills for us:** Our agents return prose-with-JSON-blocks. When the JSON shape drifts (e.g., the `html,json` reporter-syntax bug on 2026-05-14 deep-3), we only catch it because a downstream consumer fails loudly. Most agent outputs degrade quietly — the wave appears to succeed even when the agent's structured payload is malformed.

**Adoption shape:**
- Add an optional `outputSchema:` field to agent frontmatter (pointing to a `.zod.mjs` / `.json` schema in `agents/schemas/`).
- `scripts/lib/wave-executor.mjs` parses the agent's final structured message through the schema after dispatch returns.
- Schema-mismatch → fail the wave with a dedicated exit code, log to `subagents.jsonl` with `schema_violation: true`.
- Overlap with **#403 `RUBRIC_GLASS_V2` profile-config flag** — both touch agent-output validation; resolve relationship before implementing.

**Filed as:** [research/clawpatch] borrow-1 — `priority:medium`, `area:agents`, `type:feature`.

#### Borrow 2 (⭐ Net-new) — Worker-pool cursor for wave-executor dispatch

**Source:** `src/app.ts:160-175` (Clawpatch). Snippet:
```ts
const jobs = Math.min(reviewJobs(flags), Math.max(features.length, 1));
let cursor = 0;
await Promise.all(Array.from({length: jobs}, async () => {
  while (true) {
    const index = cursor; cursor += 1;
    if (index >= features.length) break;
    await reviewOne(features[index]);
  }
}));
```

**Gap it fills for us:** Our `agents-per-wave: 6` (default) / `18` (deep override) pre-commits to fan-out at wave-plan time. When some wave-plan items are tiny (1-file scope) and others are huge (8-file scope), we underutilize — the small-task agents finish in seconds while we wait on the big ones. A pull-model worker pool keeps N workers hot until the task queue drains.

**Adoption shape:**
- Replace fixed pre-allocation in `scripts/lib/wave-executor.mjs`'s dispatch step with a shared cursor over the wave's task queue.
- `jobs = min(agents-per-wave, remainingTasks)`.
- Each worker pulls the next task; finishes; pulls the next until queue empty.
- Wave completes when all workers drain (or one fails per existing kill-switch logic).
- Preserves `Promise.all()` semantics — total wall-time stays ≤ max(individual task time × ceil(tasks/workers)).

**Filed as:** [research/clawpatch] borrow-2 — `priority:medium`, `area:wave-executor`, `type:feature`.

#### Borrow 3 — Semantic feature slices

**Source:** `src/types.ts` (`FeatureRecord`) + `src/mapper.ts` (Clawpatch). Language-aware mappers project repos into `FeatureRecord[]` with `ownedFiles[]` and `contextFiles[]`. Mappers exist for npm bin entries, Next.js routes, Go packages, Rust crates, Flask/FastAPI routes, SwiftPM targets.

**Gap it fills for us:** Our `wave-scope.json` is path-based (`allowedPaths[]`). For multi-language repos (test-runner, feedfoundry, mail-assistant) the implicit owner is *"the Flask route that imports this file"* — we currently bolt that into prompt narrative ad-hoc, not into structured scope.

**Adoption shape:**
- New skill `feature-mapper` emitting `.orchestrator/features/<id>.json` during session-start Phase 2.7 (next free slot after Phase 2.6 steering).
- Wave-executor intersects `allowedPaths` with feature ownership rather than raw globs.
- Speculative — many of our target repos are monorepos already covered by tools like `nx` / `turborepo` / `pnpm` workspaces. Re-implementing language-aware ownership is non-trivial.

**Filed as:** [research/clawpatch] borrow-3 — `priority:low`, `area:skills`, `type:discovery`.

#### Borrow 4 — Triage state on discovery findings

**Source:** `README.md` + `docs/spec.md` (Clawpatch). Example: `clawpatch triage --finding <id> --status false-positive --note "covered by tests"`. Findings carry a `triage: [{status, note, ts}]` history.

**Gap it fills for us:** Our `/discovery` produces issues but has no lightweight "false-positive, don't re-surface" state. Recurring count-drift patterns (S55 → S68 → S73 in `test-quality.md`) suggest the cost is real even within our own evolution.

**Adoption shape:**
- Extend `.orchestrator/discovery/findings/<id>.json` with `triage: [{status, note, ts}]` array.
- `discovery --triage <id> --status [false-positive|wont-fix|deferred] --note "<reason>"` subcommand.
- Session-start filters out re-surfacing items marked `false-positive` or `wont-fix` from the discovery-banner.
- `false-positive` is permanent; `deferred` reactivates after a configurable cooldown (default 30 days).

**Filed as:** [research/clawpatch] borrow-4 — `priority:low`, `area:discovery`, `type:feature`.

#### Borrow 5 — Sandbox-tier capability gating

**Source:** `src/provider.ts:143` (Clawpatch). `runCodexJson(..., sandbox = "read-only")` for review/revalidate verbs; `runCodexJson(..., "workspace-write")` only for fix.

**Gap it fills for us:** Our read-only reviewer agents have the right *tools* declared (`Read, Grep, Glob, Bash`), but no enforcement that a write-capable agent isn't dispatched during Discovery or Quality waves by mistake. We're rule-based via frontmatter convention, not capability-gated.

**Adoption shape:**
- Extend `agents/*.md` frontmatter validator (`scripts/lib/validate/check-agents.mjs`) to require a new `sandbox: read-only | workspace-write` field.
- Wave-executor refuses to dispatch a `workspace-write` agent during Discovery/Quality waves; refuses to dispatch a `read-only` agent during Impl-Core/Impl-Polish.
- Plugin-distribution backward-compat: missing field defaults to `workspace-write` for now; flip default after one minor release with deprecation warning.

**Filed as:** [research/clawpatch] borrow-5 — `priority:low`, `area:agents`, `type:feature`.

#### Borrow 6 — `--since <git-ref>` to scope runs to changed surface

**Source:** Clawpatch `CHANGELOG.md` — *"Added `--since <ref>` on `clawpatch review` and `clawpatch revalidate` to restrict runs to features whose owned or context files changed since the given git ref."*

**Gap it fills for us:** Our `/discovery` and `/test` re-scan whole-repo on every invocation. For Wave 4 (Quality) on a deep session that touched 8 files out of 5000, this is overkill — most of the discovery probe time is wasted.

**Adoption shape:**
- `--since <git-ref>` flag on `/discovery`, `/test`, and inter-wave reviewer dispatch.
- Default in inter-wave context: `--since HEAD~<wave-count>` (only the files this session touched).
- Passes through to a `changedFilesSince()` helper (similar to Clawpatch's `src/git.ts`).
- Composable with existing `discovery-exclude-paths` config.

**Filed as:** [research/clawpatch] borrow-6 — `priority:low`, `area:cli`, `type:feature`.

### Pass on (do NOT adopt)

- **Linear `init → map → review → fix → revalidate` shape.** Already subsumed by `/session → /go → /close`. Adopting their command shape would regress us.
- **Codex-CLI-only provider abstraction.** We are Anthropic-first; their provider layer is shaped around `codex exec`. Not transferable.
- **Single-coordinator design.** Clawpatch has no parallel waves; their "worker pool" runs within a single coordinator and reviews features sequentially per worker. We already have richer multi-wave parallelism.

---

## Part 2 — Anthropic Prompt-Cache Pre-Warming

> **Source:** https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pre-warming-the-cache

### Mechanism (one paragraph)

Pre-warming is a `max_tokens: 0` request that runs the **full prefill phase** and writes the cache at every `cache_control` breakpoint, then returns immediately with `content: []` and `stop_reason: "max_tokens"`. Quote: *"The API runs the full prefill phase (reading your prompt into the model and writing the cache at any `cache_control` breakpoint), then returns immediately without generating any output."* Use it at app boot or on a schedule (every ≤5 min for default TTL) so the first real user turn pays a cache-read, not a cache-write, on TTFT. The documented trap: *"Place the `cache_control` breakpoint on the last block that is shared with the follow-up request… not on the placeholder user message."* Pre-warming is rejected with `stream: true`, extended thinking, structured outputs, `tool_choice: tool|any`, and Message Batches.

### Cost / TTL summary

| Item | Detail |
|---|---|
| Cache write (5-min ephemeral) | **1.25×** base input |
| Cache write (1-hour extended, `ttl: "1h"`) | **2.0×** base input |
| Cache read (both TTLs) | **0.1×** base input |
| Breakpoint count | Max **4** per request |
| Breakpoint order | `tools → system → messages` |
| Lookback window | **20 blocks** |
| Concurrency | *"Cache entry only becomes available after the first response begins. For parallel cache hits, wait for the first response before sending subsequent requests."* |
| Pitfall | Placing the breakpoint on per-request content (timestamps, user message) — hash differs every request, never hits. |

### Adoption candidates across `/Users/bernhardg./Projects/`

Surveyed 22 repos under `/Users/bernhardg./Projects/{Bernhard,intern,extern,playground,ai-factory-n8n}`. Four qualify; the rest have no direct AI surface or are already covered.

#### Candidate A (STRONG) — `extern/AngebotsChecker`

- **AI surface:** `POST /api/compare` runs a bounded tool-use loop (`MAX_TOOL_TURNS`) against `claude-opus-4-7` with `HH_SYSTEM_PROMPT` (86 LOC) + `KV_SYSTEM_PROMPT` + tool defs + per-session document blocks. Multi-turn. **Zero `cache_control` today** (grepped).
- **Why STRONG:** opus-4-7 is the most expensive model in the fleet; system prompt + tool list are stable across turns; the tool-loop guarantees 2–N turns per request with the same prefix. Every tool turn after turn 1 should be a cache-read.
- **Concrete change:** at `src/app/api/compare/_lib/handle-compare.ts:78-94` where `streamTurnToClient({ baseSystemPrompt, ... })` is called, switch `system` from a string to a block array with `cache_control: { type: "ephemeral" }` on the last system block; mirror in `stream-pass.ts`.
- **Breakpoint prefix:** system prompt (one breakpoint).
- **TTL:** 5min (interactive chat).
- **Pre-warm:** add a `register()` hook in Next.js `instrumentation.ts` calling `messages.create({ max_tokens: 0, system: [...with cache_control], messages: [{role:"user", content:"warmup"}] })`.

**Filed as:** [research/anthropic-cache] PoC AngebotsChecker — `priority:high`, `area:cross-repo`, `type:feature`.

#### Candidate B (STRONG) — `Bernhard/buchhaltgenie`

- **AI surface:** Sophie chat (`src/app/api/chat-v2/route.ts`) + agentic loop (`src/lib/ai/agentic-loop.ts`) + 5 named agents. The Sophie system prompts file is **668 LOC** (`src/lib/ai/sophie-system-prompts-v2.ts`). Hot endpoint per BG conventions. No `cache_control` usage found.
- **Why STRONG:** a 668-line system prompt is the textbook case for caching; even Haiku-4.5 traffic benefits because cache-read at 0.1× pays back after ~3 requests in a 5-min window.
- **Concrete change:** `src/lib/ai/sophie-system-prompts-v2.ts buildAdvancedSophieSystemPrompt()` already returns a string. Wrap the caller in `src/app/api/chat-v2/route.ts:42-44` to pass `system: [{ type: "text", text: prompt, cache_control: { type: "ephemeral" }}]`. If using Vercel AI SDK, set via `providerOptions.anthropic.cacheControl`.
- **TTL:** 5min for chat, **1h** for the RAG-enhanced variant if RAG injects per-session content (then breakpoint must sit BEFORE the RAG block).
- **Pre-warm:** cron / scheduled function every 4 min during business hours (~8h × 12 = 96 pre-warm calls/day ≈ trivially cheap).

**Filed as:** [research/anthropic-cache] PoC buchhaltgenie — `priority:high`, `area:cross-repo`, `type:feature`.

#### Candidate C (MEDIUM) — `extern/wien-forschungsfragen-klima`

- **AI surface:** batch re-rank + translate scripts. `scripts/lib/llm-rerank.ts:277` and `scripts/lib/llm-translate.ts:205` call `anthropic.messages.create` with versioned prompt files in `prompts/*.v1.md` (8 prompt families). Batch, not interactive.
- **Why MEDIUM:** prompt prefixes are large and reused across all candidates in a batch run, but pre-warming only helps if processing ≥2 items per 5-min window. Cache-write at 1.25× is the right tool here **even without** pre-warming.
- **Concrete change:** add `cache_control` to the system block in both `scripts/lib/llm-rerank.ts:277` and `scripts/lib/llm-translate.ts:205`. **Skip the `max_tokens:0` hop entirely** — let the first real call write the cache; subsequent items in the same batch read it.
- **TTL:** 5min default; switch to **1h** if a single batch run takes >5 min (instrument first).

**Filed as:** [research/anthropic-cache] PoC wien-forschungsfragen-klima — `priority:medium`, `area:cross-repo`, `type:feature`.

#### Candidate D (MEDIUM) — `intern/launchpad-ai-factory`

- **AI surface:** thin Vercel AI SDK adapter (`src/lib/llm/adapter.ts`) used by tagging + hypothesis-synth (`src/lib/hypothesis/synth.ts`, `src/lib/tagging/prompts/enrich.ts`). Volume: nightly enrichment jobs over HN items.
- **Why MEDIUM:** adapter is the right insertion point, but the call pattern is bulk-batch, not interactive. Same logic as C: cache, don't pre-warm.
- **Concrete change:** in `src/lib/llm/adapter.ts` add an optional `cacheableSystem?: string` parameter. When present, emit `providerOptions: { anthropic: { cacheControl: { type: "ephemeral" }}}` on the system message. Tagging/enrichment call-sites flip it on.
- **TTL:** 5min is fine; verify the nightly batch cadence keeps it warm.

**Filed as:** [research/anthropic-cache] PoC launchpad-ai-factory — `priority:medium`, `area:cross-repo`, `type:feature`.

### Skip (no fit)

`bg-pdf-service`, `Macchiato`, `onenote`, `scrapling-service`, `claude-usage-tracker`, `aiat-pmo`, `aiat-pmo-module`, `aiat-poc-infra`, `aiat-service-ops`, `kalender-sync`, `mail-assistant`, `ai-factory-n8n` (top-level + intern), `playground/*`, `sven` (only `@anthropic-ai/sdk` in vendored third-party code), `projects-baseline`, `vault`. No direct `@anthropic-ai/sdk` or `ai`-SDK usage in source.

**`session-orchestrator` itself:** no fit. Rule `backend.md:290` forbids `@anthropic-ai/sdk` in plugin code. Orchestrator dispatches via Claude Code's harness, which already manages caching at the platform layer.

### Cluster recommendation

Three Anthropic-touching repos (AngebotsChecker, buchhaltgenie, wien-forschungsfragen-klima) plus a fourth via AI-SDK (launchpad) share the **same insertion shape**: wrap an existing string system prompt as `[{type:"text", text, cache_control:{type:"ephemeral"}}]` and optionally call once with `max_tokens:0` at boot.

This does **not** warrant a shared `@goetzendorfer/cache-aware-anthropic` package — the surface is too thin (5 lines per call-site) and the SDKs differ (raw Anthropic SDK vs `@ai-sdk/anthropic` `providerOptions.anthropic.cacheControl`).

**Better path:** ship a `.claude/rules/prompt-caching.md` rule in `session-orchestrator` documenting:

- The `cache_control` block-array pattern (system-prompt-as-array, not string).
- The placeholder-message trap (breakpoint must sit on the LAST shared block, not on a per-request user-message placeholder).
- The `max_tokens: 0` pre-warm pattern + when it pays off.
- TTL selection: 5min for interactive, 1h for batch with gaps.
- Reference from `backend.md` § "AI Observability" so existing AI-touching consumers discover it naturally.

Each consumer repo then adopts independently in <30 LOC. The rule prevents the documented pitfall once instead of in N repos.

**Filed as:** [research/anthropic-cache] rule doc — `priority:medium`, `area:rules`, `type:feature`.

---

## Cross-reference: what we already shipped on origin/main

The most recent Anthropic-adoption push landed in `f617d20` (2026-05-16 deep-3, "anthropic-adoption cluster"). It covered **6 patterns from Anthropic-published reference repos**:

| Issue | Pattern | Source repo | Status |
|---|---|---|---|
| #409 | `hooks/operator-steer.mjs` — mid-wave operator steering via `STEER.md` handshake | `anthropics/cwc-long-running-agents` | shipped |
| #410 | `skills/mcp-builder/SKILL.md` "Tool-Hosting Pattern" — `@tool` decorator (Python) + `registerTool` (TS) + `readOnlyHint`/`destructiveHint` annotations | `anthropics/claude-agent-sdk-python` | shipped |
| #411 | `gen_ai.*` OTel aliases on `subagents.jsonl` — input_tokens, output_tokens, system=anthropic | OTel GenAI semconv | shipped |
| #412 | `agents/security-reviewer.md` Hard-Exclusions section — 5 FP sub-classes | `anthropics/claude-code-security-review` | shipped |
| #414 | `docs/marketplace/` + `docs/submissions/` — knowledge-work-plugins submission | claude-code marketplace conventions | shipped |
| GH#45 | `aggregator.mjs execWithTimeout` — `promisify(execFile)` → `spawn() + AbortSignal` | mirrors `playwright-driver/runner.mjs:232-245` | shipped |

**Prompt-caching pre-warming is genuinely net-new ground** — not in that cluster. **Clawpatch is also net-new** — predates Anthropic's published-ecosystem set.

---

## Issue map (filed in this session)

| Issue | Topic | Priority | Area | Type |
|---|---|---|---|---|
| [#417](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/work_items/417) | Clawpatch borrow-1 — JSON-schema-per-agent-output contract | medium | agents | feature |
| [#415](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/work_items/415) | Clawpatch borrow-2 — worker-pool cursor for wave-executor | medium | wave-executor | feature |
| [#416](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/work_items/416) | Clawpatch borrow-3 — semantic-feature-slices | low | skills | discovery |
| [#419](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/work_items/419) | Clawpatch borrow-4 — triage state on discovery findings | low | discovery | feature |
| [#418](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/work_items/418) | Clawpatch borrow-5 — sandbox-tier capability gating | low | agents | feature |
| [#420](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/work_items/420) | Clawpatch borrow-6 — `--since <git-ref>` for `/discovery` + `/test` | low | scripts | feature |
| [#421](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/work_items/421) | Prompt-caching rule doc — `.claude/rules/prompt-caching.md` | medium | rules | feature |
| [#422](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/work_items/422) | PoC cross-repo — AngebotsChecker `/api/compare` `cache_control` + pre-warm | high | cross-repo | feature |
| [#423](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/work_items/423) | PoC cross-repo — buchhaltgenie Sophie `cache_control` | high | cross-repo | feature |
| [#425](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/work_items/425) | PoC cross-repo — wien-forschungsfragen-klima batch `cache_control` | medium | cross-repo | feature |
| [#424](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/work_items/424) | PoC cross-repo — launchpad-ai-factory AI-SDK adapter `cache_control` | medium | cross-repo | feature |

## Open questions / decisions

1. **Borrow-1 vs #403 RUBRIC_GLASS_V2:** both touch agent-output schema validation. Resolve scope-overlap before implementing borrow-1 — they may merge into one v3.7 thin slice.
2. **Cross-repo issue ownership:** the 4 PoC issues live in `infrastructure/session-orchestrator` under `area:cross-repo`. Acceptable for now (single source-of-truth for research follow-ups). Move to target repos when the consumer team picks them up.
3. **Pre-warm cron cadence (AngebotsChecker, buchhaltgenie):** TTL is 5min; cron every 4min has a safety margin but burns ~360 calls/day. Acceptable cost on opus-4-7? Measure cache-write cost vs cache-read savings on real traffic before committing to a cadence.

## Method note

Two research subagents were dispatched in parallel from this coordinator session:
- **Agent A** (Clawpatch): WebFetch + `gh api` against `openclaw/clawpatch`. Read `README.md`, `src/{provider,app,prompt,state,types,mapper,git}.ts`, `docs/spec.md`, `CHANGELOG.md`. Returned 6 borrow candidates with file-path-cited 2-line quotes.
- **Agent B** (Prompt-cache): WebFetch against `platform.claude.com/docs/en/build-with-claude/prompt-caching`. Then surveyed 22 repos under `/Users/bernhardg./Projects/` via `grep -l '@anthropic-ai\|"ai":'` style filters, opening 3-4 source files per qualifying repo. Returned 4 adoption candidates with file:line insertion points.

Both agents capped at 700 words; total research time: parallel ~2.5 min wall-clock.
