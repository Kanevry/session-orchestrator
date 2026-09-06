/**
 * tests/lib/validate/check-skill-links.test.mjs
 *
 * Tests for scripts/lib/validate/check-skill-links.mjs — every relative markdown link under
 * skills/, commands/, agents/ and .claude/rules/ must resolve from the LINKING file's own
 * directory.
 *
 * The bug each case names is the one that shipped on 2026-09-06: the #1157 `references/` split
 * moved phase blocks one directory DEEPER and carried their `./sibling.md` links along unchanged.
 * The moved text was verified by content hash, which is blind to depth by construction, so three
 * links pointed at nothing and every gate stayed green — including the one that detaches the six
 * session-end tail phases from their dispatcher.
 *
 * Fixtures are throwaway roots. The live repo is used only for the CLI contract (exit 0); pinning
 * the live corpus would pin its defect state and punish the repair.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { checkSkillLinks, listMarkdown, SCAN_DIRS, PRUNE_DIRS } from '@lib/validate/check-skill-links.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-skill-links.mjs');

const tmpRoots = [];

/**
 * Build a throwaway root. `files` maps repo-relative path -> content.
 *
 * @param {Record<string, string>} files
 * @returns {string} absolute fixture root
 */
function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-skill-links-'));
  tmpRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop(), { recursive: true, force: true });
});

describe('depth-sensitive links (the #1157 defect)', () => {
  it('flags a ./sibling.md that resolves from the repo root but not from the linking file', () => {
    // Exactly the shipped bug: phase-3-documentation-updates.md moved into references/ and kept
    // `./phase-3-6-tail.md`, while the target stayed one level up.
    const root = makeFixture({
      'skills/demo/phase-3-6-tail.md': '# tail\n',
      'skills/demo/references/phase-3.md': 'Continue at [the tail](./phase-3-6-tail.md).\n',
    });
    const { ok, findings } = checkSkillLinks(root);
    expect(ok).toBe(false);
    expect(findings).toEqual([
      { file: 'skills/demo/references/phase-3.md', line: 1, target: './phase-3-6-tail.md' },
    ]);
  });

  it('accepts the corrected ../sibling.md form', () => {
    const root = makeFixture({
      'skills/demo/phase-3-6-tail.md': '# tail\n',
      'skills/demo/references/phase-3.md': 'Continue at [the tail](../phase-3-6-tail.md).\n',
    });
    expect(checkSkillLinks(root)).toMatchObject({ ok: true, checked: 1 });
  });

  it('flags a target that escapes the repo root instead of passing it', () => {
    // An out-of-tree path may well exist on the machine that runs the check and not on the next
    // one. Existence outside the repo is not evidence about this repo.
    const root = makeFixture({
      'skills/demo/SKILL.md': 'See [passwd](../../../../../../etc/passwd).\n',
    });
    const { ok, findings } = checkSkillLinks(root);
    expect(ok).toBe(false);
    expect(findings[0].target).toBe('../../../../../../etc/passwd');
  });

  it('resolves a link that points into another scanned surface', () => {
    const root = makeFixture({
      '.claude/rules/testing.md': '# testing\n',
      'skills/demo/SKILL.md': 'Per [testing](../../.claude/rules/testing.md).\n',
    });
    expect(checkSkillLinks(root).ok).toBe(true);
  });
});

