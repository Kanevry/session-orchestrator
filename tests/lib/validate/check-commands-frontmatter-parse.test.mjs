/**
 * tests/lib/validate/check-commands.test.mjs
 *
 * Tests for scripts/lib/validate/check-commands.mjs — the commands/*.md frontmatter gate.
 *
 * Why this file exists (TV-001): the commands gate had NO test of its own. Its half of
 * the shared frontmatter-block extraction was therefore unobservable — break the
 * primitive and only check-skills.test.mjs would have gone red, which proves one caller,
 * not the shared contract. Pinning the two extraction diagnostics HERE is what makes the
 * two-suite fake-regression a real proof that both gates run the same code.
 *
 * The `argument-hint` case is deliberately the one non-shared assertion: it pins that
 * the commands gate keeps its OWN field rule. The rules of the three frontmatter
 * checkers diverge on purpose — only the extraction is shared. See
 * scripts/lib/validate/frontmatter-block.mjs § header.
 *
 * Strategy: spawn the CLI against tmp plugin-roots holding commands/ fixtures, matching
 * tests/lib/validate/check-skills.test.mjs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-commands.mjs');

const tmpRoots = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Build a tmp plugin-root whose commands/ holds the given fixtures.
 *
 * No plugin.json is written, so the checker resolves the conventional ./commands path.
 *
 * @param {Record<string, string>} commands - filename -> full .md text
 * @returns {string} absolute path to the tmp plugin-root
 */
function makeRoot(commands) {
  const root = mkdtempSync(join(tmpdir(), 'check-commands-'));
  tmpRoots.push(root);
  const dir = join(root, 'commands');
  mkdirSync(dir, { recursive: true });
  for (const [filename, content] of Object.entries(commands)) {
    writeFileSync(join(dir, filename), content);
  }
  return root;
}

/**
 * Run the checker against a plugin-root.
 *
 * @param {string} root
 * @returns {{ code: number, out: string }}
 */
function run(root) {
  const res = spawnSync('node', [SCRIPT, root], { encoding: 'utf8' });
  return { code: res.status, out: (res.stdout ?? '') + (res.stderr ?? '') };
}

/** A command file that satisfies every rule — the control fixture. */
const VALID = `---
description: Use when a control fixture that satisfies every rule is needed.
argument-hint: "[mode]"
---

# Good Command
`;

describe('check-commands.mjs — frontmatter block extraction (shared primitive)', () => {
  it('fails a command file with no opening delimiter', () => {
    const root = makeRoot({ 'nofm.md': '# No Frontmatter\n\nBody only.\n' });

    const { code, out } = run(root);

    expect(code).toBe(1);
    expect(out).toContain('FAIL: nofm.md: missing YAML frontmatter opening delimiter');
  });

  it('fails a command file whose frontmatter is never closed', () => {
    const root = makeRoot({ 'unclosed.md': '---\ndescription: Use when the fence never closes.\n' });

    const { code, out } = run(root);

    expect(code).toBe(1);
    expect(out).toContain('FAIL: unclosed.md: missing YAML frontmatter closing delimiter');
  });

  it('accepts a well-formed frontmatter block', () => {
    const root = makeRoot({ 'good.md': VALID });

    const { code, out } = run(root);

    expect(code).toBe(0);
    expect(out).not.toContain('FAIL:');
    expect(out).toContain('PASS: commands directory contains 1 .md files');
  });
});

describe('check-commands.mjs — field rules stay LOCAL to this gate', () => {
  it('fails a non-string argument-hint', () => {
    const root = makeRoot({ 'badhint.md': '---\ndescription: Use when argument-hint has the wrong type.\nargument-hint: 42\n---\n' });

    const { code, out } = run(root);

    expect(code).toBe(1);
    expect(out).toContain('FAIL: badhint.md: argument-hint must be a string');
  });

  it('fails frontmatter that parses to a non-mapping', () => {
    const root = makeRoot({ 'seq.md': '---\n- just\n- a\n- list\n---\n' });

    const { code, out } = run(root);

    expect(code).toBe(1);
    expect(out).toContain('FAIL: seq.md: YAML frontmatter must be a non-null mapping/object');
  });
});
