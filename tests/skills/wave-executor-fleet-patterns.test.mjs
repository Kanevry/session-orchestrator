/**
 * tests/skills/wave-executor-fleet-patterns.test.mjs
 *
 * Cross-file prose-CONTRACT guard for the #730/H4 over-delivery Wave-History
 * header. The single-file content-presence pins that once surrounded this
 * (Contract-Lock heading present, Path-Cousin-Guard heading present, step-7
 * strings present, etc.) were removed: asserting that a heading/string exists
 * in one skill markdown file pins prose, not behaviour (TV-002c).
 *
 * What remains is the one genuine machine contract: an IDENTICAL template that
 * must appear byte-for-byte in BOTH the writer (wave-loop.md §3a) and the
 * parser (session-end metrics-collection.md). No mechanical parser enforces it
 * — the coordinator parses it — so a one-sided rewording silently kills the
 * #730/H4 signal. This is a two-file drift invariant, not a one-file pin.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WAVE_LOOP_MD = join(REPO_ROOT, 'skills/wave-executor/wave-loop.md');
const METRICS_COLLECTION_MD = join(REPO_ROOT, 'skills/session-end/metrics-collection.md');

let waveLoop;
let metricsCollection;

beforeAll(() => {
  waveLoop = readFileSync(WAVE_LOOP_MD, 'utf8');
  metricsCollection = readFileSync(METRICS_COLLECTION_MD, 'utf8');
});

describe('#730/H4 over-delivery header — cross-file prose contract (GAP-2)', () => {
  const HEADER_TEMPLATE = '(planned <P> files → actual <A>, over-delivery <R>)';

  it('the writer side (wave-loop.md §3a) carries the exact template', () => {
    expect(waveLoop).toContain(HEADER_TEMPLATE);
  });

  it('the parser side (session-end metrics-collection.md) carries the byte-identical template', () => {
    expect(metricsCollection).toContain(HEADER_TEMPLATE);
  });
});
