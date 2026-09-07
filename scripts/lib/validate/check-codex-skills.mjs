#!/usr/bin/env node
// Independently inspect Codex discovery artifacts; generator freshness alone
// cannot detect a generator that consistently emits an invalid skill contract.
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const SKILL_ROOT = '.codex-plugin/skills';
const FRONTMATTER_KEYS = new Set([
  'name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools',
]);

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read emitted artifacts against their source contract without importing the
 * generator or comparing its prose. Paths are resolved as installed files.
 * @param {string} pluginRoot
 * @returns {{skills: string[], violations: string[]}}
 */
export function validateCodexSkills(pluginRoot) {
  const root = realpathSync(pluginRoot);
  const violations = [];
  const sources = new Map();
  const skills = [];
  const label = (file) => relative(root, file).split(sep).join('/');

  function text(file) {
    try {
      const actual = realpathSync(file);
      if (!actual.startsWith(`${root}${sep}`)) {
        violations.push(`${label(file)}: outside the plugin package`);
        return null;
      }
      return readFileSync(file, 'utf8');
    } catch (error) {
      violations.push(`${label(file)}: missing or unreadable (${error.code ?? error.message})`);
      return null;
    }
  }

  function mapping(raw, file) {
    if (raw === null) return null;
    try {
      const parsed = yaml.load(raw, { schema: yaml.CORE_SCHEMA });
      if (!isRecord(parsed)) throw new Error('expected a YAML mapping');
      return parsed;
    } catch (error) {
      violations.push(`${label(file)}: invalid YAML (${error.message.split('\n')[0]})`);
      return null;
    }
  }

  function frontmatter(file) {
    const raw = text(file);
    if (raw === null) return null;
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
    if (!match) {
      violations.push(`${label(file)}: missing YAML frontmatter`);
      return null;
    }
    const fm = mapping(match[1], file);
    return fm && { fm, body: raw.slice(match[0].length) };
  }

  // Codex's Agent Plugins loader fixes skills to ./skills; its native overlay
  // cannot override skills or version. A valid native manifest alone is not
  // enough when a standard root manifest intercepts discovery (CLI 0.153.3/4).
  const rootManifestFile = join(root, 'plugin.json');
  if (existsSync(rootManifestFile)) {
    try {
      const manifest = JSON.parse(text(rootManifestFile));
      if (typeof manifest?.$schema === 'string' && manifest.$schema.startsWith('https://agent-plugins.org/schemas/')) {
        violations.push('Root Agent Plugins manifest overrides native Codex skills and cache version; use the native harness manifests');
      }
    } catch (error) {
      violations.push(`Root plugin manifest: invalid JSON (${error.message})`);
    }
  }

  const manifestFile = join(root, '.codex-plugin/plugin.json');
  try {
    const raw = text(manifestFile);
    const manifest = raw === null ? null : JSON.parse(raw);
    if (manifest?.skills !== `./${SKILL_ROOT}/`) {
      violations.push(`Codex manifest skills must register only ./${SKILL_ROOT}/`);
    }
    if (!Array.isArray(manifest?.commands) || manifest.commands.length !== 0) {
      violations.push('Codex manifest commands must be an explicit empty array to disable automatic command migration');
    }
  } catch (error) {
    violations.push(`Codex manifest: invalid JSON (${error.message})`);
  }

  // Skill first, command second: a command owns the public entry on overlap.
  for (const kind of ['skill', 'command']) {
    const directory = join(root, kind === 'skill' ? 'skills' : 'commands');
    if (!existsSync(directory)) {
      violations.push(`${label(directory)}: canonical source directory is missing`);
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = kind === 'command' ? entry.name.replace(/\.md$/, '') : entry.name;
      if (name.startsWith('.') || name.startsWith('_')) continue;
      if (kind === 'command' && !entry.name.endsWith('.md')) continue;
      const file = kind === 'command' ? join(directory, entry.name) : join(directory, name, 'SKILL.md');
      if (kind === 'skill' && !existsSync(file)) continue;
      const source = frontmatter(file);
      sources.set(name, { kind, file, fm: source?.fm });
    }
  }
  if (sources.size === 0) violations.push('No canonical commands or skills found');

  const generated = join(root, SKILL_ROOT);
  const actualNames = existsSync(generated)
    ? readdirSync(generated, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && existsSync(join(generated, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
    : [];
  for (const name of [...new Set([...sources.keys(), ...actualNames])].sort()) {
    const source = sources.get(name);
    if (!source) {
      violations.push(`${SKILL_ROOT}/${name}: no canonical source`);
      continue;
    }
    const file = join(generated, name, 'SKILL.md');
    const artifact = frontmatter(file);
    if (!artifact) continue;
    skills.push(name);
    const { fm, body } = artifact;
    if (fm.name !== name) violations.push(`${label(file)}: name must equal ${name}`);
    if (typeof fm.description !== 'string' || !fm.description.trim() || fm.description.length > 1024) {
      violations.push(`${label(file)}: description must be a non-empty string of at most 1024 characters`);
    }
    for (const key of Object.keys(fm)) {
      if (!FRONTMATTER_KEYS.has(key)) violations.push(`${label(file)}: unsupported frontmatter key ${key}`);
    }
    if (fm.metadata !== undefined && (!isRecord(fm.metadata) || Object.values(fm.metadata).some((value) => typeof value !== 'string'))) {
      violations.push(`${label(file)}: metadata must contain string values`);
    }
    const links = [...body.matchAll(/\]\(([^\s)]+)\)/g)].map((match) => match[1]);
    if (!links.some((target) => !target.includes(':') && !target.startsWith('/') && resolve(dirname(file), target) === source.file)) {
      violations.push(`${label(file)}: missing canonical link to ${label(source.file)}`);
    }
    if (source.kind === 'command' && source.fm) {
      const disabled = source.fm['disable-model-invocation'];
      if (disabled !== undefined && typeof disabled !== 'boolean') {
        violations.push(`${label(source.file)}: disable-model-invocation must be boolean`);
      }
      const policyFile = join(generated, name, 'agents/openai.yaml');
      const sidecar = mapping(text(policyFile), policyFile);
      if (sidecar && (typeof sidecar.policy?.allow_implicit_invocation !== 'boolean'
        || sidecar.policy.allow_implicit_invocation !== (disabled !== true))) {
        violations.push(`${label(policyFile)}: allow_implicit_invocation must preserve the command's boolean policy`);
      }
    }
  }
  return { skills, violations };
}

async function main(pluginRoot) {
  if (!pluginRoot) throw new Error('Usage: check-codex-skills.mjs <plugin-root>');
  console.log('--- Check: Codex command skills and generated freshness ---');
  const { skills, violations } = validateCodexSkills(pluginRoot);
  if (violations.length === 0) {
    // Invoke the function directly: a child CLI that silently skips its entry
    // point must never turn a missing freshness comparison into success.
    const { generateCodexSurface } = await import('../../generate-codex-skills.mjs');
    const fresh = generateCodexSurface({ pluginRoot, check: true });
    if (!fresh.ok || !Array.isArray(fresh.files) || fresh.files.length === 0) {
      violations.push(...(fresh.drift ?? []), ...(fresh.errors ?? []));
      if (violations.length === 0) violations.push('Codex generator did not report a successful artifact comparison');
    }
  }
  for (const violation of violations) console.log(`  FAIL: ${violation}`);
  if (violations.length === 0) console.log(`  PASS: ${skills.length} unique Codex skills, command policies and generated files in sync`);
  console.log(`Results: ${violations.length === 0 ? 1 : 0} passed, ${violations.length} failed`);
  if (violations.length) console.log('Remedy: node scripts/generate-codex-skills.mjs');
  process.exitCode = violations.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv[2]).catch((error) => {
    console.error(`FAIL: Codex skills check: ${error.message}`);
    process.exitCode = 1;
  });
}
