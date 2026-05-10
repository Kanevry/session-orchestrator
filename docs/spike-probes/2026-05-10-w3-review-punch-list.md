# W3 Review Punch List — 2026-05-10 Spike Cluster

> Internal session-deliverable. Consolidates findings from C1–C6 reviewers into actionable revisions for W4 docs-writer agents.

## Review-tier summary

- **C1 ADR-364 (analyst):** APPROVE_WITH_REVISIONS, conf 0.85, 0 BLOCK / 6 MUST-FIX
- **C2 ADR-365 (architect-reviewer):** APPROVE_WITH_REVISIONS, conf 0.78, 1 BLOCK / 4 MUST-FIX
- **C3 PRD-366 (analyst):** APPROVE_WITH_REVISIONS, conf 0.82, 1 BLOCK / 8 MUST-FIX
- **C4 PRD-366 (qa-strategist):** 27 gaps; recommends AC17–AC30 (14 new ACs)
- **C5 Cross-spike (security-reviewer):** **2 HIGH (one of them BLOCK), 3 MEDIUM, 1 LOW**
- **C6 Cross-spike consistency (architect-reviewer):** MOSTLY-COHERENT, conf 0.85, 1 BLOCK / 7 MUST-FIX / 1 NICE

---

## D1 — ADR-364 revisions (assignee: docs-writer; file: `docs/adr/2026-05-10-364-remote-agent-substrate.md`)

**MUST-FIX (in priority order):**

