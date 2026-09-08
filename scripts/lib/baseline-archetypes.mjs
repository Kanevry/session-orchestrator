/** Offline consumer of a configured baseline's reduced archetype export.
 * Lookup is read-only; command strings are documentation, never shell input.
 */
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readConfigFile } from './config/io.mjs';
import { _extractConfigSection, _parseKV, findSessionConfigBlock } from './config/section-extractor.mjs';
import { _coerceString } from './config/coercers.mjs';
import { loadHostPaths, resolveHostPath } from './config/host-paths.mjs';
import { resolveNamedBaseline } from './named-baseline-resolver.mjs';
import { resolveArchetype, syncRules } from './rules-sync.mjs';

const DEFAULT_PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..');
const MAX_BYTES = 1024 * 1024;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BASENAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md$/;
const unique = (items) => [...new Set(items)].sort();
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class BaselineContractError extends Error {
  constructor(reason) { super(`Baseline archetype lookup failed (${reason}).`); this.name = 'BaselineContractError'; this.reason = reason; }
}
function fail(reason = 'invalid-contract') { throw new BaselineContractError(reason); }
function check(condition) { if (!condition) fail(); }
function shape(value, required, optional = []) {
  check(object(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => [...required, ...optional].includes(key)));
}
function text(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 2048 && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
  // The reduced export must not carry host locations, URLs, or absolute commands.
  check(!/(?:https?|file):\/\/|(?:^|[\s='"])(?:\/|~\/|[A-Za-z]:\\)/u.test(value));
}
function array(value, visit, minimum = 0) {
  check(Array.isArray(value) && value.length >= minimum && value.length <= 256);
  value.forEach(visit);
}
function strings(value, pattern) {
  array(value, (item) => { text(item); if (pattern) check(pattern.test(item)); });
  check(new Set(value).size === value.length);
}
function relative(value, wildcard = false) {
  text(value);
  check((wildcard ? /^[A-Za-z0-9_.@/*{}[\]()-]+$/ : /^[A-Za-z0-9_.@/{}[\]()-]+$/).test(value));
  check(!value.split('/').some((part) => !part || part === '.' || part === '..'));
}
function signal(value, allowAll = true) {
  if (value?.kind === 'all' && allowAll) {
    shape(value, ['kind', 'conditions']); array(value.conditions, (part) => signal(part, false), 1); return;
  }
  shape(value, ['kind', 'value']);
  check(['path', 'packageDependency', 'packageField'].includes(value.kind));
  if (value.kind === 'path') relative(value.value, true); else text(value.value);
}

/** Validate the public-safe schema without an installed dependency or private ID matrix. */
export function validateBaselineContract(value) {
  shape(value, ['schemaVersion', 'source', 'browserAutomation', 'rulePolicy', 'archetypes']);
  check(value.schemaVersion === 1 && value.source === 'templates/archetypes.json');
  shape(value.browserAutomation, ['agent', 'repeatable', 'browserMcp']);
  text(value.browserAutomation.agent); text(value.browserAutomation.repeatable); check(typeof value.browserAutomation.browserMcp === 'boolean');
  shape(value.rulePolicy, ['conditional']);
  array(value.rulePolicy.conditional, (rule) => {
    shape(rule, ['id', 'dependencies', 'dependencyPrefixes', 'targets']); text(rule.id);
    strings(rule.dependencies); strings(rule.dependencyPrefixes); strings(rule.targets, BASENAME);
  });
  array(value.archetypes, (item) => {
    shape(item, ['id', 'order', 'templatePath', 'runtimes', 'packageManagers', 'ui', 'api', 'deploy', 'detection', 'qualityGates', 'commands', 'ci', 'ruleTargets']);
    check(typeof item.id === 'string' && ID.test(item.id));
    check(Number.isSafeInteger(item.order) && item.order >= 1);
    relative(item.templatePath); check(item.templatePath === `templates/${item.id}`);
    for (const key of ['runtimes', 'packageManagers']) array(item[key], (runtime) => { shape(runtime, ['name', 'version']); text(runtime.name); text(runtime.version); }, 1);
    shape(item.ui, ['mode', 'framework', 'tailwind']); text(item.ui.mode); text(item.ui.framework); check(typeof item.ui.tailwind === 'boolean');
    shape(item.api, ['mode', 'framework']); text(item.api.mode); text(item.api.framework);
    shape(item.deploy, ['default', 'alternatives']); text(item.deploy.default); strings(item.deploy.alternatives);
    shape(item.detection, ['priority', 'signals']); check(Number.isSafeInteger(item.detection.priority) && item.detection.priority >= 0);
    array(item.detection.signals, (part) => signal(part), 1);
    array(item.qualityGates, (gate) => { shape(gate, ['id', 'command'], ['packageScript']); text(gate.id); text(gate.command); if (gate.packageScript !== undefined) text(gate.packageScript); });
    check(new Set(item.qualityGates.map((gate) => gate.id)).size === item.qualityGates.length);
    array(item.commands, (command) => { shape(command, ['command', 'description']); text(command.command); text(command.description); });
    shape(item.ci, ['required', 'profile']); check(typeof item.ci.required === 'boolean'); text(item.ci.profile);
    strings(item.ruleTargets, BASENAME);
  }, 1);
  for (const key of ['id', 'order', 'templatePath']) check(new Set(value.archetypes.map((item) => item[key])).size === value.archetypes.length);
  check(new Set(value.rulePolicy.conditional.map((item) => item.id)).size === value.rulePolicy.conditional.length);
  return value;
}

/** Internal child-process entry. Existing resolvers may print private diagnostic
 * context; only resolveBaselineLocation calls this, with stderr captured.
 */
export function resolveConfiguredBaselinePath({ repoRoot, committed, hostPaths }) {
  const context = hostPaths ?? loadHostPaths();
  const named = resolveNamedBaseline({ ...context, cwd: repoRoot });
  return named.path ?? resolveHostPath('baseline-path', committed, context) ?? null;
}

/** Internal host-local location; never serialize this value into bootstrap artifacts. */
export async function resolveBaselineLocation({ repoRoot = process.cwd(), hostPaths } = {}) {
  let content = '';
  try { content = await readConfigFile(repoRoot); } catch { /* A new repo has no instruction file yet. */ }
  const kv = _parseKV(_extractConfigSection(content));
  const resolved = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { readFileSync } from 'node:fs';
const { resolveConfiguredBaselinePath } = await import(process.argv[1]);
process.stdout.write(JSON.stringify(resolveConfiguredBaselinePath(JSON.parse(readFileSync(0, 'utf8')))));
`, import.meta.url], {
    input: JSON.stringify({ repoRoot, committed: _coerceString(kv, 'plan-baseline-path'), hostPaths }),
    encoding: 'utf8', shell: false, timeout: 5000, maxBuffer: MAX_BYTES, killSignal: 'SIGKILL',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (resolved.error || resolved.status !== 0) fail('config-unavailable');
  let configured;
  try { configured = JSON.parse(resolved.stdout); } catch { fail('config-unavailable'); }
  if (typeof configured !== 'string' || !configured.trim()) return null;
  const expanded = configured.trim().replace(/^~(?=\/|$)/u, homedir());
  const root = path.resolve(repoRoot, expanded);
  let stat;
  try { stat = lstatSync(root); } catch (error) { if (error.code === 'ENOENT') return null; fail('baseline-unavailable'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('baseline-unavailable');
  return realpathSync(root);
}

/** Resolve a canonical relative source and reject symlinks at every component. */
export function baselineSourcePath(root, source, directory = false) {
  relative(source);
  let current = root;
  try {
    for (const component of source.split('/')) {
      current = path.join(current, component);
      if (lstatSync(current).isSymbolicLink()) fail('unsafe-source');
    }
    const stat = lstatSync(current);
    if (directory ? !stat.isDirectory() : !stat.isFile()) fail('unsafe-source');
    if (!realpathSync(current).startsWith(`${realpathSync(root)}${path.sep}`)) fail('unsafe-source');
    return current;
  } catch { fail('unsafe-source'); }
}

function projection(root, args, { timeoutMs = 5000, maxBuffer = MAX_BYTES } = {}) {
  const script = baselineSourcePath(root, 'scripts/archetype-manifest.mjs');
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root, encoding: 'utf8', timeout: Math.min(timeoutMs, 5000), maxBuffer: Math.min(maxBuffer, MAX_BYTES),
    shell: false, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) fail('producer-failed');
  if (result.stdout.includes(root)) fail();
  return result.stdout;
}

const ignored = new Set(['.git', 'node_modules', '.next', '.turbo', '.build', '.venv', 'target', 'dist', 'build', 'vendor']);
function collectFacts(repoRoot) {
  const files = [];
  function visit(relativePath, depth) {
    if (depth > 4) return;
    for (const entry of readdirSync(path.join(repoRoot, relativePath), { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const name = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      files.push(name); if (files.length > 20000) fail('repository-unavailable');
      if (entry.isDirectory()) visit(name, depth + 1);
    }
  }
  visit('', 0);
  let packageJson = {};
  if (files.includes('package.json')) {
    const filename = baselineSourcePath(repoRoot, 'package.json');
    if (lstatSync(filename).size > MAX_BYTES) fail('repository-unavailable');
    try { packageJson = JSON.parse(readFileSync(filename, 'utf8')); } catch { fail('repository-unavailable'); }
    if (!object(packageJson)) fail('repository-unavailable');
  }
  const dependencies = unique(['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((key) => object(packageJson[key]) ? Object.keys(packageJson[key]) : []));
  return { files, packageJson, dependencies };
}
function matches(signal, facts) {
  if (signal.kind === 'all') return signal.conditions.every((part) => matches(part, facts));
  if (signal.kind === 'packageDependency') return facts.dependencies.includes(signal.value);
  if (signal.kind === 'packageField') return Object.hasOwn(facts.packageJson, signal.value);
  const pattern = signal.value.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return facts.files.some((file) => new RegExp(`^${pattern}$`).test(file));
}

/** All plugin-owned basenames, including currently nonmatching scoped rules. */
export function pluginRuleTargets(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const content = readFileSync(path.join(pluginRoot, 'rules/_index.md'), 'utf8');
  return unique([...content.matchAll(/^-\s+`([^`<>]+\.md)`/gm)].map((match) => path.posix.basename(match[1])));
}

/** Resolve private selection and expectations; no baseline means the public flow. */
export async function loadBaselineArchetypes(options = {}) {
  const { repoRoot = process.cwd(), archetype, pluginRoot = DEFAULT_PLUGIN_ROOT } = options;
  try {
    const root = await resolveBaselineLocation({ ...options, repoRoot });
    if (!root) return { status: 'public', reason: 'baseline-absent', archetypes: [], selected: null };
    let manifest;
    try { manifest = validateBaselineContract(JSON.parse(projection(root, ['export'], options))); }
    catch (error) { if (error instanceof BaselineContractError) throw error; fail(); }
    for (const item of manifest.archetypes) baselineSourcePath(root, item.templatePath, true);
    const facts = collectFacts(repoRoot);
    const ordered = [...manifest.archetypes].sort((a, b) => a.order - b.order);
    const archetypes = ordered.map(({ id, order, runtimes, packageManagers, ui, api, deploy }) => ({ id, order, runtimes, packageManagers, ui, api, deploy }));
    const selected = archetype
      ? manifest.archetypes.find((item) => item.id === archetype)
      : manifest.archetypes.filter((item) => item.detection.signals.some((signal) => matches(signal, facts)))
        .sort((a, b) => b.detection.priority - a.detection.priority || a.id.localeCompare(b.id))[0];
    if (!selected) {
      if (archetype) fail('unknown-archetype');
      return { status: 'private', reason: 'insufficient-evidence', archetypes, selected: null };
    }
    const conditional = manifest.rulePolicy.conditional.filter((rule) => facts.dependencies.some((name) => rule.dependencies.includes(name) || rule.dependencyPrefixes.some((prefix) => name.startsWith(prefix))));
    const ruleTargets = unique([...selected.ruleTargets, ...conditional.flatMap((rule) => rule.targets)]);
    const owned = pluginRuleTargets(pluginRoot);
    const sources = projection(root, ['rules', selected.id, '--repo', repoRoot], options).trim().split('\n').filter(Boolean);
    const baselineRules = [];
    const seen = new Set();
    for (const source of sources) {
      relative(source);
      if (!/^(?:\.claude\/rules|templates\/shared\/\.claude\/rules)\/[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/u.test(source)) fail('unsafe-source');
      const name = path.posix.basename(source);
      if (!ruleTargets.includes(name) || seen.has(name)) fail('invalid-rule-projection');
      seen.add(name);
      if (owned.includes(name)) continue;
      baselineSourcePath(root, source);
      baselineRules.push({ source, target: `.claude/rules/${name}` });
    }
    if (ruleTargets.some((name) => !seen.has(name))) fail('invalid-rule-projection');
    baselineRules.sort((a, b) => a.target.localeCompare(b.target));
    return { status: 'private', reason: archetype ? 'selected' : 'detected', archetypes, selected: {
      ...selected, browserAutomation: manifest.browserAutomation, ruleTargets,
      pluginRuleTargets: ruleTargets.filter((name) => owned.includes(name)), baselineRules,
    } };
  } catch (error) {
    return { status: 'error', reason: error instanceof BaselineContractError ? error.reason : 'lookup-failed', archetypes: [], selected: null };
  }
}

function sourceFiles(root) {
  const files = [];
  let entries = 0;
  function visit(relativePath, depth) {
    if (depth > 16) fail('unsafe-source');
    for (const entry of readdirSync(path.join(root, relativePath), { withFileTypes: true })) {
      if (++entries > 20000 || entry.isSymbolicLink()) fail('unsafe-source');
      const name = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      relative(name);
      if (entry.isDirectory()) visit(name, depth + 1);
      else if (entry.isFile()) files.push(name);
      else fail('unsafe-source');
    }
  }
  visit('', 0);
  return files.sort();
}

// Preflight the entire destination before the first copy; a user symlink is not
// an overwrite permission, including symlinks in a target's parent directories.
function copyPlan(sourceRoot, repoRoot, mappings) {
  const plan = [];
  for (const { source, target } of mappings) {
    const from = baselineSourcePath(sourceRoot, source);
    plan.push({ from, target, ...destinationState(repoRoot, target) });
  }
  return plan;
}
function destinationState(repoRoot, target) {
  relative(target);
  let current = repoRoot;
  const segments = target.split('/');
  let exists = false;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail('unsafe-destination');
      if (index === segments.length - 1) exists = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { to: current, exists };
}
function applyCopies(plan) {
  const created = []; const preserved = [];
  try {
    for (const item of plan) {
      if (item.exists) { preserved.push(item.target); continue; }
      mkdirSync(path.dirname(item.to), { recursive: true });
      copyFileSync(item.from, item.to, constants.COPYFILE_EXCL);
      created.push(item.target);
    }
  } catch { return { status: 'error', reason: 'copy-failed', created, preserved }; }
  return { status: 'applied', created, preserved };
}
function applyFailure(error) {
  return { status: 'error', reason: error instanceof BaselineContractError ? error.reason : 'apply-failed', created: [], preserved: [] };
}
async function selectedContext(options) {
  const result = await loadBaselineArchetypes(options);
  if (result.status !== 'private' || !result.selected) fail(result.reason);
  const root = await resolveBaselineLocation(options);
  if (!root) fail('baseline-unavailable');
  return { root, selected: result.selected };
}

function selectedCommands(selected) {
  const ids = ['test', 'typecheck', 'lint'];
  const unavailableGates = ids.filter((id) => !selected.qualityGates.some((gate) => gate.id === id));
  const commands = Object.fromEntries(ids.map((id) => [id, { command: selected.qualityGates.find((gate) => gate.id === id)?.command ?? 'false', required: true }]));
  return { commands, unavailableGates };
}
function normalizeStagedCommands(staging, selected, files) {
  const { commands, unavailableGates } = selectedCommands(selected);
  const ids = Object.keys(commands);
  const lines = ids.map((id) => {
    const { command } = commands[id];
    const line = `${id}-command: ${command}${unavailableGates.includes(id) ? ` # ${id} unavailable in selected baseline contract` : ''}`;
    // Existing Session Config parsing must preserve the command verbatim.
    if (_parseKV([line]).get(`${id}-command`) !== command) fail('unsupported-command-config');
    return line;
  });
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    if (!files.includes(name)) continue;
    const filename = baselineSourcePath(staging, name);
    const content = readFileSync(filename, 'utf8');
    const block = findSessionConfigBlock(content);
    let updated;
    if (block) {
      const preserved = block.body.split('\n').filter((line) => !ids.some((id) => _parseKV([line]).has(`${id}-command`)));
      updated = `${content.slice(0, block.bodyStart)}${preserved.join('\n').trimEnd()}\n${lines.join('\n')}\n\n${content.slice(block.bodyEnd)}`;
    } else updated = `${content.trimEnd()}\n\n## Session Config\n\n${lines.join('\n')}\n`;
    writeFileSync(filename, updated);
  }
  return unavailableGates;
}

/** Explicit bootstrap action: stage the canonical local renderer, then add only
 * missing non-rule files. Lookup never calls this function. No Git/install/API.
 */
export async function scaffoldBaselineArchetype(options = {}) {
  let staging;
  try {
    const { repoRoot = process.cwd(), projectName } = options;
    if (typeof projectName !== 'string' || !ID.test(projectName)) fail('invalid-project-name');
    const { root, selected } = await selectedContext(options);
    const template = baselineSourcePath(root, selected.templatePath, true);
    sourceFiles(template);
    const shared = baselineSourcePath(root, 'templates/shared', true);
    sourceFiles(shared);
    const common = baselineSourcePath(root, 'scripts/lib/common.sh');
    const renderer = baselineSourcePath(root, 'scripts/lib/render-archetype.sh');
    staging = mkdtempSync(path.join(tmpdir(), 'baseline-bootstrap-'));
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', [
      'source "$1"', 'source "$2"', 'export TEMPLATES_DIR="$3/templates"',
      'render_archetype_dir "$4" "$6"', 'render_shared_and_substitute "$5" "$6"',
      'render_archetype_metadata "$4" "$5" "$6"',
    ].join('\n'), 'baseline-render', common, renderer, root, selected.id, projectName, staging], {
      cwd: root, encoding: 'utf8', shell: false, timeout: 30000, maxBuffer: MAX_BYTES, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) fail('render-failed');
    const files = sourceFiles(staging).filter((name) => !name.startsWith('.claude/rules/') && !name.startsWith('.git/') && !name.startsWith('.orchestrator/'));
    if (files.some((name) => name.endsWith('.template'))) fail('incomplete-render');
    // A declared CI requirement remains archetype-owned, regardless of tier.
    if (selected.ci.required && !files.some((name) => name === '.gitlab-ci.yml' || name.startsWith('.github/workflows/'))) fail('incomplete-render');
    const unavailableGates = normalizeStagedCommands(staging, selected, files);
    return { ...applyCopies(copyPlan(staging, repoRoot, files.map((name) => ({ source: name, target: name })))), unavailableGates };
  } catch (error) { return applyFailure(error); }
  finally { if (staging) rmSync(staging, { recursive: true, force: true }); }
}

/** Explicit S99 private action: re-resolve conditions from the rendered repo,
 * validate every source, and preserve all existing local files. Plugin-owned
 * basenames never enter the copy plan; rules-sync remains their sole writer.
 */
export async function applyBaselineRules(options = {}) {
  try {
    const { repoRoot = process.cwd() } = options;
    const { root, selected } = await selectedContext(options);
    return applyCopies(copyPlan(root, repoRoot, selected.baselineRules));
  } catch (error) { return applyFailure(error); }
}

function hasUnselectedFastLock(repoRoot) {
  try {
    const content = readFileSync(baselineSourcePath(repoRoot, '.orchestrator/bootstrap.lock'), 'utf8');
    return Object.entries({ version: '1', tier: 'fast', archetype: 'null' }).every(([key, expected]) => {
      const matches = [...content.matchAll(new RegExp(`^${key}:[ \\t]*(.*)$`, 'gm'))];
      if (matches.length !== 1) return false;
      const value = matches[0][1].replace(/\s+#.*$/, '').trim().replace(/^(?:"(.*)"|'(.*)')$/, '$1$2');
      return value === expected;
    });
  } catch { return false; }
}

/** Bootstrap rule action. Contract lookup stays outside the synchronous writer;
 * private required basenames add to its normal selection, never bypass gates.
 * A later --sync-rules uses the lock ID before falling back to repo markers.
 */
export async function syncBootstrapRules(options = {}) {
  try {
    const { repoRoot = process.cwd(), pluginRoot = DEFAULT_PLUGIN_ROOT, dryRun = false } = options;
    const archetype = resolveArchetype(repoRoot, options.archetype).archetype;
    // Standalone Fast has no selected archetype and deliberately uses only
    // ordinary plugin rules, just as its minimal scaffold does.
    const contract = options.minimal ? { status: 'public', selected: null }
      : await loadBaselineArchetypes({ ...options, repoRoot, pluginRoot, archetype });
    if (contract.status === 'error') fail(contract.reason);
    if (contract.status === 'private' && !contract.selected && !hasUnselectedFastLock(repoRoot)) fail(contract.reason);
    const before = new Set();
    for (const name of pluginRuleTargets(pluginRoot)) {
      if (contract.status === 'private') {
        if (destinationState(repoRoot, `.claude/rules/${name}`).exists) before.add(name);
      } else {
        try { lstatSync(path.join(repoRoot, '.claude/rules', name)); before.add(name); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    const result = syncRules({ pluginRoot, repoRoot, dryRun, categories: options.categories, archetype: contract.selected?.id ?? archetype,
      requiredBasenames: contract.selected?.pluginRuleTargets ?? null });
    return { ...result, status: result.errors.length ? 'error' : 'applied',
      created: dryRun ? [] : result.written.filter((name) => !before.has(name)).map((name) => `.claude/rules/${name}`) };
  } catch (error) { return { ...applyFailure(error), written: [], skipped: [], errors: [], warnings: [], sanitizer: [] }; }
}

/** Explicit private policy action. Existing owner policy is never overwritten;
 * absent generic slots fail honestly instead of inheriting package defaults.
 */
export async function writeBaselineQualityPolicy(options = {}) {
  try {
    const { repoRoot = process.cwd() } = options;
    const target = '.orchestrator/policy/quality-gates.json';
    const destination = destinationState(repoRoot, target);
    if (destination.exists) return { status: 'applied', created: [], preserved: [target] };
    const { selected } = await selectedContext(options);
    const { commands, unavailableGates } = selectedCommands(selected);
    const rationale = ['Commands from the selected baseline contract; only exact test/typecheck/lint IDs are used.',
      ...unavailableGates.map((id) => `${id} unavailable in selected baseline contract; false prevents a passing substitute.`)].join(' ');
    mkdirSync(path.dirname(destination.to), { recursive: true });
    writeFileSync(destination.to, `${JSON.stringify({ version: 1, rationale, commands }, null, 2)}\n`, { flag: 'wx' });
    return { status: 'applied', created: [target], preserved: [], unavailableGates };
  } catch (error) { return applyFailure(error); }
}
