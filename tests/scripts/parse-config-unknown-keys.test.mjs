/**
 * tests/scripts/parse-config-unknown-keys.test.mjs
 *
 * NAMED BUG (#1562): a typo'd top-level Session Config key (`persistance: true`)
 * parses as a well-formed line, lands in the KV map under a name nothing reads,
 * and the real key silently keeps its default — no stderr line anywhere. The
 * template even said so: "Fields not listed here are silently ignored".
 * parse-config.mjs now names every local top-level key absent from the
 * plugin's own docs/session-config-template.md — a report, never a refusal,
 * and stdout never changes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'parse-config.mjs');
const REPORT = 'unknown Session Config key';

let sandbox;
beforeEach(() => { sandbox = mkdtempSync(join(tmpdir(), 'so-unknown-keys-')); });
afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });

function block(enforcement, { typo = true } = {}) {
  return [
    '# Fixture',
    '',
    '## Session Config',
    '',
    `enforcement: ${enforcement}`,
    'waves: 5',
    ...(typo ? ['persistance: true'] : []),
    '<!--',
    'commented-typo: true',
    '-->',
    'vault-integration:',
    '  enabled: true',
    '  nested-child-not-top-level: 1',
    '',
  ].join('\n');
}

function run(content, script = SCRIPT) {
  const file = join(sandbox, 'CLAUDE.md');
  writeFileSync(file, content);
  return spawnSync('node', [script, file], {
    encoding: 'utf8',
    env: { ...process.env, SO_SKIP_CONFIG_VALIDATION: '1' },
  });
}

const typoLine = block('warn').split('\n').indexOf('persistance: true') + 1;

describe('parse-config.mjs unknown top-level keys (#1562)', () => {
  it('warn: names file, line and key on stderr; exit 0; stdout identical to the run without the typo', () => {
    const withTypo = run(block('warn'));
    const clean = run(block('warn', { typo: false }));
    expect(withTypo.status).toBe(0);
    expect(withTypo.stderr).toContain(`CLAUDE.md:${typoLine}: ${REPORT} 'persistance'`);
    expect(withTypo.stdout).toBe(clean.stdout);
  });

  it('only the typo is reported: not a key inside <!-- -->, not a known key, not an indented child', () => {
    expect(reportedLines(run(block('warn')).stderr)).toHaveLength(1);
    expect(reportedLines(run(block('warn', { typo: false })).stderr)).toEqual([]);
  });

  it('strict: still a report, never a refusal (exit 0, JSON on stdout)', () => {
    const r = run(block('strict'));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`${REPORT} 'persistance'`);
    expect(JSON.parse(r.stdout).enforcement).toBe('strict');
  });

  it('off: silent', () => {
    const r = run(block('off'));
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain(REPORT);
  });

  it('template missing: one line says the check did not run — never silence that reads as clean', () => {
    // A copy of scripts/ with no docs/ beside it — parse-config resolves the
    // template relative to its own location.
    const tree = join(sandbox, 'plugin');
    cpSync(join(REPO_ROOT, 'scripts'), join(tree, 'scripts'), { recursive: true });
    const r = run(block('warn'), join(tree, 'scripts', 'parse-config.mjs'));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('unknown Session Config key check did not run');
    expect(r.stderr).toContain('it was not found');
    expect(r.stderr).not.toContain(`${REPORT} 'persistance'`);
  });
});

function reportedLines(stderr) {
  return stderr.split('\n').filter((l) => l.includes(REPORT));
}
