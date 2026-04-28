import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

describe('Express Path (#214) — doc sections exist in both skill files and config reference', () => {
  describe('skills/session-start/SKILL.md — Phase 8.5 Express Path section', () => {
    const skillPath = path.join(repoRoot, 'skills/session-start/SKILL.md');
    let body;

    it('file exists', () => {
      expect(existsSync(skillPath)).toBe(true);
      body = readFileSync(skillPath, 'utf8');
    });

    it('contains Phase 8.5 Express Path Evaluation heading', () => {
      body = body ?? readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/Phase 8\.5.*Express Path/);
    });

    it('declares housekeeping + scope ≤ 3 activation conditions', () => {
      body = body ?? readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/housekeeping/);
      expect(body).toMatch(/≤ 3/);
    });

    it('references express-path.enabled config field with default: true', () => {
      body = body ?? readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/express-path\.enabled/);
      expect(body).toMatch(/default.*true|true.*default/i);
    });

    it('documents the user-visible banner text', () => {
      body = body ?? readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/Express path activated/);
      expect(body).toMatch(/coordinator-direct/);
      expect(body).toMatch(/no inter-wave checks/);
    });

    it('references the 13 prior coord-direct sessions for historical context', () => {
      body = body ?? readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/13 prior coordinator-direct sessions|13.*coord-direct/);
    });

    it('backward compat: express-path.enabled: false skips evaluation', () => {
      body = body ?? readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/express-path\.enabled.*false.*skipped|when.*false.*skip/i);
    });
  });

  describe('skills/session-plan/SKILL.md — Express Path Short-Circuit section', () => {
    const skillPath = path.join(repoRoot, 'skills/session-plan/SKILL.md');
    let body;

    it('file exists', () => {
      expect(existsSync(skillPath)).toBe(true);
      body = readFileSync(skillPath, 'utf8');
    });

    it('contains Express Path Short-Circuit heading', () => {
      body = body ?? readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/Express Path Short-Circuit/);
    });

    it('emits a 1-wave coordinator-direct plan', () => {
      body = body ?? readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/1.*wave|Wave 1.*Coordinator-Direct/i);
      expect(body).toMatch(/0.*agents|agents.*0/i);
    });

    it('detects activation via the banner text in conversation context', () => {
      body = body ?? readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/Express path activated/);
    });

    it('falls through to full flow when banner is absent', () => {
      body = body ?? readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/banner is absent|full.*flow|full planning flow/i);
    });

    it('references #214', () => {
      body = body ?? readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/#214/);
    });
  });

  describe('docs/session-config-reference.md — Express Path section', () => {
    const docsPath = path.join(repoRoot, 'docs/session-config-reference.md');
    let body;

    it('file exists', () => {
      expect(existsSync(docsPath)).toBe(true);
      body = readFileSync(docsPath, 'utf8');
    });

    it('contains the ## Express Path heading', () => {
      body = body ?? readFileSync(docsPath, 'utf8');
      expect(body).toMatch(/^## Express Path/m);
    });

    it('documents the express-path.enabled field with boolean type and default true', () => {
      body = body ?? readFileSync(docsPath, 'utf8');
      expect(body).toMatch(/express-path\.enabled/);
      expect(body).toMatch(/boolean/);
      expect(body).toMatch(/`true`/);
    });

    it('lists all 3 activation conditions', () => {
      body = body ?? readFileSync(docsPath, 'utf8');
      expect(body).toMatch(/express-path\.enabled.*true|true.*express-path/);
      expect(body).toMatch(/housekeeping/);
      expect(body).toMatch(/≤ 3/);
    });

    it('references both skill files in Related skills section', () => {
      body = body ?? readFileSync(docsPath, 'utf8');
      expect(body).toMatch(/skills\/session-start\/SKILL\.md/);
      expect(body).toMatch(/skills\/session-plan\/SKILL\.md/);
    });

    it('references GitLab issue #214', () => {
      body = body ?? readFileSync(docsPath, 'utf8');
      expect(body).toMatch(/#214/);
    });

    it('includes a condition matrix table', () => {
      body = body ?? readFileSync(docsPath, 'utf8');
      // Table has at least housekeeping + feature rows
      expect(body).toMatch(/housekeeping.*Yes|Yes.*housekeeping/i);
      expect(body).toMatch(/feature.*No|No.*feature/i);
    });
  });
});
