# Cross-Spike Risk Register — 2026-05-10 Cluster

- **Date:** 2026-05-10
- **Spikes covered:** #364 (remote agent-session substrate) · #365 (MCP/tool-adapter inspection + hot-reload) · #366 (bounded stop-hook verification loop)
- **Author:** session main-2026-05-10-deep-1 W2 B5
- **Status:** review-feed for W3 reviewers (analyst, security-reviewer, qa-strategist)

This register consolidates the inline "Risks" sub-bullets from `docs/spike-probes/2026-05-10-w1-research-context.md` (sections A1–A6) and re-frames them against our existing risk-discipline in `.claude/rules/security.md` (SEC-001 ff.) and `.claude/rules/parallel-sessions.md` (PSA-001/002/003). Source citations refer to the W1 research file unless otherwise noted.

## Risk classification

Each risk is graded on three axes:

- **Severity** — `critical` (data loss, runaway cost, destructive ops) · `high` (silent failure, schema drift, reviewer-load) · `medium` (DX friction, false positives) · `low` (cosmetic, latent).
- **Likelihood** — `high` / `med` / `low` given current code state and proposed change.
- **Detection** — `auto` (unit test or CI gate flags it), `manual` (human review only), `none` (no surface signal until impact).

A risk is **critical** if at least one of severity-high, likelihood-med, detection-none holds; reviewers should treat the matrix as a tripwire, not a checklist.

## Critical risks

### R-CR-1: Stop-hook infinite loop (#366)

- **Severity:** critical
- **Likelihood:** high if `stop_hook_active` guard missing
- **Detection:** automatic (events.jsonl shows repeated Stop events for same `session_id` within seconds; autopilot SPIRAL kill-switch fires on second cycle)
- **Mitigation (3 layers):**
  1. **Mandatory line-1 guard** in `hooks/on-stop.mjs`: read `stop_hook_active` from JSON payload and `process.exit(0)` if true. This is non-negotiable per the Anthropic Stop hook contract (A5: *"if true, you're in a forced-continuation already; MUST exit 0 to break the loop"*).
  2. **Vitest enforcement:** add `tests/hooks/on-stop.test.mjs` with a property test — hook called 100× with `stop_hook_active: true` MUST always exit 0 with no stderr `block` reason. Floor/ceiling per `test-quality.md` Dynamic Artifact Counts carve-out does NOT apply; this is a binary contract.
  3. **Autopilot SPIRAL kill-switch** (`scripts/lib/autopilot/kill-switches.mjs`) caps post-session re-entry attempts at 2 — third Stop→continuation triggers session abort with evidence dump.
- **Escalation:** if all three layers fail in production, operator can disable verification via Session Config: `verification.enabled: false`. This bypasses the loop entirely. The Session Config schema MUST default to `enabled: false` for the first release; opt-in only after one clean RUN cohort.

### R-CR-2: Runaway token consumption (#366 verification + #364 multi-story)

