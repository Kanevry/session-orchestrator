/**
 * tests/commands/release-command.test.mjs
 *
 * Contract between `commands/release.md` and `scripts/release.mjs`.
 *
 * THE BUG THIS CATCHES (TV-001): the release doc names a flag that the script
 * does not (or no longer) parse. `parseArgs` in release.mjs runs in strict mode,
 * so an unknown option does not degrade gracefully — it throws
 * ERR_PARSE_ARGS_UNKNOWN_OPTION and the process exits 2. The operator finds out
 * mid-release, at the one moment the sequence must not be interrupted (see the
 * 3.18.0 state: tagged and GitHub-released, never published to npm).
 *
 * NOT A PROSE PIN. `.claude/rules/test-value.md` TV-002c and the
 * `check-test-value-bans` rule forbid asserting that a sentence exists in a
 * `.md` file. This asserts no wording. It extracts flag TOKENS and then asks
 * the REAL PARSER whether it knows each one, by executing the script.
 *
 * ORACLE — why "Unknown option", not the exit code. `--help` short-circuits
 * main() before any git/npm work, but parseArgs runs FIRST, so the three
 * outcomes are distinguishable and were verified empirically at 8984224:
 *
 *   node scripts/release.mjs --help --bogus-flag   → "Unknown option '--bogus-flag'"   exit 2
 *   node scripts/release.mjs --help --set-version  → "Option '--set-version <value>'
 *                                                     argument missing"                exit 2
 *   node scripts/release.mjs --help --check        → usage text                         exit 0
 *
 * A bare exit-code assertion would therefore be assert-nothing (cases A and B
 * share exit 2). Only the "Unknown option" discriminator separates "the parser
 * has never heard of this flag" from "the parser knows it and wants a value" —
 * and the second is a documented flag, not a defect. String-valued flags are
 * consequently checked without inventing a value for them.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const RELEASE_DOC = path.join(REPO_ROOT, 'commands', 'release.md');
const RELEASE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'release.mjs');

/** Binaries other than release.mjs whose own flags must not be attributed to it. */
const OTHER_CLI = /\b(npm|gh|git|pi|npx|node)\b/;

/**
 * Flags the release doc attributes to `scripts/release.mjs`.
 *
 * Two attribution rules, both anchored on the script — never a blanket sweep
 * of every `--token` in the file, which would mis-attribute `npm view … --json`:
 *
 *   1. A line naming `scripts/release.mjs` is an invocation → every flag on it.
 *   2. A line naming NO other CLI binary is prose about this script → flags
 *      inside inline code spans only.
 */
export function extractDocumentedFlags(markdown) {
  const flags = new Set();
  for (const line of markdown.split('\n')) {
    const isInvocation = line.includes('scripts/release.mjs');
    if (isInvocation) {
      for (const m of line.matchAll(/(--[a-z][a-z0-9-]*)/g)) flags.add(m[1]);
      continue;
    }
    if (OTHER_CLI.test(line)) continue;
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      for (const m of span[1].matchAll(/(--[a-z][a-z0-9-]*)/g)) flags.add(m[1]);
    }
  }
  return [...flags].sort();
}

/** Ask the real parser about one flag. Returns the raw stderr. */
function probeFlag(flag) {
  const res = spawnSync(process.execPath, [RELEASE_SCRIPT, '--help', flag], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
}

describe('commands/release.md ↔ scripts/release.mjs flag contract', () => {
  const markdown = readFileSync(RELEASE_DOC, 'utf8');
  const documented = extractDocumentedFlags(markdown);

  it('the doc documents at least one release.mjs flag (guards a blind extractor)', () => {
    // Without this, an extractor that silently matches nothing would make every
    // per-flag assertion below vacuously green.
    expect(documented.length).toBeGreaterThanOrEqual(3);
  });

  it.each(documented)('release.mjs parses the documented flag %s', (flag) => {
    expect(probeFlag(flag)).not.toMatch(/Unknown option/);
  });

  it('reports an undocumented flag as unknown (the oracle actually bites)', () => {
    // Fake-regression in permanent form: if this ever stops matching, the
    // per-flag assertions above have stopped discriminating.
    expect(probeFlag('--flag-that-does-not-exist')).toMatch(/Unknown option/);
  });

  it('every script path the doc tells the operator to run exists', () => {
    const missing = [...markdown.matchAll(/node\s+((?:scripts|\.\/scripts)\/[\w./-]+\.mjs)/g)]
      .map((m) => m[1].replace(/^\.\//, ''))
      .filter((rel) => !existsSync(path.join(REPO_ROOT, rel)));
    expect(missing).toEqual([]);
  });
});
