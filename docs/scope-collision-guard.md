# Scope-Collision Guard — Pre-Dispatch File-Scope Deconfliction

> Reference for the mechanism that stops a wave from handing the SAME file to two agents (issue #1020).
> Five moving parts: `scripts/materialize-wave-scope.mjs` (the canonical declaration writer), the per-agent scope files, `scripts/validate-wave-scope.mjs` (`--assert-disjoint` / `--union`), `findScopeCollisions()` + `unionFileScopes()` in [`scripts/lib/scope-gate.mjs`](../scripts/lib/scope-gate.mjs), and the `PreToolUse` hook [`hooks/pre-task-scope-disjoint.mjs`](../hooks/pre-task-scope-disjoint.mjs).
> The coordinator-side **runbook** is `skills/wave-executor/wave-loop.md` § Scope Manifest 3.1–3.3 — this document does not restate it. What lives here instead: how the mechanism works, how it fails, what it deliberately does not see, and how to debug it.

## 1. What the pre-existing gates could not see

`assertFileScopeSubset()` (#796) checks each agent's scope **⊆** the wave's `allowedPaths` union, and `wave-scope-commit-guard` checks writes against that same union. A file claimed by two agents is a subset **twice over**, and the union grants it exactly once — so a double assignment is structurally invisible to both. It surfaced only afterwards, from an agent's own PSA-002 report (`findScopeCollisions()` header: `tests/scripts/sweep-expired-learnings-cli.test.mjs` handed to two agents of one wave). Per `.claude/rules/parallel-sessions.md` § Decision Tree, a file inside two declared scopes of one dispatch round is never a benign sibling signal — it is a deconfliction gap.

Two things follow, and both are the point of #1020:

- `allowedPaths` is **computed** from the per-agent declarations (`unionFileScopes()`), not transcribed by hand.
- Disjointness is asserted on the **declarations**, before the union exists.

## 2. The chain, in order

| # | Step | Artefact | Mechanism |
|---|------|----------|-----------|
| 1 | Materialize declarations | `<state-dir>/filescopes/wave-<N>/<agent-id>.json` (one per agent, plus `coordinator.json`) and `<state-dir>/filescopes/wave-<N>.scopes.json` | one canonical `[{id, files}, …]` stdin array → `materialize-wave-scope.mjs` |
| 2 | Assert disjointness | the materialized sidecar array `[{id, files}, …]` | `validate-wave-scope.mjs --assert-disjoint` → `findScopeCollisions()` |
| 3 | Compute the union | stdout of `--union` → `allowedPaths` | `expandTestSiblings(unionFileScopes(scopes), { role })` |
| 4 | Inject | `FILE-SCOPE — exactly these:` + a fenced block in each agent prompt | the per-agent file from step 1 |
| 5 | Dispatch | `.orchestrator/wave-dispatch-scopes.json` (ledger) | `hooks/pre-task-scope-disjoint.mjs`, `PreToolUse` matcher `Agent` |

`<state-dir>` is the first of `.pi` / `.cursor` / `.codex` / `.claude` that carries a `wave-scope.json` — the same precedence `findScopeFile()` and the hook's `waveKeyOf()` use.

### 2.1 Why `--union` runs last

A union computed over colliding scopes **launders the defect into the artefact meant to prevent it**: `allowedPaths` then grants the contested file, and every later gate — `--assert-subset`, `enforce-scope` Gate 7, the commit guard — sees a perfectly legal write. `validate()` in `validate-wave-scope.mjs` enforces the order in code: `--assert-subset` → `--assert-disjoint` → `--union`, and `--union` returns early because it is a QUERY MODE that replaces the manifest echo on stdout.

The same ordering argument applies one level up: step 2 runs on the **declared** scopes, before step 3 expands test siblings. See § 6 for the limit that buys.

### 2.2 Why the scope files are not temp files

Steps 1, 2, 3, 4 and the `--assert-subset` assertion all read the *same* file, addressed by wave and agent id. A `$TMPDIR` copy is the one failure in this chain that **costs no error**: the injector finds nothing, no `FILE-SCOPE` block reaches the prompt, `extractScopeFromPrompt()` returns `[]`, and the hook allows the dispatch exactly as it did before #1020 — signal-free (matrix rows 5/6 below). The scope files are control state like `wave-scope.json` itself, never a wave territory; writing them legitimately trips `bash-write-verify` once per wave rollover, and widening `allowedPaths` to silence that would grant agents write access to the deconfliction record.

The coordinator's **own** planned direct edits belong in `coordinator.json` in the identical form. They are not dispatches, so the hook can never see them (§ 6); the CLI check is the only gate that covers them.

### 2.3 The manifest names its writer (#1123)

`wave-scope.json` is written into the WORKING COPY, not into the session — so until #1123 one session's manifest governed every session sharing that checkout. Measured 2026-08-22 (#1082): a Discovery wave's `allowedPaths: []` — which `wave-loop.md` prescribes for *every* Discovery wave — denied every write of an unrelated parallel session, with a deny reason that could only tell it to fix a wave plan it does not own.

Two OPTIONAL manifest fields close that: `session` (the raw `session_id`) and its human-readable twin `semantic_session`. Both come from ONE `attributionForRecord(repoRoot)` call (`scripts/lib/events.mjs`) in the same coordinator step that writes the rest of the manifest — `skills/wave-executor/wave-loop.md` § Scope Manifest 1. Unlike a raw lock read, `attributionForRecord()` reads `.orchestrator/session.lock` and then confirms the lock's raw `session_id` against `readProcessLocalSessionIds()` before returning anything — a mismatch (or no process-local id at all) yields `{}`, never a peer's ids (#1207).

The reader is `hooks/enforce-scope.mjs` **Gate 3b**, between the manifest parse (G3) and the path-guard gate (G4). It resolves identity via `new Set(readProcessLocalSessionIds({ hookInput: input }))` and classifies via `classifyManifestSession(scope, ownIds)`, both from [`scripts/lib/session-identity/own-session.mjs`](../scripts/lib/session-identity/own-session.mjs):

| Manifest state | `classifyManifestSession` verdict | Gate 3b disposition |
|---|---|---|
| no `session` / `semantic_session` (legacy, pre-#1123) | `unknown` | ENFORCE — falls through unchanged |
| an id present and matching one of our own | `own` | ENFORCE — falls through unchanged |
| ids present, none matching, own identity resolvable | `foreign` | **ALLOW** + one `orchestrator.scope.foreign_session_ignored` event |
| ids present, own identity unresolvable (empty id set) | `unknown` | ENFORCE |

Five properties are choices, not omissions — and every one of them points the fail-**closed** way, the deliberate inverse of § 4.1's posture for the dispatch hook:

- **Only what is PROVABLY foreign is foreign.** `readProcessLocalSessionIds()` returns the ids that are PROCESS-LOCAL — hook input (`session_id`/`sessionId`/`parent_session_id`) and `CLAUDE_CODE_SESSION_ID` — and an EMPTY set when neither yields an id, which can only produce `unknown`. The repo-global `session.lock` is deliberately NOT a tier here (#1194): it is ONE file shared by every session in the checkout, so unioning it let a peer's manifest match a peer-written lock id, classify `own`, and have Gate 7 deny the second session's legitimate writes — the exact lockout G3b exists to end. A better signal REPLACES a worse one (`.claude/rules/host-resources.md` § HR-102). A gate that guessed would turn "cannot tell" into a silent enforcement-off on every harness exporting no session id. Every value is trimmed on the way in, so a whitespace-only env var cannot enter as a phantom id that matches nothing (`.claude/rules/development.md` § env-var whitespace trap).
- **Union across the process-local tiers, not first-tier-wins.** Both process-local tiers are read and merged; only an id in NEITHER is somebody else's. Gating them against each other made the READER's identity a strict subset of the WRITER's — the manifest's `session` comes from `sessionAttribution()` = the same repo-global lock — and two divergences inside these tiers produce the same silent failure, the OWN manifest read `foreign` and the write gate switched itself off for the whole wave, logging an event indistinguishable from correct behaviour: (a) a nested harness where payload `session_id` ≠ `CLAUDE_CODE_SESSION_ID` (measured in `hooks/pre-bash-issue-budget.mjs` `resolveSessionId`); (b) a sub-agent invocation, whose own id is the subagent's while the manifest names the coordinator. A third divergence — a session that lost the lock race and wrote a PEER's id into its own manifest — is NO longer covered here since #1194 dropped the lock tier; it is the accepted cost in limit 11, and its defense is the writer guard. The merge only ADDS ids the process actually carries, so the security direction is unchanged: a manifest whose id appears in neither tier still classifies `foreign`. Its cost is named in limit 11 below.
- **The writer's binding check is mechanical, not a prose comparison (#1207).** Because the lock is repo-global, `skills/wave-executor/wave-loop.md` § Scope Manifest 1 calls `attributionForRecord(repoRoot)`, which confirms the lock's raw `session_id` against `readProcessLocalSessionIds()` internally and returns `{}` on any mismatch or absent process-local id — the coordinator writes whatever comes back, with no further comparison to perform. STATE.md is deliberately not part of this check: it is a shared working-copy artefact written by whichever session holds the lock, so under a peer-owned lock STATE.md's `session` field would agree with the lock about the same peer and "confirm" exactly the wrong id. OMIT the `session`/`semantic_session` keys whenever `attributionForRecord()` returns `{}` — unbound = ENFORCE. The reader's union covers the case anyway; the writer guard keeps the manifest readable as an audit record instead of publishing a foreign name.
- **Gate 3b runs after the parse, never on the raw bytes.** A corrupt manifest yields `{}`, hence no ids, hence `unknown` — and keeps failing closed. A gate that peeked at the bytes first would let a truncated manifest disarm the guard.
- **The empty string is a validator ERROR, not a third flavour of absent.** `validateSession()` → `validateOptionalSessionId()` in `scripts/validate-wave-scope.mjs` rejects `"session": ""` with *"an empty id attributes to nothing; omit the key entirely to declare the manifest unbound"*. An empty id satisfies a truthiness check while matching nobody, so every reader would classify the manifest FOREIGN where the writer meant UNBOUND — opposite dispositions, not a cosmetic ambiguity. An ABSENT key only WARNS, because the § 3.3 pre-union skeleton is itself an unbound manifest and so is every manifest written before #1123.

The event is what keeps the skip countable rather than silent: `orchestrator.scope.foreign_session_ignored` carries `hook`, `manifest`, `manifest_session`, `own_session`, `wave` and `file_path`. It is deliberately an event and not an `emitWarn` — the branch is hit on *every* Edit of the non-owning session, so a stderr line per write would be noise the operator learns to ignore.

## 3. The collision algorithm

`findScopeCollisions(agentScopes, { knownFiles })` compares every cross-agent entry pair through `classifyEntryCollision()`, in three binding stages:

1. **Exact string equality** → kind `concrete`. The commonest real case, and the only stage that works for a file that **does not exist yet**.
2. **Concrete vs glob** via `pathMatchesPattern(concrete, glob)` → kind `concrete`. Exact and I/O-free. Two *distinct concrete* paths are disjoint and return immediately.
3. **Glob ∩ glob**, in two sub-stages:
   - **3a — witness:** expand both entries against `KNOWN = knownFiles ∪ {every concrete entry of every agent}`; a non-empty intersection is `glob-expanded`. The second half of that union matters — a file the wave is about to *create* is not in `git ls-files`, but a concrete claim by one agent can still witness another's glob.
   - **3b — prefix fallback:** for the intersection that exists only in files not yet on disk. Requires literal-prefix containment in either direction, at least one **recursive** entry (`**`, or a trailing `/`, which `pathMatchesPattern` matches by `startsWith` at any depth), and compatible literal suffixes. The suffix filter is a necessary condition, so it adds no false negative while removing `scripts/**/*.ts` vs `scripts/**/*.mjs`.

`knownFiles` is **injected, never discovered**: `scope-gate.mjs` is hook-safe (pure, sync, no I/O, no spawn) because `enforce-scope.mjs` reaches it on a hot path, and under the exit-0/stdout-JSON protocol a throw there reads as "no decision" = ALLOW. The CLI spawns `git ls-files` in `knownRepoFiles()`; the hook does the same in `listTrackedFiles()`, both resolving `git rev-parse --show-toplevel` first so a session started in a subdirectory produces repo-relative paths on both sides.

Duplicate agent ids are reported separately (`duplicateIds`), not as a self-collision. A record with no usable id runs as `<unnamed#i>` rather than being dropped — an unreviewed scope is exactly the one that collides.

### 3.1 Why `pathMatchesPattern` alone cannot do stage 3

The matcher is **directed**: argument 2 is compiled into a regex, argument 1 is tested as a literal string. Measured in this working tree on 2026-08-14:

```
$ node --input-type=module -e "import { pathMatchesPattern } from './scripts/lib/scope-gate.mjs';
  console.log(pathMatchesPattern('scripts/**/*.mjs','scripts/lib/*.mjs'));
  console.log(pathMatchesPattern('scripts/lib/x.mjs','scripts/**/*.mjs'),
              pathMatchesPattern('scripts/lib/x.mjs','scripts/lib/*.mjs'));"
false
true true
```

Both globs match `scripts/lib/x.mjs`, yet the direct comparison says `false`. For `assertFileScopeSubset()` that inexactness is *safe*: its glob branch reduces to verbatim presence plus literal-prefix coverage and therefore **over-approximates coverage**, which at worst accepts a union it could not fully prove. For a **collision** check the sign flips — the same over-approximation becomes a **false negative**, i.e. a missed collision, i.e. the incident. That is why the two exact stages decide first and stage 3 is reached only for pairs neither can settle. <!-- path-check: example -->

## 4. The hook

`hooks/pre-task-scope-disjoint.mjs` is a `PreToolUse` hook on matcher **`Agent`** (registered in `hooks/hooks.json`). It blocks a wave from handing the same file to two agents at the moment of dispatch, before either has written a byte.

It cannot compare a batch of siblings directly — the header records why, measured against 12 archived transcripts of this repo (147 dispatch `tool_use` blocks, 51 batches, measured 2026-08-14): the dispatch tool is named `Agent` and not `Task`; the payload carries **no** structured file scope (`files` / `file_scope` / `scope` → 441 probes, zero hits), so the scope exists only as prose inside `prompt`; and the not-yet-dispatched siblings of a batch are not visible in the transcript at dispatch time. What remains is a **ledger**: each dispatch records its scope under a wave key, and the next dispatch is checked against everything already recorded.

- **Ledger:** `.orchestrator/wave-dispatch-scopes.json` (gitignored), keyed `<session-id>|w<wave>|<role>` from `<state-dir>/wave-scope.json`.
- **Lock:** `.orchestrator/wave-dispatch-scopes.lock` — the read-modify-write cycle runs under `withFileLock()` (the primitive behind the PSA-005 STATE.md lock). `writeJsonAtomicSync` makes the write atomic, never the *cycle*.
- **Scope extraction:** `extractScopeFromPrompt()` finds a scope marker line and takes the FIRST fenced block after it, accepting only lines that survive a deliberately strict `looksLikeRepoPath()`. `normalizeScopeEntry()` then folds `./`, `//` and `/./` spellings together, and `promoteDirEntries()` rewrites `scripts/lib` → `scripts/lib/` **on evidence** (not a tracked file itself, at least one tracked file beneath it) — both because two spellings of one path previously compared as disjoint.
- **DENY** fires on exactly one condition: a collision involving THIS dispatch with a prior agent of the same wave that is **still in flight** (§ 5). The reason names the agent pair, the collision kind and the evidence paths; the suggestion is "give the file exactly ONE owner, or wait for the named agent(s) and re-dispatch", plus the ledger path to delete if the state is stale. The ledger is deliberately **not** persisted on a deny — the dispatch did not happen, so recording it would make the retry-after-fix look like a duplicate.

### 4.1 Error-class matrix — deliberately fail-**open**

The blast radius is asymmetric. A false positive on the dispatch path blocks every agent of the session — the guard becomes a session outage, and nothing downstream catches a dispatch that never happened. A false negative is a double assignment that three later gates still catch (`validate-wave-scope.mjs`, `enforce-scope.mjs` at write time, the W5 verification pass). Fail-closed is right for a WRITE guard (`enforce-scope.mjs` is), and wrong here. Each row is a choice, not an oversight:

| # | Condition | Decision |
|---|-----------|----------|
| 1 | disabled via profile/env | exit 0, silent |
| 2 | repo module failed to load | ALLOW + `GUARD INACTIVE` banner on stderr |
| 3 | stdin empty / not JSON | ALLOW |
| 4 | `tool_name` is not `Agent` | ALLOW |
| 5 | prompt carries no scope marker | ALLOW |
| 6 | scope block present but unparseable | ALLOW |
| 7 | ledger unreadable / corrupt | WARN + ALLOW + **self-heal** (the verdict carries a fresh ledger) |
| 8 | `git ls-files` failed | ALLOW, degraded (stage 3a loses witnesses; concrete collisions still found) |
| 9 | `findScopeCollisions` not evaluable | WARN + ALLOW |
| 10 | same agent id re-dispatched | ALLOW, ledger record replaced (a retry must not self-lock) |
| 10a | collision, but every colliding prior agent has FINISHED | ALLOW + prune those records |
| 11 | collision with a prior agent still IN FLIGHT | **DENY** |
| 12 | unexpected throw in `main()` | ALLOW + stderr |
| 13 | liveness probe throws / no evidence at all | treated as IN FLIGHT (bounded by the TTL, § 5) |
| 14 | ledger lock not acquirable within its budget | run the cycle UNLOCKED (degraded), never deny |

Two structural rules keep this matrix honest, both recorded in the hook header:

- `decide()` is a **pure function returning a verdict**; the module emits exactly once, at the end. `emitWarn`/`emitDeny` call `process.exit(0)` and never return, so a warn emitted from inside the checking flow would terminate the process before a later collision could be denied — and would skip the lock's release `finally`.
- Row 9's discriminator is **not** `ok !== true`. `ok` means *disjoint*, so `ok === false` is the normal result of a real collision; "not evaluable" is `ok === false` with BOTH result arrays empty. Reading `ok` as evaluability would turn every genuine collision into a warn, i.e. an allow — the exact fail-open the hook exists to prevent.

### 4.2 Observability — one record per dispatch decision (#1092)

Every dispatch that reaches a verdict also appends one `orchestrator.wave_dispatch.scope_checked` record to `<projectDir>/.orchestrator/metrics/events.jsonl` (payload contract: [`docs/events-schema.md`](events-schema.md)). It is built inside `decide()` as `verdict.telemetry` and emitted by `main()` — awaited **before** the terminal `emitAllow`/`emitDeny`/`emitWarn`, each of which calls `process.exit()` and would discard a pending append — inside a `try/catch`, so a failed write can never change the verdict or the exit code.

Why it exists: the in-ledger `scopeSignals` counter (§ 4.1, rows 5/6) is a **wave tally**. It answers "how many dispatches of this wave carried a scope", never "which agent was dispatched unscoped" — and a wave in which the injection step was skipped entirely still produces a plausible-looking tally. The per-dispatch record makes the individual dispatch falsifiable (`.claude/rules/host-resources.md` § HR-105).

**What the event proves:** the hook SAW — or did not see — a `FILE-SCOPE` declaration in the prompt the coordinator handed to the dispatch tool, which declaration shape parsed it (`shape`), whether any path survived (`injected`, `declared_path_count`), and which matrix row decided (`ledger_result`, `collision_count`). That is the **send** side, measured at the PreToolUse boundary.

**What it does not prove:** that the block reached the agent's context, or that the model read it. Those are **receive**-side facts, and this hook observes the tool payload, not the assembled prompt. A record reading `injected: true` is therefore evidence about the coordinator's dispatch, never about the agent's obedience — reading it as the latter rebuilds exactly the false confidence § 2.2 warns about. The counterpart signal on the receive side remains the agent's own behaviour (`enforce-scope` at write time) and the W5 verification pass.

**Payload discipline.** Counts and closed enums only, plus `agent_id` (the coordinator's own dispatch description, clamped) and the optional session attribution: no prompt body, no declared path, no glob. Issue #1092's acceptance criterion 3 is the rule, and the reason is concrete — this record also travels over the optional Clank Event-Bus webhook with no redaction, and paths under `01-projects/` carry private project slugs.

**Revisit-Trigger** (verbatim from issue #1092, for the transport half this section deliberately does NOT close):

> Implement when the platform exposes a stable prompt-assembly hook or when a coordinator-owned digest event can be proven against the real dispatched transcript.

Until then the issue's remaining acceptance criteria — a scope-file **digest** proven to have reached the prompt assembler, and an omitted/malformed injection turning an end-to-end probe red while materializer, disjointness, union and subset checks stay green — are not satisfiable by any mechanism inside this repo, because no observable boundary carries the final prompt.

## 5. The liveness probe

A ledger with no notion of completion denies the wrong thing. Measured over 38 archived transcripts of this repo (346 `Agent` dispatch blocks; hook header, 2026-08-14): 0 of 4 same-batch overlaps and **2 of 2 cross-dispatch overlaps** would have been denied — and both cross-dispatch pairs were legitimate **sequential repair passes** (a dispatch and its later fix). Because a deny deliberately does not persist the ledger, the re-dispatch would have met the same stale record: a permanent block.

The discriminator is therefore neither time nor the agent's name, but whether the recorded agent is **still in flight**. Two transcript shapes carry that:

- **Synchronous dispatch** — the `tool_result` for the dispatch's `tool_use` id arrives when the agent is done (measured: five `Agent` rows within 0.44 s, their results 5–11 minutes later). At the fifth agent's `PreToolUse` none of the first four has a result → all in flight → a real same-batch overlap still denies.
- **Asynchronous dispatch** — the `tool_result` arrives in ~0.2 s and reads `Async agent launched successfully`. **That text is a launch receipt, not a completion.** Treating it as one would let every real background-batch collision through. The completion arrives later as a `<task-notification>` record carrying `<tool-use-id>` and `<status>completed</status>` (measured: launch 14:14:26.768 → notification 14:24:39.360).

`buildTranscriptIndex()` reads all three record shapes and counts a description as finished only when **every** one of its dispatch ids is finished. Cost containment: the transcript is read **only once a collision has already been found** — i.e. only on the path that is about to deny; the no-collision path pays nothing. Transcripts above 256 MiB are treated as *no evidence*, never as a completion.

**Blind fallback and its named ceiling (BV-004).** With no transcript, or none carrying a record of that agent, liveness falls back to the ledger entry's own age with `IN_FLIGHT_TTL_MS = 30 min`. The ceiling is derived: the largest **measured** same-batch dispatch spread is 95.7 s, so 30 min is ~19× headroom against the false-ALLOW direction, while both measured sequential repair gaps (36 min, 49 min) sit above it. **Revisit trigger:** a same-batch spread above ~5 min appearing in `.orchestrator/metrics/`, or a harness change that stops writing `transcript_path` — either invalidates the headroom the number rests on.

## 6. Named limits

Complete list of what this guard does **not** see, or sees only approximately:

1. **The blind TTL window.** Without transcript evidence the only liveness signal is the 30-minute TTL above. Inside that window a finished agent still blocks (false deny, recoverable by deleting the ledger); outside it a running agent no longer blocks (false allow). Revisit trigger as stated in § 5.
2. **Test-sibling collisions.** Disjointness is asserted on the **declared** scopes (step 2), before `expandTestSiblings()` runs (step 3). Two agents whose production files share a basename receive the *same* emitted sibling glob (`tests/**/{basename}*.test.mjs`), which a declared-scope check cannot see. Revisit if a wave is ever scoped by basename family instead of by directory.
3. **Prose extraction fails only toward ALLOW.** The hook's only channel is the `FILE-SCOPE` prose block. A missing marker, a missing fence, a decorated path that fails `looksLikeRepoPath()` — all resolve to allow (rows 5/6). Measured: 42 of 147 archived prompts (28.6 %) carried a scope marker at all, so denying the non-extractable case would have denied ~7 dispatches in 10. The CLI check (step 2) is the gate that does not depend on prose.
4. **Coordinator-direct edits are invisible to the hook.** They are not dispatches, so no ledger entry exists for them. They participate in the CLI check via `coordinator.json` only — and 2 of the 5 divergences that motivated #1020 were coordinator-direct edits.
5. **The wave-key fallback.** With no readable `wave-scope.json`, `waveKeyOf()` degrades to `<session>|w?|?` and the ledger spans the whole session, so a wave-3 dispatch is compared against wave-1 records. Bounded, not eliminated, by the liveness probe: a prior record binds only while its agent is in flight.
6. **Glob ∩ glob without witnesses.** Stage 3a needs tracked files; with git unavailable (row 8) or for files not yet on disk, only stage 3b's prefix fallback carries the load — and it requires at least one recursive entry, so two non-recursive globs that intersect only in an unborn file are not detected.
7. **Only collisions involving the current dispatch are actionable.** A pair among already-dispatched agents was either denied at its own dispatch or predates the guard; re-denying it would block an innocent third agent.
8. **Lock loss reopens the race.** On lock timeout the cycle runs unlocked (row 14) — two dispatches starting together can then read the same ledger state and one record is lost. That is the pre-lock behaviour, chosen over denying on a lock-file problem.
9. **The session binding is self-declared** (§ 2.3). `session` is a plain field in a file any process in this working copy can write, so writing a foreign id into it turns the write gate off for that manifest. Named rather than hidden: it is the SAME power `enforcement: "off"` already grants in the same file, so Gate 3b adds no new authority — the manifest is the coordinator's own artefact either way.
10. **Only the WRITE gate is session-bound.** The dispatch ledger of § 4 takes its session component from the harness's own `input.session_id` (`waveKeyOf(projectDir, sessionId, …)`), and reads only `wave` and `role` out of `wave-scope.json` — the `session` field is not consulted there at all. So a peer session's manifest cannot bind this session's writes since #1123, but the two hooks reach that property by different routes, and a change to one does not carry to the other.
11. **A session that published a peer's id reads its OWN manifest as `foreign` (#1194) — the writer's defense is now mechanical (#1207).** Dropping the lock tier (§ 2.3) moved the cost to the other side of the trade: with a raw `sessionAttribution()` read, a session that lost the `bootstrapLock()` race could get the peer's id and write it into its own manifest, and Gate 3b would then classify the manifest `foreign`, standing its own write guard down. Since #1207 the writer calls `attributionForRecord(repoRoot)` instead — `skills/wave-executor/wave-loop.md` § Scope Manifest 1 — which confirms the lock's raw `session_id` against `readProcessLocalSessionIds()` before returning anything and yields `{}` on any mismatch, so the coordinator performs no manual comparison and STATE.md plays no part in it (a shared working-copy artefact written by whichever session holds the lock, not a process-local witness). A filled binding is therefore provably this session's own; unbound (`{}`) = ENFORCE. CEILING (BV-004): on a harness that exports no session env var and puts no `session_id` in the hook payload (Codex CLI, Cursor today) both tiers are empty, so G3b is permanently `unknown` = enforce = pre-#1123 behaviour there. Revisit when Codex/Cursor hook payloads carry a session id.

## 7. Debugging

**A dispatch was denied and you do not believe it.** Read `.orchestrator/wave-dispatch-scopes.json`: it carries `waveKey`, `updated`, and one `{id, desc, files, at}` record per already-dispatched agent. The deny reason names the other agent — find its record and compare its `files` to the ones in your prompt's `FILE-SCOPE` block. Three outcomes:

- The other agent is genuinely running and the overlap is real → fix the ownership in the session plan (one file, one agent), rewrite the affected `filescopes/wave-<N>/*.json`, re-assert, re-dispatch.
- The other agent has finished, but the ledger still binds it → the transcript carried no evidence (§ 5) and you are inside the TTL window. Delete `.orchestrator/wave-dispatch-scopes.json`; the next dispatch rebuilds it.
- The `waveKey` names an older wave → the `<session>|w?|?` fallback (limit 5). Check that `<state-dir>/wave-scope.json` exists and is readable, then delete the ledger.

**A dispatch was NOT denied and should have been.** Start at the ledger line, which now says which row fired without re-running anything: `jq -c 'select(.event=="orchestrator.wave_dispatch.scope_checked")' .orchestrator/metrics/events.jsonl | tail` — `injected:false` with `signal:"marker-absent"` is row 5 (no declaration in the prompt at all, i.e. the injection step, not the guard), `signal:"unparseable"` is row 6 (a declaration the parser could not use), `ledger_result:"allow-finished"` is row 10a (the collision was real but its partner had finished), and NO record at all for a dispatch you watched happen means the hook never ran or crashed before deciding (§ 4.2). Then work down the allow rows: is `FILE-SCOPE` present in the prompt with a fenced block right after it (rows 5/6)? Is the hook armed at all (`GUARD INACTIVE` on stderr = row 2)? Did a `systemMessage` warning appear (rows 7/9)? Cross-check the same scopes through the CLI, which does not depend on prose:

```bash
node scripts/validate-wave-scope.mjs --assert-disjoint "$WAVE_SCOPES_SIDECAR" < <state-dir>/wave-scope.json
```

Exit 1 prints one `ERROR:` line per collision (`agents "A" and "B" both claim [...]`) and one per duplicate id. Exit 0 — nothing on stderr, the manifest echoed back on stdout — means the declared scopes really are disjoint and the hook was right to allow; the divergence is then in the prompt, not in the plan.

**Reset.** Delete `.orchestrator/wave-dispatch-scopes.json` (and `.orchestrator/wave-dispatch-scopes.lock` if a dead holder is suspected). Both are gitignored, both are rebuilt on the next dispatch, and neither is shared with any other mechanism. After the final wave, `<state-dir>/filescopes/` is deleted along with `wave-scope.json` — a stale `wave-<N>/` directory left behind is a scope claim nobody re-verified.

**Disable.** The hook honours the repo's profile gate (`shouldRunHook('pre-task-scope-disjoint')`, row 1) — a silent exit 0, no decision at all.

## 8. Provenance of the numbers

Every figure above is quoted from a measurement recorded next to the code that carries it, with its date:

- Transcript-shape figures (147 dispatch blocks / 12 transcripts / 51 batches / 441 zero-hit probes / 28.6 % marker coverage; 346 blocks / 38 transcripts for liveness; the 95.7 s, 36 min and 49 min spreads; the 0.44 s and 10-minute observations) — header of `hooks/pre-task-scope-disjoint.mjs`, measured 2026-08-14 against this project's archived transcripts.
- The directedness transcript in § 3.1 — run in this working tree on 2026-08-14; the command is printed with it.

Re-measure before citing any of these downstream. A count re-briefed later is a claim about the past (`.claude/rules/parallel-sessions.md` § PSA-006).

## See Also

- `skills/wave-executor/wave-loop.md` § Scope Manifest — the coordinator runbook (steps 3.1–3.3) and § Pre-Dispatch: File-Scope Injection (the prompt block shape).
- `.claude/rules/parallel-sessions.md` § Decision Tree (why a file in two declared scopes is never a benign sibling signal), § PSA-006 (measurement discipline).
- `hooks/enforce-scope.mjs` — the write-time gate, fail-**closed**; the deliberate inversion of this hook's posture. Its Gate 3b is the reader of the § 2.3 session binding; `scripts/lib/session-identity/own-session.mjs` holds the identity half.
- `skills/_shared/state-ownership.md` § `wave-scope.json` Session Binding — the same contract from the ownership side (which shared working-copy artefact belongs to which session).
- [`docs/adr/0011-guard-degradation-semantics.md`](adr/0011-guard-degradation-semantics.md) — the exit-0 hook protocol (#906) and why a truncated stdout envelope reads as no-decision, i.e. as ALLOW.