describe('what is deliberately not a link', () => {
  it('ignores a link inside inline code — the MEMORY.md index FORMAT is not an index', () => {
    // skills/memory-cleanup/SKILL.md:163 documents `- [Title](file.md) — hook` as the shape of an
    // index entry. Without this carve-out the guard's first finding would demand a doc be wrong.
    const root = makeFixture({
      'skills/demo/SKILL.md': 'One-line `- [Title](file.md) — hook` entries.\n',
    });
    expect(checkSkillLinks(root)).toMatchObject({ ok: true, checked: 0 });
  });

  it('ignores a link inside a fenced code block', () => {
    const root = makeFixture({
      'skills/demo/SKILL.md': '```md\n[example](nowhere.md)\n```\n',
    });
    expect(checkSkillLinks(root)).toMatchObject({ ok: true, checked: 0 });
  });

  it('still checks a real link on the line after a fence closes', () => {
    const root = makeFixture({
      'skills/demo/SKILL.md': '```md\n[example](nowhere.md)\n```\n[real](gone.md)\n',
    });
    const { ok, findings } = checkSkillLinks(root);
    expect(ok).toBe(false);
    expect(findings).toEqual([{ file: 'skills/demo/SKILL.md', line: 4, target: 'gone.md' }]);
  });

  it('skips http(s), mailto and pure-anchor targets', () => {
    const root = makeFixture({
      'skills/demo/SKILL.md': [
        '[a](https://example.com/x.md)',
        '[b](http://example.com)',
        '[c](mailto:someone@example.com)',
        '[d](#a-heading)',
        '[e](/absolute/from/root.md)',
      ].join('\n'),
    });
    expect(checkSkillLinks(root)).toMatchObject({ ok: true, checked: 0 });
  });

  it('checks the path half of a target carrying a #fragment and ignores the fragment', () => {
    const root = makeFixture({
      'skills/demo/other.md': '# other\n',
      'skills/demo/SKILL.md': '[ok](other.md#no-such-heading) and [bad](gone.md#x)\n',
    });
    const { ok, findings, checked } = checkSkillLinks(root);
    expect(checked).toBe(2);
    expect(ok).toBe(false);
    expect(findings).toEqual([{ file: 'skills/demo/SKILL.md', line: 1, target: 'gone.md#x' }]);
  });

  it('accepts a link whose target is a directory', () => {
    const root = makeFixture({
      'skills/demo/references/a.md': '# a\n',
      'skills/demo/SKILL.md': 'See [the references](references/).\n',
    });
    expect(checkSkillLinks(root).ok).toBe(true);
  });
});

describe('enumeration', () => {
  it('walks the filesystem, so a brand-new untracked instruction file is checked', () => {
    // The git-index variant of this walk reported clean on the tree that carried the defect —
    // `.claude/rules/measurement-discipline.md` records that incident. A fixture root is not a git
    // repo at all, so every finding here is itself proof the enumeration is not git-backed.
    const root = makeFixture({ 'skills/demo/SKILL.md': '[x](gone.md)\n' });
    expect(checkSkillLinks(root).findings).toHaveLength(1);
  });

  it('prunes vendored trees — skills/vault-sync/node_modules is real and ships broken READMEs', () => {
    const root = makeFixture({
      'skills/vault-sync/node_modules/yaml/README.md': '[contributing](docs/CONTRIBUTING.md)\n',
      'skills/demo/SKILL.md': '# fine\n',
    });
    expect(listMarkdown(root)).toEqual(['skills/demo/SKILL.md']);
    expect(checkSkillLinks(root).ok).toBe(true);
  });

  it('scans all four instruction surfaces', () => {
    expect([...SCAN_DIRS]).toEqual(['skills', 'commands', 'agents', '.claude/rules']);
    const root = makeFixture(
      Object.fromEntries(SCAN_DIRS.map((d) => [`${d}/x.md`, '[dead](nope.md)\n'])),
    );
    expect(checkSkillLinks(root).findings).toHaveLength(SCAN_DIRS.length);
  });

  it('returns an empty list rather than throwing when a surface is absent', () => {
    const root = makeFixture({ 'README.md': '# nothing scannable\n' });
    expect(listMarkdown(root)).toEqual([]);
    expect(checkSkillLinks(root)).toMatchObject({ ok: true, files: 0, checked: 0 });
  });

  it('prunes node_modules by segment name anywhere in the path', () => {
    expect(PRUNE_DIRS.has('node_modules')).toBe(true);
  });
});

describe('CLI contract', () => {
  it('exits 0 on this repository and reports the counts it judged', () => {
    const r = spawnSync('node', [SCRIPT, REPO_ROOT], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ {2}PASS: \d+ relative link\(s\) in \d+ markdown file\(s\) resolve$/m);
  });

  it('exits 1 and names file:line → target for every finding', () => {
    const root = makeFixture({ 'skills/demo/SKILL.md': '\n[x](gone.md)\n' });
    const r = spawnSync('node', [SCRIPT, root], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('skills/demo/SKILL.md:2 → gone.md');
  });
});
