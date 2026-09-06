/**
 * tests/hooks/hooks-run-without-node-modules.test.mjs
 *
 * TV-001 — THE BUG THIS CATCHES, named exactly:
 *
 *   `scripts/lib/owner-yaml.mjs` carried a STATIC `import yaml from 'js-yaml'`.
 *   That module sits on the import graph of four hooks — on-session-start,
 *   on-session-end, post-edit-validate, skill-invocation-telemetry — so for
 *   every user whose `node_modules` was absent (skipped / interrupted
 *   `npm install`, half-synced plugin cache, EPERM sandbox) all four died at
 *   MODULE-LOAD time with `ERR_MODULE_NOT_FOUND: Cannot find package 'js-yaml'`
 *   and exit 1, on every single turn.
 *   GH#62 (runtime imports not declared in dependencies) / GH#63 (degrade
 *   gracefully when hook dependencies are missing) / GitLab #1230.
 *
 *   Measured 2026-09-06 @ e4674109, BEFORE the fix, with `hooks/` + `scripts/`
 *   copied to a tmp dir with no `node_modules` anywhere up the tree:
 *     FAIL rc=1 on-session-end.mjs           missing=js-yaml
 *     FAIL rc=1 on-session-start.mjs         missing=js-yaml
 *     FAIL rc=1 post-edit-validate.mjs       missing=js-yaml
 *     FAIL rc=1 skill-invocation-telemetry.mjs missing=js-yaml
 *   AFTER the fix (lazy `createRequire('js-yaml')` inside loadOwnerConfig /
 *   writeOwnerConfig) all 27 hooks exit 0.
 *
 * WHY THE EXISTING SUITE MISSED IT (the TV-001 falsification):
 *   Every other hook test runs from the repo, where `node_modules` always
 *   exists — the crash is unreachable there. `tests/hooks/on-stop.test.mjs`
 *   does build a dep-less sandbox, but only for on-stop.mjs, whose subgraph was
 *   already bare-free; and its static-import guard reads SOURCE TEXT, so it
 *   would happily accept a lazy `require()` of a package that does not exist.
 *   Only actually EXECUTING every hook without `node_modules` discriminates.
 *
 * WHY zx IS NOT ASSERTED SEPARATELY: `scripts/lib/worktree/listing.mjs` is the
 * hook graph's other bare specifier (reachable from on-session-start), but its
 * `zx` imports are already lazy + caught, so it never crashes a hook. Measured
 * the same day by installing a `js-yaml` stub alone: all four hooks reached
 * rc=0 with `zx` still absent. The zx half of GitLab #1230 is stale.
 *
 * SANDBOX HYGIENE (d7/d8 measured leaks): a hook run from a scratch dir will
 * otherwise write into the operator's REAL host-private config, session
 * registry, vault and telemetry endpoint. Every one of those destinations is
 * redirected into the tmp dir below, and telemetry is hard-disabled.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * Hooks whose payload needs a non-default `hook_event_name`. Everything absent
 * from this map is dispatched as `PreToolUse`, which is what `hooks.json`
 * registers for the majority. Derived from `hooks/hooks.json`.
 */
const HOOK_EVENTS = {
  'cwd-change-restore.mjs': 'CwdChanged',
  'loop-guard.mjs': 'PostToolUse',
  'on-session-end.mjs': 'SessionEnd',
  'on-session-start.mjs': 'SessionStart',
  'on-stop.mjs': 'Stop',
  'operator-steer.mjs': 'PostToolBatch',
  'post-bash-write-verify.mjs': 'PostToolUse',
  'post-edit-import-probe.mjs': 'PostToolUse',
  'post-edit-validate.mjs': 'PostToolUse',
  'post-subagent-discovery-validator.mjs': 'SubagentStop',
  'post-tool-batch-wave-signal.mjs': 'PostToolBatch',
  'post-tool-failure-corrective-context.mjs': 'PostToolUseFailure',
  'post-tooluse-frontend-slop.mjs': 'PostToolUse',
  'subagent-telemetry.mjs': 'SubagentStop',
};

