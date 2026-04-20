# Plugin Architecture (v3.0)

Contributor guide for the v3.x codebase. Covers layering, hook anatomy, shared-lib catalog, testing patterns, CI flow, coding conventions, and the `zx`-vs-stdlib heuristic.

Target audience: anyone writing a new hook, adding a shared lib, or extending a skill with Node-side logic. Skill authors writing pure Markdown do not need this guide — see [`CONTRIBUTING.md`](../CONTRIBUTING.md) instead.

## 1. Layering

```
┌─────────────────────────────────────────────────────────────┐
│ Editor runtime (Claude Code / Codex / Cursor IDE)           │
│   → reads hooks.json, invokes hooks on events               │
├─────────────────────────────────────────────────────────────┤
│ hooks/*.mjs                                                 │
│   PreToolUse, PostToolUse, SessionStart, Stop,              │
│   SubagentStop — Node processes, stdin JSON in,             │
│   single-line JSON out (exit 0 = allow, 2 = deny)           │
├─────────────────────────────────────────────────────────────┤
│ scripts/lib/*.mjs                                           │
│   Shared helpers — io, platform, path-utils, config,        │
│   events, worktree, hardening, common                       │
├─────────────────────────────────────────────────────────────┤
│ Node 20+ stdlib  +  zx 8                                    │
│   fs.promises, path, os, url, crypto, fetch,                │
│   AbortSignal.timeout — NO jq, NO bash                      │
└─────────────────────────────────────────────────────────────┘
```

Skills (`skills/**/*.md`) sit outside this stack — they are instructions for the agent, not code. When a skill needs logic (config parsing, file I/O, subprocess spawning), it invokes a `scripts/lib/*.mjs` module via `node -e` or delegates to a hook.

## 2. Hook Anatomy

Every hook follows the same I/O contract, enforced by `scripts/lib/io.mjs`.

### Template

```js
#!/usr/bin/env node
// hooks/example.mjs
import { readStdin, emitAllow, emitDeny, emitWarn } from '../scripts/lib/io.mjs';

async function main() {
  const input = await readStdin();              // parses JSON stdin with 5s timeout + 1 MB guard
  const event = JSON.parse(input);

  // Read the event payload. Shape depends on the hook type —
  // PreToolUse has { tool_name, tool_input }, SessionStart has { session_id, … }, etc.
  const { tool_name, tool_input } = event;

  if (tool_name === 'Bash' && looksDangerous(tool_input.command)) {
    emitDeny('Blocked by example policy', { reason: 'dangerous-pattern' });
    return;
  }

  emitAllow();
}

// Top-level try/catch prevents exit code 1 from propagating to the editor.
main().catch((err) => {
  emitDeny(`Hook crashed: ${err.message}`, { fatal: true });
});
```

### Contract

| Direction | Format |
|-----------|--------|
| stdin | Single JSON object from the editor. Type depends on hook event. |
| stdout | Exactly one line of JSON. `{ "decision": "allow" }`, `{ "decision": "deny", "reason": "…" }`, or `{ "decision": "warn", "message": "…" }`. |
| exit code | `0` on allow / warn. `2` on deny. **Never exit `1`** — the editor treats that as a hook crash and blocks conservatively. |
| stderr | Only for debugging. Not surfaced to the user. |

Always wrap `main()` in a top-level `.catch` that calls `emitDeny` — an unhandled exception would otherwise exit 1.

### Registering the hook

