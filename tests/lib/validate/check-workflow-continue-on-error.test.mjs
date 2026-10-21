import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findJobLevelContinueOnError } from '@lib/validate/check-workflow-continue-on-error.mjs';

const SCRIPT = fileURLToPath(new URL('../../../scripts/lib/validate/check-workflow-continue-on-error.mjs', import.meta.url));
const FILE = '.github/workflows/test.yml';
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workflow continue-on-error boundary (#1712)', () => {
  it.each([
    ['true', true, true],
    ['false', false, false],
    ['${{ matrix.experimental }}', '${{ matrix.experimental }}', true],
    ['"false"', 'false', true],
    ['null', null, true],
    ['0', 0, true],
    [undefined, undefined, false],
  ])('rejects job-level %s unless literally false; step-level true is allowed', (source, value, rejected) => {
    const text = `jobs:\n  smoke:\n${source === undefined ? '' : `    continue-on-error: ${source}\n`}    steps:\n      - run: npm test\n        continue-on-error: true\n`;
    expect(findJobLevelContinueOnError(text, FILE)).toEqual(
      rejected ? [{ file: FILE, job: 'smoke', value }] : [],
    );
  });

  it.each([
    { name: 'invalid YAML', file: 'test.yml', text: 'jobs: [', status: 1, output: '  FAIL: .github/workflows/test.yml:', results: '0 passed, 1 failed' },
    { name: 'missing directory', status: 0, output: '  PASS: no workflows', results: '1 passed, 0 failed' },
    { name: 'valid .yaml', file: 'test.yaml', text: 'jobs:\n  smoke:\n    steps:\n      - run: npm test\n        continue-on-error: true\n', status: 0, output: '  PASS: .github/workflows/test.yaml: no job-level continue-on-error (1 jobs)', results: '1 passed, 0 failed' },
    { name: 'multiple job findings', file: 'test.yml', text: 'jobs:\n  smoke:\n    continue-on-error: true\n  suite:\n    continue-on-error: ${{ matrix.experimental }}\n', status: 1, output: "  FAIL: .github/workflows/test.yml: job 'smoke' sets job-level continue-on-error — its check run still concludes failure; move it to the step(s)", results: '0 passed, 2 failed' },
  ])('CLI: $name', ({ file, text, status, output, results }) => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-continue-on-error-'));
    roots.push(root);
    if (file) {
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      writeFileSync(join(root, '.github/workflows', file), text);
    }
    const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(status);
    expect(result.stdout).toContain(output);
    expect(result.stdout).toContain(`Results: ${results}`);
  });
});
