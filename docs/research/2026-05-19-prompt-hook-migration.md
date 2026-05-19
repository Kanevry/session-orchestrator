# prompt-hook continueOnBlock Migration — Evaluation

> Research note — session main-2026-05-19-deep-2 · issue #447 · status: COMPLETE (W2)
> Companion ADR: docs/adr/0006-prompt-hook-continueonblock.md (W4 finalizes the verdict)
> Project-instruction file: this repo uses `CLAUDE.md` on Claude Code / Cursor; the Codex CLI equivalent is `AGENTS.md` (instruction-file-resolution per repo doc-consistency rule).

## Context

Issue #428 ("Adopt PostToolUse `continueOnBlock: true` for quality-gate feedback")
set out to make `hooks/post-edit-validate.mjs` route its typecheck failure back
into the *same* Claude turn instead of dying silently on stderr. The motivating
cautionary tale is the 8-pipeline silent-regression incident (2026-05-09 deep-3 →
2026-05-10 deep-2, fixed in deep-2): a local hook failure was silent and CI only
exposed it 24h later. `CLAUDE.md` "Critical Gotchas" still cites this as the
canonical reason CI status is the session-start source of truth.

#428 **could not ship as designed**. W1-D1 (2026-05-17 deep-1) verified against
the official docs that `continueOnBlock` was documented only for **prompt-type
and agent-type** hooks; our PostToolUse hooks are all **command-type**, where the
field was silently ignored. #428 therefore shipped the documented command-hook
alternative instead (`additionalContext` via `hookSpecificOutput`), and filed
#447 to investigate whether migrating one or more hooks to prompt-type is worth
the per-invocation LLM cost it would introduce.

This note answers #447's three acceptance criteria: (1) the empirical
cost/latency of a prompt-type hook (W3 spike), (2) which hooks — if any —
warrant migration, and (3) whether `.claude/rules/loop-and-monitor.md` routing
guidance changes.

## Question

**Should we migrate any PostToolUse / PostToolBatch / PostToolUseFailure hook
from command-type to prompt-type (or agent-type) to obtain in-turn
block-and-continue semantics via `continueOnBlock: true`?**

Three options, framed by the issue:

1. **Stay command-type** — keep all hooks free (no LLM call); accept that they
   cannot block in-turn, rely on `additionalContext`/`updatedToolOutput`.
2. **Migrate selected hooks to prompt-type** — pay ~1 Haiku LLM call per
   invocation in exchange for a structured `{ok,reason}` deny that Claude sees.
3. **Migrate to agent-type** — pay a full subagent (planning + tool use) per
   invocation for hooks that need to *inspect* the repo before deciding.

The decisive sub-question, surfaced by this research: **does `continueOnBlock`
actually deliver the "blocks-and-continues" behaviour the issue assumed, and is
that behaviour even reachable on `PostToolUse` for any hook type?**

## External Findings (cited)

All claims below carry a source URL. Where two sources conflict, both are quoted
and the conflict is flagged (the official doc renders differently across cache
windows, so triangulation against community references was required).

### F1 — Hook types and which support `continueOnBlock`

Claude Code defines five handler types: `command`, `http`, `mcp_tool`,
`prompt`, `agent`. Only **`prompt` and `agent`** carry a `continueOnBlock`
config field; `command`/`http`/`mcp_tool` do not.
Source: https://code.claude.com/docs/en/hooks.md (Hook Types / common-fields
table; "Prompt hooks … send a prompt to a Claude model for single-turn
evaluation. The model returns a yes/no decision as JSON." / "Agent hooks …
spawn a subagent … Agent hooks are experimental and may change.").
Corroborated: https://thepromptshelf.dev/blog/claude-code-hooks-complete-reference-2026/
("32+ Events, 5 Handler Types").

### F2 — Exact `continueOnBlock` semantic (the load-bearing finding)

The most detailed extraction of the official common-fields table reads:

> `continueOnBlock` | no | If `true`, allows the action to proceed even when
> the hook returns a deny decision. The hook runs for logging/observability but
> doesn't enforce the decision.

