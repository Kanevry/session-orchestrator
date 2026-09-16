import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  findFragileGuards,
  runCheckEntryGuard,
} from '../../../scripts/lib/validate/check-entry-guard.mjs';

const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A throwaway git repo — the check enumerates via `git ls-files`, so an
 * untracked fixture file would be invisible and every assertion would pass
 * vacuously.
 *
 * @param {Record<string, string>} files repo-relative path → body
 * @returns {string} absolute repo root
 */
function fixtureRepo(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'so-entry-guard-'));
  dirs.push(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.org');
  git('config', 'user.name', 'Fixture');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  git('add', '-A');
  return root;
}

describe('findFragileGuards', () => {
  it('flags the V2 pathToFileURL idiom', () => {
    const hits = findFragileGuards( // check-untracked-test-deps:ignore — arg is a fixture source string quoting `import.meta.url`
      "const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;\n",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
  });

  // The whole point of the realpath idiom is that it is CORRECT. A census that
  // flags it would push 9 already-fixed files back into the backlog.
  it('does not flag the realpath idiom it is telling people to adopt', () => {
    expect(
      findFragileGuards('return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));\n'), // check-untracked-test-deps:ignore — arg is a fixture source string quoting `import.meta.url`
    ).toEqual([]);
    expect(findFragileGuards('if (isMainModule(import.meta.url)) main();\n')).toEqual([]); // check-untracked-test-deps:ignore — arg is a fixture source string quoting `import.meta.url`
  });

  // Three files in this repo DESCRIBE the broken idiom in a comment — including
  // the check's own header. A validator that flags its own documentation is
  // unshippable.
  it('does not flag the idiom quoted inside a comment', () => {
    expect(
      findFragileGuards( // check-untracked-test-deps:ignore — arg is a fixture source string quoting `import.meta.url`
        '// `import.meta.url === pathToFileURL(process.argv[1]).href` is the broken form\n' +
          '/* import.meta.url === `file://${process.argv[1]}` */\n' +
          'export const x = 1;\n',
      ),
    ).toEqual([]);
  });
});

describe('runCheckEntryGuard', () => {
  it('fails a repo carrying a hand-written guard and passes a swept one', async () => {
    const bad = fixtureRepo({
      'scripts/bad-cli.mjs':
        "import { pathToFileURL } from 'node:url';\n" +
        "if (import.meta.url === pathToFileURL(process.argv[1]).href) main();\n",
    });
    expect(await runCheckEntryGuard(bad)).toBe(1); // check-untracked-test-deps:ignore — arg is a fixture source string quoting `import.meta.url`

    const good = fixtureRepo({
      'scripts/good-cli.mjs':
        "import { isMainModule } from './lib/is-main-module.mjs';\n" +
        'if (isMainModule(import.meta.url)) main();\n',
      'hooks/commented.mjs': '// import.meta.url === `file://${process.argv[1]}` — the old form\n',
    });
    expect(await runCheckEntryGuard(good)).toBe(0); // check-untracked-test-deps:ignore — arg is a fixture source string quoting `import.meta.url`
  });

  // CRLF: every fixture in this file is LF, so a Windows-authored or
  // CRLF-normalized module is an untested shape in a BLOCKING validator. Two
  // distinct damages live here — a miss ships a symlink-fragile guard through a
  // gate that exists to stop it, and a line number computed after the comment
  // bytes are blanked sends the fixer to the wrong statement. The block comment
  // and the trailing line comment are load-bearing: they are what makes the
  // offset bookkeeping (and therefore the line count) non-trivial.
  it('flags a fragile guard in a CRLF file and reports the right line number', async () => {
    const crlf = [
      '#!/usr/bin/env node',
      '/* header',
      ' * block comment */',
      "import { pathToFileURL } from 'node:url';",
      'if (import.meta.url === pathToFileURL(process.argv[1]).href) main(); // entry', // check-untracked-test-deps:ignore — fixture source string quoting `import.meta.url`
      '',
    ].join('\r\n');

    const hits = findFragileGuards(crlf);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(5);
    expect(hits[0].text).toContain('process.argv[1]');
    // ...and the gate BLOCKS on it, rather than counting the file as clean.
    expect(await runCheckEntryGuard(fixtureRepo({ 'scripts/crlf-cli.mjs': crlf }))).toBe(1);
  });

  // git's wildmatch makes `**` consume at least one path component, so a
  // `scripts/**/*.mjs` pathspec silently drops every top-level scripts/*.mjs and
  // ALL of hooks/*.mjs — 61 of 176 tracked modules censused, exit 0, looks clean.
  it('censuses top-level scripts/ and hooks/ modules, not just nested ones', async () => {
    const root = fixtureRepo({
      'scripts/top-level.mjs': 'if (import.meta.url === `file://${process.argv[1]}`) main();\n',
      'hooks/top-level.mjs': 'if (import.meta.url === `file://${process.argv[1]}`) main();\n',
    });
    expect(await runCheckEntryGuard(root)).toBe(1); // check-untracked-test-deps:ignore — arg is a fixture source string quoting `import.meta.url`
  });
});
