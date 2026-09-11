# Evolve — Phase 6: Dialectic Mode

> Reference of the evolve skill, split out of `SKILL.md` (#1246). Body moved **byte-identical**; only this header is new.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`** — none needed rewriting: the moved body carries no relative markdown links, only backticked file mentions, which were deliberately left untouched so the bytes stay verifiable against the pre-split file.
> **Read when `/evolve dialectic` runs** — `../SKILL.md` Phase 2's Mode Dispatch routes here. Covers argument parsing (`--apply`/`--dry-run`/`--model`/`--budget-tokens`), the 4-source data load via `runDialecticDeriver()`, dispatching the `dialectic-deriver` agent, the diff/apply gate, and telemetry error handling.

## Phase 6: Dialectic Mode

Single-pass LLM derivation of USER.md + AGENT.md (peer cards from #503) updates from current learnings + sessions + steering files. Dry-run-default per #506 EARS contract.

**Telemetry start marker (#1200):** note the current wall-clock time at Phase 6 entry (`DURATION_MS` in the Step 6.4/6.5 emits below is the elapsed milliseconds since this marker) — same placeholder convention as `skills/session-end/SKILL.md`'s `orchestrator.handover.gated` emits.

### Step 6.0: Argument Parsing

Parse `$ARGUMENTS` for trailing flags after the `dialectic` keyword:

| Flag | Default | Behavior |
|---|---|---|
| `--apply` | `false` | Write diff to USER.md/AGENT.md via merger.mjs; without it = dry-run |
| `--dry-run` | `true` | Explicit dry-run (default); mutually exclusive with --apply |
| `--model <name>` | from Session Config `dialectic.model` (default `haiku`) | Override LLM |
| `--budget-tokens <N>` | from Session Config `dialectic.budget-tokens` (default 8000) | Token budget |

Mutex check: `--apply` + `--dry-run` together = error "flags mutually exclusive".

### Step 6.1: Pre-checks
- Bootstrap gate (Phase 0) — already executed
- Persistence check (Phase 1.2) — already executed
- Cadence check: if invoked via session-end Phase 3.6.7 auto-trigger, the trigger has already pre-checked cadence. For manual invocation, skip cadence — manual always runs.

### Step 6.2: Data Load
Read all 4 input sources via `runDialecticDeriver()` from `scripts/dialectic-deriver.mjs` (see W2 I1):
1. Top-N learnings from `.orchestrator/metrics/learnings.jsonl` (default 50, sorted by confidence DESC)
2. Last-K sessions from `.orchestrator/metrics/sessions.jsonl` (default 10, sorted by completed_at DESC)
3. Peer cards via `readPeerCards(repoRoot)` from `scripts/lib/peer-cards/reader.mjs` — returns `{user, agent}` or null
4. Project steering files (CLAUDE.md / AGENTS.md Session Config block + narratives)

Graceful degradation: any null/empty source is acceptable. If ALL inputs empty → return `{status: 'empty-input'}`.

### Step 6.3: Dispatch the Deriver Agent

Construct a `dispatchAgent` function that uses the harness Agent tool to invoke the `dialectic-deriver` agent (see `agents/dialectic-deriver.md`):

```javascript
const dispatchAgent = async ({ model, prompt, maxTokens }) => {
  // Coordinator uses Agent tool with subagent_type: "session-orchestrator:dialectic-deriver"
  // and the model parameter to invoke the right tier
  const result = await Agent({
    description: "Dialectic-deriver LLM pass",
    subagent_type: "session-orchestrator:dialectic-deriver",
    model,
    prompt,
  });
  return { text: result.text, usage: result.usage ?? { input_tokens: 0, output_tokens: 0 } };
};

> **Why `maxTokens` is not passed to Agent():** the Claude Code harness `Agent()` tool does not currently accept a `max_tokens` parameter. Output-token budget is therefore enforced via prompt text (see line 414 in `skills/session-end/SKILL.md`: "with budget ${budget-tokens} input + 4000 output tokens"). The dispatchAgent contract declares `maxTokens` as the canonical interface; the evolve skill destructures it for forward-compat but routes enforcement through the prompt body. When the harness adds a max_tokens hint, this dispatchAgent becomes the single update point.

const result = await runDialecticDeriver({
  dispatchAgent,
  repoRoot: process.cwd(),
  model: argv.model ?? config.dialectic?.model ?? 'haiku',
  budget: { input: argv['budget-tokens'] ?? config.dialectic?.['budget-tokens'] ?? 8000, output: 4000 },
  dryRun: !argv.apply,
  allowEmptying: argv['allow-emptying'] ?? false,
});
```

### Step 6.4: Diff Output & Apply Gate
- If dry-run (default): present diff inline; write to `.orchestrator/dialectic-pending.md` (atomic tmp+rename); EXIT. Suggestion: "Re-run with `/evolve --dialectic --apply` to apply." <!-- path-check: example -->
- If `--apply`: call **`mergeDerivedBody(existingBody, result.diff[target])`** from `scripts/lib/peer-cards/merger.mjs` for each card target, then `writePeerCard(repoRoot, 'user', mergedUserCard)` and `writePeerCard(repoRoot, 'agent', mergedAgentCard)` from `scripts/lib/peer-cards/writer.mjs`. Update the `updated:` frontmatter.

  **Why `mergeDerivedBody` and not `mergePeerCard` directly (#1310):** the deriver emits a FULL BODY STRING per target (`agents/dialectic-deriver.md` § Output format); `mergePeerCard` consumes a SECTION MAP keyed by sentinel name. `mergeDerivedBody` is the adapter between the two — it splits the proposed body at `## ` headings and maps each heading to a sentinel section. `mergePeerCard` stays available as the section-map primitive. Handling per heading class, all of it in `mergeDerivedBody`'s return value:

  | Heading in the proposed body | Section name | Merge effect | Surfaced as |
  |---|---|---|---|
  | Matches an existing managed section's own `## ` heading | that section's EXISTING name (read from the card, NOT re-slugified) | REPLACE | `mapping[].origin === 'existing'` |
  | No existing section | slugified heading (`[a-z0-9-]+`, collisions suffixed `-2`) | APPEND | `mapping[].origin === 'new'` |
  | Existing managed section the proposal omits | — | KEPT (no auto-delete, per `mergePeerCard` semantics) | — |
  | Text before the first `## ` heading | — | NOT applied | `preamble` + a `{ type: 'unmapped-preamble' }` entry in `conflicts[]` |

  Existing names are read back out of the card rather than re-derived because the live names are not a pure function of their headings — measured 2026-09-11 in `.orchestrator/peers/AGENT.md`: `## Guard and protocol-migration discipline` → `guard-and-protocol-migration`. Re-slugifying would APPEND a duplicate section instead of replacing one.

  **Present `conflicts[]` before writing.** A non-empty `conflicts[]` (`duplicate-section`, `orphan-begin`, `unmapped-preamble`) is operator-visible content that the merge did not place — report it beside the delta line rather than writing silently.
- Report: `Dialectic-derived: M deltas to USER.md, N deltas to AGENT.md. Dry-run | Applied. Tokens: in=<X> out=<Y>.`

**Telemetry (#1200, #1206) — emitted by `scripts/dialectic-deriver.mjs`, not skill prose.**
The dry-run branch needs no action here: `runDialecticDeriver()` already emitted the success
form (`mode: 'dry-run'`) internally at Step 6.2, using `countManagedSections(diff)` on the SAME
diff this step presents — in dry-run the diff IS the final artefact, so the event and the
artefact are computed from the same value. The **apply** branch is the one case that pipeline
cannot record on its own: the merge above happens here, one layer up, so call
`recordDialecticRun()` (the sibling export beside `emitEvolveCompleted` in
`scripts/lib/learnings/evolve-telemetry.mjs`) immediately after the `writePeerCard()` calls,
using each target's `mergePeerCard()` `stats` for the deltas:

```javascript
await recordDialecticRun({
  repoRoot,
  status: 'ok',
  mode: 'apply',
  userDeltas: userMergeStats.replaced + userMergeStats.appended,
  agentDeltas: agentMergeStats.replaced + agentMergeStats.appended,
  tokensIn: result.usage?.input_tokens,
  tokensOut: result.usage?.output_tokens,
  durationMs: DURATION_MS,
});
```

### Step 6.5: Error Handling
- `status: 'unknown-model'` → fail with clear error (already thrown by validateModel)
- `status: 'budget-exceeded'` → emit `{status:'budget-exceeded', used:N, budget:M}`, do NOT truncate
- `status: 'would-empty-card'` → warn + require `--allow-emptying` flag
- `status: 'empty-input'` → exit clean with message "dialectic: skipped (no input)"
- subagent crash → log ⚠, exit cleanly (do NOT write to `.orchestrator/dialectic-pending.md`) <!-- path-check: example -->

**Telemetry (#1200, #1206) — emitted by `scripts/dialectic-deriver.mjs` for THREE of the five
outcomes.** `budget-exceeded`, `would-empty-card`, and `empty-input` are `runDialecticDeriver()`
RETURN values, so the module records them itself, mechanically, at the exact return point —
nothing to do here for those three. The remaining two are THROWN, not returned, and can only be
caught one layer up:

- `unknown-model` — `validateModel()` throws synchronously before `runDialecticDeriver()` can
  record anything about the call.
- `subagent-crash` — a `dispatchAgent`/`Agent()` failure propagates out of
  `runDialecticDeriver()` uncaught (it has no status of its own for this case).

Catch both here and call the SAME `recordDialecticRun()` used in Step 6.4's apply branch,
passing the literal slug as `status` (the abort form: `{aborted: status, duration_ms}`):

```javascript
await recordDialecticRun({ repoRoot, status: 'unknown-model' /* or 'subagent-crash' */, durationMs: DURATION_MS });
```

Cross-reference: PRD #506 AC1-AC4 + EARS gates. Vault Integration: dialectic does NOT mirror to vault (#506 scope — peer cards are repo-local by design; vault mirror is for cross-repo sessions/learnings).
