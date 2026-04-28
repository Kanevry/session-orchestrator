# Policy-Cache Effectiveness Validation (#266)

**Date:** 2026-04-28  
**Issue:** #266 — [Follow-up #250] Validate policy-cache effectiveness under Claude Code subprocess-per-call hook model  
**Measurement script:** `scripts/measure-policy-cache-effectiveness.mjs`  
**Environment:** Darwin 25.3.0, Node.js v24.13.1

---

## Background

Issue #250 introduced `scripts/lib/quality-gates-cache.mjs` — a JSONL file-based cache that persists quality-gate Baseline results to `.orchestrator/metrics/baseline-results.jsonl`. The concern raised in #266 was that under Claude Code's subprocess-per-call hook model (each hook invocation spawns a fresh Node.js process), any *in-process* memoisation would be useless because process memory is discarded after every hook run.

Two cache layers were audited:

| Module | Mechanism | Claim |
|---|---|---|
| `quality-gates-cache.mjs` | Append-only JSONL on disk | Baseline results persist across waves |
| `quality-gates-policy.mjs` | Synchronous `fs.readFileSync` | No caching claim — reads the policy file fresh every call |

---

## Findings

### 1. Baseline-Result Cache (`quality-gates-cache.mjs`)

**Cache mechanism:** JSONL file — reads and writes `.orchestrator/metrics/baseline-results.jsonl` on every call. There is **no in-process memoisation**. The file is the cache.

**Subprocess-per-call model (8 subprocesses):**

| Metric | Value |
|---|---|
| Hit rate | 100% (8/8) |
| Mean call time (self-reported) | 0.456 ms |
| Median call time | 0.453 ms |
| Persists across subprocess boundaries | **Yes** |

**Multi-call-in-process model (5 calls, same process):**

| Call | Time |
|---|---|
| Cold (#1) | 0.220 ms |
| Warm mean (#2–5) | 0.065 ms |
| Hit rate | 100% |

**Conclusion:** The cache is fully effective under the subprocess-per-call model. Because persistence is file-based (JSONL), each new subprocess reads the same on-disk record and gets a cache hit as long as the validity criteria are met (`session_start_ref` match, `dependency_hash` match, TTL, all-pass results). The 3.4× speedup from cold→warm in a single process (0.220 ms → 0.065 ms) is from OS page-cache, not module-level memoisation.

**The issue concern is a non-issue:** The cache was never designed around in-process memory. It deliberately uses disk I/O for cross-process durability.

### 2. Policy File Loader (`quality-gates-policy.mjs`)

**Cache mechanism:** None. Every call reads `.orchestrator/policy/quality-gates.json` synchronously via `fs.readFileSync`. No in-process memoisation, no file-based cache.

**Subprocess-per-call model (8 subprocesses, no policy file present):**

| Metric | Value |
|---|---|
| Policy found | 0/8 (no `quality-gates.json` in test repo) |
| Mean call time | 0.098 ms |
| Median call time | 0.096 ms |

**Multi-call-in-process model (5 calls):**

| Call | Time |
|---|---|
| Cold (#1) | 0.044 ms |
| Warm mean (#2–5) | 0.003 ms |

**Conclusion:** The 14.7× in-process speedup (0.044 ms → 0.003 ms) is entirely from OS page-cache. This module makes **no caching claims** — it is a policy *loader*, not a policy *cache*. At sub-0.1 ms per call even in the subprocess model, adding memoisation would provide no measurable benefit to hook latency.

---

## Subprocess-Per-Call Hook Model Analysis

Claude Code spawns a fresh Node.js process for each hook event. The process startup overhead (Node.js bootstrap, ESM import chain) is **not measured here** — the timings above are for the module logic only, excluding the ~50–100 ms Node.js startup cost that dominates hook wall-clock time.

**Critical finding:** The `quality-gates-cache.mjs` module is called from `skills/wave-executor/wave-loop.md` inside the coordinator session (a long-running Claude Code process), **not** from hook handlers. This means the subprocess-per-call concern does not apply to the primary usage of this cache. The cache is invoked as an LLM-directed inline script call within the coordinator's context, not as a Claude Code hook.

Hook handlers (`hooks/*.mjs`) do not import `quality-gates-cache.mjs` at all. They handle scope enforcement, destructive-command guarding, and session events — none of which use the baseline-result cache.

---

## Raw Numbers (2026-04-28T06:42:22Z)

```json
{
  "config": { "subprocessCount": 8, "inprocessCount": 5 },
  "cache_subprocess_hitRate": 1.0,
  "cache_subprocess_medianMs": 0.453,
  "cache_subprocess_meanMs": 0.455,
  "cache_inprocess_coldMs": 0.220,
  "cache_inprocess_warmMeanMs": 0.065,
  "policy_subprocess_medianMs": 0.096,
  "policy_inprocess_coldMs": 0.044,
  "policy_inprocess_warmMeanMs": 0.003
}
```

---

## Recommendation: KEEP (no changes needed)

1. **`quality-gates-cache.mjs` — KEEP as-is.** The file-based JSONL design is the correct choice for a subprocess-hostile environment. It achieves 100% hit-rate across fresh subprocesses when the validity criteria are met. Sub-millisecond call latency is negligible relative to the quality-gate commands it short-circuits (typecheck + test = typically 10–60 seconds).

2. **`quality-gates-policy.mjs` — KEEP as-is.** Not a cache, does not claim to be one. The 0.096 ms per-call cost in the subprocess model is acceptable. Adding in-process memoisation would only benefit callers that invoke it multiple times in a single process, and the current warm-path latency (0.003 ms from OS page-cache) is already negligible.

3. **No action on issue #266's concern** that "the cache may not survive between calls." It does survive, by design. The misconception is that the cache is in-process memory — it is not. The JSONL file persists until TTL expiry (7 days), session-ref changes, or dependency hash changes.

4. **Optional future improvement (low priority):** An mtime-based shortcut in `loadLatestBaselineResult` could skip the full JSONL parse on repeated reads within a session if the file mtime hasn't changed. Current latency (~0.5 ms/call) does not justify this complexity.

---

## Files

- `scripts/measure-policy-cache-effectiveness.mjs` — instrumentation script (supports `--json`, `--subprocess-count`, `--inprocess-count`, `--repo-root`)
- `docs/policy-cache-validation-2026-04-28.md` — this document
- `tests/scripts/measure-policy-cache-effectiveness.test.mjs` — smoke test (script runs, emits valid JSON)
- `skills/quality-gates/SKILL.md` — `§ Baseline Cache (#258)` — citation updated with validation reference
