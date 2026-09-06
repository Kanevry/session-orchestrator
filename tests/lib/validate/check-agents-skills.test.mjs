/**
 * tests/lib/validate/check-agents-skills.test.mjs
 *
 * Vitest suite for scripts/lib/validate/check-agents-skills.mjs — the
 * INDEPENDENT oracle over the cross-harness portable surface (root AGENTS.md,
 * root plugin.json, `.agents/skills/`).
 *
 * The checker deliberately shares no code with the generator, so these tests
 * mutate the artefacts DIRECTLY (never via the generator) — a
 * generator-vs-generator suite proves only self-consistency, which is how the
 * Cursor `argument-hint` defect survived.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECKER = resolve(__dirname, '../../../scripts/lib/validate/check-agents-skills.mjs');
const REPO_ROOT = resolve(__dirname, '../../../');

/** @type {string} */
let root;

function run(target = root) {
  return spawnSync('node', [CHECKER, target], { encoding: 'utf8' });
}

function writeMirror(name, frontmatter, body = `see skills/${name}/SKILL.md`) {
  const dir = join(root, '.agents', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter.trim()}\n---\n\n${body}\n`, 'utf8');
}

function writeSource(name) {
  const dir = join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Source.\n---\n\nbody\n`, 'utf8');
}

/** A minimal, VALID fixture repo: everything green before each test mutates one thing. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-agents-skills-'));
  writeFileSync(join(root, 'CLAUDE.md'), '# Fixture\n\n## Session Config\n\npersistence: true\n', 'utf8');
  writeFileSync(join(root, 'AGENTS.md'), '# Fixture\n\n## Session Config\n\npersistence: true\n', 'utf8');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '9.9.9' }), 'utf8');
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'fx', version: '9.9.9', description: 'Fixture.', license: 'MIT',
    skills: './skills/',
  }), 'utf8');
  writeSource('alpha');
  writeMirror('alpha', 'name: alpha\ndescription: Alpha.');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('baseline fixture', () => {
  it('exits 0 on a well-formed portable surface', () => {
    const r = run();
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/Results: \d+ passed, 0 failed/);
  });
});

describe('Check A — AGENTS.md ↔ CLAUDE.md alias', () => {
  it('fails when AGENTS.md is absent while CLAUDE.md exists', () => {
    // BUG: the whole reason this surface exists — a repo whose Session Config
    // is unreachable from Codex CLI / OpenCode / Kiro / Amp.
    rmSync(join(root, 'AGENTS.md'));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/AGENTS\.md does not/);
  });

  it('fails when the two instruction files are independent and disagree', () => {
    // BUG: two hand-maintained instruction files silently diverge — the exact
    // class drift-check Check 7 was written for (#600) and #726 measured
    // fleet-wide across six AGENTS.md strategies.
    writeFileSync(join(root, 'AGENTS.md'), '# Fixture\n\n## Session Config\n\npersistence: false\n', 'utf8');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/two independent files that disagree/);
  });

  it('accepts a symlinked AGENTS.md', () => {
    rmSync(join(root, 'AGENTS.md'));
    symlinkSync('CLAUDE.md', join(root, 'AGENTS.md'));
    const r = run();
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/alias of CLAUDE\.md \(symlink\)/);
  });
});

describe('Check B — root plugin.json', () => {
  it('fails when plugin.json version drifts from package.json', () => {
    // BUG: three manifests now carry a version (.claude-plugin, .codex-plugin,
    // root) and the release script bumps package.json only. A third copy that
    // drifts is invisible until a consumer installs the wrong version.
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'fx', version: '1.2.3', description: 'Fixture.', license: 'MIT',
    }), 'utf8');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/plugin\.json version '1\.2\.3' != package\.json version '9\.9\.9'/);
  });

  it('fails when plugin.json advertises a component this repo does not ship', () => {
    // BUG: a manifest claiming `"mcpServers": "./.mcp.json"` in a repo with no
    // .mcp.json makes a foreign harness fail at load with no useful message.
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'fx', version: '9.9.9', description: 'Fixture.', license: 'MIT',
      mcpServers: './.mcp.json',
    }), 'utf8');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/component 'mcpServers' points at '\.\/\.mcp\.json' which does not exist/);
  });

  it('fails on a wrong $schema and on a missing required field', () => {
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({
      $schema: 'https://example.invalid/schema.json', name: 'fx', version: '9.9.9',
    }), 'utf8');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\$schema is 'https:\/\/example\.invalid\/schema\.json'/);
    expect(r.stdout).toMatch(/missing required field 'description'/);
  });

  it('passes when no root plugin.json is shipped at all', () => {
    rmSync(join(root, 'plugin.json'));
    expect(run().status).toBe(0);
  });
});

describe('Check C — .agents/skills mirror', () => {
  it('fails on a non-spec frontmatter key', () => {
    // BUG: agentskills.io permits six fields outside Claude Code. Our source
    // skills carry 8 undocumented keys and 7 spell `tools:` instead of
    // `allowed-tools:`; leaking any of them makes the mirror spec-illegal.
    writeMirror('alpha', 'name: alpha\ndescription: Alpha.\ntools: Read');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/non-spec key 'tools'/);
  });

  it('fails on a description longer than 1024 characters', () => {
    writeMirror('alpha', `name: alpha\ndescription: "${'x'.repeat(1100)}"`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/description is 1100 chars \(> 1024\)/);
  });

  it('fails on a non-string metadata value', () => {
    writeMirror('alpha', 'name: alpha\ndescription: Alpha.\nmetadata:\n  invocable: true');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/metadata\.invocable is boolean, expected string/);
  });

  it('fails when a mirror duplicates the canonical body instead of pointing at it', () => {
    // BUG: progressive disclosure lost — the mirror silently becomes a second,
    // rotting copy of the instructions and doubles what a foreign harness loads.
    writeMirror('alpha', 'name: alpha\ndescription: Alpha.', `see skills/alpha/SKILL.md\n${'body line\n'.repeat(500)}`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/bytes \(> 4096\)/);
  });

  it('fails when a mirror body does not cite its canonical SKILL.md', () => {
    writeMirror('alpha', 'name: alpha\ndescription: Alpha.', 'no pointer here');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/does not cite the canonical skills\/alpha\/SKILL\.md/);
  });

  it('fails when the mirror name disagrees with its directory', () => {
    writeMirror('alpha', 'name: beta\ndescription: Alpha.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/declares name 'beta' != directory 'alpha'/);
  });

  it('fails on a missing mirror and on an orphan mirror', () => {
    // BUG: a new skill invisible to every non-Claude harness / a deleted skill
    // still advertised to them.
    writeSource('beta');
    writeMirror('ghost', 'name: ghost\ndescription: Ghost.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/1 source skill\(s\) have no mirror: beta/);
    expect(r.stdout).toMatch(/1 orphan mirror\(s\) with no source skill: ghost/);
  });

  it('fails on unparseable mirror frontmatter', () => {
    mkdirSync(join(root, '.agents', 'skills', 'alpha'), { recursive: true });
    writeFileSync(join(root, '.agents', 'skills', 'alpha', 'SKILL.md'), '---\nname: [unclosed\n---\n\nskills/alpha/SKILL.md\n', 'utf8');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/no parseable YAML frontmatter/);
  });
});

describe('live repository', () => {
  it('passes against this repository', () => {
    const r = run(REPO_ROOT);
    expect(r.status, r.stdout).toBe(0);
  });
});