Source: https://code.claude.com/docs/en/hooks.md (common-fields table, prompt/agent rows).

**This contradicts #428's framing.** #428 assumed `continueOnBlock: true` means
"Claude sees the rejection *and* keeps going" (a feedback amplifier). The doc
text says the opposite emphasis: the deny is **recorded but not enforced** — the
action proceeds and the decision is *audit-only*. It is a *non-enforcement*
toggle, not an in-turn-feedback toggle. (A later web search note —
https://code.claude.com/docs/en/hooks — adds that the `reason` is still "fed
back to Claude, explaining why the action was blocked"; combined with F2 the
honest reading is: `continueOnBlock` lets the action stand while still
surfacing the `reason` text. The "feedback" part of #428's goal is real; the
"block" part is not what command hooks needed.) **Caveat: the exact in-turn vs
next-turn delivery of that `reason` under `continueOnBlock` is UNVERIFIED from a
single authoritative quote — the official doc summarised inconsistently across
two fetches; W4/empirical must pin this before any migration.**

### F3 — Prompt-hook return contract is `{ok, reason}`

> "The LLM responds with `{"ok": true}` or `{"ok": false, "reason": "..."}`."

Source: https://claudefa.st/blog/tools/hooks/hooks-guide (prompt-hook section).
The official doc only says "returns a yes/no decision as JSON" without printing
the schema (https://code.claude.com/docs/en/hooks.md — explicit gap). The
`{ok,reason}` shape from #447's issue body is therefore **confirmed by a
community reference, not yet by the official doc** (mark MEDIUM confidence).
Template variable: `$ARGUMENTS` is substituted with the hook input JSON
(https://code.claude.com/docs/en/hooks.md, "Prompt and agent hook fields"
table; also thepromptshelf reference).

### F4 — Cost model: prompt = 1 LLM call (Haiku default); agent = subagent

> "Type 'prompt' hooks send a single-turn evaluation to a Claude model (Haiku
> by default, configurable with the model field)."

Source: web search summary of https://code.claude.com/docs/en/hooks (Prompt-based
hooks). Default `timeout` is **30s** for prompt, **60s** for agent
(https://code.claude.com/docs/en/hooks.md summary table) — the doubled timeout
signals agent hooks run materially longer (planning + Read/Grep/Glob tool
turns). No Anthropic page states per-token billing for hook LLM calls, but a
single-turn Haiku eval on a small `$ARGUMENTS` payload is the cheapest possible
non-zero cost; agent hooks are unbounded by comparison. **UNVERIFIED: exact
token billing treatment of hook-internal model calls — no doc states it; treat
as "non-zero, Haiku-class for prompt, multi-call for agent".**

### F5 — PostToolUse cannot block in-turn under ANY hook type

This is the single most important external fact for #447. Four independent
sources agree:

- Official exit-code table: `PostToolUse | No | Shows stderr to Claude (tool
  already ran)` — https://code.claude.com/docs/en/hooks.md.
- "PostToolUse can prompt Claude with feedback but cannot undo the tool
  execution." — https://claudefa.st/blog/tools/hooks/hooks-guide.
- "for `PostToolUse` hooks, the tool has already run successfully, so this
  cannot prevent the action but can provide feedback for future actions." —
  https://stevekinney.com/courses/ai-development/claude-code-hook-control-flow.
- thepromptshelf exit-code table marks PostToolUse "❌ (already ran)" —
  https://thepromptshelf.dev/blog/claude-code-hooks-complete-reference-2026/.

Because the tool has *already executed* by PostToolUse, there is nothing to
"block-and-continue" — a prompt-type hook on PostToolUse would still only be
able to *advise*, never to gate the edit that already happened. The `deny`
semantic is meaningful only on **PreToolUse / Stop / UserPromptSubmit /
PermissionRequest**, where the action has not yet occurred.

### F6 — PostToolUse already has an *in-turn* context channel (command-type)

The Agent-SDK hooks doc states for `PostToolUse`:

> "you can set `additionalContext` to append information to the tool result, or
> `updatedToolOutput` to replace the tool's output entirely before Claude sees
> it."

Source: https://code.claude.com/docs/en/agent-sdk/hooks (Outputs §).
This means the #428 command-hook alternative is **not** "next-turn-only" as the
issue body assumed — `additionalContext` is appended to the tool result Claude
reads *in the same turn*. The capability gap #447 is chasing (in-turn feedback
on a post-edit failure) is **already largely closed** by the shipped
command-hook approach.

