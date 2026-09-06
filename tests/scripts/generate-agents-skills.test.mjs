/**
 * tests/scripts/generate-agents-skills.test.mjs
 *
 * Vitest suite for scripts/generate-agents-skills.mjs — the cross-harness
 * portable-surface generator (root `AGENTS.md` + `.agents/skills/`).
 *
 * Every case below names the concrete bug it catches (TV-001). The class is
 * "a foreign harness silently sees nothing": 7 of 8 surveyed harnesses read
 * `AGENTS.md` and never `CLAUDE.md`, so a missing/stale/spec-illegal portable
 * surface is invisible from inside Claude Code — the only place anyone looks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import {
  generateAgentsSurface,
  toPortableFrontmatter,
  agentsMdAliasState,
  PORTABLE_KEYS,
  DESCRIPTION_MAX,
} from '../../scripts/generate-agents-skills.mjs';

/** @type {string} */
let root;

/** Write a source skill with the given frontmatter block + body. */
function writeSkill(name, frontmatter, body = 'canonical body') {
  const dir = join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter.trim()}\n---\n\n${body}\n`, 'utf8');
}

/** Parse a generated mirror into `{ fm, body }`. */
function readMirror(name) {
  const raw = readFileSync(join(root, '.agents', 'skills', name, 'SKILL.md'), 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  return { raw, fm: yaml.load(m[1]), body: m[2] };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agents-surface-'));
  writeFileSync(join(root, 'CLAUDE.md'), '# Fixture\n\n## Session Config\n\npersistence: true\n', 'utf8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('root AGENTS.md generation', () => {
  it('writes AGENTS.md byte-identically from CLAUDE.md', () => {
    // BUG: this repo has no root AGENTS.md, so a Codex CLI / OpenCode / Kiro /
    // Amp user opening it finds NO `## Session Config` at all — those harnesses
    // read AGENTS.md and never CLAUDE.md. A thin alias file that merely points
    // at CLAUDE.md reproduces the same failure.
    const result = generateAgentsSurface({ pluginRoot: root });
    expect(result.written).toContain('AGENTS.md');
    expect(readFileSync(join(root, 'AGENTS.md'))).toEqual(readFileSync(join(root, 'CLAUDE.md')));
    // The Session Config really travels — not just a pointer sentence.
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('## Session Config');
  });

  it('--check exits non-zero when AGENTS.md was hand-edited', () => {
    // BUG: a generated file that nothing gates rots. Six AGENTS.md strategies
    // drifted fleet-wide (#726); a hand-edit here would leave Codex reading a
    // stale Session Config while Claude Code read the current one.
    generateAgentsSurface({ pluginRoot: root });
    writeFileSync(join(root, 'AGENTS.md'), '# hand-edited\n', 'utf8');
    const check = generateAgentsSurface({ pluginRoot: root, check: true });
    expect(check.ok).toBe(false);
    expect(check.drift.join('\n')).toMatch(/AGENTS\.md differs from CLAUDE\.md/);
  });

  it('--check reports a MISSING AGENTS.md rather than passing silently', () => {
    // BUG: absence and correctness look identical to a check that only compares
    // files it finds — the exact shape that let this repo ship without an
    // AGENTS.md for its whole life.
    const check = generateAgentsSurface({ pluginRoot: root, check: true });
    expect(check.ok).toBe(false);
    expect(check.drift.join('\n')).toMatch(/AGENTS\.md is missing/);
  });

  it('accepts a symlinked AGENTS.md as already in sync', () => {
    // BUG: a consumer repo that legitimately symlinks AGENTS.md -> CLAUDE.md
    // would be reported as permanent drift and have its symlink replaced by a
    // copy on every run. The invariant is "the two cannot disagree", not "the
    // generator produced them".
    symlinkSync('CLAUDE.md', join(root, 'AGENTS.md'));
    expect(agentsMdAliasState(join(root, 'CLAUDE.md'), join(root, 'AGENTS.md')).kind).toBe('symlink');
    const check = generateAgentsSurface({ pluginRoot: root, check: true });
    expect(check.drift.filter((d) => d.includes('AGENTS.md'))).toEqual([]);
    generateAgentsSurface({ pluginRoot: root });
    expect(lstatSync(join(root, 'AGENTS.md')).isSymbolicLink()).toBe(true);
  });
});

