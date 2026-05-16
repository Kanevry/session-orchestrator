# Prompt Caching Rules (Path-scoped — repos using `@anthropic-ai/sdk` or `@ai-sdk/anthropic`)

> Path-scoped — applies anywhere a project imports `@anthropic-ai/sdk` or uses the `@ai-sdk/anthropic` provider. Out of scope: `session-orchestrator` itself (no SDK use; `backend.md` § "AI Provider Abstraction" already forbids direct SDK imports in business logic, and the orchestrator runs inside Claude Code's harness which manages caching at the platform layer).

## Why

Anthropic prompt caching pays back fast: cache **writes** cost 1.25× base input (5-min ephemeral) or 2.0× base input (1-hour extended), and cache **reads** cost 0.1× base input. A system prompt of ~600 tokens amortises the write penalty after **three** identical calls inside a 5-minute window. The most common adoption failure is silent: the breakpoint is placed on a per-request placeholder (user message, timestamp, request ID), the prefix hash differs every call, and the cache is never hit. This rule encodes the placement discipline and the pre-warming pattern once so consumer repos adopt in <30 LOC.

The four PoC targets (PC-001..PC-007 are validated against these) are documented at the bottom under "Adoption candidates".

## PC-001: System prompt as block array, not string

The fundamental shape. The `system` field accepts a string OR an array of content blocks. Caching requires the array form because `cache_control` is a per-block marker.

```typescript
// BAD — string system prompt cannot be cached
const response = await anthropic.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 1024,
  system: longSystemPromptString, // 600+ tokens, paid in full on every call
  messages: [{ role: 'user', content: userInput }],
});

// GOOD — block array with cache_control on the last shared block
const response = await anthropic.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 1024,
  system: [
    {
      type: 'text',
      text: longSystemPromptString,
      cache_control: { type: 'ephemeral' },
    },
  ],
  messages: [{ role: 'user', content: userInput }],
});
```

The block array form is mandatory for caching. There is no string-form opt-in.

## PC-002: Breakpoint placement — last shared block, never on per-request placeholder

The trap. Anthropic's docs are explicit: *"Place the `cache_control` breakpoint on the last block that is shared with the follow-up request… not on the placeholder user message."* A breakpoint on per-request content (the user's question, a timestamp, a request ID) hashes differently every call and never produces a cache hit.

```typescript
// BAD — breakpoint on the per-request user message
await anthropic.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 1024,
  system: [{ type: 'text', text: systemPrompt }],
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: userQuestion, cache_control: { type: 'ephemeral' } }, // hashes differently every call
      ],
    },
  ],
});

// BAD — system prompt includes a per-request timestamp before the breakpoint
const systemWithTimestamp = `${systemPrompt}\n\nCurrent time: ${new Date().toISOString()}`;
await anthropic.messages.create({
  system: [{ type: 'text', text: systemWithTimestamp, cache_control: { type: 'ephemeral' } }],
  // ...
});

// GOOD — breakpoint on the last STABLE block (system prompt), per-request content lives downstream
await anthropic.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 1024,
  system: [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }, // stable across requests
  ],
  messages: [
    { role: 'user', content: userQuestion }, // varies — must be AFTER the breakpoint
  ],
});

// GOOD — multi-block: tool list cached, system prompt cached, per-session RAG context UNCACHED
await anthropic.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 1024,
  system: [
    { type: 'text', text: toolListDescription, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: baseSystemPrompt, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: perSessionRagContext }, // NO cache_control — varies per session
  ],
  messages: [{ role: 'user', content: userQuestion }],
});
```

Rule: a `cache_control` breakpoint must sit on the LAST block of a contiguous stable prefix. Everything before it (and including it) is cached. Everything after varies freely.

## PC-003: TTL selection — 5min interactive, 1h batch with gaps

Two TTLs are available, with different write-cost trade-offs.

| Use case | TTL | Write cost | When |
|---|---|---|---|
| Interactive chat, tool-loop, sequential API calls | `{ type: "ephemeral" }` (default 5 min) | 1.25× base input | 95th-percentile inter-call gap ≤ 5 min |
| Batch jobs spanning >5 min, scheduled enrichment | `{ type: "ephemeral", ttl: "1h" }` | 2.0× base input | 95th-percentile inter-call gap > 5 min, or single batch run >5 min wall-clock |

Decision rule: **if the 95th-percentile gap between calls that share the prefix exceeds 5 minutes, choose 1h.** Otherwise the default 5-min TTL pays back faster (1.25× vs 2.0×).

```typescript
// 5-min — interactive chat (Sophie, AngebotsChecker tool-loop)
{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }

// 1h — batch re-rank that processes 100 items over 8 min
{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }
```

Instrument before flipping to 1h: log the time delta between successive cache-hitting calls and confirm a meaningful tail beyond 5 min. The 2.0× write cost only amortises if you actually use the longer window.

