/**
 * #1278: four worker suites each launched the complete repository validator.
 * Its 40 sequential children took up to 60s under CI coverage contention.
 * Run it once before workers and share the actual result, including on watch
 * reruns. This is an aggregate CLI budget, independent of test/hook timeouts.
 */
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './scrub-git-env.mjs';
import './scrub-session-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default function setup(project) {
  const validate = () => {
    // A failed watch rerun must never leave the previous successful receipt.
    project.provide('pluginValidation', null);
    const started = performance.now();
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/validate-plugin.mjs'), ROOT], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    const summaries = [...(result.stdout ?? '').matchAll(/^[ \t]*Results:[ \t]+(\d+)[ \t]+passed,[ \t]+(\d+)[ \t]+failed[ \t]*$/gm)];
    const summary = summaries[0];
    const passed = Number(summary?.[1]);
    const failed = Number(summary?.[2]);
    if (result.error || result.status !== 0 || summaries.length !== 1 ||
        !Number.isSafeInteger(passed) || !Number.isSafeInteger(failed) || passed < 18 || failed !== 0) {
      throw new Error([
        'validate-plugin.mjs failed before test workers started',
        `status=${result.status} signal=${result.signal ?? 'none'} error=${result.error?.message ?? 'none'}`,
        'Expected one Results summary with integer counts, at least 18 passed, 0 failed, and exit 0.',
        `stdout:\n${result.stdout || '<empty>'}`,
        `stderr:\n${result.stderr || '<empty>'}`,
      ].join('\n'));
    }
    project.provide('pluginValidation', {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    process.stdout.write(`[validate-plugin] ${summary[1]} passed, 0 failed before workers (${((performance.now() - started) / 1000).toFixed(2)}s)\n`);
  };

  // globalSetup itself runs only once in watch mode; this hook refreshes the
  // provided context before each subsequent worker run, even after a failure.
  project.onTestsRerun(validate);
  validate();
}
