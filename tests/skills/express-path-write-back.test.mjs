import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  appendDeviation,
  markExpressPathComplete,
  parseStateMd,
} from '@lib/state-md.mjs';
import { isUserInvocableValue, parseSkillFrontmatter } from '@lib/user-invocable-skills.mjs';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

const FIXTURE_WITH_DEVIATIONS = `---
schema_version: 1
status: active
updated: "2026-05-01T10:00:00Z"
---

# STATE

Some preamble.

## Deviations

(none yet)
`;

const FIXTURE_NO_DEVIATIONS = `---
schema_version: 1
status: active
updated: "2026-05-01T10:00:00Z"
---

# STATE

Some preamble without a deviations section.
`;

describe('Express Path persistence contract (#320)', () => {
  describe('Spec — phase-8-5-express-path.md declares Step 4 verification contract', () => {
    const specPath = path.join(
      repoRoot,
      'skills/session-start/phase-8-5-express-path.md',
    );
    const body = readFileSync(specPath, 'utf8');

    it('contains an explicit "Persistence contract:" heading line', () => {
      expect(body).toContain('Persistence contract:');
    });

    it('ends with a "## See Also" section', () => {
      expect(body).toContain('## See Also');
    });
  });

  // The `/go` body lives in `skills/go/SKILL.md` since #1370, and since the
  // 2026-09-16 fold that skill is ALSO the whole of `/go`: `commands/go.md` is
  // gone, because a command + same-named skill runs the skill body anyway and
  // lists the entry twice in the `/` picker (measured, claude 2.1.273). What
  // makes `/go` resolve now is the explicit `user-invocable: true` marker in the
  // skill's frontmatter — so the fifth pin below measures THAT, where it used to
  // measure the delegation. Drop the flag and `/go` silently stops resolving;
  // this goes red instead.
  describe('Spec — the /go body (skills/go/SKILL.md) has the Express Path Detection branch', () => {
    const skillPath = path.join(repoRoot, 'skills/go/SKILL.md');
    const body = readFileSync(skillPath, 'utf8');

    it('contains the "## Express Path Detection" heading', () => {
      expect(body).toContain('## Express Path Detection');
    });

    it('references the activation banner phrase', () => {
      expect(body).toContain('Express path activated —');
    });

    it('directs the coordinator to invoke session-orchestrator:session-end', () => {
      expect(body).toContain('session-orchestrator:session-end');
    });

    it('separates the express branch from the "## Standard Execution" path', () => {
      expect(body).toContain('## Standard Execution');
    });

    it('is the only surface for /go — no commands/go.md twin, explicit user-invocable: true (#1370)', () => {
      expect(existsSync(path.join(repoRoot, 'commands/go.md'))).toBe(false);
      const frontmatter = parseSkillFrontmatter(body);
      expect(isUserInvocableValue(frontmatter?.['user-invocable'])).toBe(true);
    });
  });

  describe('Runtime — markExpressPathComplete', () => {
    it('flips frontmatter status from active to completed', () => {
      const result = markExpressPathComplete(FIXTURE_WITH_DEVIATIONS, {
        taskCount: 2,
        timestamp: '2026-05-01T18:00:00Z',
      });
      const parsed = parseStateMd(result);
      expect(parsed).not.toBeNull();
      expect(parsed.frontmatter.status).toBe('completed');
    });

    it('appends an Express path coord-direct deviation bullet', () => {
      const result = markExpressPathComplete(FIXTURE_WITH_DEVIATIONS, {
        taskCount: 2,
        timestamp: '2026-05-01T18:00:00Z',
      });
      // Tolerant on timestamp shape, strict on the structured message body.
      expect(result).toMatch(
        /- \[[^\]]+\] Express path: 2 tasks executed coord-direct \(express-path\.enabled: true, session-type: housekeeping, scope: 2 issues\)/,
      );
    });

    it('returns input unchanged when given garbage (unparseable) content', () => {
      const garbage = 'not a valid state.md';
      const result = markExpressPathComplete(garbage, { taskCount: 1 });
      expect(result).toBe(garbage);
    });
  });

  describe('Runtime — appendDeviation', () => {
    it('creates the ## Deviations section when absent and writes the bullet', () => {
      const result = appendDeviation(
        FIXTURE_NO_DEVIATIONS,
        '2026-05-01T18:00:00Z',
        'test message',
      );
      expect(result).toContain('## Deviations');
      expect(result).toContain('- [2026-05-01T18:00:00Z] test message');
    });
  });
});
