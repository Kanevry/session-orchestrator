import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSessionConfig } from '../../scripts/lib/config.mjs';
import { loadQualityGatesPolicy, resolveCommand } from '../../scripts/lib/quality-gates-policy.mjs';

const pluginRoot = path.resolve(import.meta.dirname, '../..');
const roots = [];
const put = (root, name, content) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), content); };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'private-bootstrap-')); roots.push(root);
  const baseline = path.join(root, 'baseline'); const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const contract = { schemaVersion: 1, source: 'templates/archetypes.json', browserAutomation: { agent: 'sample-cli', repeatable: 'sample-test', browserMcp: false }, rulePolicy: { conditional: [{ id: 'assistant', dependencies: ['sample-assistant'], dependencyPrefixes: [], targets: ['sample-ai.md'] }] }, archetypes: [{ id: 'sample-web', order: 1, templatePath: 'templates/sample-web', runtimes: [{ name: 'node', version: '24' }], packageManagers: [{ name: 'npm', version: '11' }], ui: { mode: 'web', framework: 'sample', tailwind: false }, api: { mode: 'none', framework: 'none' }, deploy: { default: 'local', alternatives: [] }, detection: { priority: 1, signals: [{ kind: 'packageField', value: 'sample' }] }, qualityGates: [{ id: 'test', command: 'npm test' }], commands: [{ command: 'npm test', description: 'Test' }], ci: { required: true, profile: 'sample' }, ruleTargets: ['parallel-sessions.md', 'sample-runtime.md'] }] };
  put(baseline, 'contract.json', JSON.stringify(contract));
  put(baseline, 'scripts/archetype-manifest.mjs', `import {readFileSync} from 'node:fs';
if(process.argv[2] === 'export') process.stdout.write(readFileSync(new URL('../contract.json', import.meta.url)));
else if(process.argv[2] === 'rules') {
 let pkg={}; try { pkg=JSON.parse(readFileSync(process.argv[process.argv.indexOf('--repo')+1]+'/package.json')); } catch {}
 const contract=JSON.parse(readFileSync(new URL('../contract.json', import.meta.url)));
 process.stdout.write(contract.archetypes[0].ruleTargets.map(name => name === 'sample-runtime.md' ? 'templates/shared/.claude/rules/'+name : '.claude/rules/'+name).join('\\n')+'\\n' + (pkg.dependencies?.['sample-assistant'] ? '.claude/rules/sample-ai.md\\n' : ''));
} else process.exit(2);`);
  put(baseline, 'scripts/lib/common.sh', '# Synthetic offline renderer support\n');
  put(baseline, 'scripts/lib/render-archetype.sh', `render_archetype_dir() { [ "$1" = sample-web ] || return 2; cp -R "$TEMPLATES_DIR/$1/." "$2/"; }
render_shared_and_substitute() { [ "$1" = sample-project ] || return 2; printf '# Shared metadata\\n' > "$2/AGENTS.md"; }
render_archetype_metadata() { [ "$1" = sample-web ] && [ "$2" = sample-project ]; }
`);
  put(baseline, 'templates/sample-web/package.json', JSON.stringify({ name: 'sample-project', dependencies: { 'sample-assistant': '*' }, scripts: { test: 'sample-test' } }));
  put(baseline, 'templates/sample-web/.gitlab-ci.yml', 'test:\n  script: npm test\n');
  put(baseline, 'templates/sample-web/.claude/rules/parallel-sessions.md', '# Rival copy\n');
  put(baseline, 'templates/shared/.claude/rules/sample-runtime.md', '# Contract runtime\n');
  put(baseline, '.claude/rules/sample-ai.md', '# Contract conditional\n');
  put(baseline, '.claude/rules/parallel-sessions.md', '# Rival canonical rule\n');
  put(repo, '.claude/rules/parallel-sessions.md', '<!-- source: session-orchestrator plugin -->\n# Keep plugin\n');
  put(repo, 'README.md', '# Owner content\n');
  return { root, baseline, repo };
}
function block(file, heading) {
  const location = path.join(pluginRoot, 'skills/bootstrap', file);
  const body = existsSync(location) ? readFileSync(location, 'utf8') : '';
  const code = body.slice(body.indexOf(heading)).match(/```bash\n([\s\S]*?)\n\s*```/)?.[1];
  if (!code) return 'exit 3';
  const indent = Math.min(...code.split('\n').filter(line => line.trim()).map(line => line.match(/^ */)[0].length));
  return code.split('\n').map(line => line.slice(indent)).join('\n');
}
function execute(script, { root, baseline, repo }) {
  // 60 s, not 15 s: each block spawns several node processes; on a loaded shared
  // runner 15 s produced status:null (SIGTERM by the timeout) on GitLab #9048 shard 3/3
  // twice while the same code passed on #9047 and locally (2026-09-09, #1298.10).
  return spawnSync('bash', ['-euo', 'pipefail', '-c', script], { cwd: repo, timeout: 60000, encoding: 'utf8', env: {
    ...process.env, SO_CONFIG_HOME: path.join(root, 'owner-config'), SO_BASELINE_PATH: baseline, REPO_ROOT: repo,
    PLUGIN_ROOT: pluginRoot, CONFIRMED_ARCHETYPE: 'sample-web', REPO_NAME: 'sample-project', PATH_TYPE: 'private', CONFIG: '{}', GITLAB_TOKEN: '', GITLAB_HOST: '', DRY_RUN: '', RULES_CATEGORIES: '',
  } });
}
function reviseContract(context, update) {
  const filename = path.join(context.baseline, 'contract.json');
  const contract = JSON.parse(readFileSync(filename, 'utf8'));
  update(contract.archetypes[0]);
  writeFileSync(filename, JSON.stringify(contract));
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('executes the private bootstrap recipe with contract templates, CI and rule union while preserving existing files', () => {
  const context = fixture();
  const scaffold = execute(block('private-contract.md', '## Scaffold'), context);
  expect(scaffold.status, scaffold.stderr).toBe(0);
  expect(readFileSync(path.join(context.repo, '.gitlab-ci.yml'), 'utf8')).toBe('test:\n  script: npm test\n');
  expect(JSON.parse(readFileSync(path.join(context.repo, 'package.json'), 'utf8')).dependencies).toEqual({ 'sample-assistant': '*' });
  expect(readFileSync(path.join(context.repo, 'README.md'), 'utf8')).toBe('# Owner content\n');
  const rules = execute(block('_shared-template.md', '## #baseline-fetch'), context);
  expect(rules.status, rules.stderr).toBe(0);
  expect(readFileSync(path.join(context.repo, '.claude/rules/sample-runtime.md'), 'utf8')).toBe('# Contract runtime\n');
  expect(readFileSync(path.join(context.repo, '.claude/rules/sample-ai.md'), 'utf8')).toBe('# Contract conditional\n');
  expect(readFileSync(path.join(context.repo, '.claude/rules/parallel-sessions.md'), 'utf8')).toBe('<!-- source: session-orchestrator plugin -->\n# Keep plugin\n');
  expect(scaffold.stdout + scaffold.stderr + rules.stdout + rules.stderr).not.toContain(context.baseline);
});

it.each(['template', 'destination'])('rejects %s symlinks before applying scaffold files', (mode) => {
  const context = fixture(); const outside = path.join(context.root, 'outside'); mkdirSync(outside);
  if (mode === 'template') symlinkSync(outside, path.join(context.baseline, 'templates/sample-web/linked'));
  else symlinkSync(outside, path.join(context.repo, 'AGENTS.md'));
  const result = execute(block('private-contract.md', '## Scaffold'), context);
  expect(result.status).not.toBe(0);
  expect(existsSync(path.join(context.repo, 'package.json'))).toBe(false);
  expect(result.stdout + result.stderr).not.toContain(context.baseline);
});

it('derives new instruction-file command configuration from declared gates instead of inherited stack defaults', () => {
  const context = fixture();
  put(context.baseline, 'templates/sample-web/CLAUDE.md', '# Template\n\n## Session Config\n- test-command: old test\n- typecheck-command: old typecheck\n- lint-command: old lint\n\n## Project notes\nKeep these notes.\n');
  const result = execute(block('private-contract.md', '## Scaffold'), context);
  expect(result.status, result.stderr).toBe(0);
  const content = readFileSync(path.join(context.repo, 'CLAUDE.md'), 'utf8');
  const config = parseSessionConfig(content, { hostPaths: { env: {}, ownerConfig: {} } });
  expect(config['test-command']).toBe('npm test');
  expect(config['typecheck-command']).toBe('false');
  expect(config['lint-command']).toBe('false');
  expect(content).toContain('Keep these notes.');
});

it('preserves an existing local baseline rule and fails closed when source projection changes', () => {
  const context = fixture(); put(context.repo, '.claude/rules/sample-runtime.md', '# Owner rule\n');
  const first = execute(block('_shared-template.md', '## #baseline-fetch'), context);
  expect(first.status, first.stderr).toBe(0);
  expect(readFileSync(path.join(context.repo, '.claude/rules/sample-runtime.md'), 'utf8')).toBe('# Owner rule\n');
  put(context.baseline, 'scripts/archetype-manifest.mjs', 'process.stderr.write("private diagnostic"); process.exit(2)');
  const failed = execute(block('_shared-template.md', '## #baseline-fetch'), context);
  expect(failed.status).not.toBe(0);
  expect(failed.stdout + failed.stderr).not.toContain('private diagnostic');
});

it.each([['backend.md', 'security-web.md'], ['frontend.md', 'security-web.md']])('delivers the private required rule union through bootstrap and later --sync-rules: %j', (...targets) => {
  const context = fixture();
  reviseContract(context, item => { item.ruleTargets.push(...targets); });
  const result = execute([
    block('private-contract.md', '## Scaffold'),
    block('fast-template.md', '## Step 3a:'),
    block('_shared-template.md', '## #parallel-sessions-rule'),
    block('_shared-template.md', '## #baseline-fetch'),
  ].join('\n'), context);
  expect(result.status, result.stderr).toBe(0);
  for (const name of targets) {
    const filename = path.join(context.repo, '.claude/rules', name);
    expect(existsSync(filename), name).toBe(true);
    expect(readFileSync(filename, 'utf8')).toMatch(/^<!-- source: session-orchestrator plugin/);
    rmSync(filename);
  }
  put(context.repo, '.orchestrator/bootstrap.lock', 'tier: standard\narchetype: sample-web\n');
  const resync = execute(`unset CONFIRMED_ARCHETYPE\n${block('SKILL.md', '## Sync-Rules Flow')}`, context);
  expect(resync.status, resync.stderr).toBe(0);
  for (const name of targets) expect(existsSync(path.join(context.repo, '.claude/rules', name)), name).toBe(true);
});

it.each([
  { gates: [{ id: 'test', command: 'make test' }, { id: 'fmt', command: 'make fmt' }, { id: 'vet', command: 'make vet' }], expected: { test: 'make test', typecheck: 'false', lint: 'false' } },
  { gates: [{ id: 'test', command: 'make test' }, { id: 'typecheck', command: 'make typecheck' }, { id: 'lint', command: 'make lint' }], expected: { test: 'make test', typecheck: 'make typecheck', lint: 'make lint' } },
  { gates: [{ id: 'typecheck', command: 'npm run check' }, { id: 'lint', command: 'npm run lint' }], expected: { test: 'false', typecheck: 'npm run check', lint: 'npm run lint' } },
])('preserves exact private gate IDs at policy-first runtime resolution: $expected', ({ gates, expected }) => {
  const context = fixture();
  reviseContract(context, item => { item.qualityGates = gates; });
  const result = execute([block('private-contract.md', '## Scaffold'), block('_shared-template.md', '## #quality-gate-policy')].join('\n'), context);
  expect(result.status, result.stderr).toBe(0);
  const content = readFileSync(path.join(context.repo, 'AGENTS.md'), 'utf8');
  const config = parseSessionConfig(content, { hostPaths: { env: {}, ownerConfig: {} } });
  const policy = loadQualityGatesPolicy(context.repo);
  expect(policy).not.toBeNull();
  for (const [id, command] of Object.entries(expected)) {
    expect(resolveCommand(policy, id, config[`${id}-command`])).toBe(command);
    if (command === 'false') expect(policy.rationale).toContain(`${id} unavailable`);
  }
});

it('preserves an existing owner quality policy and does not claim it as created', () => {
  const context = fixture();
  const filename = '.orchestrator/policy/quality-gates.json';
  const original = '{"owner":"unchanged"}\n';
  put(context.repo, filename, original);
  const result = execute(`BOOTSTRAP_FILES=(owned.txt)\n${block('_shared-template.md', '## #quality-gate-policy')}\nprintf 'CREATED:%s\\n' "${'${BOOTSTRAP_FILES[@]}'}"`, context);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(path.join(context.repo, filename), 'utf8')).toBe(original);
  expect(result.stdout).not.toContain(`CREATED:${filename}`);
});

