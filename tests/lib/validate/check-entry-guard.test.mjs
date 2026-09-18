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

  // The bare basename form carries NO comparison operator, so the original
  // oracle could not see it by construction — and neither symlink smoke test
  // reproduced it (a same-named file behind a symlinked DIRECTORY still ends
  // with the basename). Reverting `scripts/lib/ecosystem-wizard.mjs` to this
  // shape was therefore caught by nothing: measured 2026-09-17, the revert left
  // validate-plugin at 230 passed / 0 failed. This is the test that kills it.
  it('flags a bare `argv[1].endsWith("x.mjs")` guard as fragile', () => {
    const hits = findFragileGuards(
      'if (process.argv[1] && process.argv[1].endsWith(\'ecosystem-wizard.mjs\')) main();\n',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].kind).toBe('basename');
  });

  // The receiver, not the call, is what makes an `endsWith` this defect class.
  it('flags the optional-chain and String() receiver variants', () => {
    expect(findFragileGuards("if (process.argv[1]?.endsWith('cli.mjs')) main();\n")).toHaveLength(1);
    expect(
      findFragileGuards("if (String(process.argv[1]).endsWith('cli.mjs')) main();\n"),
    ).toHaveLength(1);
    expect(
      findFragileGuards("if ((process.argv[1] || '').endsWith('cli.mjs')) main();\n"),
    ).toHaveLength(1);
  });

  // An `endsWith` on a DIFFERENT value in a statement that merely also mentions
  // argv[1] is not an entry guard — flagging it would make the gate red on
  // ordinary argument handling.
  it('does not flag an endsWith on a receiver other than argv[1]', () => {
    expect(
      findFragileGuards(
        "const target = process.argv[1]; if (someOtherPath.endsWith('x.mjs')) load(target);\n",
      ),
    ).toEqual([]);
    // ...nor a basename test whose literal is not a module file at all.
    expect(findFragileGuards("if (process.argv[1].endsWith('/bin')) main();\n")).toEqual([]);
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

  // #1383: a regex literal the lexer fails to recognise desyncs into a `/*` that
  // blanks the guard below it — a fail-open miss.
  //
  // The fixture is the CHARACTER-CLASS form (`/[/*]/`), not the earlier
  // quote-in-regex one: measured 2026-09-18, that earlier fixture was rescued by
  // the string branch's EOL bail and stayed green with the regex branch disabled
  // (`if (false)`) — it proved nothing about the branch it was written for. This
  // form has no such rescue; the trailing block comment supplies the `*/` that
  // closes the misread opener and swallows the guard.
  it('still flags a guard below a regex whose character class contains `/`', () => {
    const src =
      'const RE = /[/*]/;\n' +
      'if (process.argv[1] === import.meta.url) main();\n' +
      '/* trailing note */\n';
    const findings = findFragileGuards(src);
    expect(findings.map((f) => f.line)).toEqual([2]);
  });

  // The same desync, reached through a KEYWORD instead of a character class:
  // `return /\/*$/` — the lexer's one-char lookback saw `n` (a word character)
  // and read the `/` as a division, so the regex body's `/*` opened a block
  // comment that ran to the next `*/` and blanked the guard. Measured
  // 2026-09-18 on the pre-fix lexer: `findings: []`, the whole file silent.
  it('still flags a guard below a regex that follows a keyword', () => {
    const src =
      'function norm(p) { return /\\/*$/.test(p); }\n' +
      "if (process.argv[1].endsWith('cli.mjs')) { main(); }\n" +
      '/* trailing note */\n';
    const findings = findFragileGuards(src);
    expect(findings.map((f) => f.line)).toEqual([2]);
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

  // The gate must BLOCK on the bare form, not merely report it from
  // findFragileGuards — that is the difference between the HIGH-1 mutation being
  // caught and being noticed by a reader.
  it('blocks a repo whose guard is a bare basename test, and passes the swept form', async () => {
    const reverted = fixtureRepo({
      'scripts/lib/ecosystem-wizard.mjs':
        'async function main() {}\n' +
        "if (process.argv[1] && process.argv[1].endsWith('ecosystem-wizard.mjs')) await main();\n",
    });
    expect(await runCheckEntryGuard(reverted)).toBe(1);

    const swept = fixtureRepo({
      'scripts/lib/ecosystem-wizard.mjs':
        "import { isMainModule } from './is-main-module.mjs';\n" +
        'if (isMainModule(import.meta.url)) await main();\n',
      // The same idiom inside a comment must stay invisible — this check's own
      // header now quotes the bare form too.
      'hooks/documented.mjs': "// the pre-fix guard was process.argv[1].endsWith('x.mjs')\n",
    });
    expect(await runCheckEntryGuard(swept)).toBe(0); // check-untracked-test-deps:ignore — arg is a fixture source string quoting `import.meta.url`
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
