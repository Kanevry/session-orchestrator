#!/usr/bin/env node
// check-skills.mjs — Validate the frontmatter contract of every skills/<name>/SKILL.md.
// Usage: check-skills.mjs <plugin-root>
// Outputs lines of the form "  PASS: ..." / "  FAIL: ..."
// Exit 0 = all checks passed; exit 1 = at least one failure.
//
// WHY A REAL PARSER: the sibling check-agents.mjs validates agent frontmatter with
// line-oriented regexes. That is exactly why 12 of 46 SKILL.md frontmatter blocks
// could sit unparseable in the tree unnoticed — an unquoted single-line
// `description:` containing a `: ` (e.g. "Iron Law: NO FIXES") is not YAML, but a
// regex that only looks for `^description:` sees nothing wrong. Claude Code's own
// loader is lenient, so the defect was latent rather than visible. This check
// follows check-commands.mjs instead: a real js-yaml CORE_SCHEMA parse (R8) is the
// rule the other five hang off, because none of the field rules can be evaluated
// on a block that does not parse.
//
// DELIBERATELY NOT IMPLEMENTED — see the report for #<wave>:
//   * A block-scalar ban. check-agents.mjs bans `description: >` for agents/*.md
//     because the agent loader cannot read it. For SKILL.md the sign is REVERSED:
//     the folded block scalar is the only form that makes the `: ` collision above
//     structurally impossible, 23 of 46 files already use it, and the 12 repairs
//     that made this check green all landed on it. Porting the agent rule here
//     would red 35 of 46 files and forbid the fix.
//   * Length ceilings on `name` / `description`. No spec vendored in this repo
//     states one, and an invented requirement is worse than none. (Measured
//     2026-08-15 at the repairing commit: longest name 22 chars, longest
//     description 1012 chars — a hypothetical 1024 ceiling would sit 12 chars
//     above the live corpus and go red on the next sentence added.)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { extractInitialFrontmatter } from './frontmatter-block.mjs';

const [, , pluginRoot] = process.argv;

if (!pluginRoot) {
  console.error('Usage: check-skills.mjs <plugin-root>');
  process.exit(1);
}

const SKILLS_DIR_NAME = 'skills';
const SKILL_FILE = 'SKILL.md';
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

let passed = 0;
let failed = 0;

function pass(msg) {
  console.log(`  PASS: ${msg}`);
  passed++;
}

function fail(msg) {
  console.log(`  FAIL: ${msg}`);
  failed++;
}

/**
 * Enumerate `skills/<dir>/SKILL.md` one level below the skills root.
 *
 * Depth is capped at one level on purpose: R5 (name === directory name) is only
 * meaningful for a skill that owns its immediate directory. Measured 2026-08-15:
 * `find skills -mindepth 3 -name SKILL.md` returns 0, so the cap loses nothing
 * today. Revisit if nested skill packages ever land.
 *
 * @param {string} skillsDir - absolute path to the skills root
 * @returns {Array<{ dirName: string, relPath: string, absPath: string }>} sorted by directory name
 */
function collectSkillFiles(skillsDir) {
  const found = [];
  for (const dirName of readdirSync(skillsDir).sort()) {
    const dirPath = join(skillsDir, dirName);
    let isDir;
    try {
      isDir = statSync(dirPath).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    const absPath = join(dirPath, SKILL_FILE);
    if (!existsSync(absPath)) continue;

    found.push({ dirName, relPath: `${SKILLS_DIR_NAME}/${dirName}/${SKILL_FILE}`, absPath });
  }
  return found;
}

/**
 * Apply the frontmatter contract to one SKILL.md.
 *
 * Rules: R1 frontmatter block present · R8 block parses as a YAML mapping ·
 * R2 `name` present · R3 `name` is kebab-case · R5 `name` === directory name ·
 * R6 `description` present and non-empty.
 *
 * @param {{ dirName: string, relPath: string, absPath: string }} skill
 * @returns {boolean} true when every rule holds
 */
function validateSkillFrontmatter(skill) {
  const before = failed;
  const content = readFileSync(skill.absPath, 'utf8');

  // R1 — frontmatter block present.
  const extracted = extractInitialFrontmatter(content);
  if (!extracted.ok) {
    fail(`${skill.relPath}: ${extracted.diagnostic}`);
    return false;
  }

  // R8 — the block is valid YAML. Everything below depends on this holding.
  let frontmatter;
  try {
    frontmatter = yaml.load(extracted.yamlText, { schema: yaml.CORE_SCHEMA });
  } catch (error) {
    const reason = error?.reason ?? error?.message ?? String(error);
    const location = error?.mark
      ? ` at frontmatter line ${error.mark.line + 1}, column ${error.mark.column + 1}`
      : '';
    fail(`${skill.relPath}: invalid YAML frontmatter: ${reason}${location}`);
    return false;
  }

  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    fail(`${skill.relPath}: YAML frontmatter must be a non-null mapping/object`);
    return false;
  }

  // R2 — name present.
  const name = frontmatter.name;
  if (typeof name !== 'string' || name.trim() === '') {
    fail(`${skill.relPath}: missing or empty required frontmatter field: name`);
  } else {
    // R3 — name is kebab-case.
    if (!KEBAB_CASE.test(name)) {
      fail(`${skill.relPath}: name must be kebab-case (^[a-z0-9]+(-[a-z0-9]+)*$), got: '${name}'`);
    }
    // R5 — name matches the directory that owns the skill.
    if (name !== skill.dirName) {
      fail(`${skill.relPath}: name '${name}' does not match its directory '${skill.dirName}'`);
    }
  }

  // R6 — description present and non-empty.
  const description = frontmatter.description;
  if (typeof description !== 'string' || description.trim() === '') {
    fail(`${skill.relPath}: missing or empty required frontmatter field: description`);
  }

  return failed === before;
}

// ============================================================================
// Check: skill frontmatter (SKILL.md)
// ============================================================================
console.log('--- Check: skill frontmatter (SKILL.md) ---');

const skillsDir = join(pluginRoot, SKILLS_DIR_NAME);

if (!existsSync(skillsDir)) {
  fail(`skills directory not found at conventional location: ./${SKILLS_DIR_NAME}`);
} else {
  let skills;
  try {
    skills = collectSkillFiles(skillsDir);
  } catch (error) {
    skills = [];
    fail(`skills directory is unreadable: ${error?.message ?? String(error)}`);
  }

  if (skills.length === 0) {
    fail(`skills directory contains no ${SKILL_FILE} files`);
  } else {
    pass(`skills directory contains ${skills.length} ${SKILL_FILE} files`);

    let valid = 0;
    for (const skill of skills) {
      if (validateSkillFrontmatter(skill)) valid++;
    }

    if (valid === skills.length) {
      pass(`all ${skills.length} ${SKILL_FILE} frontmatter blocks parse as YAML and carry a kebab-case name matching their directory plus a non-empty description`);
    }
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

process.exit(failed > 0 ? 1 : 0);
