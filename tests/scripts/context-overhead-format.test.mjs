import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';
import {
  CONTEXT_OVERHEAD_HEADER,
  formatContextOverhead,
} from '../../scripts/lib/context-overhead-format.mjs';

const script = fileURLToPath(new URL('../../scripts/measure-context-overhead.sh', import.meta.url));
const usage = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 2 };
const fixtures = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) removeTree(fixture); });

// Synthetic responses target monetary edge cases; no live accounting or API call.
describe('context overhead cost provenance', () => {
  it.each([
    ['missing', {}, 'unknown', 'unknown'],
    ['null', { total_cost_usd: null }, 'unknown', 'unknown'],
    ['zero', { total_cost_usd: 0 }, '0.0000', 'unknown'],
    ['string', { total_cost_usd: '1.25' }, 'unknown', 'unknown'],
    ['missing basis', { total_cost_usd: 2, model: 'claude-opus-5' }, '2.0000', 'unknown'],
    ['invalid basis', { total_cost_usd: 2, cost_basis: 'measured' }, '2.0000', 'unknown'],
    ['explicit zero basis', { total_cost_usd: 0, cost_basis: 'api-list-equivalent' }, '0.0000', 'api-list-equivalent'],
    ['basis without amount', { cost_basis: 'api-list-equivalent' }, 'unknown', 'unknown'],
    ['basis with invalid amount', { total_cost_usd: -1, cost_basis: 'api-list-equivalent' }, 'unknown', 'unknown'],
  ])('formats %s without inventing cost or provenance', (_name, costFields, amount, basis) => {
    const row = formatContextOverhead(JSON.stringify({ usage, ...costFields }), 'sample');
    expect(row).toBe(`sample\t60\t20\t30\t2\t${amount}\t${basis}\n`);
    expect(row.trimEnd().split('\t')).toHaveLength(CONTEXT_OVERHEAD_HEADER.trimEnd().split('\t').length);
  });

  it('rejects numeric overflow without mistaking valid JSON for a parse failure', () => {
    expect(formatContextOverhead('{"total_cost_usd":1e400,"cost_basis":"api-list-equivalent"}', 'overflow'))
      .toBe('overflow\t0\t0\t0\t0\tunknown\tunknown\n');
  });

  it('keeps malformed JSON recognizable', () => {
    expect(formatContextOverhead('not JSON', 'broken')).toBe('broken\tPARSE-ERROR\n');
  });

  it('wires header and rows from another cwd while treating --header as a directory label', () => {
    const fixture = makeTmpDir('context-overhead-format-');
    fixtures.push(fixture);
    const bin = join(fixture, 'bin');
    const dirs = [join(fixture, 'sample'), join(fixture, '--header')];
    const home = join(fixture, 'home');
    const config = join(fixture, 'config');
    for (const dir of [bin, ...dirs, home, config]) mkdirSync(dir);
    // Bash builtin-only stub; checks actual production call arguments before emitting synthetic JSON.
    writeFileSync(join(bin, 'claude'), `#!/usr/bin/env bash
set -eu
[[ "$#" -eq 4 && "$1" == '-p' && "$2" == 'Antworte nur mit dem Wort: OK' && "$3" == '--output-format' && "$4" == 'json' ]] || exit 90
printf '%s\\n' '{"usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":2},"total_cost_usd":0,"cost_basis":"api-list-equivalent"}'
`, { mode: 0o755 });
    const result = spawnSync('bash', [script, ...dirs], {
      cwd: fixture,
      env: { ...process.env, HOME: home, NAVIGATOR_CONFIG_DIR: config, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8', timeout: 5000,
    });
    // Sandbox EPERM may coexist with plausible output/status; never count that as green.
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'LABEL\tCONTEXT_TOK\tcache_create\tcache_read\toutput\tUSD\tCOST_BASIS\n' +
      'sample\t60\t20\t30\t2\t0.0000\tapi-list-equivalent\n' +
      '--header\t60\t20\t30\t2\t0.0000\tapi-list-equivalent\n',
    );
  });
});