describe('.agents/skills mirror frontmatter', () => {
  it('maps `tools:` to `allowed-tools:` and emits no non-spec key', () => {
    // BUG: agentskills.io permits only name/description/license/compatibility/
    // metadata/allowed-tools outside Claude Code. Our skills carry `tools:`
    // (7 files) plus tags/model-preference*/color/args-schema; propagating them
    // verbatim makes the mirror spec-illegal for the harnesses it exists for.
    writeSkill('demo', [
      'name: demo',
      'description: A demo skill.',
      'model: inherit',
      'color: red',
      'tags: [a, b]',
      'model-preference: opus',
      'tools: Read, Grep, Bash',
    ].join('\n'));
    generateAgentsSurface({ pluginRoot: root });
    const { fm } = readMirror('demo');
    expect(Object.keys(fm).every((k) => PORTABLE_KEYS.includes(k))).toBe(true);
    expect(fm).not.toHaveProperty('tools');
    expect(fm['allowed-tools']).toEqual(['Read', 'Grep', 'Bash']);
    expect(fm.metadata).toMatchObject({ model: 'inherit', color: 'red', tags: 'a, b', 'model-preference': 'opus' });
  });

  it('renders every metadata value as a string', () => {
    // BUG: agentskills.io `metadata` is a string map. A boolean
    // (`user-invocable: false`) or a list-of-objects (`args-schema`) passed
    // through as native YAML makes a strict reader reject the whole file.
    writeSkill('typed', [
      'name: typed',
      'description: Typed values.',
      'user-invocable: false',
      'args-schema:',
      '  - flag: --x',
      '    description: an x',
    ].join('\n'));
    generateAgentsSurface({ pluginRoot: root });
    const { fm } = readMirror('typed');
    expect(Object.values(fm.metadata).every((v) => typeof v === 'string')).toBe(true);
    expect(fm.metadata['user-invocable']).toBe('false');
    expect(JSON.parse(fm.metadata['args-schema'])[0].flag).toBe('--x');
  });

  it('collapses a folded description and truncates past the 1024 cap', () => {
    // BUG: descriptions are authored as YAML block scalars, so they arrive with
    // newlines; and agentskills.io caps description at 1024. An over-long or
    // multi-line description is rejected by the spec reader — silently, since
    // Claude Code never applies that cap.
    const long = 'x'.repeat(DESCRIPTION_MAX + 200);
    writeSkill('long', `name: long\ndescription: >\n  line one\n  line two ${long}`);
    const result = generateAgentsSurface({ pluginRoot: root });
    const { fm } = readMirror('long');
    expect(fm.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(fm.description).not.toContain('\n');
    expect(result.warnings.join('\n')).toMatch(/description-truncated/);
  });

  it('falls back to the directory name when `name:` is absent', () => {
    writeSkill('nameless', 'description: No name key.');
    generateAgentsSurface({ pluginRoot: root });
    expect(readMirror('nameless').fm.name).toBe('nameless');
  });
});

describe('.agents/skills mirror body', () => {
  it('points at the canonical SKILL.md instead of duplicating it', () => {
    // BUG: a mirror that copies the full body doubles the instruction corpus a
    // foreign harness loads and creates a second place the instructions can
    // rot. Progressive disclosure: frontmatter for discovery, pointer for depth.
    writeSkill('deep', 'name: deep\ndescription: Deep skill.', 'SECRET-CANONICAL-BODY-MARKER\n'.repeat(50));
    generateAgentsSurface({ pluginRoot: root });
    const { raw, body } = readMirror('deep');
    expect(body).toContain('skills/deep/SKILL.md');
    expect(raw).not.toContain('SECRET-CANONICAL-BODY-MARKER');
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(2048);
  });
});

describe('mirror lifecycle', () => {
  it('removes an orphan mirror whose source skill is gone', () => {
    // BUG: a renamed/deleted skill leaves a mirror behind that advertises a
    // skill no harness can route to — a dead entry in the discovery surface.
    writeSkill('gone', 'name: gone\ndescription: Temporary.');
    generateAgentsSurface({ pluginRoot: root });
    rmSync(join(root, 'skills', 'gone'), { recursive: true, force: true });

    const check = generateAgentsSurface({ pluginRoot: root, check: true });
    expect(check.ok).toBe(false);
    expect(check.drift.join('\n')).toMatch(/orphan/);

    const write = generateAgentsSurface({ pluginRoot: root });
    expect(write.written.join('\n')).toMatch(/removed \.agents\/skills\/gone/);
  });

  it('is idempotent — a second run reports no drift', () => {
    // BUG: a generator whose output depends on key order or timestamps reds CI
    // on every unrelated commit, and gets switched off.
    writeSkill('a', 'name: a\ndescription: A.');
    writeSkill('b', 'name: b\ndescription: B.\ntools: Read');
    generateAgentsSurface({ pluginRoot: root });
    expect(generateAgentsSurface({ pluginRoot: root, check: true })).toMatchObject({ ok: true, drift: [] });
  });

  it('skips `_shared` and dot-directories under skills/', () => {
    // BUG: skills/_shared/ holds reference fragments with no SKILL.md; treating
    // it as a skill would publish a mirror for something no harness can invoke.
    mkdirSync(join(root, 'skills', '_shared'), { recursive: true });
    writeFileSync(join(root, 'skills', '_shared', 'notes.md'), 'fragment\n', 'utf8');
    const result = generateAgentsSurface({ pluginRoot: root });
    expect(result.skills).not.toContain('_shared');
  });
});

describe('toPortableFrontmatter', () => {
  it('emits keys in the spec field order', () => {
    const { fm } = toPortableFrontmatter(
      { tools: 'Read', description: 'd', name: 'n', license: 'MIT', color: 'red' },
      'n',
    );
    expect(Object.keys(fm)).toEqual(['name', 'description', 'license', 'metadata', 'allowed-tools']);
  });
});