## PC-004: Pre-warming with `max_tokens: 0`

The mechanism. A `max_tokens: 0` request runs the **full prefill phase** and writes the cache at every `cache_control` breakpoint, then returns immediately with `content: []` and `stop_reason: "max_tokens"`. The first real user turn then pays a cache-read (0.1×) on TTFT instead of a cache-write (1.25×).

```typescript
// src/instrumentation.ts — Next.js boot hook
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from '@/lib/ai/prompts';

export async function register() {
  const anthropic = new Anthropic();
  await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 0, // returns immediately after prefill; cache is written
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: 'warmup' }],
  });
}
```

**When to pre-warm:**
- **Boot-once** (short-lived edge runtimes, serverless cold starts): one `register()` call covers the runtime's window.
- **Scheduled** (long-lived servers, persistent processes): cron at `TTL × 0.8` — every 4 minutes for the 5-min TTL, every 48 minutes for the 1h TTL. Skip pre-warming if traffic already keeps the cache warm (≥1 real call per `TTL × 0.8`).
- **Skip entirely** for batch jobs where the first real call IS the cache write and subsequent items in the same batch read it (PC-003 batch row). The `max_tokens: 0` hop adds no value when the batch's own cadence keeps the cache warm.

**Hard rejections** — Anthropic rejects `max_tokens: 0` combined with any of these. Use a regular `max_tokens: 1` call (and discard the single token) if you need any of:

- `stream: true`
- Extended thinking (`thinking: { type: 'enabled' }`)
- Structured outputs (`response_format`)
- `tool_choice: 'tool'` or `tool_choice: 'any'`
- Message Batches API

For the AI-SDK equivalent, see PC-006.

## PC-005: Breakpoint budget + order

| Limit | Value |
|---|---|
| Max breakpoints per request | **4** |
| Breakpoint order (server processes in this order) | `tools → system → messages` |
| Lookback window | **20 blocks** |
| Concurrency | First request must complete before parallel requests can hit the same cache entry |

With 4 breakpoints you typically allocate: 1 on `tools`, 1 on `system`, up to 2 on `messages` (e.g., long document blocks or RAG context that is stable across a multi-turn session). Spending all 4 on `system` blocks is rarely worthwhile — adjacent text blocks share the same prefix anyway; one breakpoint at the end of the system array caches the lot.

**Verification signals in the response payload:**

```typescript
const response = await anthropic.messages.create({ /* ... */ });
console.log(response.usage);
// {
//   input_tokens: 12,                  // tokens NOT served from cache
//   cache_creation_input_tokens: 670,  // tokens written to cache (first call)
//   cache_read_input_tokens: 0,        // tokens served from cache (subsequent calls)
//   output_tokens: 248,
// }
```

`cache_creation_input_tokens > 0` on the first call confirms a cache write happened. `cache_read_input_tokens > 0` on subsequent calls confirms the cache is being read at 0.1×. If both stay 0 across calls, the breakpoint is on a non-stable block — see PC-002.

## PC-006: Vercel AI SDK adapter shape (`@ai-sdk/anthropic`)

The AI-SDK exposes the same mechanism via `providerOptions`. The shape differs from the raw SDK but the placement discipline (PC-002) is identical.

```typescript
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const result = await generateText({
  model: anthropic('claude-opus-4-7'),
  system: SYSTEM_PROMPT, // string is fine here; cache_control is set via providerOptions
  messages: [{ role: 'user', content: userQuestion }],
  providerOptions: {
    anthropic: {
      cacheControl: { type: 'ephemeral' }, // applied to the system message
    },
  },
});
```

For multi-block control (e.g., caching tools + system separately), pass `system` as a structured message and set `providerOptions.anthropic.cacheControl` on each cacheable message via the `experimental_providerMetadata` field on each message. See the `@ai-sdk/anthropic` README for the current message-level shape.

The canonical AI-SDK adoption point is **Candidate D (`intern/launchpad-ai-factory`)** at `src/lib/llm/adapter.ts`: add an optional `cacheableSystem?: string` parameter; when present, emit the `providerOptions` block above on the system message. Tagging and enrichment call-sites flip it on.

**Pre-warming via AI-SDK:** `max_tokens: 0` is not natively exposed by `generateText`. Use `maxTokens: 1` and discard the single-token output, or drop down to the raw SDK for the pre-warm call only.

## PC-007: Verification — what to grep for

After deployment, the cache must be observed working. Three signals, in order of authority.

1. **Response payload** — log `response.usage.cache_creation_input_tokens` and `response.usage.cache_read_input_tokens` on every cached call. Surface both in your AI-observability pipeline (see `backend.md` § "AI Observability" for the `ai_usage_log` schema — extend it with two columns for these).

2. **Smoke test** — three identical calls in <5 min against the deployed endpoint:

```typescript
// scripts/smoke-test-cache.ts
const results = [];
for (let i = 0; i < 3; i++) {
  const r = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 16,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'ping' }],
  });
  results.push({
    call: i + 1,
    cache_creation: r.usage.cache_creation_input_tokens ?? 0,
    cache_read: r.usage.cache_read_input_tokens ?? 0,
  });
}
console.table(results);
// Expected:
// call 1: cache_creation > 0, cache_read = 0   (write)
// call 2: cache_creation = 0, cache_read > 0   (read)
// call 3: cache_creation = 0, cache_read > 0   (read)
```

3. **Failure mode** — if both columns stay 0 across all three calls, the breakpoint is on a non-stable block. Most common causes: timestamp interpolated into the system prompt, user message marked with `cache_control`, request ID concatenated into a system block. Re-read PC-002 and grep the call-site for per-request data inside the cached prefix.

For Vercel AI SDK consumers, the `cache_creation_input_tokens` / `cache_read_input_tokens` fields surface on `result.providerMetadata?.anthropic?.usage`. Same smoke-test pattern, different access path.

## Adoption candidates (cross-reference)

The four PoCs filed against this rule. Each adopts in <30 LOC and is independently verifiable via PC-007.

- **`extern/AngebotsChecker`** (STRONG, Issue #422) — `src/app/api/compare/_lib/handle-compare.ts:78-94` + `src/app/api/compare/_lib/stream-pass.ts`. opus-4-7 tool-loop. System prompt + tool-list = stable prefix across 2..N tool turns per request. Switch `streamTurnToClient({ baseSystemPrompt, ... })` from string to block array with `cache_control` on the last system block. TTL: 5min. Pre-warm: `register()` hook in Next.js `instrumentation.ts`.
- **`Bernhard/buchhaltgenie`** (STRONG, Issue #423) — `src/lib/ai/sophie-system-prompts-v2.ts` (`buildAdvancedSophieSystemPrompt()`, 668 LOC) + `src/app/api/chat-v2/route.ts:42-44`. The 668-line system prompt is the textbook caching case; cache-read at 0.1× pays back after ~3 requests in a 5-min window even for Haiku-4.5 traffic. TTL: 5min for chat, 1h for the RAG-enhanced variant (breakpoint BEFORE the RAG block). Pre-warm: cron every 4 min during business hours.
- **`intern/launchpad-ai-factory`** (MED, Issue #424) — `src/lib/llm/adapter.ts`. AI-SDK adapter — add optional `cacheableSystem?: string` parameter, emit `providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }` on the system message when present. Tagging + hypothesis-synth call-sites flip it on. TTL: 5min. Nightly batch cadence keeps it warm — no pre-warm needed.
- **`extern/wien-forschungsfragen-klima`** (MED, Issue #425) — `scripts/lib/llm-rerank.ts:277` + `scripts/lib/llm-translate.ts:205`. Batch re-rank + translate with versioned prompt files (`prompts/*.v1.md`). Write-only: add `cache_control` to the system block; **skip `max_tokens: 0` entirely** — let the first real call write the cache; subsequent items in the same batch read it. TTL: 5min default; switch to 1h if a single batch run takes >5 min (instrument first).

## Anti-Patterns

- **Breakpoint on the user/placeholder message** — hashes differently every call, never hits. PC-002 is the explicit guard. Re-read the Anthropic docs quote if tempted: *"not on the placeholder user message."*
- **Forgetting to switch `system` from string to block array** — `cache_control` is silently dropped from a string-shaped system prompt. The request succeeds, the cache is never written, and there is no error.
- **Cron cadence > TTL** — pre-warming every 6 min for the 5-min TTL means the cache expires between warms. Cron at `TTL × 0.8` (every 4 min for 5min TTL, every 48 min for 1h TTL).
- **`stream: true` on the pre-warm call** — rejected by the API. Pre-warm calls must be non-streaming. The user-facing call after the warm can stream freely against the now-warm cache.
- **Per-request content (timestamps, request IDs, user IDs) inside the cached prefix** — even a 5-character difference invalidates the cache. Keep all per-request data strictly AFTER the last `cache_control` breakpoint.
- **Mixing `cache_control` with `tool_choice: 'tool' | 'any'`** — rejected by the API on the pre-warm call (`max_tokens: 0`). The regular call works, but the pre-warm has to drop the forced tool choice.
- **Spending all 4 breakpoints on adjacent system text blocks** — wastes the budget. Adjacent blocks share a prefix; one breakpoint at the end caches the whole array. Reserve breakpoints for genuinely separate cacheable regions (tools, system, long-lived document context).
- **Skipping verification** — every cache adoption ships with the PC-007 smoke test. A silent miss costs 12× more per call than a successful hit (1.25× write + 0.1× read amortised vs 1.0× × N forever).

## See Also

backend.md · ai-agent.md · testing.md · development.md