Edit `hooks/hooks.json`. Each entry maps an event matcher to the Node command:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PLUGIN_ROOT/hooks/example.mjs\"" } ] }
    ]
  }
}
```

Use `$CLAUDE_PLUGIN_ROOT` (or `$CODEX_PLUGIN_ROOT` / `$CURSOR_RULES_DIR`) — these are set by the editor. Never hard-code absolute paths.

## 3. Shared Lib Catalog

Under `scripts/lib/`. Each module is a focused concern and exports only what callers need.

| Module | 1-liner | Key exports |
|--------|---------|-------------|
| **`io.mjs`** | Hook stdin/stdout helpers matching the Claude Code contract | `readStdin`, `emitAllow`, `emitDeny`, `emitWarn`, `emitSystemMessage` |
| **`platform.mjs`** | OS + editor detection | `SO_OS`, `SO_IS_WINDOWS`, `SO_IS_WSL`, `SO_PATH_SEP`, `SO_STATE_DIR`, `detectPlatform()` |
| **`path-utils.mjs`** | CWE-23-safe path helpers (null-byte rejection, UNC block, cross-drive escape, locale-stable casing) | `normalizeForMatching`, `isWithin`, `CWE_23_ATTACK_PATTERNS` |
| **`config.mjs`** | CRLF-tolerant Session Config parser (byte-exact parity with legacy `parse-config.sh`) | `parseConfig`, `readSessionConfig` |
| **`config-schema.mjs`** | Plain-JS validator for the 7 mandatory Session Config fields | `validateConfig`, `MANDATORY_FIELDS` |
| **`events.mjs`** | Append to `.orchestrator/metrics/events.jsonl` + optional webhook POST | `emitEvent`, `appendEvent` |
| **`worktree.mjs`** | zx-based git worktree helpers with cross-platform paths | `createWorktree`, `removeWorktree`, `listWorktrees`, `cleanupAllWorktrees` |
| **`hardening.mjs`** | Scope + command enforcement primitives | `findScopeFile`, `getEnforcementLevel`, `pathMatchesPattern`, `commandMatchesBlocked` |
| **`common.mjs`** | Grab-bag utilities | `makeTmpPath`, `utcTimestamp`, `readJson`, `writeJson`, `appendJsonl` |
| **`state-md.mjs`** | Hand-rolled YAML-subset STATE.md parser (never throws) | `parseStateMd`, `serializeStateMd`, `touchUpdatedField` |
| **`host-identity.mjs`** | Device fingerprint + SSH detection (v3.1 resource-awareness) | `getHostIdentity`, `isSshSession` |
| **`resource-probe.mjs`** | Live RAM/CPU/process snapshot (v3.1) | `probe`, `evaluate` |
| **`pre-dispatch-check.mjs`** | Worktree overlap guard before agent dispatch (v3.1) | `checkOverlap` |
| **`package-manager.mjs`** | Lockfile-based package-manager detection | `detectPackageManager`, `defaultCommands` |
| **`quality-gates-policy.mjs`** | JSON-Schema policy loader for test/typecheck/lint | `loadQualityGatesPolicy`, `resolveCommand` |

### Import example

```js
import { readJson, writeJson } from '../scripts/lib/common.mjs';
import { SO_IS_WINDOWS } from '../scripts/lib/platform.mjs';

