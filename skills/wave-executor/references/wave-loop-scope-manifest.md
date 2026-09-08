# Wave Loop — Scope Manifest
> Project-instruction file resolution: `CLAUDE.md` and `AGENTS.md` (Codex CLI) are transparent aliases — see [skills/_shared/instruction-file-resolution.md](../../_shared/instruction-file-resolution.md). Wherever this file mentions a project's `CLAUDE.md`, the alias rule applies.

> Reference of the wave-executor skill, split out of `wave-loop.md` (#1157). Body moved **byte-identical**; only this header is new.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`**: `SKILL.md` → `../SKILL.md`, `circuit-breaker.md` → `../circuit-breaker.md`. They were deliberately NOT rewritten, so the moved bytes stay verifiable against the pre-split file.
> **MANDATORY BEFORE EVERY WAVE DISPATCH.** This is the file the project `CLAUDE.md` `allowedPaths` gotcha (#1020) points at as the authoritative two-stage procedure: § 3.1 writes ONE per-agent scope file, § 3.2 writes the ONE per-wave aggregate. Writing only one of the two degrades the whole chain to a signal-free ALLOW that looks identical to a clean run.
> Then continue with `wave-loop-dispatch.md`.

## Scope Manifest

Before each wave dispatch:

1. **Write `<state-dir>/wave-scope.json`** with the wave's scope:
   > (Platform-specific: `.claude/wave-scope.json` on Claude Code, `.codex/wave-scope.json` on Codex CLI, `.cursor/wave-scope.json` on Cursor IDE)

   **Deriving `blockedCommands` (effective floor∪overlay policy, #155/#972):** Before writing `wave-scope.json`, derive the blocked patterns from the EFFECTIVE policy via the shared merge module — the plugin's floor policy united with the repo's overlay policy. (A bare `jq` over the repo-local policy file alone under-counts the merged result since #972.)
   ```bash
   BLOCKED=$(node --input-type=module -e "
   import { loadEffectivePolicy } from '$PLUGIN_ROOT/scripts/lib/blocked-commands-policy.mjs';
   const { rules } = await loadEffectivePolicy({ cwd: process.cwd(), projectDir: process.env.CLAUDE_PROJECT_DIR ?? null, pluginRoot: '$PLUGIN_ROOT' });
   console.log(JSON.stringify((rules ?? []).filter(r => r.severity === 'block').map(r => r.pattern)));
   ")
   ```
   Use `$BLOCKED` as the `blockedCommands` value in `wave-scope.json`. Since #972 this is the effective floor∪overlay policy — identical to what the destructive-guard hook enforces.

   **Fallback:** If the command fails or prints `[]` (neither the plugin's floor policy nor a repo policy resolvable — pre-#155 setup), use the legacy hardcoded array and log a warning in the wave progress update:
   ```bash
   BLOCKED='["rm -rf", "git push --force", "DROP TABLE", "git reset --hard", "git checkout -- ."]'
   # Warning: policy file .orchestrator/policy/blocked-commands.json not found — using legacy hardcoded blocklist
   ```

   **Deriving the session binding (#1123, made mechanical #1207):** `wave-scope.json` lives in the WORKING COPY, and `hooks/enforce-scope.mjs` applies whatever it finds there to every session running in that checkout. Without a binding, a Discovery wave's `allowedPaths: []` denied every write of an unrelated parallel session. Name the writer — both fields come from ONE `attributionForRecord()` call, which reads `.orchestrator/session.lock` and confirms it against this process's own identity before returning anything:
   ```bash
   MANIFEST=$(printf '%s' "$DRAFT_MANIFEST" | node "$PLUGIN_ROOT/scripts/wave-scope-binding.mjs" \
     --merge --wave "$WAVE" --role "$ROLE")
   ```
   `$DRAFT_MANIFEST` is the manifest below WITHOUT the two binding keys; `$MANIFEST` is what you write to `wave-scope.json`. `--merge` reads that draft on stdin and prints it back with `session_id` / `semantic_session_id` merged in — or with both keys ABSENT (and the unbound event emitted) when the binding is `{}`. It passes every other field through untouched and drops any stale binding key the draft carried, so the merge itself can no longer produce `"session_id": ""` or a leftover id from a previous run. Without `--merge` the same command prints only the binding object (`{"session_id": …}`) and you merge it yourself — the older, hand-copied form.
   **The command is the binding step, not a convenience wrapper (#1153 P4).** `$WAVE` and `$ROLE` are the same two values you are about to write into the manifest below (`wave` and `role`); they are recorded in the event payload only, and never influence the binding itself. It makes ONE `attributionForRecord()` call and prints one JSON object — `{"session_id": ..., "semantic_session_id": ...}` since #1153 P2 — omitting any key whose value is unavailable. Readers still accept the pre-#1153 `session` / `semantic_session` spellings until the next minor release (`MANIFEST_SESSION_KEYS`, `scripts/lib/session-identity/own-session.mjs`); nothing writes them any more. When the binding resolves to `{}` it also emits exactly one `orchestrator.scope.unbound_manifest` event carrying `{wave, role, reason}` — the unbound case is the fail-closed direction and was therefore SILENT, indistinguishable from a coordinator who skipped this step (0 hits repo-wide before #1153). Do not retype the old inline `node -e` block: it produced the same JSON and no event.

   **The binding check is now mechanical, not a prose comparison (#1207).** `attributionForRecord()` reads the repo-global `.orchestrator/session.lock`, which in a shared working copy can hold a PEER's id — a session that lost the acquire race (`bootstrapLock()` reason `active`) leaves the lock naming the session that won it. It never hands that peer's id back: internally it confirms the lock's raw `session_id` against `readProcessLocalSessionIds()` (this process's own env-/hook-supplied identity) and returns `{}` — not the peer's ids, not an empty-but-present pair — whenever the two disagree or no process-local id exists at all. **STATE.md is deliberately not part of this check.** It is a shared working-copy artefact written by whichever session holds the lock, so under a peer-owned lock STATE.md's `session` field agrees with the lock about the same peer — comparing against it, as the previous version of this step asked you to do in prose, would have "confirmed" exactly the wrong id (#1177 FX1 found the identical trap in `emitEvent()`'s own correlation fill). The binding `--merge` folded in above is therefore already correct; there is no further comparison left to perform before using `$MANIFEST`. Unbound (`{}`) = ENFORCE, the fail-closed direction; a filled binding is provably this session's own, never a foreign one you'd need to catch by hand.

   `--merge` has already done the merging; what follows is WHY the result looks the way it does. **If a value is unavailable the key is OMITTED — never written as `"session_id": ""`.** An empty id is present-but-equal-to-nobody: the legacy warning stays silent while every reader compares it against its own id, finds no match, and treats the manifest as FOREIGN — the one disposition that skips enforcement entirely. `attributionForRecord()` already omits rather than fills (CI runs hold no lock, and an unauthorised process-local mismatch), and `validate-wave-scope.mjs` rejects the empty string outright, so the honest path is also the only one that validates.

   ```json
   {
     "wave": N,
     "role": "<role>",
     "enforcement": "<from Session Config, default: warn>",
     "session_id": "<raw session id from attributionForRecord(); OMIT the key if unavailable>",
     "semantic_session_id": "<semantic_session_id from the same call; OMIT if unavailable>",
     "allowedPaths": ["<from agent specs in session plan>"],
     "blockedCommands": "<derived dynamically from the effective floor∪overlay policy via loadEffectivePolicy (severity: block rules, #972); falls back to legacy 5-element array if no policy resolves>",
     "gates": "<copy of enforcement-gates from Session Config, or omit if unset>"
   }
   ```
   The `gates` field (optional) mirrors `enforcement-gates` from Session Config (#77). When present, hooks check each gate individually via `gate_enabled()`. Missing gate entries default to enabled, preserving default behavior.

   The `wave` field also doubles as the RUNNING-wave signal for readers outside this step's STATE.md `current-wave` (which records the just-completed wave, per step 1 of `3a. Post-Wave: Update STATE.md` above): `scripts/memory-propose.mjs` reads it directly for proposal attribution only when the manifest is bound to the calling session (`semantic_session_id` matches the session's own semantic id); an unbound or foreign manifest is ignored and the reader falls back to `current-wave + 1` (#1166, #1123).

   **What the binding means to a reader.** Three states, and the disposition differs for each. **Absent** = legacy = ENFORCE: a manifest written before #1123 (or by a stale skill body) binds nobody, so it must keep constraining everyone exactly as it did before — this is the only state that preserves the pre-#1123 contract, and `validate-wave-scope.mjs` marks it with one advisory stderr line rather than an error, because § 3.3's pre-union skeleton is itself an unbound manifest. **Own session** = ENFORCE, unchanged. **Foreign session** — `session_id` present (or the legacy `session`, still read for one transition release, #1153 P2) and not this session's id — = ALLOW: `hooks/enforce-scope.mjs` lets the write through and emits `orchestrator.scope.foreign_session_ignored` so the skip is counted rather than silent. A foreign manifest is somebody else's wave plan; it never had authority over this session's writes, and the event is what keeps that visible instead of leaving an allow nothing recorded. (The reader half lives in `hooks/enforce-scope.mjs` — the writer's only obligation is to name itself honestly here.)
2. Validate by piping through `node "$PLUGIN_ROOT/scripts/validate-wave-scope.mjs"` (`$PLUGIN_ROOT` — see "Shell variables used in this section" above). If validation fails (exit 1), fix the JSON based on stderr errors and retry.
3. **`allowedPaths` is COMPUTED from one canonical declaration array — never hand-transcribed (#1020/#1083).** Transcribing either declaration shape or the union by hand produced scope divergences. Globs stay verbatim (`scripts/*.sh`) — the enforcement hook resolves them at check time.

   **3.1 — materialize both declaration shapes once.** Build one JSON array from the session plan, one `{id, files}` record for every agent plus exactly one `coordinator` record for the coordinator's planned direct edits. `files` arrays, their entries and their order are the plan's verbatim declarations. Run from the **project root**, materialize it ONCE and capture the aggregate-sidecar path:

   ```bash
   WAVE_SCOPE_RECORDS='[{"id":"W3-I1","files":["scripts/example.mjs"]},{"id":"coordinator","files":["skills/wave-executor/wave-loop.md"]}]'
   WAVE_SCOPES_SIDECAR="$(
     printf '%s' "$WAVE_SCOPE_RECORDS" | node "$PLUGIN_ROOT/scripts/materialize-wave-scope.mjs" \
       --state-dir "$STATE_DIR" --wave "$WAVE" --warn-missing
   )"
   [ -n "$WAVE_SCOPES_SIDECAR" ] || { echo "materialize-wave-scope produced no sidecar path" >&2; exit 1; }
   ```

   The non-empty check is not decoration. The materializer sends every diagnostic
   to stderr, so a failure leaves `$WAVE_SCOPES_SIDECAR` empty, and an empty path
   is what step 3.2 would then pass to `--assert-disjoint`. That combination used
   to exit 0 with the collision gate never run — the same signal-free-ALLOW shape
   #1083 exists to close. `validate-wave-scope.mjs` now refuses an empty flag
   value as well, so this guard and that refusal are belt and braces.

   `materialize-wave-scope.mjs` validates the COMPLETE input before writing; it writes `<state-dir>/filescopes/wave-<N>/<agent-id>.json` as each bare `files` array first, then writes `<state-dir>/filescopes/wave-<N>.scopes.json` as the unchanged aggregate record array last. Its human stdout is only that final sidecar path, so the command substitution above is the canonical `$WAVE_SCOPES_SIDECAR`. On error, do not continue with a partial declaration set; correct the plan and run the one command again.

   **Check missing-path warnings before dispatch (#1235).** The recipe opts into `--warn-missing`: each absent concrete path is named with its agent on stderr. Relative paths resolve from the current project working directory, never from `$STATE_DIR`. A warning does not fail materialization or alter stdout, declaration bytes, ordering, or session binding. Grants containing `*` or ending in `/` retain their existing glob/prefix meaning and are skipped; `?` and braces remain literal path characters.

   For each file the plan intentionally creates, append **`--new-file PATH`**, repeating the option for multiple files. Each exception must exactly match a path already declared in a `files` array and pass the same path validation. Invalid or undeclared exceptions fail before any scope file is written, even without `--warn-missing`. This explicit declaration suppresses only that path's warning; the materializer never guesses a filename or rewrites a grant. Without `--warn-missing`, existing callers keep their quiet missing-path behavior.

   The per-agent path IS `$AGENT_FILESCOPE_JSON` — the same file `--assert-subset` (#796 below), Grounding Injection (#85), the Learnings-Index (#1014) and File-Scope Injection (#1020) consume. Never write a `$TMPDIR` copy: it degrades to a signal-free allow when an injector cannot find the addressable wave-keyed file. The coordinator's record is materialized as `coordinator.json` and included in the aggregate, so its direct edits are covered by the two checks below.

   > **`<state-dir>/filescopes/` is control state, like `wave-scope.json` itself — never a wave territory.** Step 3.1 necessarily runs before the union exists, so writing these files reports `bash-write-verify: N file(s) changed by a Bash call OUTSIDE the wave's allowedPaths` naming `filescopes/wave-<N>/*.json`. Expected once per wave rollover at this step; it is information, not a scope violation. Never widen `allowedPaths` to silence it — that would grant agents write access to the deconfliction record itself.

   **3.1a — a peer session's declared paths are their OWN record (#1195).** When a reachable peer session runs in this same checkout and has sent a Peer-Scope-Union request (`skills/_shared/parallel-aware-auq.md` § Peer-Scope-Union), carry its complete path list into the record array as exactly ONE record `{"id":"peer-session-<id>","files":[…]}` — `<id>` being the peer's semantic session id. Never merge peer paths into an agent's record: an agent record is a territory ONE agent may write, and a peer's paths are a territory NO agent of this wave may write. Keeping them separate is also what makes the disjointness check meaningful — a peer path colliding with an agent's scope is a real collision that must surface at 3.2, not be laundered by living in that agent's own record. Mechanically, a peer record takes part in `--assert-disjoint` and is EXCLUDED from `--union` (`unionFileScopes`, `scripts/lib/scope-gate.mjs`), so `allowedPaths` never grants a peer's paths to this wave's agents — which is precisely what keeps them a territory no agent may write. It also gets NO per-agent shape-(a) file: `materialize-wave-scope.mjs` writes peer records into the aggregate only, because `$AGENT_FILESCOPE_JSON` is addressed by an agent id at dispatch and no agent is dispatched for a peer session. `hooks/post-bash-write-verify.mjs` reads the same aggregate sidecar and reports a change under a `peer-session-*` record as a peer write instead of a violation — reachable only BECAUSE the union excludes it (the hook sees a path only while it is outside `allowedPaths`).

   The record's lifecycle is the coordinator's: every wave rollover re-materializes it (3.1 rebuilds the whole array, so an omitted peer record silently revokes the union mid-session), and session-end removes it with the rest of `filescopes/` — a peer record outliving its peer grants paths nothing is watching.

   **3.2 — assert disjointness BEFORE computing the union.** The materialized aggregate is an ARRAY of `{id, files}` records (never an object map: a duplicated agent id must stay visible), including `coordinator.json`. Run:

   ```bash
   node "$PLUGIN_ROOT/scripts/validate-wave-scope.mjs" \
     --assert-disjoint "$WAVE_SCOPES_SIDECAR" < <state-dir>/wave-scope.json
   ```

   Exit 1 (one stderr message per collision) means two agents were handed the same file: fix the session plan, re-materialize, re-assert. Never widen the union to make it pass. This runs **before** 3.3 because a union computed over colliding scopes launders the defect into the very artefact meant to prevent it — `allowedPaths` then grants the file and every later gate sees a legal write.

   **3.3 — compute the union.** `--union` is a QUERY MODE that still requires a schema-valid manifest on stdin, so write the skeleton first with `"allowedPaths": []`, then:

   ```bash
   node "$PLUGIN_ROOT/scripts/validate-wave-scope.mjs" \
     --union "$WAVE_SCOPES_SIDECAR" < <state-dir>/wave-scope.json
   ```

   It prints the computed `allowedPaths` array as JSON on stdout **instead of** the manifest echo — one JSON document per run, the flag decides which. Insert that array as `allowedPaths`, then write the final `wave-scope.json`. It already applies the Test-Sibling Expansion below (`expandTestSiblings(unionFileScopes(scopes), { role })`, role read from the manifest), so do not also run the helper by hand.

   **Artifact production, disjointness and union computation are mechanized. Native prompt injection is a separate follow-up.** The materializer creates the durable declarations; the validator proves disjointness and computes the union. It does not install or prove the platform's prompt-injection transport, which remains independently responsible for reading `$AGENT_FILESCOPE_JSON` before dispatch.

   **The `--assert-subset` assertion (#796, below) stays unchanged and keeps running.** It checks a DIFFERENT property — each agent's scope ⊆ the union — and a double assignment is structurally invisible to it: a file claimed twice is a subset twice over. `--assert-disjoint` is an addition, never a replacement.

   **Test-Sibling Expansion (#970):** an `allowedPaths` entry that names a production file but NOT its test sibling makes the wave's own regression test unwritable — the scope guard then mechanically enforces exactly the inconsistency the quality gate exists to catch. Cross-repo evidence, three occurrences in ONE session: a migrations glob without the SQL-test directory (the regression test could not be written); a lone `.actions.ts` file (the wave's cross-tenant security test stayed red); a dead-export deletion whose importing test lay outside every scope (the suite ended red). Do NOT hand-derive the sibling paths — step 3.3's `--union` runs `expandTestSiblings(…, { role })` for you, so the hook, the validator and this prose state one rule.

   The helper is pure (same input → same output, no filesystem writes) and is also surfaced by `scripts/validate-wave-scope.mjs`. **The role decides, inside the helper** — `scripts/lib/scope-gate.mjs` `TEST_SIBLING_EXPANSION_ROLES` is THE list (currently `Impl-Core`, `Impl-Polish` — exactly where the incident occurred), and #5/#6 below describe that gate rather than restating it. Pass the role string; do not pre-filter by role in prose, and do not hand-roll the equivalent `{ enabled: … }`. Matching is trimmed + case-insensitive, so `impl-core` behaves as `Impl-Core`.

   > **Fail-closed:** an ABSENT or unrecognised `role` does **not** expand. Omitting it fails loudly (an agent's write to its own test is blocked, recoverable by one re-union); the opposite default would silently hand a Quality phase-1 simplification agent write access to the suite. `{ enabled: false }` is the unconditional opt-out and `{ enabled: true }` the explicit opt-in — both override the role.

   **It emits a GLOB, never a computed concrete path.** Resolve via the production file's basename, e.g. `foo.mjs` → `tests/**/foo*.test.mjs` — the same form `§ 4. Test-consolidation branch` already uses, stated once. Measured over all **439** tracked production `.mjs` in THIS repo (production = `scripts/**` + `hooks/**` + `skills/**`; tests = a top-level `tests/**` mirror with the `scripts/` prefix dropped): a same-basename test exists somewhere under `tests/` for **375/439 (85.4%)**, whereas a naive 1:1 mirror path resolves for only **272/439 (62.0%)**. So the glob is right ~85% of the time and *harmless* when wrong — it grants write access to a path that may not exist; a computed concrete path would be wrong ~38% of the time **and still deny the real test**. The ~15% residual is real, mostly semantic naming (`scripts/lib/learnings/*.mjs` → `tests/unit/learnings.test.mjs`): when an agent's test sibling does not match the glob, add it by hand to that agent's "Files:" scope in the session plan. This is an 85% default, not a guarantee.

   > Measured at `HEAD=730ee9d`, 2026-08-03, clean-tree, via `git ls-files | grep -E '^(scripts|hooks|skills)/.*\.mjs$'` for the denominator, matched against `git ls-files | grep -E '^tests/.*\.test\.mjs$'` by basename (85.4% figure) and by mirrored path (62.0% figure). Re-measure before citing these downstream — a count re-briefed later is a claim about the past (`.claude/rules/parallel-sessions.md` § PSA-006).

   **The sibling rule is repo-configurable, not a hardcoded layout.** THIS repo has zero `__tests__/` directories and no co-located tests; consumer-repo shapes (`<file>.test.*` beside the source, `<dir>/__tests__/**`, `supabase/migrations/** → supabase/tests/**`) are configured per repo and do not apply here.

   Three ordering constraints, all load-bearing:
   - The deconfliction check (3.2) runs on the DECLARED per-agent scopes, **before** the union expands anything. Named ceiling: two agents whose production files share a basename receive the same emitted sibling glob, which a declared-scope check cannot see — revisit if a wave is ever scoped by basename family instead of by directory.
   - Expand **before** `wave-scope.json` is written, in ONE pass. `hooks/post-bash-write-verify.mjs` fingerprints `allowedPaths` via `scopeSignature()` and fires a control notice on change, so a later mutation reads as tampering.
   - Skip **absolute** entries entirely — expanding a Gate-5b out-of-repo grant would sprout a synthetic `tests/**` sibling outside the repo.

   **Pre-Dispatch Scope-Union Assertion (#796):** `wave-scope.json` is GLOBAL per wave — `hooks/enforce-scope.mjs` Gate 7 checks EVERY agent against the same `allowedPaths` union, so a union that (re)written for only ONE agent silently denies its siblings' legitimate writes. Before each `Agent()` batch, mechanically assert — for EVERY agent in the batch — that its fileScope ⊆ `wave-scope.allowedPaths`. `$AGENT_FILESCOPE_JSON` is that agent's § 3.1 file — `<state-dir>/filescopes/wave-<N>/<agent-id>.json`, already written above and shared with every other consumer. Do not re-write it to a temp path here (§ 3.1 says why that degrades silently); just run:

   ```bash
   node "$PLUGIN_ROOT/scripts/validate-wave-scope.mjs" \
     --assert-subset "$AGENT_FILESCOPE_JSON" --expand-test-siblings \
     < <state-dir>/wave-scope.json
   ```

   `--expand-test-siblings` (#970) is the mechanical half of the Test-Sibling Expansion rule above: it re-derives each agent's siblings and requires the union to grant them, so "the coordinator ran the expansion" stops being a matter of prose compliance. Pass it on **every** batch — the flag is gated on the manifest's own `role` through the same `TEST_SIBLING_EXPANSION_ROLES` predicate the helper uses, so it is a self-announcing no-op (`WARN: … skipped for role "Quality"`) wherever expansion does not fire. Do not add a role condition in the shell; that would put the role list back in prose.

   It only ever ADDS a requirement, so a manifest that passed the plain subset check can now fail — that is the point. On exit 1 (`allowedPaths does not grant the test sibling … missing: [...]`): the union was not produced by `expandTestSiblings`. Re-run the Scope Manifest step, rewrite `wave-scope.json`, re-assert. Do NOT hand-add the missing glob and move on — the next agent in the batch will hit the same gap. (If a legitimate test sibling does not match the emitted glob — the ~15% residual — it belongs in that agent's "Files:" scope in the session plan, which puts it in the union and satisfies the check honestly.)

   On exit 1 (`agent fileScope not ⊆ allowedPaths — missing: [...]`): re-union `allowedPaths` across ALL agents that will be in-flight — **including still-running siblings from this wave** — re-write `wave-scope.json`, then re-run the assertion before dispatching. `allowedPaths` MUST NEVER shrink while sibling agents of the same wave are still running. This applies to EVERY batch — including fix-pass and re-dispatch batches, the incident class that motivated #796 (a fix-pass batch rewrote the union for a single agent and denied a sibling's legitimate writes). The assertion runs uniformly, even for single-agent waves — cost is negligible and the invariant is the same.
4. Read `enforcement` from Session Config (default: `warn`). The `enforcement` field is REQUIRED in `wave-scope.json` — always write it explicitly. The hooks default to `warn` if the field is missing, which would silently degrade strict enforcement. If jq was confirmed missing in Pre-Execution Check step 4, set `enforcement` to `off` and include a comment in the progress update noting that enforcement is disabled.
5. For **Discovery** role waves, set `allowedPaths` to `[]` (empty array) — Discovery agents are read-only and must not modify files. Also add to each Discovery agent prompt: "You are READ-ONLY. Do NOT use Edit or Write tools."
   > **Defense in depth:** The empty `allowedPaths` enforcement hook is the PRIMARY barrier (blocks Write/Edit at the tool level). The prompt instruction is a SECONDARY safeguard. If jq is unavailable (enforcement set to `off`), the prompt instruction becomes the ONLY barrier — log a warning in this case.
   > **Test-sibling expansion (#970) cannot reach here, twice over:** `Discovery` is not in `TEST_SIBLING_EXPANSION_ROLES`, and `expandTestSiblings([], …)` returns `[]` STRUCTURALLY — before any gate, so the empty case holds even for a caller that opts in explicitly. Discovery's deny-all is a contract with its own regression test (`tests/hooks/enforce-scope.test.mjs`, "enforces Discovery-wave deny-all semantics… (issue #256 NO-OP contract)") — nothing may re-populate it.
6. For **Quality** role waves, use two-phase scope enforcement:
   - **Phase 1 (Simplification)**: Before dispatching simplification agents, set `allowedPaths` to the production files changed this session (`git diff --name-only $SESSION_START_REF..HEAD`, excluding test files). After simplification agents complete, **delete** `<state-dir>/wave-scope.json` before proceeding to Phase 2.
     Test-sibling expansion (#970) does not fire here, because `Quality` is not in `TEST_SIBLING_EXPANSION_ROLES` — passing `{ role: 'Quality' }` is enough and no extra opt-out is needed. This phase's scope is production files with tests explicitly excluded, under a "do NOT change functionality" brief — expanding would hand simplification agents write access to the suite, which is the "agent deletes a dead export, then edits the test to match" failure mode. The pre-dispatch `--expand-test-siblings` assertion is gated on the same role and self-announces its skip, so it cannot block this phase either.
   - **Phase 2 (Test/Review)**: Before dispatching test and review agents, regenerate `<state-dir>/wave-scope.json` with `allowedPaths` restricted to test file patterns (`**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, plus test config files). Quality test/review agents must not modify production source code.
     Test-sibling expansion (#970) is **inert** here — the scope is already test patterns. It must never add production paths; the inverse expansion (test → production sibling) does not exist and must not be introduced.

   **Phase transition sequence:**
   1. Compute production file list: `git diff --name-only $SESSION_START_REF..HEAD | grep -v -E '\.(test|spec)\.' | grep -v '__tests__/'`
   2. If no production files → skip Phase 1 entirely, proceed to Phase 2 (write test-only wave-scope.json)
   3. Write Phase 1 wave-scope.json with production file allowedPaths
   4. Dispatch simplification agents, wait for completion
   5. Delete `<state-dir>/wave-scope.json`
   6. Write Phase 2 wave-scope.json with test file allowedPaths (`**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`)
   7. Dispatch test/review agents
7. After the final wave completes, delete `<state-dir>/wave-scope.json` (cleanup). Delete `<state-dir>/filescopes/` in the same step — the per-agent scope files (§ 3.1) are wave-local working state, and a stale `wave-<N>/` directory left behind is a scope claim nobody re-verified.
