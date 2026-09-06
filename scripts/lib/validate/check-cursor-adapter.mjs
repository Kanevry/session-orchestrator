#!/usr/bin/env node
// check-cursor-adapter.mjs — Ensure Cursor-native commands, skills, and hooks stay wired.
// Usage: check-cursor-adapter.mjs <plugin-root>
// Exit 0 = all checks passed, 1 = at least one failure.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import yaml from 'js-yaml';

import { CURSOR_TO_CANONICAL_EVENT } from '../cursor-hook-bridge.mjs';

/** agentskills.io caps a skill/command description at 1024 characters. */
const DESCRIPTION_MAX = 1024;

/**
 * Locate a top-level frontmatter key's line number (1-based) so a violation can
 * be reported as `file:line` rather than `file`.
 *
 * @param {string} content raw file content
 * @param {string} key frontmatter key
 * @returns {number} 1-based line number, or 1 when the key is absent
 */
function frontmatterKeyLine(content, key) {
  const lines = content.split('\n');
  const needle = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0 && lines[i] === '---') break; // end of frontmatter
    if (needle.test(lines[i])) return i + 1;
  }
  return 1;
}

/**
 * Validate ONE generated artefact's frontmatter against the Cursor/agentskills
 * spec, independent of the generator that produced it.
 *
 * @param {string} filePath absolute path to the artefact
 * @param {string} rel path to report violations against
 * @param {{requireName: boolean}} opts
 * @returns {string[]} violation strings, empty when the artefact is conformant
 */
function validateArtefactFrontmatter(filePath, rel, { requireName }) {
  const violations = [];
  const content = readFileSync(filePath, 'utf8');

  if (!content.startsWith('---\n')) {
    return [`${rel}:1 — no YAML frontmatter block (file must start with '---')`];
  }
  const end = content.indexOf('\n---\n', 3);
  if (end === -1) {
    return [`${rel}:1 — frontmatter block is never closed`];
  }

  let fm;
  try {
    fm = yaml.load(content.slice(4, end + 1), { schema: yaml.CORE_SCHEMA });
  } catch (err) {
    return [`${rel}:1 — frontmatter is not parseable YAML: ${err.message.split('\n')[0]}`];
  }
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
    return [`${rel}:1 — frontmatter does not parse to a mapping`];
  }

  // `argument-hint`, when present, MUST be a string. Its canonical authored
  // form is `[mode] [--flag]`, which YAML reads as a flow SEQUENCE unless the
  // generator quotes it — GH#54, which made Copilot CLI >= 1.0.65 silently drop
  // the file. Type, not presence, is the assertion: an array here is the bug.
  if (Object.hasOwn(fm, 'argument-hint')) {
    const hint = fm['argument-hint'];
    if (typeof hint !== 'string') {
      violations.push(
        `${rel}:${frontmatterKeyLine(content, 'argument-hint')} — argument-hint must be a string, got ${Array.isArray(hint) ? 'array' : typeof hint} (GH#54: an unquoted [a] [b] is a YAML flow sequence)`,
      );
    } else if (hint.trim() === '') {
      violations.push(`${rel}:${frontmatterKeyLine(content, 'argument-hint')} — argument-hint is present but empty`);
    }
  }

  const required = requireName ? ['name', 'description'] : ['description'];
  for (const key of required) {
    const value = fm[key];
    if (typeof value !== 'string' || value.trim() === '') {
      violations.push(
        `${rel}:${frontmatterKeyLine(content, key)} — ${key} must be a non-empty string, got ${value === undefined ? 'nothing' : (Array.isArray(value) ? 'array' : typeof value)}`,
      );
    }
  }

  if (typeof fm.description === 'string' && fm.description.length > DESCRIPTION_MAX) {
    violations.push(
      `${rel}:${frontmatterKeyLine(content, 'description')} — description is ${fm.description.length} chars, over the ${DESCRIPTION_MAX} limit (agentskills.io)`,
    );
  }

  return violations;
}

/**
 * Validate every generated Cursor artefact under `<pluginRoot>/.cursor`.
 *
 * This deliberately does NOT run the generator. Comparing generator output to
 * generator output — which is all `--check` does — cannot see a defect the
 * generator itself emits: it would report "up to date" while every file is
 * broken, and a snapshot-style guard would freeze the broken files as the
 * expectation. This reads the artefacts and judges them against the spec.
 *
 * @param {string} pluginRoot
 * @returns {{files: number, violations: string[]}}
 */
export function validateCursorArtefacts(pluginRoot) {
  const violations = [];
  let files = 0;

  const commandsDir = join(pluginRoot, '.cursor', 'commands');
  if (existsSync(commandsDir)) {
    for (const name of readdirSync(commandsDir).filter((n) => n.endsWith('.md')).sort()) {
      const filePath = join(commandsDir, name);
      files += 1;
      violations.push(
        ...validateArtefactFrontmatter(filePath, relative(pluginRoot, filePath), { requireName: false }),
      );
    }
  }

  const skillsDir = join(pluginRoot, '.cursor', 'skills');
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir).sort()) {
      const filePath = join(skillsDir, name, 'SKILL.md');
      let isDir;
      try { isDir = statSync(join(skillsDir, name)).isDirectory(); } catch { isDir = false; }
      if (!isDir || !existsSync(filePath)) continue;
      files += 1;
      violations.push(
        ...validateArtefactFrontmatter(filePath, relative(pluginRoot, filePath), { requireName: true }),
      );
    }
  }

  return { files, violations };
}