/** @type {string[]} tmp roots to remove in afterAll. */
const created = [];

/**
 * Build a COPY of `hooks/` + `scripts/` + `package.json` in a tmp dir with no
 * `node_modules` anywhere up the tree — Node's resolver walks upward from the
 * importing module, so a copy is the only faithful way to reproduce the
 * skipped-install state.
 *
 * The sandbox is `git init`-ed on purpose: `hooks/wave-scope-commit-guard.mjs`
 * runs `execSync('git rev-parse --show-toplevel')` unguarded and dies rc=1 in a
 * non-repo. That is a real but SEPARATE defect (no dependency involved); leaving
 * it in would make this test red for a reason it does not name.
 */
async function makeSandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hooks-nodeps-'));
  created.push(root);
  for (const entry of ['hooks', 'scripts']) {
    await fs.cp(path.join(REPO_ROOT, entry), path.join(root, entry), { recursive: true });
  }
  await fs.cp(path.join(REPO_ROOT, 'package.json'), path.join(root, 'package.json'));
  for (const d of ['proj', 'home', 'cfg', 'vault', 'registry', 'tmp']) {
    await fs.mkdir(path.join(root, d), { recursive: true });
  }
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  return root;
}

/** Spawn one SANDBOX hook (never the repo copy) and collect rc + stderr. */
function runHook(root, hookFile) {
  const event = HOOK_EVENTS[hookFile] ?? 'PreToolUse';
  const payload = JSON.stringify({
    hook_event_name: event,
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    session_id: 't',
    cwd: path.join(root, 'proj'),
  });

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'hooks', hookFile)], {
      cwd: root,
      env: {
        ...process.env,
        // Nothing may reach the operator's real config / registry / vault /
        // telemetry endpoint — d7 measured a session-registry leak and d8 six
        // production telemetry pings from exactly this kind of sandbox run.
        HOME: path.join(root, 'home'),
        CLAUDE_PROJECT_DIR: path.join(root, 'proj'),
        SO_CONFIG_HOME: path.join(root, 'cfg'),
        SO_VAULT_DIR: path.join(root, 'vault'),
        SO_SESSION_REGISTRY_DIR: path.join(root, 'registry'),
        SO_TELEMETRY_DISABLED: '1',
        DO_NOT_TRACK: '1',
        TMPDIR: path.join(root, 'tmp'),
        CLANK_EVENT_SECRET: undefined,
        CLANK_EVENT_URL: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ hook: hookFile, code, stderr }));
    child.stdin.end(payload);
  });
}

afterAll(async () => {
  for (const root of created) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// Windows resolves paths and spawns `git`/node differently enough that a red
// result there would be about the harness, not about the import graph.
describe.skipIf(process.platform === 'win32')(
  'every hook loads without node_modules (GH#62/#63, GitLab #1230)',
  { timeout: 60000 },
  () => {
    it('no hook exits non-zero or throws ERR_MODULE_NOT_FOUND', async () => {
      const root = await makeSandbox();
      const hooks = (await fs.readdir(path.join(root, 'hooks')))
        .filter((f) => f.endsWith('.mjs'))
        .sort();

      // Guard the guard: if the copy silently produced nothing, an empty
      // `results` array would make every assertion below vacuously true.
      expect(hooks.length).toBeGreaterThanOrEqual(27);
      await expect(fs.access(path.join(root, 'node_modules'))).rejects.toThrow();

      const results = await Promise.all(hooks.map((h) => runHook(root, h)));

      // Report the offenders by NAME — a bare "27 !== 26" tells the next
      // reader nothing about which hook regressed or which package it wants.
      const crashed = results
        .filter((r) => r.code !== 0)
        .map((r) => `${r.hook} rc=${r.code} ${(r.stderr.match(/Cannot find package '[^']+'/) ?? [''])[0]}`.trim());
      expect(crashed).toEqual([]);

      const moduleNotFound = results
        .filter((r) => r.stderr.includes('ERR_MODULE_NOT_FOUND'))
        .map((r) => r.hook);
      expect(moduleNotFound).toEqual([]);
    });
  },
);