1. **Definition of Done for thin-slice MVP** (C1 #1 + C1 #4): add a "Definition of Done" sub-section to §Thin-slice MVP. One observable test per item. Promote Risk #2's unit-test ("kill-switch returns null until sampler exists") into AC for item 3.
2. **Schema-version v1→v2 stance reconciliation** (C6 #1, #2): currently §Thin-slice item 1 declares the bump but Risk #1 defers it. Pick one — recommend Risk #1 wins ("additive-only first; bump in follow-up after all 82 historical entries readable with new validator"). Update item 1 prose to match.
3. **B6 subagent_stop schema gap** (C1 #6): add Open-question: "Should `subagent_stop` events in `events.jsonl` be enriched with `session_id` + `wave` + `agent_identity` as part of this thin slice, or deferred to PRD-366's `failures.jsonl` work?" Cite proofs.md probe 4 finding #3.
4. **Narrow spike open-questions** (C1 #1, #2): rewrite quota-visibility spike to specific 3 providers (`{Anthropic Admin API, OpenAI usage endpoint, OpenRouter /api/v1/auth/key}`). Add ordering: "quota-probe spike MUST land before cost-cap spike."
5. **Replace "one quiet release cycle"** (C1 #5): in Risk #5 mitigation, replace with measurable threshold: "after the helper has logged zero would-have-rejected warnings across N≥3 deep sessions in `events.jsonl`, OR after 30 days, whichever is later."
6. **Stall-timeout output destination** (C6 #3): add one sentence to §Thin-slice item 3: stall-timeout fires write to `autopilot.jsonl` (telemetry) — NOT `failures.jsonl` (which is owned by #366 per cross-connections rule 4).
7. **Kill-switch value convention** (C6 finding 7 / NICE in #2): add explicit value to thin-slice item 3 — `STALL_TIMEOUT: 'stall-timeout'` (mirrors existing convention).
8. **Cross-reference rule** (C1 #9 NICE): add `Schema-bump ownership coordinated with sibling spikes per docs/adr/2026-05-10-spike-cluster-cross-connections.md rule #2` to §Sources.

**NICE (add if time, otherwise leave):**
- Risk #5 dependency on #341: add note that the helper has zero call-sites and risks bit-rot if #341 deprioritizes; mitigation = include in dead-code lint detection.

---

## D2 — ADR-365 revisions (file: `docs/adr/2026-05-10-365-mcp-tool-adapter-debug.md`)

**BLOCK + MUST-FIX:**

1. **[BLOCK] B6 abstraction-leak findings as new standards** (C2 BLOCK): add MCP-DBG-12 + MCP-DBG-13:
   - **MCP-DBG-12:** "Health checks MUST use `inspect server-info` (not `ping`) until our MCP server upgrades past protocol `2024-11-05`."
   - **MCP-DBG-13:** "Scripted `--quiet` consumers MUST redirect stderr (`2>/dev/null`) and tolerate non-JSON warnings on stdout until upstream fixes the stream split."
2. **Fix MCP-DBG-9 CI gate** (C2 MUST-FIX #1): rewrite as `npx reloaderoo inspect list-tools --quiet -- bash scripts/mcp-server.sh 2>/dev/null | grep -v "^Error:" | jq -e '.tools | length > 0'` — verified pipeline that survives the `--quiet` quirk.
3. **MCP-DBG-3 demotion or OQ-6 resolution** (C2 MUST-FIX #2): demote MCP-DBG-3 to a "Future Standards" annex until OQ-6 resolves whether tool-invocations live in events.jsonl or a new file. Don't standardize an undecided path.
4. **Reloaderoo version pin + fork plan** (C2 MUST-FIX #3, also C5 MEDIUM #4):
   - Add MCP-DBG-14: "Pin reloaderoo to `~1.1.5` in skills/mcp-debug/SKILL.md examples and CI invocations. Bump intentionally with re-validation pass against MCP-DBG-1..14."
   - Add to §Risks R3 mitigation: concrete fork-or-swap runbook (`@modelcontextprotocol/inspector` CLI mode as fallback target).
   - For CI usage: add `reloaderoo` as `devDependencies` with exact pin so `pnpm-lock.yaml` governs (C5 mitigation).
5. **Cross-spike #364 reciprocation** (C2 MUST-FIX #4, also C6 finding 5): add §Cross-references section: "The proposed `scripts/lib/tool-adapter.mjs` (Decision §3) is the single seam for both local-direct and managed-agent → MCP tool calls. Per ADR-364, managed-agent dispatchers MUST route through this adapter, not invent a parallel one."
6. **mcp-debug Session Config block decision** (C6 finding 5): either (a) add a `mcp-debug:` config block (e.g., `timeout-overrides`, `default-version: ~1.1.5`), or (b) note in ADR-365 that no Session Config keys are introduced and ask cross-connections doc (D4) to drop the `mcp-debug.*` ownership claim. Recommend (b) — keep ADR-365 docs-only.

**NICE:**
- Vocabulary: rename §Decision 3 "Tool-adapter abstraction" → "Tool-adapter seam" (LANGUAGE.md vocabulary).
- Resolve OpenQ-1 (default-on proxy in dev) — recommend "opt-in via `SESSION_ORCH_MCP_PROXY=1`, never default-on."
- Add scope statement at top of §Standards: "These rules cover MCP **tools**. Resource and prompt debug standards are deferred."

---

## D3 — PRD-366 revisions (file: `docs/prd/2026-05-10-366-stop-hook-verification-loop.md`) — **LARGEST REVISION**

**[BLOCK / SECURITY]:**

1. **[CRITICAL — C5 HIGH-#1] Replace `spawnSync('sh', ['-c', cmd])` with `execFile`-with-allowlist:**
   - Update §Architecture step 4: do NOT use `sh -c`. Parse `verification.command` as `[binary, ...args]`. Validate `binary` against an allowlist (`npm`, `npx`, `node`, `pnpm`, `vitest`, project-local `./scripts/*`). Call `spawnSync(binary, args, { cwd, stdio })` with `shell: false`.
   - Update Session Config schema: `verification.command` becomes either a string parsed by a Zod transform that splits on whitespace (with quoting awareness) OR an array `[binary, ...args]` (recommended — no shell parsing ambiguity).
   - Update Zod validator: reject any `command[0]` not in the allowlist. Reject any element containing shell metacharacters (`$`, `` ` ``, `|`, `;`, `&&`, `||`, `>`, `<`).
   - Add new AC: "command with shell metacharacter is rejected by Zod with `fail_reason: 'config-validation-error'`."
2. **[CRITICAL — C5 HIGH-#2] Correct the "pre-bash destructive guard is second-line" claim** (Risks R-CR-3 in PRD): the existing guard fires only on `Bash` tool calls, NOT on hook-internal `spawnSync`. Update R-CR-3 mitigation to remove this layer; replace with the execFile-allowlist approach (HIGH-#1 fix). The Zod validator IS the only line of defense; document it as such.

**[BLOCK / DESIGN]:**

3. **AC15 vs YAML schema mismatch** (C3 BLOCK): move AC15 entirely to Phase 2 OR add `use-json-decision: false` to Session Config schema + verification-config.mjs allowed-key list. Recommend: move to Phase 2 (simpler, smaller Phase 1).

**MUST-FIX (incorporate per priority):**

4. **B6 subagent_stop session_id+wave linkage** (C3 MUST-FIX #2): add AC10b: "failures.jsonl record from a SubagentStop verification failure has non-null `session_id` (resolved via `resolveSessionId()`) and non-zero `wave` (resolved via `readWaveNumber()`)." State in §Hooks integration that SubagentStop reuses these resolvers.
5. **B6 duration_ms != 0** (C3 MUST-FIX): add AC2b: "verification_duration_ms > 0 (computed via Date.now() delta around spawnSync, not from input.start_ms)." Update §Hooks integration step 2.
6. **B6 empty-stderr guidance** (C3 MUST-FIX): add to §Session Config additions a SHOULD note: "verification.command SHOULD produce actionable stderr on failure. Builtins like `false`/`test` provide no diagnostic; recommended: `npm test -- --reporter verbose` or equivalent."
7. **AC4 split into AC4a–AC4d** (C3 MUST-FIX #6): split the compound AC. AC4d is load-bearing — assert no spawn occurred via mock spawn-counter spy.
8. **AC7 verification-spend trigger source** (C3 MUST-FIX #7): specify the source. Recommend: per-failed-iteration counter at `.orchestrator/metrics/verification-spend.json`, with `estimated_token_cost: 1500` configurable. Add this file to Phase 1 NEW list.
9. **AC16 `destructive-command-blocked` enum value** (C3 MUST-FIX, C6 #4): add to closed `fail_reason` enum, OR reclassify under `permission-denied`. Recommend: ADD as 6th value.
10. **Rollback plan section** (C3 MUST-FIX #8): add new §Rollback section: (i) flip `verification.enabled: false` — takes effect on next Stop event (config re-read per invocation); (ii) revert hooks.json timeout via `git revert <commit>`; (iii) in-flight failures.jsonl entries kept (append-only safe).
11. **Phase 1 sizing honest revision** (C3 MUST-FIX #9): change appetite from "1 week" to "1.5–2 weeks" (Medium Batch per `.claude/rules/mvp-scope.md`). Justification: NEW verification-spend.json file + SubagentStop resolver reuse + 14 additional ACs from C4.
12. **hooks.json ownership** (C6 BLOCK #7): explicitly state in Phase 1 §Hooks integration: "Phase 1 bumps the uniform Stop+SubagentStop timeout from 5s to 65s. This is compatible with #365's deferred per-matcher schema extension (additive). Cross-connections doc D4 must reflect this." Update cross-connections in D4 simultaneously.
13. **AC15 + Open Q5 dedup** (C3 MUST-FIX #2): once AC15 is moved to Phase 2 per fix #3, OQ5 alone tracks the question.

**C4 NEW ACs (AC17–AC30, copy-paste ready from C4 review):** add all 14 new ACs to PRD's §Acceptance Criteria. They cover:
- AC17: stop_hook_active type-juggling (8 cases)
- AC18: invalid JSON stdin
- AC19: concurrent failures.jsonl atomic-append (10-way stress)
- AC20: failures.jsonl missing/corrupt resilience
- AC21: disk-full / EACCES on write
- AC22: stderr binary/non-UTF8
- AC23: stderr byte-cap (32 KB)
- AC24: SIGKILL → fail_reason mapping
- AC25: detached subprocess timeout
- AC26: hooks.json timeout vs wall-time validator
- AC27: disabled-mode preserves deregisterSelf + webhook
- AC28: VERIFICATION_BUDGET counter is per-session (not global, not per-iteration)
- AC29: unknown-key strict rejection (Zod `.strict()`)
- AC30: schema_version forward-compat

**Final AC count after revision:** 16 (existing) − 1 (AC15 → Phase 2) + 1 (AC2b) + 1 (AC10b) + 1 (config-validation-error) + 14 (C4 new) = **32 ACs**.

---

## D4 — Cross-connections doc revisions (file: `docs/adr/2026-05-10-spike-cluster-cross-connections.md`)

**MUST-FIX:**

1. **Schema-version stance** (C6 #1, #2): align rule 2 with ADR-364's revised language ("additive-only fields, version stays at v1 until field becomes required").
2. **hooks.json ownership** (C6 BLOCK #7): update shared-design table — `#366 EXTEND` (timeout 5→65) is correct; remove the "—" entry. Both #365 (deferred per-matcher) and #366 (uniform bump) modify the same file with non-overlapping additive changes.
3. **§rule 1 wording** (C6 finding 5, 6, 8): rewrite the rule. Current: "Session Config additions MUST nest under spike-named keys." Revised: "Spike-introduced **Session Config keys** MUST nest under spike-named blocks (`verification.*`); spike-introduced **schema fields** on existing JSONL records may use unprefixed names (`agent_identity`, `worktree_path`). Cross-connections does NOT mandate that every spike introduce a Session Config block — ADR-365 introduces none, ADR-364 introduces none, PRD-366 introduces `verification.*`."
4. **Drop `mcp-debug.*` and `agent-identity.*` ownership claims** (C6 #5, #6): since neither ADR introduces a config block, remove these from §Conflict-avoidance rules. Only `verification.*` (PRD-366) remains.
5. **Hoist events.jsonl retention** (C6 #9): add to top of cross-connections as a single cluster-level open question with a single owner (recommend: deferred to a separate housekeeping issue, not this cluster).
6. **Sequencing dependency note**: add explicit sentence: "PRD-366's hooks.json timeout bump (uniform 5→65) lands AS-IS in Phase 1; ADR-365's deferred per-matcher timeout schema extension layers on top in a separate follow-up."

---

## D5 — Risks doc revisions (file: `docs/adr/2026-05-10-spike-cluster-risks.md`)

**MUST-FIX:**

1. **Add R-CR-4** (escalate C5 HIGH-#1): "Arbitrary command execution via `verification.command` in untrusted Session Config" — severity critical, likelihood high without execFile-allowlist mitigation, owning files: `scripts/lib/verification-config.mjs` (Zod validator) + `hooks/on-stop.mjs` (execFile usage).
2. **Update R-CR-3 mitigations** (C5 HIGH-#2): remove "pre-bash destructive guard is second-line defense" — that claim is architecturally false (the guard only fires on Bash tool calls, not on hook-internal spawnSync). Replace with: Zod validator IS first AND only line of defense; documentation MUST emphasize this.
3. **Add R-M-7** (C6 gap 1): latent path-traversal in `worktree.mjs` callers (from ADR-364 Risk #5).
4. **Add R-L-6** (C6 gap 2): MCP version drift (ADR-365 R2).
5. **Add R-L-7** (C6 gap 3): per-hook timeout 30s latency tail (ADR-365 R4).
6. **Update R-H-4 mitigation** (C5 MEDIUM #4): "Pin reloaderoo to specific semver. Add `devDependencies` entry with exact pin so pnpm-lock.yaml governs CI usage."
7. **Add R-M-8**: world-readable control directory (C5 MEDIUM #5) — mitigation: explicit `chmod 0o700` on dir creation, `chmod 0o600` on files.
8. **Add R-L-8**: agent_identity has no auth (C5 LOW #6) — mitigation: document as observability label, never authorization.

---

## D6 — CLAUDE.md alias-fix + regression test (NOT docs-writer; code-implementer)

**Files:**
- `CLAUDE.md` — fix line 57: rephrase "Reconstructed entry from commit `68e5e75` + CLAUDE.md narrative + git stat" → use the alias-aware phrase: "Reconstructed entry from commit `68e5e75` + CLAUDE.md (or `AGENTS.md` on Codex CLI) narrative + git stat" (single-instance — the doc-consistency rule will accept this).
- (optional, if test-writer time permits): `tests/scripts/check-doc-consistency-alias-rule.test.mjs` — NEW unit-fixture test covering the regex rule itself: feed the script a fixture with a bare `CLAUDE.md narrative` and assert it detects the drift; feed the script a fixture with `CLAUDE.md (or AGENTS.md on Codex CLI) narrative` and assert clean.

**AC:** `bash scripts/check-doc-consistency.sh` exits 0 with `=> 0 findings (clean)`. The existing `tests/scripts/check-doc-consistency.test.mjs` passes.