const cfg = await readJson('.orchestrator/policy/blocked-commands.json');
cfg.updated = new Date().toISOString();
await writeJson('.orchestrator/policy/blocked-commands.json', cfg);
```

All shared libs are ES modules. Import with explicit `.mjs` extensions — Node's ESM loader does not resolve bare specifiers for relative paths.

## 4. Testing Patterns

Tests live under `tests/` and are run by `npm test` (vitest).

### Directory layout

```
tests/
├── lib/               # unit tests for scripts/lib/*.mjs
├── hooks/             # unit tests for hooks/*.mjs
├── integration/       # cross-component tests (hook-smoke, parse-config-validator, etc.)
└── fixtures/          # fixture inputs (CLAUDE.md variants, event payloads, …)
```

### Stdin mocking for hooks

Hooks read JSON from stdin. The pattern is to spawn the hook as a subprocess and pipe the payload:

```js
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function runHook(hookPath, payload) {
  return new Promise((resolveResult) => {
    const proc = spawn('node', [hookPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => resolveResult({ code, stdout, stderr }));
    proc.stdin.end(JSON.stringify(payload));
  });
}

// Usage
const hookPath = resolve(fileURLToPath(import.meta.url), '../../../hooks/example.mjs');
const { code, stdout } = await runHook(hookPath, { tool_name: 'Bash', tool_input: { command: 'ls' } });
expect(code).toBe(0);
expect(JSON.parse(stdout).decision).toBe('allow');
```

`tests/integration/hook-smoke.test.mjs` is the canonical reference for this pattern.

### OS-conditional tests

Use `skipIf` / `runIf` with `process.platform`:

```js
import { describe, it, skipIf } from 'vitest';

describe('symlink escape on posix only', () => {
  skipIf(process.platform === 'win32')('rejects symlinks outside scope', async () => {
    // posix-specific test body
  });
});
```

### Spawn helper

For lib tests that invoke real subprocesses (e.g., parity checks against the legacy Bash versions), use the helper in `tests/_spawn-helper.mjs` which handles Windows shell quoting and timeouts.

## 5. CI Flow

`.github/workflows/test.yml` runs the full suite on every push and PR across three OSes.

```
matrix:
  os: [ubuntu-latest, macos-latest, windows-latest]
  node: [20]
```

`fail-fast: false` so a Windows-only flake does not mask an Ubuntu regression. Each job:

1. Checkouts (SHA-pinned `actions/checkout`).
2. Installs `jq` via the OS package manager.
3. `npm ci` — reproducible install from lockfile.
4. `npm run lint` — ESLint v9 + Prettier.
5. `npm run typecheck` — `node --check scripts/lib/*.mjs` (syntactic-only; there is no TypeScript yet).
6. `npm test` — vitest run.

### Debugging Windows-only failures

1. Reproduce locally if possible (Windows VM, GitHub Actions runner image, or a Windows-native dev box).
2. Check line endings — v3 ships `.gitattributes` with explicit LF rules, but a pre-v3 checkout may have CRLF. Run `git config core.autocrlf false && git rm --cached -r . && git reset --hard`.
3. Inspect paths — Node on Windows uses `\`, but many libs normalize to `/`. `scripts/lib/path-utils.mjs:normalizeForMatching` is the canonical normalizer.
4. Check tmpdir — `os.tmpdir()` on Windows returns `C:\Users\…\Temp`, which trips tests that hard-coded `/tmp`.
5. Read the CI logs: `gh run view --log <run-id>` or download the artifact from the Actions tab.

## 6. Coding Conventions

Enforced by ESLint v9 + Prettier. See `eslint.config.js` and `.prettierrc`.

- **ES modules only.** Every new Node file uses `.mjs`, `import`/`export`, top-level `await`. No CommonJS (`require`, `module.exports`).
- **Single quotes, 100-column width, LF line endings.** Prettier handles this automatically — `npm run lint:fix` fixes offenders in place.
- **`_`-prefix for intentionally-unused variables.** `no-unused-vars` allows `_`-prefixed names (including destructure patterns). Example: `const [_status, stdout] = await run(cmd);`.
- **Path handling.** Never concatenate path strings with `+` or `\``. Always `path.join(...)`. For path comparisons, go through `path-utils.mjs:normalizeForMatching`.
- **Subprocess spawning.** Prefer `zx`'s `$` tag for shell-like commands (handles quoting). For untrusted input, pass arguments via `child_process.spawn` arg arrays, not concatenated shell strings.
- **Error handling.** Hooks: top-level `.catch` → `emitDeny`. Libs: throw with context (`throw new Error('parseConfig: missing field X')`) and let the caller decide. Never swallow errors silently except on best-effort cleanup paths, and warn to stderr when you do.
- **No `console.log` in libs or hooks.** `stdout` is reserved for the hook I/O contract. Diagnostics go to `stderr` or `events.jsonl` via `events.mjs`.
- **`===` / `!==` always.** `==`/`!=` is banned (`eqeqeq`).
- **No `var`.** `const` by default, `let` when reassignment is genuinely needed.
- **Tests are `.test.mjs` or `.spec.mjs`.** vitest picks them up automatically under `tests/`.

## 7. When to use zx vs. Node stdlib

Rule of thumb:

| Use zx (`$`, `nothrow`) | Use Node stdlib |
|------------------------|-----------------|
| Spawning external commands (`git`, `glab`, `gh`, `npm`) | Reading/writing files |
| Shell-like composition (pipes, redirection) | Parsing JSON |
| Cross-platform quoting (zx handles spaces, quotes) | HTTP requests (`fetch`) |
| Commands that may fail and whose failure you want to inspect (`nothrow`) | Timers, signals, crypto |

Example — **good zx usage**:

```js
import { $, nothrow } from 'zx';

const { stdout: branch } = await $`git rev-parse --abbrev-ref HEAD`;
const { exitCode } = await nothrow($`git worktree remove ${tmpDir}`);
if (exitCode !== 0) {
  // best-effort cleanup; don't crash
}
```

Example — **use stdlib instead**:

```js
// BAD — zx for a pure file read
const { stdout } = await $`cat ${path}`;

// GOOD — use fs
import { readFile } from 'node:fs/promises';
const content = await readFile(path, 'utf-8');
```

Reasons to prefer stdlib when possible:

- **Speed.** Spawning a shell to `cat` a file is ~100× slower than `fs.readFile`.
- **Windows portability.** `cat` is absent on stock Windows; `readFile` is universal.
- **Error messages.** `ENOENT` from stdlib is more precise than a shell exit code.

Reasons zx wins when it does:

- **Git + CLI tooling.** `git`, `glab`, `gh` have rich output formats and exit-code semantics that zx preserves.
- **Quote handling.** zx's `$` template literal handles argument quoting on Windows and POSIX consistently. `child_process.exec` with concatenated strings does not.

---

Questions or gaps? Open an issue at [infrastructure/session-orchestrator](https://gitlab.gotzendorfer.at/infrastructure/session-orchestrator/-/issues) with label `area:docs`.
