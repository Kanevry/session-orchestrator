import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { generateCodexSurface } from '../../scripts/generate-codex-skills.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/generate-codex-skills.mjs', import.meta.url));
let root;

function write(relativePath, content) {
  const destination = join(root, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function command(name, fields = '') {
  write(`commands/${name}.md`, `---\ndescription: Command ${name}.\n${fields}---\n\nCanonical command ${name}.\n`);
}

function skill(name) {
  write(`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Internal ${name}.\n---\n\nCanonical skill ${name}.\n`);
}

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, '--plugin-root', root, '--json', ...args], {
    encoding: 'utf8',
    env: { ...process.env, SO_WAVE_AGENT: '1' },
  });
}

function readSkill(name) {
  const file = join(root, '.codex-plugin', 'skills', name, 'SKILL.md');
  const raw = readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  return { file, raw, fm: yaml.load(match[1]), body: match[2] };
}

function outputSnapshot(directory = '.codex-plugin/skills') {
  if (!existsSync(join(root, directory))) return {};
  return Object.fromEntries(readdirSync(join(root, directory), { recursive: true })
    .map((name) => join(directory, name))
    .filter((name) => statSync(join(root, name)).isFile())
    .map((name) => [name, { body: readFileSync(join(root, name), 'utf8'), mtime: statSync(join(root, name)).mtimeMs }]));
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codex-surface-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('Codex command discovery', () => {
  it('publishes missing command names and gives a command precedence over its internal skill', () => {
    // Regression: exposing skills/ alone loses /go and bypasses /plan argument handling.
    command('go', 'disable-model-invocation: true\n');
    command('plan');
    skill('plan');
    skill('wave-executor');

    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.skills).toEqual(['go', 'plan', 'wave-executor']);
    expect(report.files).toEqual([
      '.codex-plugin/skills/go/SKILL.md',
      '.codex-plugin/skills/go/agents/openai.yaml',
      '.codex-plugin/skills/plan/SKILL.md',
      '.codex-plugin/skills/plan/agents/openai.yaml',
      '.codex-plugin/skills/wave-executor/SKILL.md',
    ]);
    for (const name of ['go', 'plan', 'wave-executor']) {
      const entry = readSkill(name);
      expect(entry.fm.name).toBe(name);
      const target = /\]\((\.\.\/\.\.\/\.\.\/[^)]+)\)/.exec(entry.body)[1];
      const expected = name === 'wave-executor' ? 'skills/wave-executor/SKILL.md' : `commands/${name}.md`;
      expect(resolve(dirname(entry.file), target)).toBe(join(root, expected));
      expect(existsSync(resolve(dirname(entry.file), target))).toBe(true);
      expect(entry.body).not.toContain(`Canonical command ${name}.`);
    }
    expect(readSkill('plan').fm.description).toBe('Command plan.');
  });

  it.each([
    ['close', 'disable-model-invocation: true\n', false],
    ['persona-panel', 'disable-model-invocation: false\n', true],
    ['session', '', true],
  ])('preserves native implicit invocation policy for %s', (name, fields, expected) => {
    // Regression: putting the flag only into SKILL metadata leaves Codex policy enabled.
    command(name, fields);
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const config = yaml.load(readFileSync(join(root, '.codex-plugin', 'skills', name, 'agents', 'openai.yaml'), 'utf8'));
    expect(config.policy.allow_implicit_invocation).toBe(expected);
    expect(config.interface.display_name).toBe(name);
  });

  it('preserves a native internal skill policy without inventing a policy for other skills', () => {
    skill('internal');
    skill('ordinary');
    write('skills/internal/agents/openai.yaml', 'policy:\n  allow_implicit_invocation: false\n');
    const result = generateCodexSurface({ pluginRoot: root });
    expect(result.ok).toBe(true);
    const file = join(root, '.codex-plugin/skills/internal/agents/openai.yaml');
    expect(existsSync(file)).toBe(true);
    const config = yaml.load(readFileSync(file, 'utf8'));
    expect(config.policy.allow_implicit_invocation).toBe(false);
    expect(existsSync(join(root, '.codex-plugin/skills/ordinary/agents/openai.yaml'))).toBe(false);
  });
});

