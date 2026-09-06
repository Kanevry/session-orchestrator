#!/usr/bin/env node
/**
 * check-agents-skills.mjs — validate the CROSS-HARNESS PORTABLE SURFACE.
 *
 * Scope note on the name: "agents-skills" is the `.agents`/`AGENTS`-family
 * surface, not just the skill mirror. Three artefacts are checked, because
 * they are one feature — the set of files a NON-Claude harness (Codex CLI,
 * Cursor, Amp, Copilot CLI, OpenCode, Kiro) reads when it opens this repo:
 *
 *   A. root `AGENTS.md` — must be an alias of `CLAUDE.md` (symlink to the same
 *      inode, or byte-identical).
 *   B. root `plugin.json` — the agent-plugins.org 1.0.0 manifest; its `version`
 *      must equal `package.json`'s and the two existing plugin manifests'.
 *   C. `.agents/skills/<name>/SKILL.md` — one spec-legal mirror per source
 *      skill, no orphans, agentskills.io field list only, description ≤ 1024.
 *
 * INDEPENDENCE (load-bearing). This checker deliberately imports NOTHING from
 * `scripts/generate-agents-skills.mjs` and re-derives the spec field list, the
 * 1024 cap and the alias rule from the spec, not from the generator. A
 * generator-vs-generator check only proves the generator is self-consistent —
 * that is how the Cursor `argument-hint` defect survived. The oracles here are
 * the repository's own filesystem (`skills/`, `CLAUDE.md`, `package.json`) and
 * the published field list.
 *
 * Usage: node scripts/lib/validate/check-agents-skills.mjs <plugin-root>
 * Exit codes: 0 — all checks passed · 1 — one or more failures.
 */

import { existsSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error('Usage: check-agents-skills.mjs <plugin-root>');
  process.exit(1);
}

let passed = 0;
let failed = 0;
const pass = (msg) => { console.log(`  PASS: ${msg}`); passed += 1; };
const fail = (msg) => { console.log(`  FAIL: ${msg}`); failed += 1; };

/**
 * The complete agentskills.io field list permitted outside Claude Code.
 * Re-derived from the spec here on purpose — see INDEPENDENCE above.
 */
const SPEC_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const DESCRIPTION_MAX = 1024;

/**
 * Per-mirror byte ceiling. A mirror is a frontmatter block plus a 6-line
 * pointer; the largest one measured 2026-09-06 was ~1.9 KB (its description is
 * 1012 chars). The ceiling exists to catch the failure this design prevents —
 * a mirror that starts duplicating the canonical body, which would double the
 * instruction corpus a foreign harness loads. Revisit trigger: raise it only
 * together with a re-measurement of `.agents/skills/` total bytes, never to
 * accommodate a body that was pasted in.
 */
const MIRROR_MAX_BYTES = 4096;

const AGENT_PLUGINS_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

/** Read + parse a JSON file; null on missing or malformed. */
function readJson(absPath) {
  if (!existsSync(absPath)) return null;
  try { return JSON.parse(readFileSync(absPath, 'utf8')); } catch { return null; }
}

/** Split a Markdown file into `{ frontmatter, body }`; frontmatter null when absent/unparseable. */
function splitFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!m) return { frontmatter: null, body: content };
  try {
    const parsed = yaml.load(m[1]);
    return {
      frontmatter: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null,
      body: m[2],
    };
  } catch {
    return { frontmatter: null, body: m[2] };
  }
}

// ---------------------------------------------------------------------------
// A. root AGENTS.md is an alias of CLAUDE.md
// ---------------------------------------------------------------------------

console.log('--- Check A: root AGENTS.md ↔ CLAUDE.md alias ---');
{
  const claudePath = join(pluginRoot, 'CLAUDE.md');
  const agentsPath = join(pluginRoot, 'AGENTS.md');
  if (!existsSync(claudePath)) {
    pass('no CLAUDE.md at plugin root — alias check not applicable');
  } else if (!existsSync(agentsPath)) {
    fail('CLAUDE.md exists but AGENTS.md does not — Codex CLI, OpenCode, Kiro and Amp '
      + 'read AGENTS.md and never CLAUDE.md, so this repo would ship without a Session Config for them '
      + '(remedy: node scripts/generate-agents-skills.mjs)');
  } else {
    let aliased = false;
    let how = '';
    try {
      if (lstatSync(agentsPath).isSymbolicLink()) {
        aliased = realpathSync(agentsPath) === realpathSync(claudePath);
        how = 'symlink';
      } else {
        const a = statSync(agentsPath);
        const c = statSync(claudePath);
        if (a.ino !== 0 && a.ino === c.ino && a.dev === c.dev) { aliased = true; how = 'same inode'; }
      }
    } catch { /* fall through to the byte comparison */ }
    if (!aliased) {
      aliased = readFileSync(agentsPath).equals(readFileSync(claudePath));
      how = 'byte-identical';
    }
    if (aliased) {
      pass(`AGENTS.md is an alias of CLAUDE.md (${how})`);
    } else {
      fail('AGENTS.md and CLAUDE.md are two independent files that disagree — AGENTS.md is GENERATED; '
        + 'put the change in CLAUDE.md and run `node scripts/generate-agents-skills.mjs`');
    }
  }
}

