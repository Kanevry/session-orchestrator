/**
 * tests/hooks/post-edit-import-probe.test.mjs
 *
 * hooks/post-edit-import-probe.mjs — PostToolUse probe for a broken
 * hook-reachable module (GitLab #1224).
 *
 * Fixture strategy: each test builds a throwaway "project" in a tmp dir
 * (CLAUDE_PROJECT_DIR) carrying its own `hooks/_lib/hook-import-set.json`
 * allowlist, its own minimal flat `eslint.config.mjs`, and the module under
 * test. The tmp project has NO node_modules — the hook falls back to the REAL
 * plugin root's vendored ESLint binary, which is precisely the resolution order
 * a consumer repo exercises. Nothing is written inside the repo under test.
 *
 * Each case names the bug it catches:
 *   (i)   the 2026-09-04 incident shape — a call to an undefined function
 *   (ii)  false-positive guard — the same call with the definition BELOW it
 *         (hoisting) must stay silent, else the probe cries wolf on every edit
 *   (iii) load-time throw — invisible to ESLint, caught by the import check
 *         (this case caught a real RangeError: spawnSync rejects a fractional
 *         timeout, which silently swallowed the whole import check)
 *   (iv)  a module NOT in the allowlist must not spawn anything
 *   (v)   a module that hangs on import must not hang the hook
 *   (vi)  malformed stdin must not crash the hook
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(REPO_ROOT, 'hooks', 'post-edit-import-probe.mjs');

const ESLINT_CONFIG = `export default [
  { files: ["**/*.mjs"], languageOptions: { ecmaVersion: 2024, sourceType: "module" }, rules: { "no-undef": "error" } },
];
`;

let projectDir;

/**
 * Create the tmp project and write one module under scripts/lib/, registering
 * it in the allowlist unless `inSet` is false.
 *
 * @param {{name?: string, source: string, inSet?: boolean}} opts
 * @returns {string} absolute path of the written module
 */
function fixture({ name = 'broken.mjs', source, inSet = true }) {
  mkdirSync(path.join(projectDir, 'hooks', '_lib'), { recursive: true });
  mkdirSync(path.join(projectDir, 'scripts', 'lib'), { recursive: true });
  writeFileSync(path.join(projectDir, 'eslint.config.mjs'), ESLINT_CONFIG, 'utf8');
  const rel = `scripts/lib/${name}`;
  const abs = path.join(projectDir, rel);
  writeFileSync(abs, source, 'utf8');
  writeFileSync(
    path.join(projectDir, 'hooks', '_lib', 'hook-import-set.json'),
    JSON.stringify({
      generated_at: '2026-09-05T00:00:00.000Z',
      head: 'test',
      entries: inSet
        ? [{ file: rel, reachable_from: ['enforce-scope.mjs', 'enforce-commands.mjs'] }]
        : [{ file: 'scripts/lib/unrelated.mjs', reachable_from: ['enforce-scope.mjs'] }],
    }, null, 2),
    'utf8',
  );
  return abs;
}

/**
 * Spawn the hook with a PostToolUse payload and collect its output.
 *
 * @param {string|object} payload - JSON payload, or a raw string for the malformed case
 * @param {Record<string,string>} [extraEnv]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, ms: number}>}
 */
function runHook(payload, extraEnv = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

/** PostToolUse Edit payload for an absolute file path. */
const editPayload = (file) => ({ tool_name: 'Edit', tool_input: { file_path: file } });

beforeEach(() => {
  // realpath the tmp root: on macOS `/tmp` is a symlink to `/private/tmp`, and
  // an unresolved project dir makes every `import.meta.url === <argv[1] URL>`
  // main-guard fail to match for reasons that have nothing to do with the code
  // under test — case (vii) would then pass vacuously.
  projectDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'import-probe-')));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('post-edit-import-probe', () => {
  it('(i) reports a call to an undefined function in a hook-reachable module', async () => {
    // The 2026-09-04 incident shape: valid syntax, module-level import succeeds,
    // ReferenceError only when a hook CALLS the exported function.
    const file = fixture({ source: 'export function a(x) { return b(x); }\n' });
    const { code, stdout } = await runHook(editPayload(file));

    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('scripts/lib/broken.mjs');
    expect(out.hookSpecificOutput.additionalContext).toContain('no-undef');
    expect(out.hookSpecificOutput.additionalContext).toContain('enforce-scope.mjs');
    expect(out.systemMessage).toContain('import-probe FAILED');
  }, 30_000);

  it('(ii) stays silent when the callee is declared LATER in the file (hoisting)', async () => {
    const file = fixture({
      source: 'export function a(x) { return b(x); }\nfunction b(y) { return y; }\n',
    });
    const { code, stdout } = await runHook(editPayload(file));

    expect(code).toBe(0);
    expect(stdout).toBe('');
  }, 30_000);

  it('(iii) reports a load-time throw that ESLint cannot see', async () => {
    const file = fixture({ source: 'throw new Error("boom");\n' });
    const { code, stdout } = await runHook(editPayload(file));

    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain('Error: boom');
  }, 30_000);

  it('(iv) does not run any check for a module outside the hook-reachable set', async () => {
    const file = fixture({ source: 'export function a(x) { return b(x); }\n', inSet: false });
    // SO_IMPORT_PROBE_TRACE marks the point where the gates are passed; its
    // absence proves the membership gate short-circuited before any spawn.
    const { code, stdout, stderr } = await runHook(editPayload(file), { SO_IMPORT_PROBE_TRACE: '1' });

    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).not.toContain('probe:checks-start');
  }, 30_000);

  it('(v) exits 0 within the budget when the module hangs on import', async () => {
    const file = fixture({ source: 'for (;;) { /* hang */ }\n' });
    const { code, stdout, ms } = await runHook(editPayload(file));

    expect(code).toBe(0);
    // A killed child is not evidence of breakage — no warning, no hang.
    expect(stdout).toBe('');
    // BUDGET_MS is 3 s; 8 s is spawn + cold-start headroom. A 15 s ceiling
    // would have passed with the budget wired to nothing at all.
    expect(ms).toBeLessThan(8_000);
  }, 30_000);

  it('(vi) exits 0 on malformed stdin', async () => {
    fixture({ source: 'export const ok = 1;\n' });
    const { code, stdout } = await runHook('not json at all');

    expect(code).toBe(0);
    expect(stdout).toBe('');
  }, 30_000);

  it('(vii) never EXECUTES the module\'s CLI main() while importing it', async () => {
    // The bug: the import check passed the target as argv[1], which satisfies
    // the `import.meta.url === pathToFileURL(process.argv[1]).href` main-guard
    // that many modules carry — so the probe RAN their CLI (measured:
    // scripts/lib/sunset/walker.mjs walked the repo for 3.9 s, then SIGTERM).
    const marker = path.join(projectDir, 'MAIN-RAN');
    const file = fixture({
      name: 'with-main.mjs',
      source: [
        "import { writeFileSync } from 'node:fs';",
        "import { pathToFileURL } from 'node:url';",
        'export function lib() { return 1; }',
        `function main() { writeFileSync(${JSON.stringify(marker)}, 'ran'); }`,
        // `globalThis.process` (not bare `process`): the fixture's flat config
        // declares no node globals, and a bare `process` would trip no-undef —
        // turning this case into an ESLint test instead of a main-guard test.
        'if (import.meta.url === pathToFileURL(globalThis.process.argv[1] ?? \'\').href) main();',
        '',
      ].join('\n'),
    });
    const { code, stdout } = await runHook(editPayload(file));

    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(marker), 'the probe must not execute the module\'s main()').toBe(false);
  }, 30_000);

  it('(viii) skips the ESLint check silently when no ESLint is resolvable', async () => {
    // In an npm-installed consumer repo the plugin root carries no devDeps, so
    // the primary check must degrade to a traced no-op — never to a crash and
    // never to an invented finding.
    const file = fixture({ source: 'export function a(x) { return b(x); }\n' });
    const { code, stdout, stderr } = await runHook(editPayload(file), {
      SO_IMPORT_PROBE_ESLINT: '',
      SO_IMPORT_PROBE_TRACE: '1',
    });

    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('probe:eslint-unavailable');
  }, 30_000);

  it('(ix) reports its OWN breakage on stderr while still exiting 0', async () => {
    // `main().catch(() => {})` swallowed every internal fault, so a probe that
    // had stopped working looked exactly like a probe with nothing to report.
    // A NUL byte in the payload path makes spawnSync throw a TypeError — a real
    // internal fault, reached through the hook's real input surface.
    const rel = `scripts/lib/bad${String.fromCharCode(0)}.mjs`;
    mkdirSync(path.join(projectDir, 'hooks', '_lib'), { recursive: true });
    writeFileSync(
      path.join(projectDir, 'hooks', '_lib', 'hook-import-set.json'),
      JSON.stringify({ entries: [{ file: rel, reachable_from: ['enforce-scope.mjs'] }] }),
      'utf8',
    );
    const { code, stdout, stderr } = await runHook(
      editPayload(path.join(projectDir, rel)),
    );

    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('post-edit-import-probe:');
  }, 30_000);
});
