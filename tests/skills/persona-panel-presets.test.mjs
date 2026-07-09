/**
 * tests/skills/persona-panel-presets.test.mjs
 *
 * Guards the bundled persona-panel presets (skills/persona-panel/presets/*.md)
 * the same way tests/templates/personas/parse-each.test.mjs guards
 * templates/personas/*.v1.md: presets ship to operators via cp into
 * .claude/personas/, so a broken output_contract or invalid frontmatter would
 * ship unverified (W4 qa-strategist GAP-1, session main-2026-07-09-session-2,
 * issue #760).
 *
 * Falsification check: breaking any preset's frontmatter (e.g. removing
 * `role`) makes the per-file validatePersonaSpec assertion fail; the
 * floor/ceiling count guard catches accidental deletion or runaway
 * duplication of preset files.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validatePersonaSpec, SAFE_PERSONA_NAME_RE } from '../../scripts/lib/persona-panel/catalog-loader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const PRESETS_DIR = join(REPO_ROOT, 'skills', 'persona-panel', 'presets');

/** Match the YAML frontmatter block at the head of a markdown file (mirrors catalog-loader). */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseFrontmatter(filePath) {
  const contents = readFileSync(filePath, 'utf8');
  const match = FRONTMATTER_RE.exec(contents);
  if (match === null) {
    throw new Error(`${filePath}: missing YAML frontmatter block (expected --- ... ---)`);
  }
  return yaml.load(match[1], { schema: yaml.CORE_SCHEMA });
}

const presetFiles = readdirSync(PRESETS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();

describe('persona-panel bundled presets (#760)', () => {
  it('presets/ holds between 3 and 12 preset files (floor/ceiling)', () => {
    // Floor 3: pm-lens, designer-lens, engineer-lens. Ceiling 12 catches loops.
    expect(presetFiles.length).toBeGreaterThanOrEqual(3);
    expect(presetFiles.length).toBeLessThanOrEqual(12);
  });

  it.each(presetFiles)('%s parses and passes validatePersonaSpec', (file) => {
    const abs = join(PRESETS_DIR, file);
    const spec = parseFrontmatter(abs);
    const result = validatePersonaSpec(spec, abs);
    expect(result.ok, JSON.stringify(result.ok ? {} : result.errors, null, 2)).toBe(true);
  });

  it.each(presetFiles)('%s name matches SAFE_PERSONA_NAME_RE and its filename stem', (file) => {
    const spec = parseFrontmatter(join(PRESETS_DIR, file));
    const stem = file.replace(/\.md$/, '');
    expect(spec.name).toBe(stem);
    expect(spec.name).toMatch(SAFE_PERSONA_NAME_RE);
  });
});
