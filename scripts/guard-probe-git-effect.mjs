#!/usr/bin/env node
/**
 * guard-probe-git-effect.mjs — execute synthetic `{D}` guard-probe cases, each
 * in its own fresh scratch repo with a fully replaced environment (#1943).
 * Library: scripts/lib/guard-probe/git-effect.mjs.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { isMainModule } from './lib/is-main-module.mjs';
import {
  GitEffectInputError,
  assertNotReplayCorpus,
  makeScratch,
  runCase,
  vetCase,
} from './lib/guard-probe/git-effect.mjs';

const HELP = `Usage: node scripts/guard-probe-git-effect.mjs --cases <file> [--json] [--timeout-ms N]

Run synthetic guard-probe cases and report what each did to its scratch repo.

A case is a TEMPLATE: the only path it may name is {D} (its scratch repo) or a
relative path. Every case is vetted fail-closed first: no absolute paths, cd,
~, $-expansion, command substitution, git -C/--git-dir/--work-tree, network
git subcommands, and no command word other than git, echo, printf, true,
false, test, [ and :. Only vetted cases run, each in a fresh
<tmpdir>/so-git-effect-*/repo with HOME=scratch and no inherited environment.

A file carrying the replay-corpus marker is refused: real fleet commands are
for read-only replay readers, never for an executing probe.

Options:
  --cases <file>     JSON array of template strings, or { "cases": [...] }
  --json             print one JSON array instead of one line per case
  --timeout-ms <N>   per-case timeout (default 10000)
  -h, --help         show this help

Exit codes: 0 ran (rejected cases are results, not errors), 1 input error
(bad args, unreadable/invalid file, replay corpus), 2 system error.

Example:
  node scripts/guard-probe-git-effect.mjs --cases cases.json --json
  cases.json: ["git switch -c probe", "git add {D}/README"]`;

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        cases: { type: 'string' },
        json: { type: 'boolean', default: false },
        'timeout-ms': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    process.stderr.write(`guard-probe-git-effect: ${err.message}\n`);
    return 1;
  }
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!values.cases) {
    process.stderr.write('guard-probe-git-effect: --cases <file> is required (see --help)\n');
    return 1;
  }
  const timeoutMs = values['timeout-ms'] === undefined ? 10_000 : Number(values['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write('guard-probe-git-effect: --timeout-ms must be a positive integer\n');
    return 1;
  }

  let templates;
  try {
    templates = assertNotReplayCorpus(readFileSync(values.cases));
  } catch (err) {
    const msg = err instanceof GitEffectInputError ? err.message : `cannot read cases file (${err.code ?? 'error'})`;
    process.stderr.write(`guard-probe-git-effect: ${msg}\n`);
    return 1;
  }

  const results = [];
  try {
    for (const template of templates) {
      const pre = vetCase(template);
      if (!pre.ok) {
        results.push({ template, vetted: false, reason: pre.reason });
        continue;
      }
      const { scratch, cleanup } = makeScratch();
      try {
        const vetted = vetCase(template, { scratch });
        if (!vetted.ok) {
          results.push({ template, vetted: false, reason: vetted.reason });
          continue;
        }
        const r = runCase(vetted.command, { scratch, timeoutMs });
        results.push({ template, vetted: true, exitCode: r.exitCode, ...(r.signal ? { signal: r.signal } : {}), gitStatusAfter: r.gitStatusAfter });
      } finally {
        cleanup();
      }
    }
  } catch (err) {
    process.stderr.write(`guard-probe-git-effect: ${err.message}\n`);
    return 2;
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    for (const r of results) {
      const verdict = r.vetted ? `ran exit=${r.exitCode}${r.signal ? ` signal=${r.signal}` : ''}` : `rejected: ${r.reason}`;
      process.stdout.write(`${verdict}\t${r.template}\n`);
      if (r.vetted) process.stdout.write(`  status: ${r.gitStatusAfter.trim().split('\n').join(' | ')}\n`);
    }
  }
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main();
