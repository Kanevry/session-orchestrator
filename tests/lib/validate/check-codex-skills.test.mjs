import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateCodexSkills } from '../../../scripts/lib/validate/check-codex-skills.mjs';

let root;

function write(relative, content) {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function source(name, kind, extra = '') {
  const file = kind === 'command' ? `commands/${name}.md` : `skills/${name}/SKILL.md`;
  write(file, `---\nname: ${name}\ndescription: Canonical ${name}.\n${extra}---\n\nOriginal workflow.\n`);
}

function entry(name, kind) {
  const target = kind === 'command' ? `commands/${name}.md` : `skills/${name}/SKILL.md`;
  write(`.codex-plugin/skills/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: Select ${name}.\n---\n\n[Canonical source](../../../${target})\n`);
  if (kind === 'command') {
    write(`.codex-plugin/skills/${name}/agents/openai.yaml`,
      `interface:\n  display_name: ${name}\npolicy:\n  allow_implicit_invocation: false\n`);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-skill-contract-'));
  write('.codex-plugin/plugin.json', JSON.stringify({ skills: './.codex-plugin/skills/', commands: [] }));
  source('go', 'command', 'disable-model-invocation: true\n');
  source('plan', 'command', 'disable-model-invocation: true\n');
  source('plan', 'skill');
  source('wave-executor', 'skill');
  entry('go', 'command');
  entry('plan', 'command');
  entry('wave-executor', 'skill');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Codex discovery contract, independent of generated text', () => {
  it('accepts a complete command-first union authored without the generator', () => {
    expect(validateCodexSkills(root)).toEqual({
      skills: ['go', 'plan', 'wave-executor'], violations: [],
    });
  });

  it('rejects a manifest that leaves otherwise valid command adapters disconnected', () => {
    write('.codex-plugin/plugin.json', JSON.stringify({ skills: './skills/', commands: [] }));
    expect(validateCodexSkills(root).violations.join('\n')).toMatch(/manifest.*skills/i);
  });

  it('rejects a standard root manifest that overrides native Codex skill discovery', () => {
    write('plugin.json', JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'fixture', version: '1.0.0', skills: './.codex-plugin/skills/',
    }));
    expect(validateCodexSkills(root).violations.join('\n')).toMatch(/root.*manifest.*overrides.*Codex/i);
  });

  it.each([undefined, null, './commands/', ['./commands/']])('rejects automatic command migration when commands is %s', (commands) => {
    write('.codex-plugin/plugin.json', JSON.stringify({ skills: './.codex-plugin/skills/', commands }));
    expect(validateCodexSkills(root).violations.join('\n')).toMatch(/commands.*empty.*migration/i);
  });

  it('detects a missing command and an orphan registration together', () => {
    rmSync(join(root, '.codex-plugin/skills/go'), { recursive: true });
    entry('retired', 'skill');
    const errors = validateCodexSkills(root).violations.join('\n');
    expect(errors).toMatch(/go.*missing/);
    expect(errors).toMatch(/retired.*no canonical source/);
  });

  it('ignores retained resources after a command and its generated entry are removed', () => {
    rmSync(join(root, 'commands/go.md'));
    rmSync(join(root, '.codex-plugin/skills/go/SKILL.md'));
    rmSync(join(root, '.codex-plugin/skills/go/agents/openai.yaml'));
    write('.codex-plugin/skills/go/notes.txt', 'Keep this unrelated resource.');
    expect(validateCodexSkills(root)).toEqual({
      skills: ['plan', 'wave-executor'], violations: [],
    });
  });

  it('rejects an adapter that bypasses its command in favor of a same-named skill', () => {
    entry('plan', 'skill');
    expect(validateCodexSkills(root).violations.join('\n')).toMatch(/plan.*canonical.*commands\/plan\.md/);
  });

  it.each([true, 'false', null])('rejects a lost or mistyped explicit-only policy: %s', (value) => {
    write('.codex-plugin/skills/go/agents/openai.yaml',
      `policy:\n  allow_implicit_invocation: ${JSON.stringify(value)}\n`);
    expect(validateCodexSkills(root).violations.join('\n')).toMatch(/go.*allow_implicit_invocation/);
  });

  it('requires a command policy sidecar even when metadata advertises a policy', () => {
    rmSync(join(root, '.codex-plugin/skills/go/agents/openai.yaml'));
    expect(validateCodexSkills(root).violations.join('\n')).toMatch(/go.*openai\.yaml/);
  });

  it('rejects malformed discovery metadata and duplicate frontmatter names', () => {
    const file = join(root, '.codex-plugin/skills/go/SKILL.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('name: go', 'name: plan').replace('description: Select go.', 'description: []'));
    const errors = validateCodexSkills(root).violations.join('\n');
    expect(errors).toMatch(/go.*name/);
    expect(errors).toMatch(/go.*description/);
  });

  it('rejects a canonical source symlink that would escape the distributed package', () => {
    const outside = mkdtempSync(join(tmpdir(), 'codex-outside-'));
    try {
      writeFileSync(join(outside, 'source.md'), readFileSync(join(root, 'commands/go.md')));
      rmSync(join(root, 'commands/go.md'));
      symlinkSync(join(outside, 'source.md'), join(root, 'commands/go.md'));
      expect(validateCodexSkills(root).violations.join('\n')).toMatch(/go.*outside.*package/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
