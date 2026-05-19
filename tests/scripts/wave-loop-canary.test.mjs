/**
 * tests/scripts/wave-loop-canary.test.mjs
 *
 * Simulator-canary for skills/wave-executor/wave-loop.md spec (#480).
 *
 * Guards the enforce:off behaviour documented at wave-loop.md:364:
 * "Under enforce: off: record the violation in subagents.jsonl for diagnostics
 * (schema_violation: true, schema_errors: [...] are set on the agent record) but
 * do NOT emit a log line in the wave progress update and do NOT block the wave."
 *
 * If these strings disappear or drift (e.g. spec rewritten without updating the
 * inline test in wave-loop-schema-validation.test.mjs), this canary fails loudly
 * rather than silently passing while the spec has diverged.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WAVE_LOOP_PATH = resolve('skills/wave-executor/wave-loop.md');
const content = readFileSync(WAVE_LOOP_PATH, 'utf8');
const lines = content.split('\n');

describe('wave-loop.md spec canary (#480 simulator-canary)', () => {
  it('contains the enforce:off spec at the documented location', () => {
    expect(content).toContain('enforce: off');
    expect(content).toContain('schema_violation');
  });

  it('documents that enforce:off does NOT emit a log line', () => {
    expect(content).toMatch(/do NOT emit (?:a log|in-wave|the log)/i);
  });

  it('section enforce:off appears in the schema-validation context (proximity check)', () => {
    // Find the line containing the enforcement-mode table entry for 'enforce: off'
    const enforceLineIdx = lines.findIndex((l) => l.includes('enforce: off'));
    expect(enforceLineIdx).toBeGreaterThan(0);
    // Within +/-30 lines, schema_violation should also appear (schema-validation context)
    const window = lines
      .slice(Math.max(0, enforceLineIdx - 30), Math.min(lines.length, enforceLineIdx + 30))
      .join('\n');
    expect(window).toContain('schema_violation');
  });
});