describe('source validation before publication', () => {
  it('rejects a missing plugin root instead of claiming an empty surface is valid', () => {
    const missing = join(root, 'missing');
    const result = generateCodexSurface({ pluginRoot: missing });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(missing);
    expect(existsSync(missing)).toBe(false);
  });

  it.each([
    ['disable-model-invocation: "true"\n', 'disable-model-invocation'],
    ['argument-hint: [feature, deep]\n', 'argument-hint'],
    ['description: [wrong, type]\n', 'description'],
    ['name: other\n', 'name'],
    ['metadata: wrong\n', 'metadata'],
    ['allowed-tools: 4\n', 'allowed-tools'],
    // A QUOTED `user-invocable` is no longer a hard fail — it is normalised by
    // the shared `isUserInvocableValue` (2026-09-17: the boolean-only throw
    // crashed this generator on a value the Cursor and Pi generators happily
    // turned into a wrapper). A non-scalar still is.
    ['user-invocable: [nope]\n', 'user-invocable'],
    ['description: [unclosed\n', 'YAML'],
  ])('rejects invalid %s without updating earlier valid entries', (invalid, field) => {
    command('go');
    expect(generateCodexSurface({ pluginRoot: root }).ok).toBe(true);
    const before = outputSnapshot();
    command('go', 'disable-model-invocation: true\n');
    write('commands/zzz.md', `---\n${invalid.startsWith('description:') ? '' : 'description: Invalid source.\n'}${invalid}---\n`);

    const result = generateCodexSurface({ pluginRoot: root });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('commands/zzz.md');
    expect(result.errors.join('\n')).toContain(field);
    expect(result.written).toEqual([]);
    expect(outputSnapshot()).toEqual(before);
  });

  it('validates an internal skill even when its public command takes precedence', () => {
    command('plan');
    write('skills/plan/SKILL.md', '---\n- not a mapping\n---\n');
    const result = generateCodexSurface({ pluginRoot: root });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('skills/plan/SKILL.md');
    expect(result.written).toEqual([]);
  });

  // HIGH-2 (2026-09-17): one value, four verdicts — `user-invocable: "true"`
  // threw here, produced a wrapper on Cursor/Pi, and counted for neither
  // counter. The shared normaliser makes every quoted/cased form of `true`
  // produce the same generated POLICY + `$ARGUMENTS` wiring a bare `true`
  // produces.
  //
  // QA-MED-2 (2026-09-17): the ORIGINAL 4-form list — `'"true"'`, `"'true'"`,
  // `'True'` and `'true # a slash command'` — all SURVIVE a revert of the
  // shared normaliser back to its OLD form (`value === true || value ===
  // 'true'`): js-yaml's CORE_SCHEMA already resolves `True` and `true # c` to
  // the BOOLEAN `true`, and `"true"`/`'true'` to the exact STRING `'true'`,
  // all of which the OLD predicate accepted on its own (measured via
  // `yaml.load(src, {schema: yaml.CORE_SCHEMA})`; old `isUserInvocableValue`
  // at `git show HEAD:scripts/lib/user-invocable-skills.mjs`). `' true'` (a
  // quoted leading space) and `'TRUE'` (quoted, so js-yaml keeps it a STRING
  // instead of resolving it to a boolean) are the two forms that actually
  // distinguish the two predicates: OLD rejects both, NEW accepts both.
  //
  // Measured deviation from a byte-identical full-file assertion: unlike the
  // 4 original forms, `' true'` and `'TRUE'` do NOT round-trip through
  // `toPortableFrontmatter`'s `toMetadataString` (`scripts/generate-agents-skills.mjs`)
  // as the literal text `true` — that helper does a bare `String(value)`
  // with no case/whitespace normalisation, so the projected
  // `metadata.user-invocable` frontmatter field legitimately echoes the
  // source token verbatim (`' true'` / `'TRUE'`), not `'true'`. That is a
  // portability-mirror concern, not the HIGH-2/QA-MED-2 defect class. So this
  // test compares the parts that DO depend on `isUserInvocableValue`'s
  // verdict — the generated policy file and the `$ARGUMENTS`-bearing body —
  // rather than the full raw SKILL.md text.
  it.each(["' true'", "'TRUE'"])(
    'reads user-invocable: %s exactly like a bare true (same policy + $ARGUMENTS wiring)',
    (form) => {
      write('skills/close/SKILL.md', '---\nname: close\ndescription: Close it.\nuser-invocable: true\n---\n\nBody.\n');
      expect(generateCodexSurface({ pluginRoot: root }).ok).toBe(true);
      const barePolicyPath = join(root, '.codex-plugin/skills/close/agents/openai.yaml');
      const barePolicy = yaml.load(readFileSync(barePolicyPath, 'utf8'));
      const bareBody = readSkill('close').body;

      rmSync(join(root, '.codex-plugin'), { recursive: true, force: true });
      write('skills/close/SKILL.md', `---\nname: close\ndescription: Close it.\nuser-invocable: ${form}\n---\n\nBody.\n`);
      const result = generateCodexSurface({ pluginRoot: root });
      expect(result.ok).toBe(true);
      const quotedPolicy = yaml.load(readFileSync(barePolicyPath, 'utf8'));
      const quotedBody = readSkill('close').body;

      expect(quotedPolicy).toEqual(barePolicy);
      expect(quotedBody).toBe(bareBody);
      expect(quotedBody).toContain('$ARGUMENTS');
    },
  );

  // QA-MED-2 (2026-09-17): the rejects-invalid table above used to carry
  // `['user-invocable: "false"\n', 'user-invocable']` (`git show
  // 3ebf0e9d:tests/scripts/generate-codex-skills.test.mjs`); replacing it with
  // the non-scalar `[nope]` case lost the quoted-false pin. `"false"` is a
  // VALID string scalar — `validateFrontmatter` never throws on it — so it
  // belongs here as its own not-invocable assertion, not back in the
  // rejects-invalid table.
  it('treats user-invocable: "false" as not user-invocable rather than throwing', () => {
    write('skills/quiet/SKILL.md', '---\nname: quiet\ndescription: A quiet skill.\nuser-invocable: "false"\n---\n\nBody.\n');
    const result = generateCodexSurface({ pluginRoot: root });
    expect(result.ok).toBe(true);
    const entry = readSkill('quiet');
    expect(entry.body).not.toContain('$ARGUMENTS');
    expect(existsSync(join(root, '.codex-plugin/skills/quiet/agents/openai.yaml'))).toBe(false);
  });

  it('rejects an invalid native skill policy before publishing the public command', () => {
    skill('plan');
    command('plan');
    write('skills/plan/agents/openai.yaml', 'policy:\n  allow_implicit_invocation: "false"\n');
    const result = generateCodexSurface({ pluginRoot: root });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('skills/plan/agents/openai.yaml');
    expect(result.written).toEqual([]);
  });
});