- **Severity:** critical
- **Likelihood:** medium without explicit cap; high under combined verification + multi-story dispatch
- **Detection:** automatic via TOKEN_BUDGET_EXCEEDED kill-switch (#355, already shipped) plus a NEW `VERIFICATION_BUDGET_EXCEEDED` switch that fires before the parent budget cascade
- **Mitigation (3 layers):**
  1. **Per-loop token cap:** new Session Config `verification.token-budget-extra` defaults to `0.20` (20% headroom on top of the autopilot baseline; matches the community-measured 10–20% verification overhead in A5).
  2. **VERIFICATION_BUDGET_EXCEEDED kill-switch** (NEW; `scripts/lib/autopilot/kill-switches.mjs`) fires *before* the existing TOKEN_BUDGET_EXCEEDED, so verification overruns are attributable rather than masked as autopilot exhaustion.
  3. **Per-#364 multi-story:** `multi-story-concurrency: 2` static cap (Symphony A3 pattern) plus a hybrid resource-probe veto on `priority:critical` issues. Concurrent verification loops × multi-story dispatch is the worst-case multiplier; the static cap is the hard ceiling.
- **Escalation:** every overrun is appended to `.orchestrator/metrics/failures.jsonl` for confidence calibration (#297 data-gated). Once ≥10 RUNS show stable median verification cost, the default headroom can be re-tuned. Until then, fail-fast > fail-cheap.

### R-CR-3: Destructive verification commands (#366)

- **Severity:** critical
- **Likelihood:** medium (operator can configure `verification-command: rm -rf node_modules && npm test` thinking it's "clean")
- **Detection:** automatic via Session Config Zod schema validation (rejects on load). **Note:** the pre-bash destructive-command guard (`hooks/pre-bash-destructive-guard.mjs`) does NOT cover this path — it fires on Bash *tool* calls only, not on hook-internal `spawnSync`/`execFile`. The Zod validator IS first AND only line of defense.
- **Mitigation (3 layers):**
  1. **Documentation rule** in `docs/session-config-reference.md`: verification commands MUST be idempotent and read-mostly. Citing `parallel-sessions.md` PSA-003 — *"Did I create this file/commit/change? If not, it is not mine to touch."* — verification runs inside a shared workspace and inherits PSA-003 destructive-action safeguards. **MUST emphasize that the pre-bash destructive guard does NOT protect this code path** (hook-internal spawn bypasses the Bash-tool guard surface).
  2. **Zod schema validation** in `scripts/lib/verification-config.mjs` (NEW; mirrors `scripts/lib/owner-yaml.mjs` pattern from `owner-persona.md`) rejects known-dangerous patterns at config load: `git reset`, `git push --force`, `rm -rf`, `npm publish`, `git checkout --`, `git clean -f`, `> ` redirects to tracked files. Reuse the regex set from `.orchestrator/policy/blocked-commands.json` rather than re-inventing. **This is the only enforcement gate — there is no second line of defense.**
  3. **Sandbox option** for genuinely destructive proof commands: `verification.sandbox: worktree` runs the command inside a per-iteration `git worktree` (A5 mitigation). Default `none` so the safe path is the loud one.
- **Escalation:** if the Zod validator regresses, there is NO architectural fallback covering hook-internal spawn. Treat any change to `scripts/lib/verification-config.mjs` as security-critical. Pair with R-CR-4 (execFile-allowlist) which adds a complementary gate at the *execution* boundary rather than the config-load boundary.

### R-CR-4: Arbitrary command execution via `verification.command` (#366)

- **Severity:** critical
- **Likelihood:** high without execFile-allowlist mitigation (any string fed to `spawnSync('sh', ['-c', cmd])` is full shell-injection surface)
- **Detection:** automatic via Zod schema validator with binary allowlist + shell-metacharacter rejection at config-load time; complemented by `execFile`-with-`shell: false` at execution time (no shell parsing means no injection vector even if validator regresses)
- **Mitigation (3 layers):**
  1. **Zod validator with binary allowlist + shell-metacharacter rejection** in `scripts/lib/verification-config.mjs`: `verification.command` is an array `[binary, ...args]` (recommended) or a string parsed via whitespace-aware Zod transform. Reject any `command[0]` not in the allowlist (`npm`, `npx`, `node`, `pnpm`, `vitest`, project-local `./scripts/*`). Reject any element containing shell metacharacters (`$`, `` ` ``, `|`, `;`, `&&`, `||`, `>`, `<`, newline). Failure surfaces as `fail_reason: 'config-validation-error'`.
  2. **`execFile(bin, args, { shell: false })`** in `hooks/on-stop.mjs`: replace any `spawnSync('sh', ['-c', cmd])` with `execFile(binary, args, { cwd, stdio, shell: false, timeout: ... })`. With `shell: false`, the OS execve() call takes binary + argv directly — there is no shell to interpret metacharacters even if the validator misses one. This is the architectural backstop.
  3. **AC asserts shell-metacharacter rejection at config-validation time:** add a vitest test that feeds the Zod validator each metacharacter (`$`, `` ` ``, `|`, `;`, `&&`, `||`, `>`, `<`) embedded in command args and asserts rejection with `fail_reason: 'config-validation-error'`. This is a binary contract — re-runs floor/ceiling do NOT apply.
- **Escalation:** if both the validator and `shell: false` are bypassed (e.g. operator force-pushes a malicious config + somehow re-introduces `sh -c`), the system has no further architectural defense. The pre-bash destructive guard does NOT fire on hook-internal spawn (see R-CR-3 note). Treat any PR touching `scripts/lib/verification-config.mjs` OR `hooks/on-stop.mjs` spawn invocation as security-reviewer-required.

## High risks

### R-H-1: Schema-drift in sessions.jsonl (#364)

- **Severity:** high
- **Likelihood:** med
- **Detection:** automatic (`scripts/lib/validate/check-session-schema.mjs` runs in CI; flags missing required fields and unknown fields)
- **Mitigation:** A6 documents the v1 schema (82 entries). Phase D extensions (`agent_identity`, `worktree_path`, `parent_run_id`, `stall_recovery_count`) MUST be **additive-only**: new fields default to `null` or `undefined`; existing readers tolerate missing fields. Bump `schema_version: 2` only when a field becomes required. Run the existing migrate-cli pattern (#305) for any non-additive change. Cite `backend-data.md` Migration Patterns: *"Always write reversible migrations."*
- **Escalation:** if a reader breaks, fall back to `schema_version: 1` reads with explicit nullability handling for the new fields. Never strip unknown fields on write — preserves forward-compat for in-flight sessions.

### R-H-2: MCP tool name collisions (#365)

- **Severity:** high
- **Likelihood:** med (two MCP servers exposing `list_items` with different semantics is plausible once the catalogue grows past one server)
- **Detection:** automatic via a new `.mcp.json` validation step in `scripts/validate-plugin.mjs` (currently 27 checks; this becomes 28). Unique-name check across all registered servers.
- **Mitigation:** enforce the prefix-by-server convention `mcp__<server>__<tool>` already used in `hooks/hooks.json:24–46` (A6). Document in `skills/mcp-builder/SKILL.md` as a hard rule, not a recommendation. Collision fails plugin-validation at install time. The `scripts/lib/tool-adapter.mjs` abstraction (#365 deliverable) is the natural enforcement point — but see R-M-3 for premature-abstraction risk.
- **Escalation:** if a third-party MCP server violates the convention, `tool-adapter.mjs` injects the prefix at registration time (best-effort) and logs a warning to `events.jsonl`.

### R-H-3: Worktree disk fill (#364)

- **Severity:** high
- **Likelihood:** med under multi-story dispatch + crashed waves
- **Detection:** automatic — `df` check at session-start fires a warning at 80% and blocks at 95% (mirrors the resource-overload kill-switch pattern in `scripts/lib/autopilot/kill-switches.mjs`)
- **Mitigation:** new `scripts/gc-stale-worktrees.mjs` cron (analogous to coordinator-snapshot GC at session-end Phase 3.4a, A6). 14-day retention parallel to snapshot GC. Symphony A3 Risks bullet — *"cleanup failures → disk fill"* — is the explicit driver. Multi-story dispatch with `multi-story-concurrency: 2` (R-CR-2 cap) bounds the steady-state worktree count at 2; cleanup failures are the only growth vector.
- **Escalation:** if disk hits 95% mid-session, autopilot RESOURCE_OVERLOAD kill-switch (existing) aborts before next wave. Manual cleanup via `git worktree prune` + `scripts/gc-stale-worktrees.mjs --force`.

### R-H-4: Reloaderoo upstream abandonment (#365)

- **Severity:** high
- **Likelihood:** low (MIT, mature, no peer deps per A4) but consequence is wide
- **Detection:** manual — quarterly upstream-health sweep (last-publish, open-issue ratio, security advisories)
- **Mitigation:** the ADR for #365 commits us to `pnpm exec reloaderoo` as the canonical inspect/proxy tool. Guard rails:
  1. **Pin to specific semver in `devDependencies`** (e.g. `"reloaderoo": "1.1.5"` — exact pin, no caret) so `pnpm-lock.yaml` governs CI usage and bumps are intentional. CI invocations use `pnpm exec reloaderoo` (NOT `npx reloaderoo`, which would re-resolve from the registry on every run and bypass the lockfile guarantee).
  2. **Bump intentionally with re-validation pass** against MCP-DBG-1..14 standards (defined in ADR-365) so a breaking upstream change cannot land without a deliberate review.
  3. **Documented fallback** to manual MCP inspect via raw stdio JSON-RPC (the protocol reloaderoo wraps; no other dependency required) — A4 confirms reloaderoo's CLI is a thin shell over the MCP spec.
  4. **Quarterly sweep** added to vault staleness checks (`vault-staleness` config in CLAUDE.md is already opt-in; extend the probe set when enabled).
- **Escalation:** if upstream goes stale, vendor a fork into `scripts/lib/mcp-inspect/` (A4 Adoption Tier 2 — adapt). Defer until needed; do not pre-vendor.

## Medium risks

### R-M-1: Stale PID detection cross-platform (#364)

- **Severity:** medium · **Likelihood:** med · **Detection:** manual (failure surfaces as ghost-lock at session-start)
- `scripts/lib/session-lock.mjs:1-92` (A6) uses PID liveness for stale-lock detection. macOS / Linux behave; Windows-via-WSL2 has known `kill -0` quirks under cross-FS PID translation. Mitigation: Linux-only support is the current contract (CLAUDE.md "Stack: Node 20+"); document explicitly in lock-mjs header. Escalation: AUQ at session-start to "force-release stale lock" (existing flow).

### R-M-2: Verification command timeout race (#366)

- **Severity:** medium · **Likelihood:** med · **Detection:** auto (vitest test runs verification with 1ms timeout, asserts graceful failure)
- 60s default (Anthropic ceiling per A5) is fine on the dev box; flaky on slow CI runners. Mitigation: per-command override `verification.timeout-ms`; default 60000 but documented escalation to 120000 for known-slow suites. Pair with A5 mitigation: *"Run 2× and surface flake evidence"* — re-run on timeout exactly once before marking failed.

### R-M-3: Tool-adapter abstraction premature (#365)

- **Severity:** medium · **Likelihood:** med · **Detection:** manual (review surfaces it as YAGNI)
- A6 notes `scripts/lib/tool-adapter.mjs` does NOT exist. The temptation in #365 is to ship the abstraction *and* the reloaderoo recommendation in one wave. Mitigation: defer the adapter to phase 2; document the seam in the ADR but ship only the reloaderoo `npx` recommendation + `mcp-builder` skill update in phase 1. Escalation: if a second consumer materialises (#341 Phase D multi-story dispatch needing per-story MCP routing), promote the abstraction with concrete shape.

### R-M-4: failures.jsonl unbounded growth (#366)

- **Severity:** medium · **Likelihood:** high (matches the existing events.jsonl gap noted in A6 cross-cutting #1: 86K entries already, no retention policy)
- Mitigation: GC policy in PRD phase 2, mirroring autopilot.jsonl rotation. Until then, `wc -l` check in session-start fires a warning at 100K. Escalation: manual rotation via `mv failures.jsonl failures.jsonl.$(date +%Y%m%d)` is acceptable interim.

### R-M-5: Per-loop dispatch fairness (#364 Phase D)

- **Severity:** medium · **Likelihood:** med · **Detection:** manual (low-priority issues showing 0 dispatch over 30 days = starvation)
- Multi-story dispatch with naive priority-only scheduling starves low-priority issues if highest-priority is also slowest. Mitigation: hybrid scheduling (priority weight + age-since-last-dispatch); document in #341 PRD. Escalation: per-issue `--force-dispatch` operator override.

### R-M-6: Verification false-positive on flaky tests (#366)

- **Severity:** medium · **Likelihood:** med · **Detection:** auto (re-run rate metric in `failures.jsonl`)
- A5 mitigation: run 2× and surface flake evidence. If the second run passes, mark `verification.status: flake-recovered` rather than `passed` so the calibration data (#297) sees the signal.

### R-M-7: Latent path-traversal in `worktree.mjs` callers (#364)

- **Severity:** medium · **Likelihood:** med · **Detection:** manual (review-only; surfaces as out-of-tree write or read on adversarial `worktree_path` input)
- ADR-364 Risk #5 documents that `scripts/lib/worktree.mjs` accepts caller-supplied path fragments (story-id, agent-identity) that are joined into the worktree root. If a caller passes `../../etc/passwd` or a symlink-bearing fragment, the join produces an out-of-tree path. The current callers are trusted (session-internal), but Phase D multi-story dispatch widens the surface to per-story dispatchers that may originate from less-vetted code paths.
- **Mitigation:** add a `validateWorktreeFragment(fragment)` helper at the lifecycle boundary (`scripts/lib/worktree/lifecycle.mjs`) that rejects `..`, absolute paths, and any fragment containing path separators or NUL bytes. Use `path.resolve(root, fragment)` followed by `path.startsWith(root + path.sep)` containment check. Add a unit test asserting traversal attempts are rejected with `WorktreeFragmentError`.
- **Escalation:** if a Phase D dispatcher needs to address a worktree by absolute path (e.g. for cross-story coordination), require an explicit `allowAbsolute: true` opt-in flag with audit logging to `events.jsonl`.

### R-M-8: World-readable control directory (#364)

- **Severity:** medium · **Likelihood:** med (default umask 0022 on macOS/Linux creates 0755 dirs and 0644 files — readable by any local user)
- **Detection:** manual (security-review-only; no automated check today). C5 MEDIUM #5 finding.
- The control directory `~/.session-orchestrator/control/<sessionId>/` will hold per-session control sockets and metadata for the Phase D agent substrate. Default file-mode permissions allow any local user on a shared host (CI runner, dev workstation with multiple accounts) to read session metadata, including potentially sensitive prompt context or agent-identity tokens.
- **Mitigation:** explicit `chmod 0o700` on directory creation and `chmod 0o600` on every file written. Use `fs.mkdir(path, { mode: 0o700, recursive: true })` and `fs.writeFile(path, data, { mode: 0o600 })`. Add a startup self-check that `stat`s the control directory and refuses to proceed if mode is not `0700` (defense against `umask` drift or operator override).
- **Escalation:** on shared CI runners, additionally namespace by UID (`~/.session-orchestrator/control/uid-<euid>/<sessionId>/`) so a path-prediction attack across tenants requires UID collision (effectively impossible). Document in `infrastructure.md` deploy section.

## Low risks

- **R-L-1:** Session-record `agent_identity` field name conflict with existing `agent_summary.complete|partial|failed|spiral` — namespace under `extensions.agent_identity` to avoid root-level collision.
- **R-L-2:** Reloaderoo `--max-restarts` default unclear (A4 Open Q). Pin explicitly in skill docs (`--max-restarts 5`) so behaviour is reproducible.
- **R-L-3:** Hook timeout 5s (A6 cross-cutting #2) too tight for reloaderoo proxy mode introspection. Bump to 15s for `mcp-debug` matchers only — narrow scope.
- **R-L-4:** Mission-status enum gap (A6 cross-cutting #4) — document the mapping in a follow-up issue; not blocking for this cluster.
- **R-L-5:** Manual schema refresh in Claude Code on capability change (A4 known limitation). Document in skill notes; no code workaround needed.
- **R-L-6:** MCP version drift (#365) — the MCP protocol version pinned in `hooks/hooks.json` and the version negotiated by `reloaderoo` at runtime can diverge silently if a client upgrade lands without a hooks-config bump. Mitigation: at session-start, log the negotiated MCP protocol version to `events.jsonl` and emit a warning if it differs from the pinned-config value. ADR-365 R2 documents this as a "low-likelihood, slow-burn" failure mode — the warning surfaces drift before behaviour breaks.
- **R-L-7:** Per-hook timeout 30s latency tail (#365) — ADR-365 R4 notes that a 30s per-hook timeout (proposed for `mcp-debug` matchers) creates a long tail under MCP-server warm-up scenarios. Mitigation: instrument `events.jsonl` with `hook_duration_ms` per invocation; surface p95/p99 in the existing CI test-quality dashboard so latency drift becomes observable. No action required at config time — observability is sufficient until p95 crosses 5s.
- **R-L-8:** `agent_identity` schema field has no auth (#364 Phase D) — the field is an *observability label*, not an *authorization claim*. Any caller can set any string. Mitigation: document explicitly in the schema header (`scripts/lib/session-schema/constants.mjs` and `docs/adr/2026-05-10-364-remote-agent-substrate.md`) that `agent_identity` is for telemetry/correlation only — never for authorization decisions. If Phase D requires authz, bind identity via HMAC (signed token from a session-issuer) and validate at the dispatch boundary; do NOT trust the raw `agent_identity` field. Add a lint rule (or grep-based CI check) flagging any code path that reads `agent_identity` and branches on its value as suspect.
- **R-L-9:** `events.jsonl` and `failures.jsonl` written from multiple processes — atomic-append is filesystem-dependent. Mitigation: use the existing `scripts/lib/io.mjs` `appendJsonl()` helper which already handles atomicity.

## Risk-mitigation matrix (cross-cutting)

| Risk | Owning file(s) | Mitigation type |
|------|----------------|------------------|
| R-CR-1 | `hooks/on-stop.mjs` + `tests/hooks/on-stop.test.mjs` + `scripts/lib/autopilot/kill-switches.mjs` | code + test |
| R-CR-2 | `scripts/lib/autopilot/kill-switches.mjs` + `scripts/lib/verification-config.mjs` (NEW) + Session Config | code + config |
| R-CR-3 | `docs/session-config-reference.md` + `scripts/lib/verification-config.mjs` (NEW Zod) | docs + validation (NOTE: pre-bash guard does NOT cover this path) |
| R-CR-4 | `scripts/lib/verification-config.mjs` (NEW Zod allowlist) + `hooks/on-stop.mjs` (execFile, shell:false) + AC test for shell-metacharacter rejection | validation + execution + test |
| R-H-1 | `scripts/lib/validate/check-session-schema.mjs` + sessions.jsonl writer | schema + CI gate |
| R-H-2 | `skills/mcp-builder/SKILL.md` + `scripts/validate-plugin.mjs` + `.mcp.json` | docs + validation |
| R-H-3 | `scripts/gc-stale-worktrees.mjs` (NEW) + session-start `df` check | code + ops |
| R-H-4 | `package.json` devDependencies (exact pin) + `pnpm-lock.yaml` + `skills/mcp-builder/SKILL.md` (`pnpm exec reloaderoo`) + vault-staleness probe | dependency-pin + docs + observability |
| R-M-1 | `scripts/lib/session-lock.mjs` (header docs) | docs |
| R-M-2 | `scripts/lib/verification-config.mjs` (NEW timeout field) | config |
| R-M-3 | ADR text only — defer code | docs |
| R-M-4 | PRD phase 2 — GC policy | code (deferred) |
| R-M-5 | `#341` PRD draft | docs |
| R-M-6 | `scripts/lib/verification-config.mjs` re-run logic | code |
| R-M-7 | `scripts/lib/worktree/lifecycle.mjs` (NEW `validateWorktreeFragment`) + unit test for traversal rejection | code + test |
| R-M-8 | Phase D control-dir code (`mkdir { mode: 0o700 }`, `writeFile { mode: 0o600 }`) + startup self-check + `infrastructure.md` deploy note | code + ops + docs |
| R-L-6 | session-start logger + `events.jsonl` MCP-version-drift warning | observability |
| R-L-7 | `events.jsonl` `hook_duration_ms` instrumentation + CI test-quality dashboard p95/p99 | observability |
| R-L-8 | `scripts/lib/session-schema/constants.mjs` (header docs) + `docs/adr/2026-05-10-364-remote-agent-substrate.md` + lint/grep CI check | docs + validation |
| R-L-9 | `scripts/lib/io.mjs` `appendJsonl()` (existing) | code (existing) |

## Open questions for reviewers

1. **(security-reviewer)** Is the line-1 `stop_hook_active` mandatory check (R-CR-1, layer 1) sufficient guard, or should we add a hard iteration counter persisted in `autopilot.jsonl` keyed by `session_id` so even hook-bypass scenarios are bounded? Trade-off: extra disk write per Stop event vs absolute belt-and-braces.
2. **(analyst)** R-CR-2 sets `verification.token-budget-extra: 0.20` based on community-measured 10–20% (A5). Should this default to `0.10` until our own #297 calibration cohort lands, then re-tune up if too tight? Or does conservative default ≥ overrun bias?
3. **(qa-strategist)** R-CR-3 escalation defers to the existing pre-bash destructive guard as second-line defense. Should verification commands additionally be required to declare a `safety: read-mostly | write | destructive` field in Session Config so the rejection logic is intent-aware rather than pattern-matching only?
4. **(security-reviewer)** R-H-2 collision detection runs at plugin-validation time. What about runtime — if a user adds an MCP server mid-session via dynamic config? Should `tool-adapter.mjs` (when it eventually ships) re-validate on every registration?
5. **(analyst)** R-M-3 defers `tool-adapter.mjs` to phase 2. Is the seam in the ADR sufficient, or do we need a stub interface file in phase 1 to anchor the contract? Risk of stub-only is the YAGNI tax; benefit is reviewer-clarity for #341 Phase D planning.

## Sources

- `docs/spike-probes/2026-05-10-w1-research-context.md` (W1 research consolidation):
  - A1 — VibeTunnel architecture + adoption tiers
  - A2 — Crabbox (lease/TTL, cost-cap) + CodexBar (quota visibility)
  - A3 — Symphony three-level isolation + 4 kill-switches + risks bullet
  - A4 — reloaderoo inspect/proxy modes + open questions
  - A5 — Stop hook contract, `stop_hook_active` semantics, Cat Wu 3-layer model, risk table
  - A6 — internal codebase audit: session-record schema v1, key files for each issue, cross-cutting gaps
- `.claude/rules/security.md` — SEC-006 (Zod validation at boundaries) for R-CR-3 schema validation; SEC-009 (error exposure) for R-CR-2 telemetry
- `.claude/rules/parallel-sessions.md` — PSA-003 (Destructive Action Safeguards) for R-CR-3; PSA-001/002 (parallel-session detection) for R-H-3 worktree fill under multi-session load
- `glab issue view 364 365 366` — risk-related language: #364 *"auth, terminal control, runaway costs, destructive commands, multi-tenant boundaries"* · #366 *"infinite loops, flaky tests, destructive commands, excessive token burn"* · #365 (no explicit risks, scope-only)
- `CLAUDE.md` Current State — existing 9 autopilot kill-switches in `scripts/lib/autopilot/kill-switches.mjs` (deep-2 #355–#358 baseline) and 13 destructive-command rules in `.orchestrator/policy/blocked-commands.json`
