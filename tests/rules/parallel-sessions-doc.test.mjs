import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const rulesFile = path.join(repoRoot, '.claude', 'rules', 'parallel-sessions.md');

const content = readFileSync(rulesFile, 'utf8');

describe('parallel-sessions.md — PSA rule structure (#156)', () => {
  it('has a PSA-001 section labelled Aware (passive)', () => {
    expect(content).toMatch(/PSA-001[^#]*Aware/);
  });

  it('has a PSA-002 section labelled Pause (active)', () => {
    expect(content).toMatch(/PSA-002[^#]*Pause/);
  });

  it('PSA-001 section appears before PSA-002 section', () => {
    const idx001 = content.indexOf('PSA-001');
    const idx002 = content.indexOf('PSA-002');
    expect(idx001).toBeGreaterThan(-1);
    expect(idx002).toBeGreaterThan(-1);
    expect(idx001).toBeLessThan(idx002);
  });

  it('PSA-001 and PSA-002 are separate headings (not merged)', () => {
    const psa001Heading = /##\s+PSA-001/;
    const psa002Heading = /##\s+PSA-002/;
    expect(content).toMatch(psa001Heading);
    expect(content).toMatch(psa002Heading);
  });

  it('decision tree section exists with both routing outcomes', () => {
    expect(content).toContain('Decision Tree');
    expect(content).toContain('PSA-001');
    expect(content).toContain('PSA-002');
  });

  it('PSA-001 body explicitly says continue (no pause)', () => {
    const psa001Start = content.indexOf('## PSA-001');
    const psa002Start = content.indexOf('## PSA-002');
    const psa001Body = content.slice(psa001Start, psa002Start);
    expect(psa001Body.toLowerCase()).toMatch(/continue/);
    expect(psa001Body.toLowerCase()).toMatch(/not pause|no pause|do not pause/);
  });

  it('PSA-002 body explicitly says stop or pause', () => {
    const psa002Start = content.indexOf('## PSA-002');
    const psa003Start = content.indexOf('## PSA-003');
    const psa002Body = content.slice(psa002Start, psa003Start);
    expect(psa002Body.toLowerCase()).toMatch(/stop|pause/);
  });

  it('PSA-003 and PSA-004 sections remain present and unchanged in structure', () => {
    expect(content).toMatch(/##\s+PSA-003/);
    expect(content).toMatch(/##\s+PSA-004/);
    expect(content).toContain('git reset');
    expect(content).toContain('git push --force');
    expect(content).toContain('git add <file>');
  });
});
