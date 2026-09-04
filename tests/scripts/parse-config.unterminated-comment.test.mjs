/**
 * tests/scripts/parse-config.unterminated-comment.test.mjs
 *
 * One defect, two halves (W4b P2):
 *
 *   (a) An UNTERMINATED `<!--` put the shared HTML-comment skipper in the
 *       swallowing state for the rest of the document, so every block below it
 *       vanished and each parser fell back to its DEFAULT — `config-protection`
 *       silently degrading `strict` → `warn`, i.e. a guard disarmed by a typo
 *       with no error anywhere. `stripHtmlCommentBlocks` now fails CLOSED.
 *   (b) Failing closed keeps the config correct but still leaves the operator
 *       unaware the document is malformed, so parse-config.mjs — the
 *       session-start surface that reads CLAUDE.md — emits ONE stderr WARN.
 *
 * Exit code must stay unchanged: this is a report, never a gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _parseConfigProtection } from '@lib/config/config-protection.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'parse-config.mjs');

const UNTERMINATED = `# Test

<!-- dangling opener, never closed

## Session Config

persistence: true
enforcement: warn
waves: 5
agents-per-wave: 6
config-protection:
  enabled: true
  mode: strict
`;

const TERMINATED = UNTERMINATED.replace(
  '<!-- dangling opener, never closed',
  '<!-- properly closed -->',
);

function runParseConfig(cwd, content) {
  writeFileSync(join(cwd, 'CLAUDE.md'), content, 'utf8');
  return spawnSync('node', [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SO_SKIP_CONFIG_VALIDATION: '1' },
  });
}

let sandbox;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pc-unterminated-'));
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('parse-config.mjs — unterminated <!-- gate', () => {
  it('keeps config-protection at strict instead of degrading it to warn', () => {
    // The security half. Before the fail-closed fix the whole block below the
    // dangling opener was stripped and this returned {enabled:false,mode:'warn'}.
    expect(_parseConfigProtection(UNTERMINATED)).toEqual({ enabled: true, mode: 'strict' });
  });

  it('warns on stderr naming the config file and the opener line, exit code unchanged', () => {
    const res = runParseConfig(sandbox, UNTERMINATED);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain(
      'CLAUDE.md: unterminated <!-- at line 3 — comment stripping disabled for the whole document',
    );
    // stdout is still a parseable config envelope — the WARN is not a gate.
    expect(JSON.parse(res.stdout).waves).toBe(5);
  });

  it('stays silent for a terminated comment (the WARN discriminates, it does not always fire)', () => {
    const res = runParseConfig(sandbox, TERMINATED);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('unterminated <!--');
    expect(_parseConfigProtection(TERMINATED)).toEqual({ enabled: true, mode: 'strict' });
  });
});