describe('generated artifact ownership and freshness', () => {
  it('detects policy changes and removed commands without writes, then exposes the underlying skill', () => {
    command('plan', 'disable-model-invocation: true\n');
    skill('plan');
    command('go');
    expect(generateCodexSurface({ pluginRoot: root }).ok).toBe(true);
    const before = outputSnapshot();
    rmSync(join(root, 'commands/plan.md'));
    command('go', 'disable-model-invocation: true\n');

    const check = generateCodexSurface({ pluginRoot: root, check: true });
    expect(check.ok).toBe(false);
    expect(check.drift.join('\n')).toContain('plan');
    expect(check.drift.join('\n')).toContain('go');
    expect(check.written).toEqual([]);
    expect(outputSnapshot()).toEqual(before);

    expect(generateCodexSurface({ pluginRoot: root }).ok).toBe(true);
    expect(readSkill('plan').fm.description).toBe('Internal plan.');
    expect(existsSync(join(root, '.codex-plugin/skills/plan/agents/openai.yaml'))).toBe(false);
    expect(generateCodexSurface({ pluginRoot: root, check: true }).ok).toBe(true);
  });

  it('removes only obsolete generated files and retains unrelated neighboring files', () => {
    command('go');
    expect(generateCodexSurface({ pluginRoot: root }).ok).toBe(true);
    write('.codex-plugin/skills/go/notes.txt', 'Operator notes.');
    rmSync(join(root, 'commands/go.md'));
    const check = generateCodexSurface({ pluginRoot: root, check: true });
    expect(check.ok).toBe(false);
    expect(existsSync(join(root, '.codex-plugin/skills/go/SKILL.md'))).toBe(true);
    const generated = generateCodexSurface({ pluginRoot: root });
    expect(generated.ok).toBe(true);
    expect(existsSync(join(root, '.codex-plugin/skills/go/SKILL.md'))).toBe(false);
    expect(readFileSync(join(root, '.codex-plugin/skills/go/notes.txt'), 'utf8')).toBe('Operator notes.');
    expect(generated.warnings.join('\n')).toContain('notes.txt');
  });

  it('refuses to overwrite an unrelated artifact before writing other entries', () => {
    command('close');
    command('go');
    write('.codex-plugin/skills/go/SKILL.md', 'Hand-authored skill.');
    const before = outputSnapshot();
    const result = generateCodexSurface({ pluginRoot: root });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('.codex-plugin/skills/go/SKILL.md');
    expect(result.written).toEqual([]);
    expect(outputSnapshot()).toEqual(before);
  });

  it('does not clean obsolete files through a symlinked output parent when no sources remain', () => {
    command('go');
    expect(generateCodexSurface({ pluginRoot: root }).ok).toBe(true);
    const before = outputSnapshot();
    const other = mkdtempSync(join(tmpdir(), 'codex-surface-link-'));
    try {
      symlinkSync(join(root, '.codex-plugin'), join(other, '.codex-plugin'), 'dir');
      const result = generateCodexSurface({ pluginRoot: other });
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('.codex-plugin');
      expect(outputSnapshot()).toEqual(before);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  it('detects an artifact occupied by a directory before publishing earlier entries', () => {
    command('close');
    command('go');
    mkdirSync(join(root, '.codex-plugin/skills/go/SKILL.md'), { recursive: true });
    const result = generateCodexSurface({ pluginRoot: root });
    expect(result.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(existsSync(join(root, '.codex-plugin/skills/close'))).toBe(false);
  });
});
