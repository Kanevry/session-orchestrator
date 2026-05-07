import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

// Test 1: skills/session-plan/SKILL.md contains the Wave-Plan Mission Status section
// and all 5 enum values
describe('skills/session-plan/SKILL.md — Wave-Plan Mission Status section (#340)', () => {
  const skillPath = path.join(repoRoot, 'skills/session-plan/SKILL.md');
  let body;

  const getBody = () => {
    body = body ?? readFileSync(skillPath, 'utf8');
    return body;
  };

  it('file exists', () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it('contains the "Wave-Plan Mission Status (machine-readable)" heading', () => {
    expect(getBody()).toContain('Wave-Plan Mission Status (machine-readable)');
  });

  it('contains all 5 mission-status enum values', () => {
    const content = getBody();
    expect(content).toContain('brainstormed');
    expect(content).toContain('validated');
    expect(content).toContain('in-dev');
    expect(content).toContain('testing');
    expect(content).toContain('completed');
  });

  it('references the schema module mission-status-schema.mjs', () => {
    expect(getBody()).toContain('mission-status-schema.mjs');
  });

  it('references #340', () => {
    expect(getBody()).toMatch(/#340/);
  });

  it('documents the block starts all entries at status: brainstormed', () => {
    expect(getBody()).toContain('status: brainstormed');
  });

  it('references writeMissionStatus from state-md.mjs for persistence', () => {
    const content = getBody();
    expect(content).toContain('writeMissionStatus');
    expect(content).toContain('state-md.mjs');
  });

  it('references parseMissionStatus from state-md.mjs for session-end', () => {
    expect(getBody()).toContain('parseMissionStatus');
  });
});

// Test 2: skills/session-plan/wave-template.md contains status: brainstormed field
describe('skills/session-plan/wave-template.md — mission-status status field (#340)', () => {
  const templatePath = path.join(repoRoot, 'skills/session-plan/wave-template.md');
  let body;

  const getBody = () => {
    body = body ?? readFileSync(templatePath, 'utf8');
    return body;
  };

  it('file exists', () => {
    expect(existsSync(templatePath)).toBe(true);
  });

  it('contains "status: brainstormed" field in the agent spec template', () => {
    expect(getBody()).toContain('status: brainstormed');
  });

  it('references #340 for the status field', () => {
    expect(getBody()).toMatch(/#340/);
  });

  it('documents that status is the mission-status enum value for the wave-plan item', () => {
    const content = getBody();
    // The field should describe its enum nature and lifecycle transitions
    expect(content).toMatch(/mission-status/i);
    expect(content).toContain('brainstormed');
  });

  it('documents rollback to brainstormed is allowed from any state', () => {
    expect(getBody()).toMatch(/[Rr]ollback.*brainstormed|brainstormed.*[Rr]ollback/);
  });

  it('references the schema module for transition validation', () => {
    expect(getBody()).toContain('mission-status-schema.mjs');
  });
});

// Test 3: skills/session-end/SKILL.md Phase 1 contains mission-status classification logic
describe('skills/session-end/SKILL.md — Phase 1.9 mission-status classification (#340)', () => {
  const skillPath = path.join(repoRoot, 'skills/session-end/SKILL.md');
  let body;

  const getBody = () => {
    body = body ?? readFileSync(skillPath, 'utf8');
    return body;
  };

  it('file exists', () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it('contains a Phase 1.9 section for mission-status classification', () => {
    expect(getBody()).toMatch(/1\.9.*[Mm]ission-[Ss]tatus|[Mm]ission-[Ss]tatus.*1\.9/);
  });

  it('contains "mission-status" in Phase 1 classification logic', () => {
    expect(getBody()).toContain('mission-status');
  });

  it('references parseMissionStatus from state-md.mjs', () => {
    expect(getBody()).toContain('parseMissionStatus');
  });

  it('maps status: completed to 1.1 Done Items bucket', () => {
    const content = getBody();
    expect(content).toMatch(/completed.*1\.1|1\.1.*completed/);
  });

  it('maps status: in-dev and testing to 1.2 Partially Done bucket', () => {
    const content = getBody();
    expect(content).toMatch(/in-dev.*1\.2|1\.2.*in-dev/);
    expect(content).toMatch(/testing.*1\.2|1\.2.*testing/);
  });

  it('maps status: brainstormed and validated to 1.3 Not Started bucket', () => {
    const content = getBody();
    expect(content).toMatch(/brainstormed.*1\.3|1\.3.*brainstormed/);
    expect(content).toMatch(/validated.*1\.3|1\.3.*validated/);
  });

  it('documents backward compat: skips when mission-status key is absent', () => {
    const content = getBody();
    expect(content).toMatch(/absent|backward compat|backward-compat/i);
  });
});