// ---------------------------------------------------------------------------
// B. root plugin.json (agent-plugins.org 1.0.0)
// ---------------------------------------------------------------------------

console.log('');
console.log('--- Check B: root plugin.json (agent-plugins.org 1.0.0) ---');
{
  const rootManifest = readJson(join(pluginRoot, 'plugin.json'));
  if (rootManifest === null) {
    if (existsSync(join(pluginRoot, 'plugin.json'))) {
      fail('plugin.json exists but is not valid JSON');
    } else {
      pass('no root plugin.json — vendor-neutral manifest not shipped');
    }
  } else {
    if (rootManifest.$schema === AGENT_PLUGINS_SCHEMA) {
      pass('plugin.json declares the agent-plugins.org 1.0.0 $schema');
    } else {
      fail(`plugin.json $schema is '${rootManifest.$schema ?? '(unset)'}', expected '${AGENT_PLUGINS_SCHEMA}'`);
    }

    for (const field of ['name', 'version', 'description', 'license']) {
      if (typeof rootManifest[field] === 'string' && rootManifest[field].trim()) {
        pass(`plugin.json has a non-empty '${field}'`);
      } else {
        fail(`plugin.json is missing required field '${field}'`);
      }
    }

    // Version parity across ALL manifests. Three manifests now carry a version
    // and only `package.json` is bumped by the release script — a third copy
    // that drifts silently is the whole reason this case exists.
    const pkg = readJson(join(pluginRoot, 'package.json'));
    const pkgVersion = pkg?.version ?? null;
    if (!pkgVersion) {
      fail('package.json has no version — cannot verify manifest version parity');
    } else if (rootManifest.version === pkgVersion) {
      pass(`plugin.json version matches package.json (${pkgVersion})`);
    } else {
      fail(`plugin.json version '${rootManifest.version}' != package.json version '${pkgVersion}' `
        + '— the release script bumps package.json only');
    }

    const claudeManifest = readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'));
    if (claudeManifest?.version && rootManifest.version !== claudeManifest.version) {
      fail(`plugin.json version '${rootManifest.version}' != .claude-plugin/plugin.json version '${claudeManifest.version}'`);
    } else if (claudeManifest?.version) {
      pass('plugin.json version matches .claude-plugin/plugin.json');
    }

    // Declared component paths must exist — a manifest may not advertise a
    // component this repo does not ship.
    let componentFail = 0;
    for (const [key, value] of Object.entries(rootManifest)) {
      if (typeof value !== 'string' || !value.startsWith('./')) continue;
      if (key === '$schema') continue;
      if (!existsSync(join(pluginRoot, value))) {
        fail(`plugin.json component '${key}' points at '${value}' which does not exist`);
        componentFail += 1;
      }
    }
    if (componentFail === 0) pass('all plugin.json component paths resolve on disk');
  }
}

// ---------------------------------------------------------------------------
// C. .agents/skills/ portable mirror
// ---------------------------------------------------------------------------

