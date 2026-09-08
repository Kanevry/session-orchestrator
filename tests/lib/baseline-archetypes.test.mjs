import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pluginRoot = path.resolve(import.meta.dirname, '../..');
const cli = path.join(pluginRoot, 'scripts/baseline-archetypes.mjs');
const roots = [];
const temp = () => { const root = mkdtempSync(path.join(tmpdir(), 'baseline-contract-')); roots.push(root); return root; };
const put = (root, name, body) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), body); };

// Same reduced producer field set, with arbitrary synthetic identities and markers.
function entry(id, priority, signals) {
  return {
    id, order: priority + 1, templatePath: `templates/${id}`,
    runtimes: [{ name: 'node', version: '24' }], packageManagers: [{ name: 'npm', version: '11' }],
    ui: { mode: 'none', framework: 'none', tailwind: false }, api: { mode: 'http', framework: 'sample-http' },
    deploy: { default: 'local', alternatives: [] }, detection: { priority, signals },
    qualityGates: [{ id: 'test', command: 'npm test', packageScript: 'test' }],
    commands: [{ command: 'npm test', description: 'Run checks' }], ci: { required: true, profile: 'sample' },
    ruleTargets: ['parallel-sessions.md', 'sample-runtime.md'],
  };
}
function fixture(mutate = () => {}) {
  const baseline = temp();
  const contract = {
    schemaVersion: 1, source: 'templates/archetypes.json',
    browserAutomation: { agent: 'sample-browser-cli', repeatable: 'sample-browser-test', browserMcp: false },
    rulePolicy: { conditional: [{ id: 'assistant', dependencies: ['sample-assistant'], dependencyPrefixes: ['@sample-ai/'], targets: ['sample-ai.md', 'parallel-sessions.md'] }] },
    archetypes: [entry('sample-general', 1, [{ kind: 'path', value: 'package.json' }]), entry('sample-specific', 10, [{ kind: 'all', conditions: [{ kind: 'packageDependency', value: 'sample-engine' }, { kind: 'path', value: 'service/*.mjs' }] }])],
  };
  mutate(contract);
  put(baseline, 'contract.json', JSON.stringify(contract));
  put(baseline, 'scripts/archetype-manifest.mjs', `import { readFileSync } from 'node:fs';
const command = process.argv[2];
if (command === 'export') process.stdout.write(readFileSync(new URL('../contract.json', import.meta.url)));
else if (command === 'rules') {
  const root = process.argv[process.argv.indexOf('--repo') + 1];
  let pkg = {}; try { pkg = JSON.parse(readFileSync(root + '/package.json')); } catch {}
  const names = Object.keys({...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies});
  const rules = ['.claude/rules/parallel-sessions.md', 'templates/shared/.claude/rules/sample-runtime.md'];
  if (names.some(n => n === 'sample-assistant' || n.startsWith('@sample-ai/'))) rules.push('.claude/rules/sample-ai.md');
  process.stdout.write(rules.join('\\n') + '\\n');
} else process.exit(2);
`);
  for (const name of ['sample-general', 'sample-specific']) put(baseline, `templates/${name}/README.md`, '# Synthetic template');
  put(baseline, 'templates/shared/.claude/rules/sample-runtime.md', '# Runtime');
  put(baseline, '.claude/rules/sample-ai.md', '# Conditional');
  put(baseline, '.claude/rules/parallel-sessions.md', '# Must not replace plugin rule');
  return baseline;
}
function run(repo, baseline, args = []) {
  const env = { ...process.env, SO_BASELINE_PATH: baseline ?? '', SO_CONFIG_HOME: path.join(repo, 'no-owner-config'), SO_PLATFORM: 'codex' };
  return spawnSync(process.execPath, [cli, '--repo', repo, ...args], { env, cwd: repo, encoding: 'utf8', timeout: 10000 });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('configured baseline bootstrap contract', () => {
  it('keeps an unconfigured or missing baseline public without writing files', () => {
    const repo = temp();
    for (const baseline of [undefined, path.join(repo, 'absent')]) {
      const result = run(repo, baseline);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'public', selected: null, archetypes: [] });
    }
    expect(readdirSync(repo)).toEqual([]);
  });

  it('runs the public lookup with no installed package dependencies', () => {
    const isolated = temp(); const repo = temp();
    cpSync(path.join(pluginRoot, 'scripts/lib'), path.join(isolated, 'scripts/lib'), { recursive: true });
    cpSync(cli, path.join(isolated, 'scripts/baseline-archetypes.mjs'));
    const result = spawnSync(process.execPath, [path.join(isolated, 'scripts/baseline-archetypes.mjs'), '--repo', repo], {
      cwd: repo, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, SO_BASELINE_PATH: '', SO_CONFIG_HOME: path.join(repo, 'absent-owner') },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('public');
    expect(readdirSync(repo)).toEqual([]);
  });

  it('selects a synthetic private ID and carries complete expectations without leaking the host path', () => {
    const repo = temp(); const baseline = fixture();
    const result = run(repo, baseline, ['--archetype', 'sample-specific']);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ status: 'private', reason: 'selected', selected: {
      id: 'sample-specific', templatePath: 'templates/sample-specific',
      commands: [{ command: 'npm test', description: 'Run checks' }],
      qualityGates: [{ id: 'test', command: 'npm test', packageScript: 'test' }],
      ci: { required: true, profile: 'sample' },
      baselineRules: [{ source: 'templates/shared/.claude/rules/sample-runtime.md', target: '.claude/rules/sample-runtime.md' }],
    } });
    expect(output.selected.pluginRuleTargets).toEqual(['parallel-sessions.md']);
    expect(result.stdout).not.toContain(baseline);
    expect(result.stderr).toBe('');
    expect(readdirSync(repo)).toEqual([]);
  });

  it('prefers specific markers and includes conditional rules for optional dependencies', () => {
    const repo = temp(); const baseline = fixture();
    put(repo, 'package.json', JSON.stringify({ dependencies: { 'sample-engine': '*' }, optionalDependencies: { '@sample-ai/client': '*' } }));
    put(repo, 'service/main.mjs', '');
    const result = run(repo, baseline);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).selected).toMatchObject({ id: 'sample-specific', ruleTargets: ['parallel-sessions.md', 'sample-ai.md', 'sample-runtime.md'], baselineRules: [
      { source: '.claude/rules/sample-ai.md', target: '.claude/rules/sample-ai.md' },
      { source: 'templates/shared/.claude/rules/sample-runtime.md', target: '.claude/rules/sample-runtime.md' },
    ] });
  });

  it('reports unknown evidence without substituting a public archetype', () => {
    const result = run(temp(), fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'private', reason: 'insufficient-evidence', selected: null, archetypes: [{ id: 'sample-general' }, { id: 'sample-specific' }] });
  });

  it.each([
    ['schema version', (m) => { m.schemaVersion = 2; }],
    ['missing metadata', (m) => { delete m.archetypes[0].ci; }],
    ['private extra data', (m) => { m.catalog = { package: '@secret/internal' }; }],
    ['template traversal', (m) => { m.archetypes[0].templatePath = 'templates/../../secret'; }],
    ['rule traversal', (m) => { m.archetypes[0].ruleTargets.push('../secret.md'); }],
    ['unsafe marker', (m) => { m.archetypes[0].detection.signals[0].value = '../private'; }],
    ['unknown signal', (m) => { m.archetypes[0].detection.signals[0].kind = 'script'; }],
    ['duplicate id', (m) => { m.archetypes[1].id = m.archetypes[0].id; }],
    ['absolute host command', (m) => { m.archetypes[0].commands[0].command = '/private/local/tool'; }],
  ])('fails closed for %s without disclosing rejected data', (_label, mutate) => {
    const baseline = fixture(mutate); const result = run(temp(), baseline);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'error', reason: 'invalid-contract' });
    expect(result.stdout + result.stderr).not.toContain(baseline);
    expect(result.stdout + result.stderr).not.toContain('@secret/internal');
    expect(result.stderr).toBe('');
  });

  it('does not execute manifest command data', () => {
    const repo = temp(); const result = run(repo, fixture((m) => { m.archetypes[0].commands[0].command = 'touch command-was-executed'; }), ['--archetype', 'sample-general']);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(repo)).toEqual([]);
  });

  it.each(['missing', 'malformed', 'stderr', 'oversize', 'unsafe-rules', 'missing-rule', 'symlink'])('rejects a %s producer instead of falling back', (mode) => {
    const baseline = fixture();
    const script = 'scripts/archetype-manifest.mjs';
    if (mode === 'missing') rmSync(path.join(baseline, script));
    if (mode === 'malformed') put(baseline, script, 'process.stdout.write("not json")');
    if (mode === 'stderr') put(baseline, script, 'process.stderr.write("/private/secret-host/token"); process.exit(1)');
    if (mode === 'oversize') put(baseline, script, 'process.stdout.write("x".repeat(2000000))');
    if (mode === 'unsafe-rules') put(baseline, script, `import {readFileSync} from 'node:fs'; process.stdout.write(process.argv[2] === 'export' ? readFileSync(new URL('../contract.json', import.meta.url)) : '../secret.md');`);
    if (mode === 'missing-rule') rmSync(path.join(baseline, 'templates/shared/.claude/rules/sample-runtime.md'));
    if (mode === 'symlink') { rmSync(path.join(baseline, script)); symlinkSync(path.join(baseline, 'contract.json'), path.join(baseline, script)); }
    const result = run(temp(), baseline, ['--archetype', 'sample-general']);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).status).toBe('error');
    expect(result.stdout + result.stderr).not.toContain('/private/secret-host');
    expect(result.stdout + result.stderr).not.toContain(baseline);
  });

  it('rejects unknown explicit archetypes without echoing them', () => {
    const result = run(temp(), fixture(), ['--archetype', 'unknown-choice']);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'error', reason: 'unknown-archetype' });
    expect(result.stdout).not.toContain('unknown-choice');
  });

  it('keeps ambiguous named baseline diagnostics private while preserving first-match resolution', () => {
    const repo = temp(); const baseline = fixture();
    const owner = {
      owner: { name: 'Synthetic Owner', language: 'en' }, tone: { style: 'neutral', tonality: '' },
      efficiency: { 'output-level': 'lite', preamble: 'minimal' }, 'hardware-sharing': { enabled: false },
      baselines: [
        { name: 'private-first-name', path: baseline, match: { 'path-prefix': repo } },
        { name: 'private-second-name', path: path.join(repo, 'missing'), match: { 'path-prefix': repo } },
      ],
    };
    // JSON is valid YAML, avoiding any fixture dependency on a YAML writer.
    put(repo, 'no-owner-config/owner.yaml', JSON.stringify(owner));
    const result = run(repo, undefined, ['--archetype', 'sample-specific']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).selected.id).toBe('sample-specific');
    for (const secret of [repo, baseline, 'private-first-name', 'private-second-name']) expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it('filters plugin-owned scoped basenames even when the selected private ID does not match their scope', () => {
    const baseline = fixture((m) => { for (const entry of m.archetypes) entry.ruleTargets.push('frontend.md'); });
    const producer = path.join(baseline, 'scripts/archetype-manifest.mjs');
    const script = readFileSync(producer, 'utf8').replace("const rules = [", "const rules = ['.claude/rules/frontend.md', ");
    writeFileSync(producer, script);
    const result = run(temp(), baseline, ['--archetype', 'sample-specific']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).selected.pluginRuleTargets).toEqual(['frontend.md', 'parallel-sessions.md']);
    expect(JSON.parse(result.stdout).selected.baselineRules).toEqual([{ source: 'templates/shared/.claude/rules/sample-runtime.md', target: '.claude/rules/sample-runtime.md' }]);
  });

  it.each(['committed', 'owner', 'named', 'environment'])('uses %s configuration at the established precedence', async (tier) => {
    const { loadBaselineArchetypes } = await import('../../scripts/lib/baseline-archetypes.mjs');
    const repoRoot = temp(); const baseline = fixture(); const broken = temp();
    put(repoRoot, 'AGENTS.md', `## Session Config\n- plan-baseline-path: ${tier === 'committed' ? baseline : broken}\n`);
    const ownerConfig = {}; const env = {};
    if (tier !== 'committed') ownerConfig.paths = { 'baseline-path': tier === 'owner' ? baseline : broken };
    if (['named', 'environment'].includes(tier)) ownerConfig.baselines = [{ name: 'sample-context', path: tier === 'named' ? baseline : broken, match: { 'path-prefix': repoRoot } }];
    if (tier === 'environment') env.SO_BASELINE_PATH = baseline;
    const result = await loadBaselineArchetypes({ repoRoot, archetype: 'sample-specific', hostPaths: { env, ownerConfig } });
    expect(result).toMatchObject({ status: 'private', selected: { id: 'sample-specific' } });
  });

  it('bounds a stalled local producer and sanitizes its failure', async () => {
    const { loadBaselineArchetypes } = await import('../../scripts/lib/baseline-archetypes.mjs');
    const baseline = fixture(); put(baseline, 'scripts/archetype-manifest.mjs', 'setInterval(() => {}, 1000);');
    const result = await loadBaselineArchetypes({ repoRoot: temp(), timeoutMs: 30, hostPaths: { env: { SO_BASELINE_PATH: baseline }, ownerConfig: {} } });
    expect(result).toMatchObject({ status: 'error', reason: 'producer-failed' });
  });
});
