# ADR 0011: Guard-Degradation Semantics under the exit-0 PreToolUse Protocol

> Status: Accepted · 2026-08-05 · session main-2026-08-05-deep-1 · issue #997
> Decisions recorded: #992 (late binding + HEAD fallback) · #993 (generalisation across all four armGuard hooks) · #995 / #1001 (visible-channel degradation notice) · #998 (hardening: git-env scrub, ppid-composed banner key)
> Context inherited from: #906 (exit-0 stdout-JSON PreToolUse protocol migration) · rejected alternative from #1000
> Authoritative implementation: [`hooks/_lib/guard-source-loader.mjs`](../../hooks/_lib/guard-source-loader.mjs) · [`scripts/lib/io.mjs`](../../scripts/lib/io.mjs)
> Project-instruction file resolution: this repo's root context file is `CLAUDE.md` on Claude Code / Cursor IDE and `AGENTS.md` on Codex CLI — transparent aliases per [skills/_shared/instruction-file-resolution.md](../../skills/_shared/instruction-file-resolution.md).

## Context

### The protocol inversion (#906)

Under the pre-#906 exit-code protocol, a deny-capable PreToolUse hook signalled a
block with `exit 2`. The exit code carried the decision *by itself*, so a bug in
the payload path was harmless: a hook that crashed, truncated its stdout, or
printed nothing at all still blocked, because the exit code said so.

#906 moved the decision onto stdout. Under the exit-0 protocol an ALLOW is
`exit 0` with empty stdout, and a DENY is `exit 0` with exactly one
`hookSpecificOutput` JSON line carrying `permissionDecision: "deny"`
(`scripts/lib/io.mjs#emitDeny`). **The payload IS the decision.** Any crash,
truncation or absence of that line reads as *no decision* — which the harness
resolves as ALLOW.

This inverts the failure direction of every deny-capable hook in the repo: they
are now **fail-open by protocol**. Three measured consequences from the migration
are already codified as auto-generated rules:

- `.claude/rules/proven-pattern-moving-a-guard-from-exit-code-signalling-to-stdout-json-inverts-its-failure-direction-re-verify-every-deny-path-afterwards-3aeb9fc.md`
  — every crash-, throw- and short-circuit path that was previously fail-closed
  must be re-examined, and allow-assertions in tests stop discriminating because
  allow and deny now share an exit code.
- `.claude/rules/anti-pattern-console-log-process-exit-drops-stdout-above-the-pipe-buffer-on-an-exit-0-protocol-that-means-fail-open-91c32e4.md`
  — `console.log` + `process.exit()` drops stdout past the 64 KiB pipe buffer; a
  truncated envelope reads as no-decision and the tool call is ALLOWED.
- `.claude/rules/anti-pattern-a-protocol-migration-census-keyed-on-the-payload-misses-every-consumer-that-pins-only-the-channel-18f3d0a.md`
  — a migration census keyed on the payload field name misses every consumer that
  pins only the exit code or the stream.

### The defect this ADR's decisions close (#992)

`hooks/hooks.json` runs `sh run-node.sh <hook>.mjs`, which `exec node "$@"`. A
hook that **statically** imports a repo module inherits that module's parse
failure at ESM *link* time — before the first statement of the hook body runs.
The hook's own `main().catch(...)` is structurally unreachable (it only covers
runtime errors inside `main()`), and node terminates with exit 1, **stdout 0
bytes**, stderr = a SyntaxError stack trace.

On the only decision-bearing channel, 0 bytes of stdout is byte-identical to an
explicit `emitAllow()`. So one unparseable `scripts/lib/command-blocker.mjs` —
a merge-conflict marker, a partial edit — silently disarmed four of the seven
deny-capable hooks at once, across both Bash and Edit/Write enforcement, while
printing an ambiguous harness error line that wave agents read as a crash and
began routing around.

Two further facts constrain any fix:

- **stderr is not a channel here.** Under exit 0 the harness discards stderr, so
  a warning written there reaches neither the operator nor the model.
- **`emitWarn` is `@returns {never}`** (`scripts/lib/io.mjs#emitWarn` calls
  `process.exit(0)`). Any inline warning emitted *before* the decision logic
  terminates the hook with an ALLOW.

## Decision

### D1 — Late binding with a HEAD fallback for dependency-free modules (#992, generalised #993)

Deny-capable hooks bind their repo dependencies **at first use**, through
`armGuard()` in `hooks/_lib/guard-source-loader.mjs`, never through top-level
static imports. `armGuard` moves the failure out of ESM link time and into a
`try`/`catch` the hook can act on.