it('keeps configured-baseline standalone Fast independent of private archetype selection', () => {
  const context = fixture();
  const result = execute(`unset CONFIRMED_ARCHETYPE\n${block('fast-template.md', '## Step 3a:')}`, context);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(path.join(context.repo, '.claude/rules/commit-discipline.md'))).toBe(true);
  expect(existsSync(path.join(context.repo, '.claude/rules/frontend.md'))).toBe(false);
  expect(existsSync(path.join(context.repo, '.orchestrator/policy/quality-gates.json'))).toBe(false);
  expect(existsSync(path.join(context.repo, 'package.json'))).toBe(false);
});

it('refreshes ordinary rules for a valid Fast/null lock, but still rejects a malformed configured contract', () => {
  const context = fixture();
  put(context.repo, '.orchestrator/bootstrap.lock', 'version: 1\ntier: fast\narchetype: null\n');
  const recipe = `unset CONFIRMED_ARCHETYPE\n${block('SKILL.md', '## Sync-Rules Flow')}`;
  const refresh = execute(recipe, context);
  expect(refresh.status, refresh.stderr).toBe(0);
  const target = path.join(context.repo, '.claude/rules/commit-discipline.md');
  expect(existsSync(target)).toBe(true);
  expect(existsSync(path.join(context.repo, '.claude/rules/frontend.md'))).toBe(false);
  writeFileSync(target, '<!-- source: session-orchestrator plugin -->\n# Stale\n');
  put(context.baseline, 'contract.json', '{}');
  const invalid = execute(recipe, context);
  expect(invalid.status).not.toBe(0);
  expect(readFileSync(target, 'utf8')).toContain('# Stale');
});