console.log('');
console.log('--- Check C: .agents/skills/ portable mirror ---');
{
  const skillsDir = join(pluginRoot, 'skills');
  const mirrorDir = join(pluginRoot, '.agents', 'skills');

  const sourceSkills = existsSync(skillsDir) && statSync(skillsDir).isDirectory()
    ? readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map((e) => e.name)
      .filter((n) => existsSync(join(skillsDir, n, 'SKILL.md')))
      .sort()
    : [];

  if (!existsSync(mirrorDir)) {
    if (sourceSkills.length === 0) {
      pass('no skills/ and no .agents/skills/ — nothing to mirror');
    } else {
      fail(`.agents/skills/ is missing but ${sourceSkills.length} source skill(s) exist `
        + '(remedy: node scripts/generate-agents-skills.mjs)');
    }
  } else {
    const mirrored = readdirSync(mirrorDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();

    const missing = sourceSkills.filter((n) => !mirrored.includes(n));
    const orphans = mirrored.filter((n) => !sourceSkills.includes(n));
    if (missing.length === 0) pass(`every source skill has a mirror (${sourceSkills.length})`);
    else fail(`${missing.length} source skill(s) have no mirror: ${missing.join(', ')}`);
    if (orphans.length === 0) pass('no orphan mirrors');
    else fail(`${orphans.length} orphan mirror(s) with no source skill: ${orphans.join(', ')}`);

    let fmFail = 0;
    let keyFail = 0;
    let descFail = 0;
    let sizeFail = 0;
    let pointerFail = 0;
    let totalBytes = 0;

    for (const name of mirrored) {
      const file = join(mirrorDir, name, 'SKILL.md');
      if (!existsSync(file)) {
        fail(`.agents/skills/${name}/ has no SKILL.md`);
        fmFail += 1;
        continue;
      }
      const raw = readFileSync(file, 'utf8');
      totalBytes += Buffer.byteLength(raw, 'utf8');

      if (Buffer.byteLength(raw, 'utf8') > MIRROR_MAX_BYTES) {
        fail(`.agents/skills/${name}/SKILL.md is ${Buffer.byteLength(raw, 'utf8')} bytes `
          + `(> ${MIRROR_MAX_BYTES}) — the mirror must point at the canonical body, never duplicate it`);
        sizeFail += 1;
      }

      const { frontmatter, body } = splitFrontmatter(raw);
      if (!frontmatter) {
        fail(`.agents/skills/${name}/SKILL.md has no parseable YAML frontmatter`);
        fmFail += 1;
        continue;
      }

      for (const key of Object.keys(frontmatter)) {
        if (!SPEC_KEYS.has(key)) {
          fail(`.agents/skills/${name}/SKILL.md frontmatter carries non-spec key '${key}' `
            + `(agentskills.io permits only: ${[...SPEC_KEYS].join(', ')})`);
          keyFail += 1;
        }
      }

      if (frontmatter.name !== name) {
        fail(`.agents/skills/${name}/SKILL.md declares name '${frontmatter.name}' != directory '${name}'`);
        keyFail += 1;
      } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
        fail(`.agents/skills/${name}/SKILL.md name is not kebab-case`);
        keyFail += 1;
      }

      const desc = frontmatter.description;
      if (typeof desc !== 'string' || !desc.trim()) {
        fail(`.agents/skills/${name}/SKILL.md has an empty description`);
        descFail += 1;
      } else if (desc.length > DESCRIPTION_MAX) {
        fail(`.agents/skills/${name}/SKILL.md description is ${desc.length} chars (> ${DESCRIPTION_MAX})`);
        descFail += 1;
      }

      if ('metadata' in frontmatter) {
        const md = frontmatter.metadata;
        if (!md || typeof md !== 'object' || Array.isArray(md)) {
          fail(`.agents/skills/${name}/SKILL.md metadata is not a string map`);
          keyFail += 1;
        } else {
          for (const [mk, mv] of Object.entries(md)) {
            if (typeof mv !== 'string') {
              fail(`.agents/skills/${name}/SKILL.md metadata.${mk} is ${typeof mv}, expected string`);
              keyFail += 1;
            }
          }
        }
      }

      if ('allowed-tools' in frontmatter) {
        const tools = frontmatter['allowed-tools'];
        if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string' || !t.trim())) {
          fail(`.agents/skills/${name}/SKILL.md allowed-tools is not an array of non-empty strings`);
          keyFail += 1;
        }
      }

      if (!body.includes(`skills/${name}/SKILL.md`)) {
        fail(`.agents/skills/${name}/SKILL.md body does not cite the canonical skills/${name}/SKILL.md `
          + '— the mirror is a pointer, and a pointer with no target is dead weight');
        pointerFail += 1;
      }
    }

    if (fmFail === 0 && mirrored.length > 0) pass(`all ${mirrored.length} mirrors have parseable frontmatter`);
    if (keyFail === 0 && mirrored.length > 0) pass('all mirrors use only agentskills.io spec fields');
    if (descFail === 0 && mirrored.length > 0) pass(`all mirror descriptions are non-empty and ≤ ${DESCRIPTION_MAX} chars`);
    if (sizeFail === 0 && mirrored.length > 0) pass(`all mirrors ≤ ${MIRROR_MAX_BYTES} bytes (total ${totalBytes} bytes)`);
    if (pointerFail === 0 && mirrored.length > 0) pass('all mirrors cite their canonical SKILL.md');
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