When the working-tree copy of a module fails — a **parse error OR a shape
failure** (`assertShape`: a required export that is not a function) — the loader
falls back to the committed source via `git show HEAD:<relPath>`, imported
through a `data:` URL (`readFromHead` → `importFromSource`).

**The fallback is deliberately restricted to dependency-free modules.** A `data:`
URL has no base against which a relative import specifier could resolve, so a
`headFallback` on a module carrying relative imports would produce a silently
unloadable fallback. `armGuard` therefore rejects `headFallback: true` on any
basename outside `HEAD_FALLBACK_ALLOWLIST` (`command-blocker.mjs`, `io.mjs`,
`path-utils.mjs`, `common.mjs`, `plugin-root.mjs`) as a hard **config** error
rather than arming a guard whose fallback can never fire. In practice exactly one
module opts in per hook: `command-blocker.mjs`, whose only import is `node:path`.

The shape check runs on **both** copies. A HEAD copy that parses but is older
than the working tree — the normal case when a newly added export is the very
thing that broke — is treated as a total failure, not a usable fallback. The
earlier partial check (2 of 6 exports) let such a copy banner "DEGRADED,
enforcement IS still armed" and then allow every command with an
`⚠ internal error — <fn> is not a function` line.

`hookName`, the `requires` set, and the `consequence` prose are all **parameters**
(#993). `hookName` is mandatory with no default on both public exports: a default
would re-freeze one hook's name into every hook's banner, which is the exact drift
#993 removed.

**Hardening (#998.1):** `readFromHead` scrubs the git-discovery environment
(`GIT_DIR`, `GIT_WORK_TREE`, `GIT_OBJECT_DIRECTORY`,
`GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`,
`GIT_NAMESPACE`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_COUNT`) by
setting each to `undefined`, which Node omits from the child env — a deletion,
never an empty-string assignment (`GIT_DIR=` is itself a discovery override).
`-C <repoRoot>` sets only the child's cwd and does **not** win against `GIT_DIR`.
The bytes this call returns are *imported as code* inside a deny-capable hook,
which makes it the single trust-sensitive shell-out in the loader; the scrub is
applied there rather than at `armGuard` entry for that reason. Measured on this
loader: without `GIT_DIR`, 57,446 bytes of real source; with a foreign `GIT_DIR`,
128 bytes of attacker-controlled content. **No vector is currently known by which
a Bash command sets a later hook process's environment — this is defense in
depth, not a fix for a reachable exploit.**

### D2 — Degradation is announced on the visible channel, aggregated and flushed (#995 / #1001)

A degraded guard must not be silently indistinguishable from a healthy one. Two
banner classes, with deliberately different throttling, plus a stdout notice:

| Class | Channel | Throttle | Emitter |
|---|---|---|---|
| **DEGRADED** (armed, evaluating HEAD) | stderr banner **+** stdout `systemMessage` notice | once per session (stderr) | `emitGuardBannerOnce` + hook-local `flushNotices` |
| **GUARD INACTIVE** (not armed at all) | stderr banner | **none — every call** | `emitGuardInactiveBanner` |

The INACTIVE banner is not throttled on purpose. Its predecessor went through the
once-per-session marker, and because that marker was suppressible by a bare
`touch` on a derivable path, the loudest signal in the system had the weakest lock
on it. Every call after the first is equally unprotected, so every call has equal
right to say so.

**stdout notice, not an inline `emitWarn`.** Because stderr is discarded under
exit 0, the DEGRADED state is additionally pushed onto the visible stdout channel
as a top-level `systemMessage` (`emitWarn`, which carries no
`hookSpecificOutput`/`permissionDecision` and is therefore non-blocking). It is
**aggregated into a `notices[]` array and flushed exactly once, on the allow path
only** — `flushNotices(notices)` returns `emitWarn(joined)` when non-empty, else
`emitAllow()`. An inline `emitWarn` at the degradation site would exit 0 before
any `block` rule was evaluated, flipping every would-be DENY into an
ALLOW-with-notice for the whole degraded session. When a deny fires it exits via
`emitDeny` and the queued notices are simply dropped: DENY wins, and the stderr
copies remain for CI/debug.

This pattern is now identical in all three hooks that can degrade —
`pre-bash-destructive-guard.mjs`, `enforce-commands.mjs`,
`pre-bash-sessions-ledger-guard.mjs` (#1001; #995 had rolled it out to the first
only).

**Marker mechanics (#998.3).** Where the once-per-session throttle remains
(`head-fallback`), **content decides, not existence**: a scoped JSON payload
(magic + version + kind + banner key + projectDir digest + bucketed boot epoch +
timestamp), written `O_CREAT|O_EXCL|O_NOFOLLOW` at mode `0600` and read
`O_RDONLY|O_NOFOLLOW` with regular-file / `nlink === 1` / same-uid checks. Every
rejection path is the fail-LOUD one: a foreign, empty, hard-linked, stale-boot or
future-stamped file makes the banner **repeat** rather than vanish. The marker
lives in `os.tmpdir()` via `path.join` — not in the repo (the error path must not
presuppose repo write access, and an in-repo marker is another deletable trust
anchor), and not via `$TMPDIR` string concatenation (trailing slash on macOS,
unset on a Linux container).

The banner key is **`<session-id-slice>-p<ppid>`**, not the session id alone.
There is exactly one `session.lock` per working copy, so two parallel sessions in
the same working copy resolve the same `session_id` and the second would never see
its own degradation banner. `ppid` — deliberately not `pid` — because every hook
invocation is its own short-lived node process, so a `pid`-keyed marker would fire
on every call; `hooks/run-node.sh` uses `exec node` on every branch, so no
intermediate shell survives and the ppid **is** the stable harness process. That
`exec` is load-bearing: adding a non-exec branch to `run-node.sh` would silently
re-break the key. When `.orchestrator/session.lock` is absent or malformed, the key
degrades to `ttl-p<ppid>` under a 6 h time TTL, mirroring `run-node.sh`.

## Consequences

### Blast-radius table (built from the code, 2026-08-05)

Seven hooks call `emitDeny` (`grep -rln "emitDeny" hooks/`). Four bind through
`armGuard`; three still use top-level static imports.

| Hook | Binding | `headFallback` module (`requires`) | Reachable states |
|---|---|---|---|
| `pre-bash-destructive-guard.mjs` | `armGuard` | `command-blocker.mjs` — 7 exports: `tokenizeCommand`, `commandMatchesBlocked`, `extractRedirectTargets`, `redirectRuleMatches`, `redirectSpanEnd`, `resolveSegmentVerb`, `splitChainSegments` | healthy · DEGRADED · INACTIVE |
| `pre-bash-sessions-ledger-guard.mjs` | `armGuard` | `command-blocker.mjs` — 3 exports: `tokenizeCommand`, `resolveSegmentVerb`, `splitChainSegments` | healthy · DEGRADED · INACTIVE |
| `enforce-commands.mjs` | `armGuard` | `command-blocker.mjs` — 2 exports: `commandMatchesBlocked`, `suggestForCommandBlock` | healthy · DEGRADED (shape-check door only, see below) · INACTIVE |
| `enforce-scope.mjs` | `armGuard` | none (`headFallback` on 0/5 entries; 3 modules dependency-free, 2 carry relative imports) | healthy · INACTIVE only |
| `config-protection.mjs` | static `import` | — | healthy · silent disarm (pre-#992 exposure) |
| `pre-bash-issue-budget.mjs` | static `import` | — | healthy · silent disarm (pre-#992 exposure) |
| `pre-bash-templates-first.mjs` | static `import` | — | healthy · silent disarm (pre-#992 exposure) |

**Why `enforce-commands` reaches DEGRADED only through the shape-check door.**
`armGuard` sorts `headFallback` entries **last**, so the cheap plain imports arm
first. `enforce-commands` binds `hardening.mjs` (no fallback — it carries relative
imports), and `hardening.mjs` → `scope-gate.mjs` imports `tokenizeCommand`,
`splitChainSegments`, `resolveSegmentVerb` from `command-blocker.mjs`. So a
**parse error** in `command-blocker.mjs` — or the loss of any of those three
exports, which is an ESM link error at `scope-gate.mjs` — kills the `hardening`
entry *before* the `blocker` entry is reached: GUARD INACTIVE, git or no git. It
degrades only when `command-blocker.mjs` parses and links for `scope-gate` but
fails `enforce-commands`' own `requires` shape check (e.g. a missing
`commandMatchesBlocked`).

### What an operator sees in each state

- **healthy** — nothing. Bare `emitAllow()`, empty stdout.
- **DEGRADED** — a stderr banner once per session (`⚠️  <hook>: DEGRADED —
  running against HEAD, not your working tree`, the failing relPath, the
  first line of the working-tree error, the hook's verbatim `consequence.degraded`
  block, a repair hint, `See: issue #992`) **and**, on every allow, a stdout
  `systemMessage`: `<hook>: DEGRADED — guard module(s) loaded from HEAD, not your
  working tree (<labels>); uncommitted changes to them are NOT in effect. See
  #992.`
- **GUARD INACTIVE** — a stderr banner on **every** call: `🚨 <hook>: GUARD
  INACTIVE — this session is NOT protected.`, the module-load error, the HEAD
  fallback error when one occurred, the hook's verbatim `consequence.inactive`
  block naming the concrete commands that are no longer blocked, and
  `See: issue #992, .claude/rules/parallel-sessions.md (PSA-003)`.

### Cost, and where it is paid

`git show` median 4.2 ms (n=21) against a hook allow-path median of 61 ms (n=15)
— +11 ms, and only in the defect case. Zero in normal operation: nothing in the
loader runs unless an import already threw.

### Known limitations (accepted, not deferred)

- **The HEAD fallback presupposes a git checkout.** It shells out in the *plugin
  root*, not the project dir. For an npm-installed plugin, or any vendored copy
  without a `.git`, that command fails by construction: every load failure
  degrades straight to GUARD INACTIVE. That is the designed fail-loud direction,
  but it means the banner is the only protection npm consumers get.
- **A committed conflict marker breaks the HEAD copy too** — then only the banner
  fires. This is why the banner is the base and the fallback the topping.
- **The `head-fallback` marker remains forgeable by the same uid.** An attacker
  running as the session's uid who reproduces the payload format can still
  suppress the DEGRADED banner. That is precisely why the class that means
  "unprotected" (INACTIVE) no longer depends on the marker at all, and why the
  stdout notice (#1001) is emitted per allow rather than once per session.
- **Three deny-capable hooks are still statically bound** (`config-protection`,
  `pre-bash-issue-budget`, `pre-bash-templates-first`) and retain the full #992
  silent-disarm exposure: no banner, no fallback, 0 bytes of stdout on a broken
  import.
- **`hooks/_lib/guard-source-loader.mjs` must never import a repo module.**
  Everything in it runs on the error path of a module-loading failure, so
  `node:*` builtins only. This is a hard constraint on that file, not a style
  preference.

## Rejected Alternatives

### R1 — An on-disk source cache under `.orchestrator/runtime/`

Rejected. Its cold-start failure mode is *exactly the target scenario*: a fresh
worktree mid-merge has no warm cache, which is the state in which a conflict
marker breaks a guard module. It also creates a deletable trust anchor inside the
writable repo — a file an agent can remove or overwrite to steer which source the
guard executes. `git show HEAD:` needs no warm-up and its trust anchor is the
object store.

### R2 — Generalising the HEAD fallback to every guard import

Rejected. The fallback re-imports source through a `data:` URL, and a `data:` URL
has **no base** against which a relative import specifier could resolve.
`hardening.mjs` and `platform.mjs` carry relative imports, so a
`headFallback: true` there would produce a silently unloadable module — a guard
whose fallback can never fire, arming "successfully" and failing per call.
Generalising would require a recursive specifier resolver, its own trust surface.
`armGuard` therefore treats an off-allowlist `headFallback` as a hard config
error, and for every non-dependency-free module the banner (D2) stands alone.

### R3 — Fail-closed on unknown value-taking wrapper flags (#1000)

Rejected on measurement: **fail-closed is fail-open here.** The proposal was to
treat an unknown `-x` wrapper flag as value-taking (`i++` → `i += 2`) in
`resolveSegmentVerb`. Measured (issue #1000, verbatim):

```
LOST verb=null   sudo -n / -H / -E / -b / -S bash -c "x"
LOST verb=null   env -i / -0 / -v bash -c "x"
LOST verb=null   nice -5 bash -c "x"
LOST verb=-c     timeout --foreground 5 bash -c "x"
rm-rf still blocked behind sudo -n: false
tests/lib/    6 failed | tests/hooks/  121 failed
```

`verb: null` means "no interpreter in this segment", which makes the quoted
payload **inert** — so `sudo -n bash -c 'rm -rf /'` falls from DENY to ALLOW. 12
of 12 genuine boolean flags lose their resolution and 127 tests break. The parser
is the only component that finds the interpreter at all; blinding it cannot fail
closed. The adopted design is instead a **dual parse**: evaluate both readings and
block if either matches (`resolveSegmentVerb` runs `resolveCore` twice and returns
an `alt` key only when an unknown flag was skipped *and* the two readings differ,
keeping the unambiguous return shape byte-identical to pre-#1000). Match recursion
and redirect recursion both traverse the de-duplicated union of payloads from the
primary and alternate resolved readings; the shared `dedupedSegmentPayloads`
helper charges the recursion budget once per distinct payload.

## Verified against (2026-08-05, this working tree)

| Claim | Verified against |
|---|---|
| exit-0 payload-is-the-decision; allow = empty stdout | `scripts/lib/io.mjs#emitAllow`, `#emitDeny` (module doc, verbatim hooks-doc quotes) |
| link-time failure ⇒ exit 1, stdout 0 bytes, `main().catch` unreachable | `hooks/_lib/guard-source-loader.mjs` module header (#992) |
| HEAD fallback via `git show` + `data:` URL, dep-free only | `guard-source-loader.mjs#readFromHead`, `#importFromSource`, `HEAD_FALLBACK_ALLOWLIST` |
| off-allowlist `headFallback` is a hard config error | `guard-source-loader.mjs#armGuard` (throw before the try/catch) |
| shape check on BOTH copies | `guard-source-loader.mjs#assertShape` call sites (`'working-tree copy'` / `'HEAD copy'`) |
| git-env scrub, `undefined` = deletion, 57,446 vs 128 bytes | `guard-source-loader.mjs#readFromHead` doc + `env:` literal (#998.1) |
| banner key `<id>-p<ppid>`, ppid-not-pid, `exec node` dependency | `guard-source-loader.mjs#resolveBannerKey` (#998.3); `hooks/run-node.sh` |
| marker `O_CREAT\|O_EXCL\|O_NOFOLLOW`, content-validated | `guard-source-loader.mjs#writeMarker`, `#readMarker` |
| INACTIVE banner unthrottled, DEGRADED throttled | `guard-source-loader.mjs#emitGuardInactiveBanner` doc vs `#emitGuardBannerOnce` |
| `emitWarn` is `@returns {never}` / `process.exit(0)` | `scripts/lib/io.mjs#emitWarn` |
| aggregate-and-flush, deny drops notices | `flushNotices` in `pre-bash-destructive-guard.mjs`, `enforce-commands.mjs`, `pre-bash-sessions-ledger-guard.mjs` (#1001) |
| 7 deny-capable hooks; 4 armGuard; 3 static | `grep -rln "emitDeny" hooks/` (7) · `grep -rln "armGuard" hooks/` (4 + loader) · top-level `import` in the other 3 |
| per-hook `requires` sets | `bootstrap()` in each of the three headFallback hooks |
| hardening → scope-gate → command-blocker | `scripts/lib/scope-gate.mjs:17`; `scripts/lib/hardening.mjs` re-exports |
| headFallback entries arm LAST | `guard-source-loader.mjs#armGuard` `entries.sort(...)` |
| `git show` 4.2 ms vs 61 ms allow path | `guard-source-loader.mjs` module header ("Measured cost") |
| #1000 fail-closed measurement + dual parse | issue #1000 (verbatim block) · `scripts/lib/command-blocker.mjs#resolveSegmentVerb`, `#resolveCore` |
| de-duplicated primary/alternate payload union for match and redirect recursion | `scripts/lib/command-blocker.mjs#dedupedSegmentPayloads`, consumed by `matchSegments` and `collectRedirectTargets` |

## References

- Issue #906 — exit-0 stdout-JSON PreToolUse protocol migration (the inversion)
- Issue #992 — guard hooks fail open on unparseable working-tree source
- Issue #993 — generalisation of late binding to the other three deny-capable hooks
- Issue #995 — fail-visible wrote to stderr, the channel exit 0 discards
- Issue #998 — W4-panel hardening bundle (`.1` git-env scrub, `.3` banner key)
- Issue #1000 — unknown value-taking wrapper flags: fail-closed rejected, dual parse adopted
- Issue #1001 — degraded-notice rollout to ledger-guard + enforce-commands
- Issue #997 — this ADR
- [ADR 0006 — prompt-hook `continueOnBlock` migration](0006-prompt-hook-continueonblock.md) (nearest neighbour: hook handler types; explicitly does **not** cover degradation semantics)
- `.claude/rules/proven-pattern-moving-a-guard-from-exit-code-signalling-to-stdout-json-inverts-its-failure-direction-re-verify-every-deny-path-afterwards-3aeb9fc.md`
- `.claude/rules/anti-pattern-console-log-process-exit-drops-stdout-above-the-pipe-buffer-on-an-exit-0-protocol-that-means-fail-open-91c32e4.md`
- `.claude/rules/anti-pattern-a-protocol-migration-census-keyed-on-the-payload-misses-every-consumer-that-pins-only-the-channel-18f3d0a.md`
- [`.claude/rules/parallel-sessions.md`](../../.claude/rules/parallel-sessions.md) § PSA-003 (the enforcement an INACTIVE destructive-guard stops applying)