it('keeps standalone --sync-rules dry-run and category selection while validating private IDs before writes', () => {
  const context = fixture();
  reviseContract(context, item => { item.ruleTargets.push('frontend.md'); });
  const recipe = block('SKILL.md', '## Sync-Rules Flow');
  const preview = execute(`DRY_RUN=true\nRULES_CATEGORIES=always-on\n${recipe}`, context);
  expect(preview.status, preview.stderr).toBe(0);
  const report = JSON.parse(preview.stdout);
  expect(report.written).toContain('frontend.md');
  expect(report.created).toEqual([]);
  expect(existsSync(path.join(context.repo, '.claude/rules/frontend.md'))).toBe(false);
  put(context.repo, '.orchestrator/bootstrap.lock', 'tier: standard\narchetype: missing-archetype\n');
  const invalid = execute(`unset CONFIRMED_ARCHETYPE\n${recipe}`, context);
  expect(invalid.status).not.toBe(0);
  expect(existsSync(path.join(context.repo, '.claude/rules/commit-discipline.md'))).toBe(false);
  const explicit = execute(recipe, context);
  expect(explicit.status, explicit.stderr).toBe(0);
  expect(existsSync(path.join(context.repo, '.claude/rules/frontend.md'))).toBe(true);
});

it('detects private repository markers for standalone --sync-rules without a lock', () => {
  const context = fixture();
  put(context.repo, 'package.json', '{"sample":true}\n');
  reviseContract(context, item => { item.ruleTargets.push('frontend.md'); });
  const result = execute(`unset CONFIRMED_ARCHETYPE\n${block('SKILL.md', '## Sync-Rules Flow')}`, context);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(path.join(context.repo, '.claude/rules/frontend.md'))).toBe(true);
});

