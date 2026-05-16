/**
 * security-reviewer-exclusions.test.mjs
 *
 * Regression sentinel for the "Hard Exclusions (False-Positive Patterns)"
 * section in agents/security-reviewer.md (GitLab #412).
 *
 * If anyone edits the Hard Exclusions section the snapshot test fails,
 * forcing a deliberate fixture re-confirm before the change can land.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve paths relative to the repo root (3 levels up from tests/unit/agents/)
const REPO_ROOT = path.resolve(__dirname, '../../..');
const AGENT_FILE = path.join(REPO_ROOT, 'agents/security-reviewer.md');
const FIXTURE_FILE = path.join(
  REPO_ROOT,
  'tests/fixtures/agents/security-reviewer-exclusions-snapshot.txt',
);

/**
 * Extract a markdown section by heading.
 * Returns the text from the heading line (inclusive) through — but not
 * including — the next `## ` heading (exclusive), trimmed of trailing whitespace.
 */
function extractSection(content, headingText) {
  const startMarker = `## ${headingText}`;
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) return null;

  // Find the next `## ` heading after the start
  const afterStart = content.indexOf('\n## ', startIdx + startMarker.length);
  const section =
    afterStart === -1
      ? content.slice(startIdx)
      : content.slice(startIdx, afterStart);

  return section.trimEnd();
}

const agentContent = fs.readFileSync(AGENT_FILE, 'utf8');
const fixtureContent = fs.readFileSync(FIXTURE_FILE, 'utf8').trimEnd();

// ---------------------------------------------------------------------------
// 1. Snapshot equivalence
// ---------------------------------------------------------------------------

describe('Hard Exclusions section — snapshot equivalence', () => {
  it('matches the fixture verbatim (regression sentinel)', () => {
    const extracted = extractSection(agentContent, 'Hard Exclusions (False-Positive Patterns)');
    expect(extracted).not.toBeNull();
    // toEqual on strings — must match byte-for-byte
    expect(extracted).toEqual(fixtureContent);
  });
});

// ---------------------------------------------------------------------------
// 2. Keyword presence — the 5 sub-section pattern classes
// ---------------------------------------------------------------------------

describe('Hard Exclusions section — keyword presence', () => {
  it('contains "Open Redirect" with exact capitalization', () => {
    expect(agentContent).toContain('Open Redirect');
  });

  it('contains "Memory-Safety Patterns"', () => {
    expect(agentContent).toContain('Memory-Safety Patterns');
  });

  it('contains "Regex Catastrophic Backtracking"', () => {
    expect(agentContent).toContain('Regex Catastrophic Backtracking');
  });

  it('contains both "SSRF" and "HTML-only"', () => {
    expect(agentContent).toContain('SSRF');
    expect(agentContent).toContain('HTML-only');
  });

  it('contains both "Memory Leak" and "reproducer"', () => {
    expect(agentContent).toContain('Memory Leak');
    expect(agentContent).toContain('reproducer');
  });
});

// ---------------------------------------------------------------------------
// 3. Anthropic source attribution
// ---------------------------------------------------------------------------

describe('Hard Exclusions section — Anthropic source attribution', () => {
  it('references anthropics/claude-code-security-review', () => {
    expect(agentContent).toContain('anthropics/claude-code-security-review');
  });

  it('references the findings_filter.py source file path', () => {
    expect(agentContent).toContain('claudecode/findings_filter.py:L20–100');
  });
});

// ---------------------------------------------------------------------------
// 4. Cross-references to existing sections
// ---------------------------------------------------------------------------

describe('Hard Exclusions section — cross-references', () => {
  it('references back to "Exclusions — DO NOT REPORT"', () => {
    // The Cross-References sub-block must link back to the existing Exclusions section
    expect(agentContent).toContain('Exclusions — DO NOT REPORT');
  });

  it('references back to "Confidence Calibration"', () => {
    expect(agentContent).toContain('Confidence Calibration');
  });
});

// ---------------------------------------------------------------------------
// 5. Section ordering invariant
// ---------------------------------------------------------------------------

describe('Hard Exclusions section — ordering invariant', () => {
  it('Hard Exclusions appears after "## Exclusions" and before "## Analysis Methodology"', () => {
    const exclusionsIdx = agentContent.indexOf('## Exclusions');
    const hardExclusionsIdx = agentContent.indexOf('## Hard Exclusions');
    const analysisMethodologyIdx = agentContent.indexOf('## Analysis Methodology');

    // All three headings must be present
    expect(exclusionsIdx).toBeGreaterThan(-1);
    expect(hardExclusionsIdx).toBeGreaterThan(-1);
    expect(analysisMethodologyIdx).toBeGreaterThan(-1);

    // Hard Exclusions must come after Exclusions
    expect(hardExclusionsIdx).toBeGreaterThan(exclusionsIdx);

    // Hard Exclusions must come before Analysis Methodology
    expect(hardExclusionsIdx).toBeLessThan(analysisMethodologyIdx);
  });
});
