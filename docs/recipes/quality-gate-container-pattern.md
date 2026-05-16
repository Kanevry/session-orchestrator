# Recipe: Quality Gate — Container Test Runner Pattern

> **Applies to:** Session Orchestrator v3.6+  
> **Source issue:** GH #42 (root cause: aiat-pmo-module #251 V0.15.7-close incident)  
> **Related:** `scripts/lib/gates/echo-stub-detect.mjs`, `skills/session-end/SKILL.md` Phase 2.0a

---

## 1. Problem

Some projects run their real test suite inside a Docker container — for example, EspoCRM uses PHPUnit executed via `docker compose exec`. The historical workaround was to set:

```yaml
## Session Config (CLAUDE.md)
test-command: echo "tests run in container — skip"
```

This worked silently: `runCheck()` executed the command, saw it exit 0, and recorded `status: pass`. The session-end close verdict appeared clean. But no tests actually ran. A real regression would go undetected until the next manual container run.

This is the **silent false-positive close-verdict** bug documented in GH #42.

---

## 2. The Stub-Detection Guardrail

As of v3.6, `scripts/lib/gates/echo-stub-detect.mjs` exports `detectStubCommand(cmd)` which returns `{ isStub: boolean, kind?: 'echo'|'noop' }`. `gate-helpers.mjs::runCheck()` calls it before executing the command — if a stub is detected, it short-circuits with `status: 'pass', stubbed: { kind }` and the parent `gate-full.mjs` result includes a top-level `stubbed: {}` map.

Session-end Phase 2.0a reads this map. When non-empty, it emits:

```
⚠ QUALITY GATE STUBBED — 1 command(s) are echo/noop stubs, not real checks:
  - test: echo stub  (configured: "echo "tests run in container — skip"")
Re-configure with a real test command in CLAUDE.md Session Config before /close,
OR document this exception in /close --reason.
```

In `enforcement: strict` mode this blocks `/close`. In `enforcement: warn` (default) it continues but marks `quality-gate-stubbed: true` in STATE.md Deviations.

---

## 3. Recipe A — Container-Aware Test Command

Replace the echo-stub with the actual containerized invocation. Set in `CLAUDE.md` Session Config:

```yaml
## Session Config
test-command: docker compose -f dev/docker-compose.yml exec -T espocrm vendor/bin/phpunit --testdox
```

Key flags:
- `-T` — disables TTY allocation. Required for non-interactive shell-executor runners (GitLab CI, cron, headless).
- `--testdox` — human-readable test names in output. Swap for `--log-junit /tmp/junit.xml` for CI artifact ingestion.
- `-f dev/docker-compose.yml` — explicit compose file path. Omit if the default `docker-compose.yml` is in the project root.

This command fails with a non-zero exit code when the container is not running, so any CI or session-end run against a stopped environment will fail loudly — exactly the correct behavior.

---

## 4. Recipe B — Pre-Flight Container Check

If your environment sometimes runs with the container stopped (e.g. laptop dev, partial stack), wrap the command so it fails fast with a clear message instead of a cryptic Docker error:

```yaml
## Session Config
test-command: bash -c 'docker compose ps espocrm --status running | grep -q espocrm && docker compose exec -T espocrm vendor/bin/phpunit'
```

What this does:
1. `docker compose ps espocrm --status running` — lists the container only if it is in the `running` state.
2. `grep -q espocrm` — exits 1 (silently) if no running container is found.
3. `&&` — only executes PHPUnit if the pre-flight check passed.

Exit code 1 from the pre-flight check propagates through `runCheck()` as `status: fail`. Session-end will block the commit and surface the failure — no silent pass.

**Note:** the `&&` compound operator is safe from stub detection. `detectStubCommand` classifies a command as a stub only when the entire command string is a bare `echo ...` or `true`/`noop` invocation. Compound commands with `&&` are not stubs.

---

## 5. Recipe C — When You Genuinely Have No Tests Yet

If the project has no automated test suite at all (early prototype, spike branch), use the explicit `skip` keyword rather than an echo-stub:

```yaml
## Session Config
test-command: skip
```

`runCheck()` recognizes `skip` as a first-class value and returns `status: skip`. Session-end treats this as "tests not configured" — visible in the close report, but not flagged as a stub, not a WARN, and not blocking in any enforcement mode.

The distinction matters: `skip` is a deliberate declaration by the operator. An `echo` stub is an implementation accident. Only the latter is flagged by the guardrail.

---

## 6. Anti-Patterns

- **`echo "no tests yet"`** — stub-detected (`kind: echo`). Produces WARN in `warn` mode, blocks close in `strict` mode. Do not use.
- **`true`** — not currently classified as a stub by `detectStubCommand`. The gate will record `status: pass` silently. File a follow-up to add `true`/`exit 0` detection to `echo-stub-detect.mjs` if this becomes common.
- **`exit 0`** — same situation as `true`. Not yet classified.
- **`echo "running tests" && docker compose exec ...`** — safe. The `&&` compound makes this a real command with side effects. `detectStubCommand` does not flag it.
- **Wrapping the stub to silence the WARN** (e.g. `echo "" && true`) — the guardrail catches the leading `echo`. Do not try to work around stub detection — document the exception via `/close --reason` instead.

---

## 7. Cross-References

- **GH #42** — bug report: session-end close-verdict false-positive from echo-stub test commands.
- **aiat-pmo-module #251** — V0.15.7-close incident: the originating production case.
- **`scripts/lib/gates/echo-stub-detect.mjs`** — stub classifier. Exports `detectStubCommand(cmd): { isStub, kind? }`.
- **`scripts/lib/gates/gate-helpers.mjs`** — `runCheck()` integration point. Short-circuits stubs before shell execution.
- **`scripts/lib/gates/gate-full.mjs`** — emits top-level `stubbed: {}` map in JSON result.
- **`skills/session-end/SKILL.md` Phase 2.0a** — coordinator behavior: WARN block, enforcement-mode routing, STATE.md deviation write.