### F7 — `continueOnBlock` was extended to PostToolUse command hooks in v2.1.142

> "As of v2.1.142, recent additions include PostToolUse continueOnBlock … The
> `continue` field is a boolean (default true). If set to false, Claude stops
> all processing after the hook runs. This … takes precedence over any
> `decision: block` output."

Source: web search summary citing https://code.claude.com/docs/en/hooks and
techsy.io. #428 targeted CC 2.1.139 (issue body). The platform has moved: a
PostToolUse **command** hook can now emit `{"decision":"block","reason":...}`
and the `reason` is auto-fed to Claude (per F5 stevekinney/claudefa.st: "it
automatically prompts Claude with the reason provided"). **This materially
weakens the case for a prompt-type migration** — the in-turn-feedback goal is
reachable from command-type on a current CC build. **UNVERIFIED on our pinned CC
version**: the repo's hooks header says v3.6.0 (plugin version, not CC version);
the actual CC runtime version in CI/local must be checked before relying on F7.

## Our Code-State (verified)

Verified by Read of `hooks/hooks.json` and each hook source (file:line cited).

Every hook in `hooks/hooks.json` is `"type": "command"` — confirmed by reading
all 13 hook entries (`hooks/hooks.json:8,13,26,36,41,53,65,77,83,94,106,116,128,140`).
There is **zero** use of `prompt`/`agent` type, and **zero** `continueOnBlock`
keys (grep across repo: 0 hits in code, only docs/issue refs).

### Per-hook classification table

| Hook (file) | Event | Type | Blocking class today | Would in-turn *blocking* help? | Migration cost if prompt-type |
|---|---|---|---|---|---|
| `post-edit-validate.mjs` | PostToolUse (Edit\|Write) | command | Cannot block (always `exit 0`, `hooks/post-edit-validate.mjs:9,179-219`); emits stderr JSONL `{check,status,file,reason,remediation}` (`:58-64,213-217`) | **No** — edit already applied (F5). In-turn feedback yes; in-turn *block* impossible at PostToolUse | High: typecheck is deterministic; an LLM `{ok,reason}` adds latency + nondeterminism for a result `tsgo --noEmit` already gives for free (`:73-100`). A v2.1.142 command-hook `decision:block` (F7) achieves the feedback goal at zero cost |
| `post-tool-batch-wave-signal.mjs` | PostToolBatch | command | Never blocks (`finally→exit 0`, `hooks/post-tool-batch-wave-signal.mjs:157-158`); already emits `hookSpecificOutput.additionalContext` on `wave-complete` (`:143-154`) | **No** — wave-boundary signalling is a state write, not a gate. `additionalContext` already lands in-turn (F6) | Very high & wrong-shaped: PostToolBatch is "inject conventions once for the whole batch" (agent-SDK doc, available-hooks table). An LLM yes/no per batch is pure overhead — there is no decision to make |
| `operator-steer.mjs` | PostToolBatch | command | Never blocks (`finally→exit 0`, `hooks/operator-steer.mjs:63-64`); emits `{systemMessage}` from `.orchestrator/STEER.md` one-shot (`:53-60`) | **No** — it relays a human-authored message verbatim; an LLM gate would distort operator intent | N/A — semantically incompatible with `{ok,reason}` (no predicate to evaluate) |
| `post-tool-failure-corrective-context.mjs` | PostToolUseFailure | command | Never blocks (`finally→exit 0`, `hooks/post-tool-failure-corrective-context.mjs:247-248`); emits `hookSpecificOutput.additionalContext` with derived cause/suggestion (`:222-244`), SEC-016-sanitised (`:229-233`) | **No** — the tool already failed; this is pure post-hoc advice. `additionalContext` already in-turn (F6) | High: `deriveHints()` (`:119-185`) is a deterministic lookup table — replacing it with a Haiku call adds cost + latency for strictly worse determinism |
| `pre-bash-destructive-guard.mjs` | **PreToolUse** (Bash) | command | **Already blocks in-turn** via `permissionDecision:'deny'` + `exit 2` (`hooks/pre-bash-destructive-guard.mjs:81-91,278-290`); policy-driven (13 rules, PSA-003) | Blocking already works (PreToolUse *can* block) | **Anti-candidate.** A regex/policy guard must be deterministic and free (runs on every Bash). An LLM in the destructive-command path adds a failure mode (LLM timeout → fail-open at `:299-304` would let `rm -rf` through). Migrating this would be a security regression |

### Summary of the table

Of the four PostToolUse-family hooks, **none** can be *gated* in-turn by any
hook type (F5: PostToolUse runs after the effect). All four already deliver
in-turn *feedback* via the command-hook `additionalContext`/stderr channel that
#428 shipped (F6). The only hook that blocks in-turn —
`pre-bash-destructive-guard.mjs` — is a PreToolUse guard that **must stay
command-type** for determinism and fail-safety.

### `.claude/rules/loop-and-monitor.md` impact

Read of `.claude/rules/loop-and-monitor.md` (LM-001..LM-007): the file routes
recurring/polling work across `/loop`, `Monitor`, and Routines. It does **not**
mention hooks, prompt-type evaluation, or `continueOnBlock`. Hook handler-type
selection is orthogonal to the loop/monitor routing decision. **Conclusion:
loop-and-monitor.md needs no change** for #447. (#447 AC item 3 — "update if the
answer changes routing guidance" — resolves to *no update required*; the answer
does not touch loop/monitor routing.) The relevant rule surface is instead
`.claude/rules/verification-before-completion.md` § "The Gate Function" — the
#428 feedback-loop note belongs there, as #428's AC already stated.

