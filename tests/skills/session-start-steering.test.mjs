/**
 * tests/skills/session-start-steering.test.mjs
 *
 * Regression tests for #338 — steering/ persistent context split.
 *
 * Verifies that:
 *   - All three steering docs exist and contain real content
 *   - Each doc starts with a markdown heading
 *   - skills/session-start/SKILL.md has the Phase 2.6 steering-loading section
 *   - Phase 2.6 documents the silent-no-op behaviour when steering dir is absent
 *   - skills/plan/mode-new.md scaffolds .orchestrator/steering/ on /plan new
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function exists(rel) {
  return existsSync(path.join(REPO_ROOT, rel));
}

const STEERING_FILES = [
  '.orchestrator/steering/product.md',
  '.orchestrator/steering/tech.md',
  '.orchestrator/steering/structure.md',
];

// ─── Test 1: Steering docs exist ─────────────────────────────────────────────

describe('#338 — steering docs existence', () => {
  it('all three steering docs exist at .orchestrator/steering/{product,tech,structure}.md', () => {
    for (const rel of STEERING_FILES) {
      expect(exists(rel), `expected ${rel} to exist`).toBe(true);
    }
  });
});

// ─── Test 2: Steering docs are non-empty with real content ───────────────────

describe('#338 — steering doc content quality', () => {
  it('each steering doc is non-empty and has at least 30 lines', () => {
    for (const rel of STEERING_FILES) {
      const content = read(rel);
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      expect(lines.length, `${rel} should have >= 30 non-empty lines`).toBeGreaterThanOrEqual(30);
    }
  });

  // ─── Test 3: Each doc starts with a markdown heading ───────────────────────

  it('each steering doc starts with an H1 or H2 markdown heading', () => {
    for (const rel of STEERING_FILES) {
      const content = read(rel);
      const firstLine = content.trimStart().split('\n')[0];
      expect(firstLine, `${rel} must start with # or ##`).toMatch(/^#{1,2}\s+\S/);
    }
  });
});

// ─── Test 4: Session-start SKILL.md has Phase 2.6 ────────────────────────────

describe('#338 — session-start SKILL.md Phase 2.6', () => {
  const skillMd = read('skills/session-start/SKILL.md');

  it('contains a Phase 2.6 steering-loading section', () => {
    expect(skillMd).toContain('Phase 2.6');
    expect(skillMd).toMatch(/[Ss]teering/);
  });

  // ─── Test 5: Phase 2.6 documents the silent-no-op behaviour ────────────────

  it('Phase 2.6 documents silent-no-op when steering dir is absent', () => {
    // Extract the Phase 2.6 section up to the next ## heading
    const phase26Match = skillMd.match(/## Phase 2\.6[\s\S]+?(?=\n## )/);
    expect(phase26Match, 'Phase 2.6 section should be extractable').not.toBeNull();
    const section = phase26Match[0];
    // Must mention skip / no-op / absent to document the silent fallback
    expect(section).toMatch(/skip|no-op|absent/i);
  });

  it('Phase 2.6 references the steering directory path', () => {
    const phase26Match = skillMd.match(/## Phase 2\.6[\s\S]+?(?=\n## )/);
    expect(phase26Match).not.toBeNull();
    const section = phase26Match[0];
    expect(section).toContain('.orchestrator/steering');
  });
});

// ─── Test 6 (bonus): mode-new.md scaffolds steering ─────────────────────────

describe('#338 — /plan mode-new.md scaffolds steering', () => {
  it('skills/plan/mode-new.md contains a step that scaffolds .orchestrator/steering/', () => {
    const modeNewMd = read('skills/plan/mode-new.md');
    expect(modeNewMd).toMatch(/\.orchestrator\/steering/);
  });

  it('skills/plan/mode-new.md creates all three steering stub files', () => {
    const modeNewMd = read('skills/plan/mode-new.md');
    expect(modeNewMd).toMatch(/product\.md/);
    expect(modeNewMd).toMatch(/tech\.md/);
    expect(modeNewMd).toMatch(/structure\.md/);
  });
});
