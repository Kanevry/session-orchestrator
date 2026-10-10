import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CASE_ID = 'sec-007-sql-parameterisation';

it('preserves unknown ablation costs without losing real zero costs or reporting incomplete totals', () => {
  const scratch = join(tmpdir(), 'so-da3');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'ablation-cost-'));
  try {
    const scenarios = [
      { name: 'mixed', costs: [undefined, 0, 1.23456, null], expected: [null, 0, 1.2346, null], total: 'unknown' },
      { name: 'zero', costs: [0, 0], expected: [0, 0], total: '0.00' },
      { name: 'known', costs: [1.23456, 0], expected: [1.2346, 0], total: '1.23' },
    ];
    // Copy the runner byte-for-byte: its results directory is relative to its
    // own path. Only imports resolve through the scripts link to this repo.
    const runs = scenarios.map((scenario) => {
      const cwd = join(root, scenario.name);
      const here = join(cwd, 'evals', 'instruction-ablation');
      const bin = join(cwd, 'bin');
      const calls = join(cwd, 'calls.jsonl');
      mkdirSync(join(here, 'cases'), { recursive: true });
      mkdirSync(bin);
      cpSync(join(REPO, 'evals', 'instruction-ablation', 'run.mjs'), join(here, 'run.mjs'));
      cpSync(join(REPO, 'evals', 'instruction-ablation', 'cases', `${CASE_ID}.json`), join(here, 'cases', `${CASE_ID}.json`));
      symlinkSync(join(REPO, 'scripts'), join(cwd, 'scripts'), 'dir');
      writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const run = Number(process.cwd().match(/__r(\\d+)$/)[1]);
const responses = JSON.parse(process.env.ABLATION_RESPONSES);
fs.appendFileSync(process.env.ABLATION_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
fs.writeFileSync('query.js', "export const getUserByName = (name) => client.query('SELECT * FROM users WHERE name = $1', [name]);\\n");
process.stdout.write(JSON.stringify(responses[run - 1]));
`, { mode: 0o755 });
      const env = {
        PATH: bin,
        ABLATION_CALLS: calls,
        ABLATION_RESPONSES: JSON.stringify(scenario.costs.map((cost) => ({
          result: 'query.js written', usage: { input_tokens: 10, output_tokens: 2 },
          ...(cost === undefined ? {} : { total_cost_usd: cost }),
        }))),
      };
      for (const key of ['HOME', 'NAVIGATOR_CONFIG_DIR', 'SO_CONFIG_HOME', 'XDG_CONFIG_HOME', 'SO_VAULT_DIR', 'TMPDIR']) {
        env[key] = join(cwd, key.toLowerCase());
        mkdirSync(env[key]);
      }
      const result = spawnSync(process.execPath, [join(here, 'run.mjs'),
        '--rules-source', 'repo', '--variants', 'v2-no-rules', '--cases', CASE_ID,
        '--runs', String(scenario.costs.length)], {
        cwd, env, encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error, scenario.name).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const files = readdirSync(join(here, 'results'));
      expect(files).toHaveLength(1);
      const records = readFileSync(join(here, 'results', files[0]), 'utf8').trim().split('\n').map(JSON.parse);
      const invocations = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
      expect(invocations).toHaveLength(scenario.costs.length);
      for (const args of invocations) {
        expect(args[0]).toBe('-p');
        expect(args.slice(-2)).toEqual(['--output-format', 'json']);
      }
      expect(records.map((record) => record.pass)).toEqual(scenario.costs.map(() => true));
      return { scenario, result, records };
    });
    for (const { scenario, result, records } of runs) {
      expect(records.map((record) => record.cost_usd), scenario.name).toEqual(scenario.expected);
      const cellCosts = [...result.stderr.matchAll(/PASS \(([^)]+) USD\)/g)].map((match) => match[1]);
      expect(cellCosts, scenario.name).toEqual(scenario.expected.map((cost) => cost === null ? 'unknown' : String(cost)));
      expect(result.stdout.split('\n').find((line) => line.startsWith('total spend:'))).toBe(`total spend: USD ${scenario.total}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
