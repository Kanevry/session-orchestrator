/**
 * tests/eval/eval-session-append-exit.test.mjs
 *
 * Pins the append-failure exit contract of scripts/eval-session.mjs (GitLab #969).
 *
 * The bug: `appendEvalRecord` is a never-throw sink returning
 * `{ ok:false, reason }`. The CLI logged that WARN and still exited **0**, so a
 * caller saw success while the eval journal had no record.
 *
 * Two things must hold together, which is why every case asserts BOTH the exit
 * code AND stdout. A bare exit-code assertion would stay green if the payload
 * were dropped by a `console.log` + `process.exit()` regression (stdout is async
 * on a pipe on macOS — the #906 truncation shape), and a bare stdout assertion
 * would stay green if the exit code fell back to 0. Neither half is sufficient.
 *
 * Unwritable-target technique: the append target `<metricsDir>/eval.jsonl` is
 * created as a DIRECTORY, so `appendFileSync` fails fast with EISDIR for every
 * uid — root included (CI runs as uid 0). `chmod` is not usable here because
 * root ignores the permission bits, and `tests/_helpers/unwritable-path.mjs`
 * (/dev/null/<sub>) is not usable either: `--metrics-dir` is ALSO the read path,
 * so an unwritable dir fails at session resolution (exit 1, "no session records
 * found") and never reaches the append.
 *
 * Not covered here on purpose (TV-004 duplication check): the success path
 * (exit 0 + a written journal line) is already pinned by
 * tests/eval/verify.test.mjs § "appends a JSON record and exits 0".
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scenarioCleanCompleted } from '../fixtures/eval/metrics-tree/build.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../../scripts/eval-session.mjs');

const dirsToClean = [];

afterEach(() => {
  while (dirsToClean.length) {
    const dir = dirsToClean.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function runCli(args) {
  const env = { ...process.env };
  delete env.ANTHROPIC_MODEL; // deterministic model source
  const res = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('eval-session CLI — a failed append must not exit 0 (#969)', () => {
  it('exits 2 (system error) when the journal cannot be written, and still emits the record', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);
    // Occupy the append target with a directory → appendFileSync EISDIR (any uid).
    mkdirSync(path.join(fx.dir, 'eval.jsonl'), { recursive: true });

    const r = runCli(['--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-id', 'm', '--json']);

    expect(r.status).toBe(2);
    // Condition 1: the payload survives the non-zero exit — parseable, complete.
    const record = JSON.parse(r.stdout);
    expect(record.session_id).toBe('sess-clean');
    expect(record.dimensions.length).toBeGreaterThan(0);
    expect(r.stderr).toContain('append failed (fs-error)');
  });

  it('exits 1 (user error) when the record fails validation, and still emits the record', () => {
    const fx = scenarioCleanCompleted();
    dirsToClean.push(fx.dir);

    // `--handle ""` survives the `?? null` default as an empty string and trips
    // "handle must be a non-empty string or null" in eval/schema.mjs. This is the
    // reachable-from-argv validation path, hence EXIT_USER rather than EXIT_SYSTEM.
    const r = runCli([
      '--metrics-dir', fx.dir, '--rubric', fx.rubricPath, '--model-id', 'm', '--handle', '', '--json',
    ]);

    expect(r.status).toBe(1);
    const record = JSON.parse(r.stdout);
    expect(record.session_id).toBe('sess-clean');
    expect(r.stderr).toContain('append failed (validation)');
  });
});
