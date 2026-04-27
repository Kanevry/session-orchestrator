/**
 * tests/skills/vault-mirror-session-id-wiring.test.mjs
 *
 * Regression: GH#31 phased-rollout completion.
 * Both vault-mirror call sites (session-end Phase 3.7 + evolve Step 9) MUST pass
 * `--session-id <id>` to scripts/vault-mirror.mjs so the auto-commit phase fires
 * with a traceable subject line. Without these, GH#31 ships but stays inert.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('vault-mirror --session-id wiring (#31 phased-rollout)', () => {
  it('skills/session-end/session-metrics-write.md passes --session-id "$SESSION_ID"', () => {
    const body = read('skills/session-end/session-metrics-write.md');
    expect(body).toMatch(/scripts\/vault-mirror\.mjs/);
    expect(body).toMatch(/--session-id\s+"\$SESSION_ID"/);
  });

  it('skills/evolve/SKILL.md derives EVOLVE_SESSION_ID and passes --session-id', () => {
    const body = read('skills/evolve/SKILL.md');
    expect(body).toMatch(/EVOLVE_SESSION_ID="evolve-\$\(date/);
    expect(body).toMatch(/--session-id\s+"\$EVOLVE_SESSION_ID"/);
  });
});

describe('evolve source_session contract (#307)', () => {
  it('skills/evolve/SKILL.md requires source_session as non-empty string', () => {
    const body = read('skills/evolve/SKILL.md');
    expect(body).toMatch(/non-empty kebab-slug string/);
    expect(body).toMatch(/never an object/i);
    expect(body).toMatch(/#307/);
  });
});