/**
 * CLI entry point. Kept behind a direct-invocation guard so the module can be
 * imported for {@link validateCursorArtefacts} without running (and exiting).
 *
 * @param {string|undefined} pluginRoot
 * @returns {never}
 */
function runCli(pluginRoot) {
  if (!pluginRoot) {
    console.error('Usage: check-cursor-adapter.mjs <plugin-root>');
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  function pass(msg) { console.log(`  PASS: ${msg}`); passed += 1; }
  function fail(msg) { console.log(`  FAIL: ${msg}`); failed += 1; }

  console.log('--- Check 1: generated Cursor command and skill wrappers ---');

  const generator = join(pluginRoot, 'scripts', 'generate-cursor-adapter.mjs');
  if (!existsSync(generator)) {
    fail('scripts/generate-cursor-adapter.mjs exists');
  } else {
    const result = spawnSync(process.execPath, [generator, '--check'], {
      cwd: pluginRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0) {
      pass('.cursor/commands and .cursor/skills are up to date with commands/ and skills/');
    } else {
      const detail = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
      fail(`Cursor adapter wrappers are stale${detail ? `: ${detail}` : ''}`);
    }
  }

  console.log('');
  console.log('--- Check 1b: generated artefacts conform to the frontmatter spec ---');

  // Check 1 above runs the generator against its own output. That comparison is
  // structurally blind to a defect the generator EMITS — it reported "up to
  // date" while 24 of 28 command wrappers carried an array-shaped
  // `argument-hint` (GH#54). Check 1b judges the artefacts against the spec
  // instead, so a generator bug surfaces as a failure rather than as a snapshot.
  const { files: artefactCount, violations } = validateCursorArtefacts(pluginRoot);
  if (violations.length === 0) {
    pass(`${artefactCount} generated Cursor artefact(s) have spec-conformant frontmatter`);
  } else {
    for (const violation of violations) process.stderr.write(`FAIL: ${violation}\n`);
    fail(`${violations.length} generated Cursor artefact(s) violate the frontmatter spec (see stderr for file:line)`);
  }

  console.log('');
  console.log('--- Check 2: .cursor/hooks.json native manifest ---');

  const hooksPath = join(pluginRoot, '.cursor', 'hooks.json');
  if (!existsSync(hooksPath)) {
    fail('.cursor/hooks.json exists');
  } else {
    let hooksJson;
    try {
      hooksJson = JSON.parse(readFileSync(hooksPath, 'utf8'));
      pass('.cursor/hooks.json is valid JSON');
    } catch (err) {
      fail(`.cursor/hooks.json is not valid JSON: ${err.message}`);
      hooksJson = null;
    }

    if (hooksJson) {
      if (hooksJson.version === 1) {
        pass('.cursor/hooks.json version is 1');
      } else {
        fail('.cursor/hooks.json version must be 1');
      }

      const declared = Object.keys(hooksJson.hooks || {});
      const expected = Object.keys(CURSOR_TO_CANONICAL_EVENT);
      const missing = expected.filter((event) => !declared.includes(event));
      const extra = declared.filter((event) => !expected.includes(event));
      if (missing.length === 0 && extra.length === 0) {
        pass(`.cursor/hooks.json events match CURSOR_TO_CANONICAL_EVENT (${expected.length})`);
      } else {
        if (missing.length > 0) fail(`.cursor/hooks.json missing events: ${missing.join(', ')}`);
        if (extra.length > 0) fail(`.cursor/hooks.json extra events: ${extra.join(', ')}`);
      }

      const bridgeRef = 'scripts/lib/cursor-hook-bridge.mjs';
      const allPointAtBridge = declared.every((event) => {
        const entries = Array.isArray(hooksJson.hooks[event]) ? hooksJson.hooks[event] : [];
        return entries.some((entry) => typeof entry.command === 'string' && entry.command.includes(bridgeRef) && entry.command.includes(`--event ${event}`));
      });
      if (allPointAtBridge) {
        pass('.cursor/hooks.json commands invoke cursor-hook-bridge.mjs with --event');
      } else {
        fail('.cursor/hooks.json commands must invoke scripts/lib/cursor-hook-bridge.mjs --event <name>');
      }
    }
  }

  console.log('');
  console.log('--- Check 3: Cursor hook bridge module ---');

  const bridgePath = join(pluginRoot, 'scripts', 'lib', 'cursor-hook-bridge.mjs');
  if (existsSync(bridgePath)) {
    pass('scripts/lib/cursor-hook-bridge.mjs exists');
  } else {
    fail('scripts/lib/cursor-hook-bridge.mjs exists');
  }

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// Direct invocation only — importing this module must not run the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv[2]);
}
