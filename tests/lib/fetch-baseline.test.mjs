/**
 * tests/lib/fetch-baseline.test.mjs
 *
 * Vitest port of scripts/tests/fetch-baseline.bats
 * Subject: scripts/lib/fetch-baseline.sh
 *
 * Covers 4 exit-code paths:
 *   0 — 200 OK (network success)
 *   1 — auth failure (401/403) — fatal, no cache fallback
 *   2 — file not found (404, no cache)
 *   0 — network failure with seeded cache (fallback, warns)
 *
 * Approach: spawn `bash scripts/lib/fetch-baseline.sh` with a mock `curl`
 * prepended to PATH. The mock curl script is written into a temp dir for
 * each test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const FETCH_BASELINE_SH = join(REPO_ROOT, 'scripts/lib/fetch-baseline.sh');
const FIXTURE_SAMPLE_RULE = join(__dirname, 'fixtures/fetch-baseline/sample-rule.md');

// ---------------------------------------------------------------------------
// Helper: write a mock `curl` into mockDir and make it executable
//
//   httpCode  — HTTP status string printed to stdout (simulating -w '%{http_code}')
//   bodyFile  — path whose contents are copied to the -o destination (200 path)
//   exitCode  — curl transport exit code (0 = success, 7 = connection refused)
// ---------------------------------------------------------------------------
function installCurlMock(mockDir, httpCode, bodyFile, exitCode) {
  const bodyLine =
    bodyFile
      ? `[ -n "$out_path" ] && cp '${bodyFile}' "$out_path" || true`
      : `[ -n "$out_path" ] && printf '' > "$out_path" || true`;

  const script = `#!/usr/bin/env bash
# mock curl for fetch-baseline.test.mjs
out_path=""
args=("$@")
i=0
while [[ $i -lt \${#args[@]} ]]; do
  case "\${args[$i]}" in
    -o)
      i=$(( i + 1 ))
      out_path="\${args[$i]}"
      ;;
    -o*)
      out_path="\${args[$i]#-o}"
      ;;
  esac
  i=$(( i + 1 ))
done

if [[ "${exitCode}" != "0" ]]; then
  echo "mock: simulated transport failure (exit ${exitCode})" >&2
  exit ${exitCode}
fi

${bodyLine}

printf '%s' "${httpCode}"
`;

  const curlPath = join(mockDir, 'curl');
  writeFileSync(curlPath, script, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Helper: run fetch_baseline_file via bash subprocess
// ---------------------------------------------------------------------------
function runFetchBaseline({ mockDir, cacheDir, projectId, filePath, ref, dest }) {
  // We call bash and source fetch-baseline.sh, then invoke fetch_baseline_file
  const script = `
set +euo pipefail
source '${FETCH_BASELINE_SH}'
set +euo pipefail
fetch_baseline_file '${projectId}' '${filePath}' '${ref}' '${dest}'
`;

  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${mockDir}:${process.env.PATH}`,
      BASELINE_CACHE_DIR: cacheDir,
      GITLAB_TOKEN: 'test-token-do-not-use-in-real-calls',
    },
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('fetch-baseline.sh', () => {
  let tmpBase;
  let mockDir;
  let cacheDir;
  let destDir;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'fetch-baseline-test-'));
    mockDir = join(tmpBase, 'mocks');
    cacheDir = join(tmpBase, '.cache');
    destDir = join(tmpBase, 'output');
    mkdirSync(mockDir, { recursive: true });
    mkdirSync(destDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('200 OK: exits 0 and writes file matching fixture', () => {
    installCurlMock(mockDir, '200', FIXTURE_SAMPLE_RULE, 0);
    const dest = join(destDir, 'out.md');

    const result = runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest,
    });

    expect(result.status).toBe(0);
    expect(existsSync(dest)).toBe(true);
  });

  it('200 OK: dest file content matches fixture', () => {
    installCurlMock(mockDir, '200', FIXTURE_SAMPLE_RULE, 0);
    const dest = join(destDir, 'out.md');

    runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest,
    });

    const diff = spawnSync('diff', [dest, FIXTURE_SAMPLE_RULE], { encoding: 'utf8' });
    expect(diff.status).toBe(0);
  });

  it('200 OK: cache directory is created and contains an entry with project id', () => {
    installCurlMock(mockDir, '200', FIXTURE_SAMPLE_RULE, 0);
    const dest = join(destDir, 'out.md');

    runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest,
    });

    expect(existsSync(cacheDir)).toBe(true);
    const entries = readdirSync(cacheDir).filter((f) => f.includes('52'));
    expect(entries.length).toBe(1);
  });

  it('401 auth failure: exits 1 even when cache is seeded', () => {
    // Seed cache via a successful fetch first
    installCurlMock(mockDir, '200', FIXTURE_SAMPLE_RULE, 0);
    runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest: join(destDir, 'prime.md'),
    });

    // Now simulate 401
    installCurlMock(mockDir, '401', '', 0);
    const dest = join(destDir, 'auth-fail.md');

    const result = runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest,
    });

    expect(result.status).toBe(1);
  });

  it('401 auth failure: output mentions auth or GITLAB_TOKEN', () => {
    installCurlMock(mockDir, '200', FIXTURE_SAMPLE_RULE, 0);
    runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest: join(destDir, 'prime.md'),
    });

    installCurlMock(mockDir, '401', '', 0);
    const dest = join(destDir, 'auth-fail.md');

    const result = runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest,
    });

    const combined = result.stdout + result.stderr;
    expect(combined.toLowerCase()).toMatch(/auth|gitlab_token/i);
  });

  it('401 auth failure: dest file is NOT written (no cache fallback)', () => {
    installCurlMock(mockDir, '200', FIXTURE_SAMPLE_RULE, 0);
    runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest: join(destDir, 'prime.md'),
    });

    installCurlMock(mockDir, '401', '', 0);
    const dest = join(destDir, 'auth-fail.md');

    runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest,
    });

    expect(existsSync(dest)).toBe(false);
  });

  it('404 with no cache: exits 2', () => {
    installCurlMock(mockDir, '404', '', 0);
    const dest = join(destDir, 'missing.md');

    const result = runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest,
    });

    expect(result.status).toBe(2);
  });

  it('404 with no cache: output mentions "not found" or "404"', () => {
    installCurlMock(mockDir, '404', '', 0);
    const dest = join(destDir, 'missing.md');

    const result = runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest,
    });

    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not found|404/i);
  });

  it('404 with no cache: does not write dest file', () => {
    installCurlMock(mockDir, '404', '', 0);
    const dest = join(destDir, 'missing.md');

    runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest,
    });

    expect(existsSync(dest)).toBe(false);
  });

  it('network failure with seeded cache: exits 0 (cache fallback)', () => {
    // Seed cache
    installCurlMock(mockDir, '200', FIXTURE_SAMPLE_RULE, 0);
    runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest: join(destDir, 'prime.md'),
    });

    // Simulate transport failure (curl exit 7)
    installCurlMock(mockDir, '200', FIXTURE_SAMPLE_RULE, 7);
    const dest = join(destDir, 'offline-result.md');

    const result = runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest,
    });

    expect(result.status).toBe(0);
  });

  it('network failure with seeded cache: dest written from cache matches fixture', () => {
    installCurlMock(mockDir, '200', FIXTURE_SAMPLE_RULE, 0);
    runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest: join(destDir, 'prime.md'),
    });

    installCurlMock(mockDir, '200', FIXTURE_SAMPLE_RULE, 7);
    const dest = join(destDir, 'offline-result.md');

    runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest,
    });

    expect(existsSync(dest)).toBe(true);
    const diff = spawnSync('diff', [dest, FIXTURE_SAMPLE_RULE], { encoding: 'utf8' });
    expect(diff.status).toBe(0);
  });

  it('network failure with seeded cache: output warns about cache', () => {
    installCurlMock(mockDir, '200', FIXTURE_SAMPLE_RULE, 0);
    runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest: join(destDir, 'prime.md'),
    });

    installCurlMock(mockDir, '200', FIXTURE_SAMPLE_RULE, 7);
    const dest = join(destDir, 'offline-result.md');

    const result = runFetchBaseline({
      mockDir,
      cacheDir,
      projectId: '52',
      filePath: '.claude/rules/security.md',
      ref: 'main',
      dest,
    });

    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/cache|WARNING/i);
  });
});
