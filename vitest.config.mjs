import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@lib': path.resolve(__dirname, 'scripts/lib'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.mjs'],
    // #1278: validate the repository once before workers, then share that run's
    // result with the CLI/wiring assertions instead of four concurrent scans.
    globalSetup: ['./tests/setup/validate-plugin.mjs'],
    // Strips git's repo-pointing environment once per worker. Those variables
    // outrank BOTH `cwd:` and `-C <path>`, so without this a fixture git call
    // writes into the INVOKING repository — measured on 2026-08-19, when it
    // detached the real HEAD, added three commits and rewrote .git/config.
    // The two call sites that caused it already passed a correct `cwd`, which
    // is why the static census (check-test-git-config-target.mjs) cannot close
    // this half and reports it as `gitDirInheritable` instead.
    // vault-guard pins SO_VAULT_DIR — the HIGHEST tier of the host-local
    // vault-dir chain (env > owner.yaml > committed CLAUDE.md) — at a fresh tmp
    // dir per worker. Without it a test that calls a vault writer without a
    // hermetic hostPaths ctx resolves tiers 2/3 on the HOST and writes into the
    // operator's real vault, which is a foreign tracked repo. Opt out with
    // SO_VAULT_GUARD_ALLOW_REAL=1.
    // host-alias-guard pins SO_HOST_ALIASES_FILE at a per-run tmp file. Without
    // it a lock-taking suite writes the operator's REAL
    // ~/.config/session-orchestrator/host-aliases.json, because recordHostAlias()
    // fires inside buildLock() — and that ledger is what hostnamesMatch() reads
    // to decide whether a lock is this machine's (#1072). Measured 2026-08-24:
    // three suites reach that path with no redirect of their own. Opt out with
    // SO_HOST_ALIAS_GUARD_ALLOW_REAL=1.
    // Native identity is isolated before test imports: ambient Codex/Claude
    // IDs must not conflict with fixture IDs or prove fixture lock ownership.
    // events-ledger-guard sets SO_EVENTS_LEDGER_SANDBOX to a per-run tmp file.
    // Without it every default-destination emitEvent — in-process or in a
    // script spawned with `cwd: <repo root>` — appends to the REAL
    // .orchestrator/metrics/events.jsonl with the live session id (#1397 item
    // 11; measured 2026-09-19: 10 lines from two test files). Only defaults that
    // would leave the temp root are redirected; tmp fixture roots are untouched.
    setupFiles: [
      './tests/setup/scrub-git-env.mjs',
      './tests/setup/scrub-session-env.mjs',
      './tests/setup/vault-guard.mjs',
      './tests/setup/host-alias-guard.mjs',
      './tests/setup/events-ledger-guard.mjs',
    ],
    // skills/vault-sync/tests/schema-drift.test.mjs intentionally excluded:
    // it requires a sibling projects-baseline checkout (HAS_CANONICAL) and
    // ALL 5 tests skip in CI anyway. In vitest 2.1.9 + tinypool, discovering
    // a test file where every test is skipped leaves the worker hung at exit
    // → CI job hits 15m timeout despite all real tests passing (#268).
    // The schema-drift gate is enforced by the .gitlab-ci.yml `schema-drift`
    // stage via the sync-vault-schema.mjs script directly, not via vitest.
    // Local dev can still run: `npx vitest skills/vault-sync/tests/schema-drift.test.mjs`.
    // CI override (30 s) tolerates concurrent-Claude CPU starvation on the
    // shared Mac shell-executor runner (testing.md > Shared-Hardware Runner
    // Contention, #392 cautionary tale, #408 mitigation). Local dev keeps
    // 10 s for fast hang detection. Per testing.md: 30 s is the ceiling
    // — do not push higher as a default.
    testTimeout: process.env.CI ? 30000 : 10000,
    // pool: 'forks' + teardownTimeout are belt+suspenders hardening against
    // tinypool worker-exit hangs. Integration tests spawn subprocesses (hooks,
    // registry, snapshots); process-fork pool has cleaner teardown than the
    // default thread pool, and the timeout kills a stuck worker in 15s
    // instead of letting the CI job hit its 15m timeout.
    pool: 'forks',
    // Integration workers spawn Node/npm/git children of their own, so using
    // every core can overcommit a busy host (#1360): the unchanged full suite
    // took 220s with timing failures at 11 workers, versus 150s all-passing at
    // 4. The bound is OPT-IN rather than global, because it is not free — on an
    // idle 12-core host the same suite measured 87s unbounded (677% CPU) versus
    // 138s at 4 workers (317% CPU), both 678 files / 17347 passed / 0 failed
    // (2026-09-13, A/B back-to-back on one machine). Paying +59% on every local
    // `npm test` to insure against a contention failure that only appears under
    // load is the wrong trade; scoping it to the gate keeps both properties.
    //
    // `runGate()` in scripts/lib/quality-gate.mjs sets SO_BOUNDED_WORKERS=1 for
    // every gate subprocess, so the pre-push and release gates — the runs where
    // #1360's timeouts were actually observed — get the bound, and a bare
    // `npm test` keeps Vitest's own default. Same conditional idiom as
    // `testTimeout` two lines up.
    //
    // NAMED CEILING (BV-004): 4 is the value #1360 measured, not a derived
    // optimum. Revisit when a gate run times out WITH the bound applied, or
    // when the host class changes (the measurements above are one 12-core
    // machine).
    ...(process.env.SO_BOUNDED_WORKERS
      ? { maxWorkers: Math.min(4, Math.max(availableParallelism() - 1, 1)) }
      : {}),
    teardownTimeout: 15000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary', 'cobertura'],
      include: ['scripts/lib/**/*.mjs', 'hooks/**/*.mjs'],
      exclude: [
        '**/__tests__/**',
        '**/*.test.mjs',
        '**/*.spec.mjs',
        'scripts/lib/vault-sync/**',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60,
      },
    },
  },
});