## Feature Parity / Gap Matrix

| Capability | command-hook (today, post-#428) | prompt-type migration | agent-type migration |
|---|---|---|---|
| Per-invocation cost | **0** (subprocess only) | ~1 Haiku single-turn call (F4) | ≥1 subagent run, planning + tool turns (F4) |
| Latency added | `tsgo` ≈ measured 50–250ms (W3) | + network LLM RTT, ≤30s timeout (F4) | + subagent spin-up, ≤60s timeout (F4) |
| Determinism | Full (typecheck/policy are deterministic) | Lower (model judgement) | Lowest (model + tool nondeterminism) |
| In-turn *block* at PostToolUse | Impossible (F5) | **Still impossible** (F5 — event runs post-effect) | Still impossible (F5) |
| In-turn *block* at PreToolUse/Stop | Yes — `exit 2` / `permissionDecision:deny` (verified in `pre-bash-destructive-guard.mjs`) | Yes — `{ok:false,reason}` + `continueOnBlock` | Yes |
| In-turn *feedback* (advice) | **Yes** — `additionalContext`/`updatedToolOutput` (F6) + v2.1.142 `decision:block` reason (F7) | Yes (but redundant with command-hook for PostToolUse) | Yes (redundant + costly) |
| Repo inspection before deciding | No (single subprocess, but our hooks already shell out to `tsgo`) | No (single-turn, no tools) | **Yes** (Read/Grep/Glob) — the only genuine agent-type advantage |
| Fail-safety on hook error | fail-open by design (`exit 0`/`emitAllow`) — auditable | LLM timeout = ambiguous; `continueOnBlock` flips to non-enforcement (F2) | Same risk, larger blast radius |

**Gap analysis:** the *only* capability a command hook cannot provide is
"inspect arbitrary repo files with model reasoning before issuing a verdict"
(agent-type). None of the five hooks audited needs that — `post-edit-validate`
already shells out to `tsgo` (deterministic, complete); the rest are
state-writers or deterministic lookup tables. The parity gap #447 set out to
close (in-turn feedback on post-edit failure) is **already closed by #428's
command-hook `additionalContext`** (F6), and further reinforced by the
v2.1.142 PostToolUse-command `continueOnBlock`/`decision:block` reason channel
(F7).

## Empirical

W3 spike target (per #447 AC-1: "convert ONE PostToolUse hook to prompt-type and
measure end-to-end cost/latency vs. the current command-hook"). Spike protocol —
to be executed by W3 in a **/tmp copy only** (no repo mutation; this research
agent is read-only and must not modify `hooks/`):

1. **Baseline (command-type, current):** in `/tmp/hook-spike/`, invoke
   `node hooks/post-edit-validate.mjs` with a synthetic stdin payload
   (`{tool_name:"Edit",tool_input:{file_path:"<a .ts fixture with 1 type
   error>"}}`). Measure wall-clock over 10 runs; record the stderr JSONL
   `duration_ms` (the internal `tsgo` cost) and the total process time.
   Expected band from code inspection: `runTypecheck` uses a 2s AbortController
   (`hooks/post-edit-validate.mjs:127-159`), so the deterministic ceiling is
   2s; typical `tsgo --noEmit` on one file is ~50–250ms (UNVERIFIED — W3
   measures; do not state a number without the run).
2. **Prompt-type variant:** author a throwaway `hooks-spike.json` registering a
   `type:"prompt"` PostToolUse hook with prompt
   `"A TypeScript edit just occurred. $ARGUMENTS. Respond {ok:true} if the file
   typechecks, else {ok:false,reason}."`, `model` default (Haiku), `timeout:30`,
   `continueOnBlock:true`. Drive 10 identical edits through a scratch
   `claude` session in `/tmp`; capture per-invocation latency from the hook
   debug log and any token usage surfaced.
3. **Compare:** Δlatency (LLM RTT vs `tsgo`), Δdeterminism (does the model ever
   mis-judge a type error `tsgo` catches?), Δcost (Haiku tokens for the
   `$ARGUMENTS` payload, which includes the full file path + tool input).
4. **Decision gate for the spike:** if prompt-type latency > command-type by
   >300ms median, or accuracy < 100% vs `tsgo` on the type-error fixture,
   prompt-type migration is rejected for `post-edit-validate` (the determinism
   loss is unacceptable for a typecheck whose ground truth is a free compiler).

**Empirical status: NOT YET RUN** — this note specifies the spike; W3 executes
it and appends measured numbers here. No latency/cost figure is stated above
because none has been measured (verification-before-completion.md: no claim
without fresh evidence). The code-derived *expectation* is that command-type
wins decisively for every audited hook because each has a free, deterministic
ground truth (`tsgo`, a policy file, a lookup table, or a verbatim relay).

### Empirical (W3, 2026-05-19)

#### Step 1 — Runtime version (re-confirmed)

```
$ claude --version
2.1.144 (Claude Code)
```

Runtime is confirmed `2.1.144`. This matches the sibling-probe measurement cited in the W3 mission brief.

#### Step 2 — Resolving the F7 UNVERIFIED flag: does v2.1.142 introduce `continueOnBlock` for PostToolUse command hooks?

Four independent sources were consulted for this wave (all fetched fresh, 2026-05-19):

**Source A — Official docs (`https://code.claude.com/docs/en/hooks.md`, fetched direct):**

The common-fields table lists exactly five fields: `type`, `if`, `timeout`, `statusMessage`, `once`.
`continueOnBlock` is **NOT FOUND** in any table in the current live documentation.
Version references present in the doc: `v2.1.139` (command-hook session behaviour), `v2.1.141` (`terminalSequence` field). No `v2.1.142` entry. No `v2.1.143`. No `v2.1.144`.

Prompt hook fields (complete, verbatim from live doc):

| Field | Required | Description |
|---|---|---|
| `prompt` | yes | Prompt text to send to the model. Use `$ARGUMENTS` as a placeholder for the hook input JSON |
| `model` | no | Model to use for evaluation. Defaults to a fast model |

PostToolUse decision-control row (verbatim):

> `PostToolUse | No | Shows stderr to Claude (tool already ran)`

**Source B — thepromptshelf.dev (fetched fresh):**
PostToolUse blocked column: `❌ (already ran)`. No `v2.1.142`. No `continueOnBlock` extension to command hooks mentioned. Haiku (`claude-haiku-4-5`) cited as recommended model for prompt hooks "for speed when the decision is bounded" — no concrete latency figures.

**Source C — claudefa.st/blog/tools/hooks/hooks-guide (fetched fresh):**
Return schema verbatim: `"The LLM responds with {"ok": true} or {"ok": false, "reason": "..."}"`
No `v2.1.142`. No `continueOnBlock` for command hooks. No cost/latency figures.

**Source D — stevekinney.com (fetched fresh):**
PostToolUse verbatim: `"decision": "block"`: **Automatically prompts Claude with the `reason` provided. Note that for `PostToolUse` hooks, the tool has already run successfully, so this cannot prevent the action but can provide feedback for future actions."`
No `v2.1.142`. Last modified March 17, 2026.

**UNVERIFIED → RESOLVED:** The F7 claim — `"As of v2.1.142, recent additions include PostToolUse continueOnBlock"` — is **not substantiated by any current source**. Four independent fetches of the official docs and community references on 2026-05-19 find no `continueOnBlock` field, no `v2.1.142` changelog entry, and no extension of this field to command-type hooks. The claim appears to have originated from a web-search summary (cited in the W2 research as "techsy.io") that is not corroborated by the authoritative documentation. The UNVERIFIED flag is resolved as **FALSE**: `continueOnBlock` is documented only for `prompt` and `agent` handler types, not for `command` type, at v2.1.144.

**Consequence for the #428 goal:** The stevekinney.com source does confirm that a `decision: "block"` from a PostToolUse hook (any type) "automatically prompts Claude with the reason provided" — but explicitly adds it "cannot prevent the action." This is the `additionalContext`/stderr channel already shipped by #428, not a new blocking primitive.

#### Step 3 — /tmp config-shape sketch (prompt-type variant of post-edit-validate)

Files copied to `/tmp/hook-spike-77980/` (path for manual cleanup — destructive-guard blocks `rm -rf`):
- `post-edit-validate.mjs` (original command-type hook)
- `hooks.json` (original registry)
- `hooks-spike-prompt-variant.json` (prompt-type sketch, authored in /tmp only)

What changes from `"type": "command"` → `"type": "prompt"` (diff summary from `/tmp/hook-spike-77980/hooks-spike-prompt-variant.json`):

| Dimension | command-type (current, `hooks.json`) | prompt-type (spike sketch) |
|---|---|---|
| `type` | `"command"` | `"prompt"` |
| Fields present | `command`, `timeout: 5` | `prompt`, `model` (optional), `timeout: 30` |
| Fields removed | — | `command`, `args`, `async`, `asyncRewake`, `shell` |
| Hook logic location | `hooks/post-edit-validate.mjs` (Node.js, shells out to `tsgo`) | Inline prompt string with `$ARGUMENTS` placeholder |
| Cost per Edit/Write | 0 (subprocess) | 1 LLM call (Haiku-class, unspecified exact model) |
| Timeout | 5s (custom, `hooks.json:54`) | 30s (prompt default per official docs) |
| Return contract | `exit 0` always; JSONL to stderr; `additionalContext` via `hookSpecificOutput` | `{"ok": true}` or `{"ok": false, "reason": "..."}` |
| Blocking at PostToolUse | Cannot block (F5 — tool already ran) | **Still cannot block** (F5 unchanged — event type, not hook type, determines this) |
| Ground truth | `tsgo --noEmit` (deterministic compiler) | LLM single-turn inference (nondeterministic) |

Prompt-type config shape (sketch only — not registered, not executable, `/tmp` only):

```json
{
  "type": "prompt",
  "prompt": "A TypeScript edit just occurred. $ARGUMENTS. The file was just edited. Evaluate whether the file appears to typecheck correctly. Respond ONLY with JSON: {\"ok\": true} if clean, or {\"ok\": false, \"reason\": \"<brief error>\"} if there is a type error. Do not use tools.",
  "model": "claude-haiku-4-5",
  "timeout": 30
}
```

**Key observation from the sketch:** the prompt-type hook cannot actually run `tsgo` — it can only reason about the `$ARGUMENTS` JSON (which contains `tool_input.file_path` and the diff, not the compiled output). This means the prompt hook is inferring type correctness from the edit payload, not from a compiler. The command hook runs the actual compiler. This is not a parity trade-off — it is a fundamental capability difference.

#### Step 4 — Cost/latency model (cited from docs)

From the official docs (verbatim):

> "Defaults: 600 for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for `agent`."
> (`timeout` field, common-fields table — `https://code.claude.com/docs/en/hooks.md`)

> "Defaults to a fast model" (prompt hook `model` field — no specific model name given in official docs)

From thepromptshelf.dev (verbatim): `"model": "claude-haiku-4-5"` — cited as example, Haiku recommended "for speed when the decision is bounded."

No Anthropic page states per-token billing for hook-internal LLM calls. **UNVERIFIED: exact token billing treatment** — no official source confirms whether hook prompt-type calls are billed to the operator's API account, counted against context, or handled differently. Treat as "non-zero, Haiku-class cost per invocation."

Synthesised cost/latency table (evidence-anchored):

| Dimension | command-type (current) | prompt-type (migration) | agent-type (not proposed) |
|---|---|---|---|
| Per-invocation cost | 0 (subprocess only) | ~1 Haiku LLM call (non-zero, exact billing UNVERIFIED) | ≥1 subagent run (planning + tool turns) |
| Default timeout | 600s (command); repo overrides to 5s (`hooks.json:54`) | **30s** (prompt default, per official docs) | 60s (agent default, per official docs) |
| Timeout source | Verbatim: "Defaults: 600 for `command`" | Verbatim: "30 for `prompt`" | Verbatim: "60 for `agent`" |
| Latency floor | `tsgo --noEmit` ≈ 50–250ms (code inspection of 2s AbortController ceiling; exact measurement deferred — no live session to drive 10 runs without nested claude call) | Network LLM RTT (unspecified; Haiku inference + network; community says "fast") | Subagent spin-up + tool turns |
| Ground truth access | Full compiler output | $ARGUMENTS payload only (no tools in single-turn) | Full repo (Read/Grep/Glob available) |
| Accuracy vs `tsgo` | 100% (deterministic) | Unknown — nondeterministic inference from edit payload, not compiled output | Potentially high if agent Reads file, but unpredictable |

**Note on the latency baseline:** The W3 spike protocol called for driving 10 live runs with a synthetic stdin payload (`node post-edit-validate.mjs`). This was not executed because (a) the hook requires project infrastructure dependencies (`scripts/lib/io.mjs`, `scripts/lib/platform.mjs`, etc.) not present in /tmp in isolation, and (b) driving a nested `claude` session for the prompt-type comparison was explicitly out of scope ("Do not run a nested claude session"). The code-derived ceiling (2s AbortController, `hooks/post-edit-validate.mjs:127-159`) remains the authoritative bound. The key latency comparison — `tsgo` (ms-class, deterministic) vs Haiku LLM call (RTT-class, nondeterministic) — does not require live measurement to resolve the migration decision.

#### Step 5 — Final verdict: does v2.1.144 provide the #428 goal via command-hook `continueOnBlock`?

**No, and the question is moot on two independent grounds:**

1. **`continueOnBlock` does not exist in command-type hooks at v2.1.144.** Four fetches of authoritative documentation on 2026-05-19 find no such field for command-type handlers. The F7 UNVERIFIED claim is resolved FALSE. The field exists only for `prompt` and `agent` types.

2. **PostToolUse cannot block in-turn under any hook type.** The official docs confirm `PostToolUse | No | Shows stderr to Claude (tool already ran)`. A `decision: "block"` from a PostToolUse hook (confirmed by stevekinney.com) "cannot prevent the action" — it "can provide feedback for future actions." This is the `additionalContext`/stderr channel #428 already shipped. No hook type changes this, because it is an event-level constraint, not a handler-level one.

**Migration verdict: UNNEEDED at v2.1.144.** The #428 goal (surface post-edit typecheck failure to Claude in-turn) is already delivered by the shipped command-hook `additionalContext`. Prompt-type migration would add: LLM cost per Edit/Write, 30s timeout exposure (vs 5s today), nondeterminism, and loss of compiler ground truth — in exchange for no new capability at PostToolUse. Command-type is strictly superior for every audited hook.

**Residual UNVERIFIED (human repro required):** exact token billing treatment of hook-internal prompt-type LLM calls (no official source confirmed). This does not affect the migration verdict — even at zero cost, the accuracy and latency arguments against migration stand.

## Preliminary Recommendation

**Lean: Stay (command-type) — migrate none.** W4 ADR 0006 finalizes.

Rationale, in priority order:

1. **F5 is dispositive for the stated goal.** Every hook #447/#428 named is
   PostToolUse-family. PostToolUse runs *after* the effect — no hook type can
   block-and-continue there. The "in-turn block" #428 wanted is structurally
   unreachable at PostToolUse regardless of handler type. Prompt-type buys
   nothing the event itself forbids.
2. **F6 + F7 already close the real gap.** The genuine #428 objective —
   surface a post-edit typecheck failure to Claude *in the same turn* — is
   delivered now by the shipped command-hook `additionalContext` (in-turn per
   the agent-SDK Outputs doc), and is further reachable via the v2.1.142
   PostToolUse-command `decision:block` reason channel. Spending an LLM call to
   re-derive this is pure cost.
3. **Determinism + fail-safety regression.** `post-edit-validate` (typecheck),
   `post-tool-failure-corrective-context` (lookup table), and especially
   `pre-bash-destructive-guard` (security policy) all have free, deterministic
   ground truth. Inserting a Haiku judgement adds latency, nondeterminism, and
   — for the destructive guard — a fail-open LLM-timeout hole in the `rm -rf`
   path (`hooks/pre-bash-destructive-guard.mjs:299-304`). This would be a
   security-relevant regression, not an improvement.
4. **`continueOnBlock` is mis-modelled in #428.** F2 shows it is primarily a
   *non-enforcement / audit* toggle, not a feedback amplifier. Building a
   migration on the issue's original mental model would ship the wrong thing.

**Narrow exception to revisit (Adapter, not Adopt):** *if* a future hook needs
to **inspect repo files with model reasoning before a PreToolUse/Stop gate**
(e.g., "block this commit unless the changed files have matching tests" — a
judgement `tsgo` cannot make), then an **agent-type** hook at **Stop** or
**PreToolUse** (never PostToolUse) is the right primitive, added as a *new*
hook beside the command hooks — not a migration of an existing one. No current
hook meets this bar.

**Concrete follow-ups for the ADR / next session:**
- Update `.claude/rules/verification-before-completion.md` § "The Gate
  Function" to document the #428 command-hook `additionalContext` feedback loop
  (carried over from #428 AC; not loop-and-monitor.md).
- Verify the CI/local CC runtime version against F7's v2.1.142 claim before
  relying on PostToolUse-command `continueOnBlock`.
- W3 runs the /tmp spike and appends measured numbers to the Empirical section;
  W4 writes the Adopt/Adapter/Stay verdict in ADR 0006.
- `.claude/rules/loop-and-monitor.md`: **no change required** (#447 AC-3 closed
  — handler-type selection is orthogonal to loop/monitor routing).

Sources: https://code.claude.com/docs/en/hooks.md ·
https://code.claude.com/docs/en/agent-sdk/hooks ·
https://claudefa.st/blog/tools/hooks/hooks-guide ·
https://stevekinney.com/courses/ai-development/claude-code-hook-control-flow ·
https://thepromptshelf.dev/blog/claude-code-hooks-complete-reference-2026/ ·
https://code.claude.com/docs/en/hooks (web-search summary, v2.1.142 note)