it.each([
  ['standard-template.md', '## Step 6: Write bootstrap.lock', '## Step 7: Initial Git Commit'],
  ['deep-template.md', '## Step D7: Write bootstrap.lock', '## Step D8: Git Commit'],
])('stages accumulated actual created files without existing owner files: %s', (file, lockHeading, commitHeading) => {
  const context = fixture();
  put(context.baseline, 'templates/sample-web/go.mod', 'module sample\n');
  put(context.baseline, 'templates/sample-web/Makefile', 'test:\n\t@true\n');
  put(context.repo, '.claude/owner-note.md', '# Owner note\n');
  put(context.repo, 'src/owner.txt', 'Owner source\n');
  const result = execute([
    'git() { if [[ "$1" = add ]]; then printf "%s\\n" "$3" >> "$REPO_ROOT/staged.log"; fi; }',
    block('private-contract.md', '## Scaffold'),
    block('fast-template.md', '## Step 3a:'),
    block('_shared-template.md', '## #parallel-sessions-rule'),
    block('_shared-template.md', '## #baseline-fetch'),
    block('_shared-template.md', '## #quality-gate-policy'),
    block(file, lockHeading),
    // Deep inheritance repeats writers: empty created reports must not reset
    // earlier actual paths, and an existing lock is not newly claimed.
    block('private-contract.md', '## Scaffold'),
    block('_shared-template.md', '## #parallel-sessions-rule'),
    block('_shared-template.md', '## #baseline-fetch'),
    block('_shared-template.md', '## #quality-gate-policy'),
    block(file, lockHeading),
    block(file, commitHeading),
  ].join('\n'), context);
  expect(result.status, result.stderr).toBe(0);
  const staged = readFileSync(path.join(context.repo, 'staged.log'), 'utf8').trim().split('\n');
  for (const name of ['go.mod', 'Makefile', '.gitlab-ci.yml', '.orchestrator/bootstrap.lock', '.orchestrator/policy/quality-gates.json', '.claude/rules/sample-runtime.md', '.claude/rules/sample-ai.md']) expect(staged).toContain(name);
  for (const name of ['README.md', '.claude/', 'src/', '.claude/owner-note.md', 'src/owner.txt', '.claude/rules/parallel-sessions.md']) expect(staged).not.toContain(name);
  expect(staged.filter(name => name === '.orchestrator/bootstrap.lock')).toHaveLength(1);
  expect(staged.filter(name => name === '.claude/rules/commit-discipline.md')).toHaveLength(1);
});
