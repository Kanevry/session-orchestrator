# Evolve — Phase 6: Dialectic Mode

> Reference of the evolve skill, split out of `SKILL.md` (#1246). Body moved **byte-identical**; only this header is new.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`** — none needed rewriting: the moved body carries no relative markdown links, only backticked file mentions, which were deliberately left untouched so the bytes stay verifiable against the pre-split file.
> **Read when `/evolve dialectic` runs** — `../SKILL.md` Phase 2's Mode Dispatch routes here. Covers argument parsing (`--apply`/`--dry-run`/`--model`/`--budget-tokens`), the 4-source data load via `runDialecticDeriver()`, dispatching the `dialectic-deriver` agent, the diff/apply gate, and telemetry error handling.

## Phase 6: Dialectic Mode

Single-pass LLM derivation of USER.md + AGENT.md (peer cards from #503) updates from current learnings + sessions + steering files. Dry-run-default per #506 EARS contract.

**Telemetry start marker (#1200):** note the current wall-clock time at Phase 6 entry (`DURATION_MS` in the Step 6.4 apply emit below is the elapsed milliseconds since this marker) — same placeholder convention as `skills/session-end/SKILL.md`'s `orchestrator.handover.gated` emits.

### Step 6.0: Argument Parsing

Parse `$ARGUMENTS` for trailing flags after the `dialectic` keyword:

| Flag | Default | Behavior |
|---|---|---|
| `--apply` | `false` | Write diff to USER.md/AGENT.md via merger.mjs; without it = dry-run |
| `--dry-run` | `true` | Explicit dry-run (default); mutually exclusive with --apply |
| `--model <name>` | from Session Config `dialectic.model` (default `haiku`) | Override LLM |
| `--budget-tokens <N>` | from Session Config `dialectic.budget-tokens` (default 32000) | Input-token ceiling (the pre-dispatch estimate aborts above it; not a spend) |

Mutex check: `--apply` + `--dry-run` together = error "flags mutually exclusive".

### Step 6.1: Pre-checks
- Bootstrap gate (Phase 0) — already executed
- Persistence check (Phase 1.2) — already executed
- Cadence check: none. `/evolve dialectic` is invoked MANUALLY (by the operator, or by the session-start maintenance loop acting on the `maintenance-due` probe's `dialectic` signal) and always runs. The session-end Phase 3.6.7 auto-trigger that used to pre-check cadence was removed in #1288; `shouldDispatchAutoDialectic` (`scripts/lib/auto-dialectic.mjs`) survives only as the side-effect-free signal that probe reads, and this phase never calls it.

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
  budget: { input: argv['budget-tokens'] ?? config.dialectic?.['budget-tokens'] ?? 32000, output: 4000 },
  dryRun: !argv.apply,
  allowEmptying: argv['allow-emptying'] ?? false,
});
```

### Step 6.4: Diff Output & Apply Gate
- If dry-run (default): present diff inline; write to `.orchestrator/dialectic-pending.md` via `writeDialecticPending({ repoRoot, diff })` from `scripts/lib/auto-dialectic.mjs` (path constant `DIALECTIC_PENDING_PATH`; atomic tmp+rename). `runDialecticDeriver()` does NOT write this file itself — the dry-run branch returns the diff and the caller persists it. The body parameter is named `diff`, not `body`, and it is a Markdown **string**: `result.diff` is an OBJECT `{ user?, agent? }`, so serialize it first — passing the object throws `TypeError` (as does an empty string or a missing `repoRoot`). An empty `result.diff` (no target proposed) has nothing to review: write no sidecar. EXIT. Suggestion: "Re-run with `/evolve --dialectic --apply` to apply." <!-- path-check: example -->

  ```javascript
  const pendingBody = renderPendingBody(result.diff); // scripts/lib/auto-dialectic.mjs
  if (pendingBody) {
    await writeDialecticPending({ repoRoot, diff: pendingBody, usage: result.usage, model });
  }
  ```

  `renderPendingBody({ user?, agent? })` is the serializer that used to live here as a snippet (#1386). It is now code so the dry-run write and the apply-time drift check below build the body the SAME way — two hand-copied serializers would report drift that is only formatting. It returns `''` when neither target is a string: nothing to review, write no sidecar.
- **Before `--apply` writes anything: show the operator what changed since he approved (#1386).** `--apply` re-derives from the model (`dispatchAgent` runs unconditionally in `scripts/dialectic-deriver.mjs`), so under variant (b) the apply still costs a SECOND model call and what would be applied is not necessarily what was read in `.orchestrator/dialectic-pending.md`. This step makes that drift VISIBLE; it does **not** make apply deterministic. Run it after the fresh derivation and BEFORE any `writePeerCard()` call: <!-- path-check: example -->

  ```javascript
  const fresh = renderPendingBody(result.diff);
  const cmp = await comparePendingBody({ repoRoot, body: fresh }); // never throws
  ```

  - `cmp.sidecarAbsent === true` (no sidecar — the operator may never have run the dry-run) or `cmp.drifted === false`: apply SILENTLY. An `AskUserQuestion` that blocks nothing is a rule break (`.claude/rules/ask-via-tool.md` AUQ-001/AUQ-005).
  - `cmp.drifted === true`: present BOTH bodies (`cmp.sidecarBody` = approved, `cmp.freshBody` = fresh) and ask via `AskUserQuestion` — two options, each description carrying reason + cost + consequence, and the drifted text in the option `preview` so the operator decides from the payload rather than from a file:
    - **"Frischen Vorschlag anwenden (Recommended)"** — recommended because the fresh derivation saw the newest learnings and sessions, while the sidecar is a snapshot of an earlier run; cost: the peer cards get text the operator has not reviewed line by line; consequence: cards are written, `writeDialecticLastRun` + `consumeDialecticPending` run, the sidecar is archived.
    - **"Verwerfen, Sidecar für eine weitere Prüfung behalten"** — when the delta is large enough to want a second read; cost: the second model call just spent is wasted and `--apply` must run again later; consequence: **nothing is written to the peer cards and the sidecar is NOT consumed** — skip both bookkeeping calls below so the `pending-sidecar` signal keeps the review due. EXIT.
- If `--apply`: call **`mergeDerivedBody(existingBody, result.diff[target])`** from `scripts/lib/peer-cards/merger.mjs` for each card target, then `writePeerCard(repoRoot, 'user', mergedUserCard)` and `writePeerCard(repoRoot, 'agent', mergedAgentCard)` from `scripts/lib/peer-cards/writer.mjs`. Update the `updated:` frontmatter.

  **`writePeerCard` shape (#1303).** `writePeerCard(repoRoot, target, card)` takes `card = { frontmatter, body }`. `frontmatter.id` (kebab-case slug, 2..128 chars) is **required and never auto-filled**; `type: 'peer-card'`, `target`, `updated` (defaults to `new Date().toISOString()`) and `created` (defaults to `updated`) are filled by the writer. ISO timestamps may carry optional milliseconds (`scripts/lib/peer-cards/schema.mjs` `ISO_DATETIME_REGEX`). A missing `id` returns `{ ok: false, errors: [...] }` and leaves the target file untouched — it does **not** throw; branch on `result.ok`.

  **Why `mergeDerivedBody` and not `mergePeerCard` directly (#1310):** the deriver emits, per target, the WHOLE `## ` SECTIONS it changes or adds — never the card's full body (`agents/dialectic-deriver.md` § Output format: "Omitted sections stay unchanged (nothing auto-deletes), so emit only the sections you change or newly ground"). `mergePeerCard` consumes a SECTION MAP keyed by sentinel name. `mergeDerivedBody` is the adapter between the two — it splits the proposed text at `## ` headings and maps each heading to a sentinel section, merging SECTION-WISE. Do not read this as a full-body replacement: a deriver that emitted the full body would overwrite every hand-written managed section with an LLM reproduction, and `detectEmptying` (`scripts/dialectic-deriver.mjs`) would not catch it — it refuses only a proposal with ZERO content lines. `mergePeerCard` stays available as the section-map primitive. Handling per heading class, all of it in `mergeDerivedBody`'s return value:

  | Heading in the proposed body | Section name | Merge effect | Surfaced as |
  |---|---|---|---|
  | Matches an existing managed section's own `## ` heading | that section's EXISTING name (read from the card, NOT re-slugified) | REPLACE | `mapping[].origin === 'existing'` |
  | No existing section | slugified heading (`[a-z0-9-]+`, collisions suffixed `-2`) | APPEND | `mapping[].origin === 'new'` |
  | Existing managed section the proposal omits | — | KEPT (no auto-delete, per `mergePeerCard` semantics) | — |
  | Section name outside `[A-Za-z0-9_-]+` | — | `mergePeerCard` **throws** `invalid section name` | fix the name before merging |
  | Text before the first `## ` heading | — | NOT applied | `preamble` + a `{ type: 'unmapped-preamble' }` entry in `conflicts[]` |
  | Falls inside an existing managed region that wraps MORE than one `## ` heading | — | NOT applied — the region stays byte-unchanged (no replace, which would delete its sibling headings' hand-written text; no append, which would duplicate the heading) | `{ type: 'multi-heading-region', region, headings, skipped }` in `conflicts[]` — `region` is the region's section name, `headings` the `## ` headings it wraps, `skipped` the proposed headings dropped. Operator action: split the region by hand into one managed region per heading, then re-run — or discard the proposal for those headings |

  Existing names are read back out of the card rather than re-derived because the live names are not a pure function of their headings — measured 2026-09-11 in `.orchestrator/peers/AGENT.md`: `## Guard and protocol-migration discipline` → `guard-and-protocol-migration`. Re-slugifying would APPEND a duplicate section instead of replacing one.

  **Present `conflicts[]` before writing.** A non-empty `conflicts[]` (`duplicate-section`, `orphan-begin`, `unmapped-preamble`, `multi-heading-region`) is operator-visible content that the merge did not place — report it beside the delta line rather than writing silently.
- **Close the loop — after a successful `--apply` AND after the operator explicitly discards a reviewed proposal** (never after a dry-run, a failure, a skip, or the drift-check's "keep the sidecar for another review" branch above): record the run and consume the sidecar, both from `scripts/lib/auto-dialectic.mjs`. Without these two calls the maintenance-due probe keeps `dialectic` (measured against `.orchestrator/dialectic-last-run`) and `pending-sidecar` (`.orchestrator/dialectic-pending.md` younger than 14 days) due forever — nothing else writes the one or moves the other (#1380). Both return `{ ok, error? }` and never throw; log a failure and continue. Since #1388 `consumeDialecticPending` MOVES the sidecar to `.orchestrator/consumed/<timestamp>-dialectic-pending.md` (newest 10 retained) instead of deleting it, so the reviewed text survives the apply; `archivedTo` on the result names the file. <!-- path-check: example -->

  ```javascript
  const lastRun = await writeDialecticLastRun({ repoRoot, isoTimestamp: new Date().toISOString() });
  const consumed = await consumeDialecticPending({ repoRoot }); // ENOENT → { ok: true, consumed: false }
  if (!lastRun.ok || !consumed.ok) console.error(`⚠ dialectic bookkeeping: ${lastRun.error ?? consumed.error}`);
  ```
- Report: `Dialectic-derived: M deltas to USER.md, N deltas to AGENT.md. Dry-run | Applied. Tokens: in=<X> out=<Y>.`

**Telemetry (#1200, #1206) — emitted by `scripts/dialectic-deriver.mjs`, not skill prose.**
The dry-run branch needs no action here: `runDialecticDeriver()` already emitted the success
form (`mode: 'dry-run'`) internally at Step 6.2, using `countManagedSections(diff)` on the SAME
diff this step presents — in dry-run the diff IS the final artefact, so the event and the
artefact are computed from the same value. Dry-run counting rule (#1319): `<!-- BEGIN MANAGED -->`
sentinels if present, otherwise the `## ` headings outside code fences, otherwise 1 for any
non-empty body (0 for an empty one). The two modes therefore count different things on the
same `user_deltas` / `agent_deltas` fields: dry-run counts sections of the PROPOSED body,
apply counts sections the merge actually `replaced + appended`. The **apply** branch is the one case that pipeline
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
- `status: 'budget-exceeded'` → emit `{status:'budget-exceeded', used:N, budget:M}`, do NOT truncate.
  The budget is an input CEILING, not a spend. The former 8000 default aborted real runs — a consumer repo estimated 11 158 input tokens (S119, 2026-09-10) and later 30 262, this repo ~12 268 for card bodies + steering alone — so the default is 32000 since #1380. If a repo still exceeds it, raise `--budget-tokens` or `dialectic.budget-tokens` in Session Config rather than trimming inputs.
- `status: 'would-empty-card'` → warn + require `--allow-emptying` flag
- `status: 'empty-input'` → exit clean with message "dialectic: skipped (no input)"
- subagent crash → log ⚠, exit cleanly (do NOT write to `.orchestrator/dialectic-pending.md`) <!-- path-check: example -->

**Telemetry (#1200, #1206, #1221) — all five outcomes are emitted by `scripts/dialectic-deriver.mjs`;
do NOT call `recordDialecticRun()` for any of them here.** `budget-exceeded`, `would-empty-card` and
`empty-input` are recorded at their return point; `unknown-model` and `subagent-crash` are recorded
at the throw point, and the original error is then rethrown unchanged — so catch it for the ⚠ log
above, but a second record here would double-count the run. The only caller-side emit left is
apply-mode success (Step 6.4).

Cross-reference: PRD #506 AC1-AC4 + EARS gates. Vault Integration: dialectic does NOT mirror to vault (#506 scope — peer cards are repo-local by design; vault mirror is for cross-repo sessions/learnings).
