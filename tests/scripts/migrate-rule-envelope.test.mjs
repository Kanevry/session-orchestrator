/**
 * tests/scripts/migrate-rule-envelope.test.mjs
 *
 * CLI contract of scripts/migrate-rule-envelope.mjs (#1792): it moves fleet
 * copies of generated rules from the legacy HTML-comment untrusted-content
 * envelope (stripped by Claude Code before injection) to the visible one.
 *
 * Every fixture lives in an mkdtemp root — the live repo is never a target.
 * The CLI is spawned as a real child so exit codes and stdout are the ones a
 * maintenance runner sees.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  LEGACY_UNTRUSTED_BEGIN,
  LEGACY_UNTRUSTED_END,
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
} from '../../scripts/lib/reconcile/sanitize.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'migrate-rule-envelope.mjs');

const tmpRoots = [];

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'migrate-envelope-'));
  tmpRoots.push(root);
  const rulesDir = join(root, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  return { root, rulesDir };
}

function run(...args) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 15_000 });
  return { ...r, json: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null };
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A legacy rule shaped like the pre-#1779 renderer output, with CRLF on the
// prose lines and no final newline, so a rewrite that normalises line endings
// or appends a newline changes bytes it must not touch.
const FM =
  '---\nauto-generated: true\npaths: ["src/**"]\nlearning-key: anti-pattern/invented\nexpires-at: 2099-01-01\n---\n\n';
const PROSE = '### Invented heading\r\n\r\nInvented prose with trailing spaces.   \r\n';
const legacyRule = `${FM}${LEGACY_UNTRUSTED_BEGIN}\n\n${PROSE}\n${LEGACY_UNTRUSTED_END}\n\n## Provenance\n- learning-id: \`x\``;

describe('migrate-rule-envelope — dry-run and apply (#1792)', () => {
  // BUG CAUGHT: a dry-run that writes (or an apply that rewrites more than the
  // two sentinel lines) silently edits fleet rules beyond the migration.
  it('dry-run counts the legacy file and writes nothing; apply changes ONLY the two sentinel lines', () => {
    const { root, rulesDir } = makeRepo();
    writeFileSync(join(rulesDir, 'legacy.md'), legacyRule);
    writeFileSync(join(rulesDir, 'plain.md'), '# Handwritten\n');

    const dry = run('--root', root, '--json');
    expect(dry.status).toBe(0);
    expect(dry.json.mode).toBe('dry-run');
    expect(dry.json.totals).toMatchObject({
      files_scanned: 2,
      pending: 1,
      migrated: 0,
      skipped: 0,
      errors: 0,
    });
    expect(dry.json.roots[0].pending).toEqual([
      { file: join('.claude', 'rules', 'legacy.md'), lines: [8, 14] },
    ]);
    expect(readFileSync(join(rulesDir, 'legacy.md'), 'utf8')).toBe(legacyRule);

    const applied = run('--root', root, '--apply', '--json');
    expect(applied.status).toBe(0);
    expect(applied.json.totals).toMatchObject({ pending: 1, migrated: 1 });

    const after = readFileSync(join(rulesDir, 'legacy.md'), 'utf8');
    expect(after).toBe(
      `${FM}${UNTRUSTED_BEGIN}\n\n${PROSE}\n${UNTRUSTED_END}\n\n## Provenance\n- learning-id: \`x\``,
    );
    // No tmp file left behind by the atomic write.
    expect(readdirSync(rulesDir).sort()).toEqual(['legacy.md', 'plain.md']);
  });

  // BUG CAUGHT: a non-idempotent migration re-touches already visible files on
  // every maintenance run (or flips them back).
  it('a second apply finds nothing pending and leaves the file byte-identical', () => {
    const { root, rulesDir } = makeRepo();
    writeFileSync(join(rulesDir, 'legacy.md'), legacyRule);
    run('--root', root, '--apply');
    const once = readFileSync(join(rulesDir, 'legacy.md'));

    const again = run('--root', root, '--apply', '--json');

    expect(again.status).toBe(0);
    expect(again.json.totals).toMatchObject({ pending: 0, migrated: 0, already_visible: 1 });
    expect(readFileSync(join(rulesDir, 'legacy.md')).equals(once)).toBe(true);
  });
});

describe('migrate-rule-envelope — refuses to half-migrate (#1792)', () => {
  // BUG CAUGHT: migrating a file whose envelope is duplicated, reversed or
  // mixed produces a visible envelope that frames the wrong region.
  it.each([
    [
      'duplicated start',
      `${LEGACY_UNTRUSTED_BEGIN}\n${LEGACY_UNTRUSTED_BEGIN}\nx\n${LEGACY_UNTRUSTED_END}\n`,
      'envelope count: 2 start / 1 end',
    ],
    [
      'end before start',
      `${LEGACY_UNTRUSTED_END}\nx\n${LEGACY_UNTRUSTED_BEGIN}\n`,
      'end line 1 before start line 3',
    ],
    [
      'mixed forms',
      `${LEGACY_UNTRUSTED_BEGIN}\nx\n${UNTRUSTED_END}\n`,
      'mixes legacy and visible sentinels',
    ],
    [
      'edited sentinel',
      `<!-- untrusted-content:start (edited) -->\nx\n${LEGACY_UNTRUSTED_END}\n`,
      'non-sentinel token line 1',
    ],
  ])('skips a file with %s and leaves it untouched', (_label, content, reason) => {
    const { root, rulesDir } = makeRepo();
    writeFileSync(join(rulesDir, 'bad.md'), content);

    const r = run('--root', root, '--apply', '--json');

    expect(r.status).toBe(0);
    expect(r.json.roots[0].skipped).toEqual([{ file: join('.claude', 'rules', 'bad.md'), reason }]);
    expect(r.json.totals.migrated).toBe(0);
    expect(readFileSync(join(rulesDir, 'bad.md'), 'utf8')).toBe(content);
  });

  // BUG CAUGHT: following a symlink lets one --root rewrite a file in another
  // repo — one the caller never boundary-checked.
  it('does not follow a symlinked rule file', () => {
    const outside = makeRepo();
    const target = join(outside.rulesDir, 'target.md');
    writeFileSync(target, legacyRule);
    const { root, rulesDir } = makeRepo();
    symlinkSync(target, join(rulesDir, 'link.md'));

    const r = run('--root', root, '--apply', '--json');

    expect(r.status).toBe(0);
    expect(r.json.roots[0].skipped).toEqual([
      { file: join('.claude', 'rules', 'link.md'), reason: 'symlink (not followed)' },
    ]);
    expect(readFileSync(target, 'utf8')).toBe(legacyRule);
  });

  // BUG CAUGHT (#1792 review F5): only `.claude/rules` was lstat'ed, so a
  // symlinked `.claude` with a REAL `rules` dir inside passed the check and
  // --apply rewrote a file outside the root (exit 0, `migrated:[…]`). A
  // symlinked `rules` was silently reported and exited 0.
  it.each([
    ['.claude', (root, outside) => symlinkSync(outside.root, join(root, '.claude'))],
    [
      join('.claude', 'rules'),
      (root, outside) => {
        mkdirSync(join(root, '.claude'));
        symlinkSync(outside.rulesDir, join(root, '.claude', 'rules'));
      },
    ],
  ])('refuses the whole root when %s is a symlink and writes nothing outside it', (component, link) => {
    const outside = makeRepo();
    const target = join(outside.rulesDir, 'probe.md');
    writeFileSync(target, legacyRule);
    const root = mkdtempSync(join(tmpdir(), 'migrate-envelope-'));
    tmpRoots.push(root);
    link(root, outside);

    const r = run('--root', root, '--apply', '--json');

    expect(r.status).toBe(2);
    expect(r.json.roots[0]).toMatchObject({ rules_dir: 'symlink', migrated: [], files_scanned: 0 });
    expect(r.json.roots[0].errors).toEqual([
      { file: component, error: 'symlink — root refused, nothing read or written' },
    ]);
    expect(readFileSync(target, 'utf8')).toBe(legacyRule);
    expect(readdirSync(outside.rulesDir)).toEqual(['probe.md']);
  });
});

describe('migrate-rule-envelope — usage errors', () => {
  // BUG CAUGHT: validating roots lazily lets a typo in the LAST --root abort an
  // apply after the earlier roots were already rewritten.
  it('exits 1 on a missing root BEFORE migrating any earlier root', () => {
    const { root, rulesDir } = makeRepo();
    writeFileSync(join(rulesDir, 'legacy.md'), legacyRule);

    const r = run('--root', root, '--root', join(root, 'does-not-exist'), '--apply');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not exist');
    expect(readFileSync(join(rulesDir, 'legacy.md'), 'utf8')).toBe(legacyRule);
  });

  it('exits 1 without any --root', () => {
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('at least one --root');
  });
});
