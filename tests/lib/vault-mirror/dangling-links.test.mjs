/**
 * Hermetic corpus tests — 0-dangling-assertion + bare-link lockdown guard
 *
 * Issue #704 Task 1 (corpus 0-dangling) + Task 2 (bare-link lockdown guard).
 *
 * IMPORTANT: all fixtures are deterministic and self-contained.
 * No live .orchestrator/metrics/learnings.jsonl is read — this test is hermetic.
 *
 * Fixture matrix (6 entries covering every resolution path):
 *   [A] resolvable semantic, noteExists=true   → [[main-2026-06-11-deep-1]]
 *   [B] 'unknown'                               → plain text, no [[
 *   [C] branch-style-no-counter, no predicate  → plain text, no [[
 *   [D] corrupted '[object', no predicate      → plain text, no [[
 *   [E] legacy HHmm id, noteExists=true        → [[main-2026-04-23-1255]]
 *   [F] legacy HHmm id, noteExists=false       → plain text, no [[
 */

import { describe, it, expect } from 'vitest';
import { generateLearningNote } from '@lib/vault-mirror/render-learnings.mjs';

// ── Hermetic fixture factory ──────────────────────────────────────────────────

/** Minimal valid v1 learning entry for dangling-link corpus tests. */
function makeFixtureEntry(source_session) {
  return {
    id: 'fixture-entry',
    type: 'proven-pattern',
    subject: 'Fixture subject for dangling-link tests',
    insight: 'Fixture insight text for hermetic corpus testing',
    evidence: 'Hermetic fixture evidence',
    confidence: 0.9,
    source_session,
    created_at: '2026-06-11T10:00:00Z',
  };
}

// ── Per-fixture checks (Task 1) ───────────────────────────────────────────────

describe('dangling-links [A]: resolvable semantic session with noteExists=true', () => {
  it('emits [[main-2026-06-11-deep-1]] in the frontmatter source_session field', () => {
    const out = generateLearningNote(
      makeFixtureEntry('main-2026-06-11-deep-1'),
      'main-2026-06-11-deep-1',
      { noteExists: () => true },
    );
    expect(out).toContain('source_session: "[[main-2026-06-11-deep-1]]"');
  });

  it('emits [[main-2026-06-11-deep-1]] in the body Source session bullet', () => {
    const out = generateLearningNote(
      makeFixtureEntry('main-2026-06-11-deep-1'),
      'main-2026-06-11-deep-1',
      { noteExists: () => true },
    );
    expect(out).toContain('**Source session:** [[main-2026-06-11-deep-1]]');
  });

  it('produces exactly 2 wikilink occurrences total (frontmatter + body)', () => {
    const out = generateLearningNote(
      makeFixtureEntry('main-2026-06-11-deep-1'),
      'main-2026-06-11-deep-1',
      { noteExists: () => true },
    );
    const links = out.match(/\[\[[^\]]+\]\]/g) ?? [];
    expect(links).toHaveLength(2);
  });
});

describe('dangling-links [B]: source_session "unknown"', () => {
  it('emits no wikilinks when source_session is "unknown"', () => {
    const out = generateLearningNote(
      makeFixtureEntry('unknown'),
      'unknown-slug',
      {},
    );
    const links = out.match(/\[\[[^\]]+\]\]/g) ?? [];
    expect(links).toHaveLength(0);
  });

  it('emits the string "unknown" as plain text in frontmatter (not [[unknown]])', () => {
    const out = generateLearningNote(
      makeFixtureEntry('unknown'),
      'unknown-slug',
      {},
    );
    expect(out).toContain('source_session: unknown');
    expect(out).not.toContain('[[unknown]]');
  });
});

describe('dangling-links [C]: branch-style-no-counter session without predicate', () => {
  it('emits no wikilinks for "develop-2026-04-09-evolve" (no numeric counter — not semantic format)', () => {
    const out = generateLearningNote(
      makeFixtureEntry('develop-2026-04-09-evolve'),
      'evolve-session-slug',
      {},
    );
    const links = out.match(/\[\[[^\]]+\]\]/g) ?? [];
    expect(links).toHaveLength(0);
  });

  it('emits plain text for the branch-style id in the body Source session bullet', () => {
    const out = generateLearningNote(
      makeFixtureEntry('develop-2026-04-09-evolve'),
      'evolve-session-slug',
      {},
    );
    expect(out).toContain('**Source session:** develop-2026-04-09-evolve');
    expect(out).not.toContain('[[develop-2026-04-09-evolve]]');
  });
});

describe('dangling-links [D]: corrupted "[object" source_session', () => {
  it('emits no [[ sequences for corrupted "[object" input', () => {
    const out = generateLearningNote(
      makeFixtureEntry('[object'),
      'corrupted-slug',
      {},
    );
    expect(out).not.toContain('[[');
  });

  it('does not emit [[object]] — subjectToSlug stripping does not promote to a link target', () => {
    const out = generateLearningNote(
      makeFixtureEntry('[object'),
      'corrupted-slug',
      {},
    );
    expect(out).not.toContain('[[object]]');
  });
});

describe('dangling-links [E]: legacy HHmm id (main-2026-04-23-1255) with noteExists=true', () => {
  it('emits [[main-2026-04-23-1255]] in the frontmatter source_session field', () => {
    const out = generateLearningNote(
      makeFixtureEntry('main-2026-04-23-1255'),
      'main-2026-04-23-1255',
      { noteExists: () => true },
    );
    expect(out).toContain('source_session: "[[main-2026-04-23-1255]]"');
  });

  it('emits [[main-2026-04-23-1255]] in the body Source session bullet', () => {
    const out = generateLearningNote(
      makeFixtureEntry('main-2026-04-23-1255'),
      'main-2026-04-23-1255',
      { noteExists: () => true },
    );
    expect(out).toContain('**Source session:** [[main-2026-04-23-1255]]');
  });
});

describe('dangling-links [F]: legacy HHmm id (main-2026-04-23-1255) with noteExists=false', () => {
  it('emits no wikilinks when noteExists returns false for legacy HHmm id', () => {
    const out = generateLearningNote(
      makeFixtureEntry('main-2026-04-23-1255'),
      'main-2026-04-23-1255',
      { noteExists: () => false },
    );
    const links = out.match(/\[\[[^\]]+\]\]/g) ?? [];
    expect(links).toHaveLength(0);
  });

  it('emits plain text for the legacy HHmm id in frontmatter when noteExists=false', () => {
    const out = generateLearningNote(
      makeFixtureEntry('main-2026-04-23-1255'),
      'main-2026-04-23-1255',
      { noteExists: () => false },
    );
    expect(out).toContain('source_session: main-2026-04-23-1255');
    expect(out).not.toContain('[[main-2026-04-23-1255]]');
  });
});

// ── Corpus sweep (Task 1 full sweep + Task 2 bare-link lockdown) ─────────────
//
// All 6 fixture renders are computed once at module scope so each it() body
// has cyclomatic complexity = 1 (no branching — pure assertions on constants).

const _CORPUS_RENDERS = [
  // [A] resolvable semantic, noteExists=true → link
  generateLearningNote(makeFixtureEntry('main-2026-06-11-deep-1'), 'main-2026-06-11-deep-1', { noteExists: () => true }),
  // [B] 'unknown' → plain
  generateLearningNote(makeFixtureEntry('unknown'), 'unknown-slug', {}),
  // [C] branch-style, no counter, no predicate → plain
  generateLearningNote(makeFixtureEntry('develop-2026-04-09-evolve'), 'evolve-session-slug', {}),
  // [D] corrupted → plain
  generateLearningNote(makeFixtureEntry('[object'), 'corrupted-slug', {}),
  // [E] legacy HHmm, noteExists=true → link
  generateLearningNote(makeFixtureEntry('main-2026-04-23-1255'), 'main-2026-04-23-1255', { noteExists: () => true }),
  // [F] legacy HHmm, noteExists=false → plain
  generateLearningNote(makeFixtureEntry('main-2026-04-23-1255'), 'main-2026-04-23-1255', { noteExists: () => false }),
];

// Concatenate all renders for aggregate grep-style assertions.
const _CORPUS_ALL_TEXT = _CORPUS_RENDERS.join('\n---corpus-separator---\n');

// All [[...]] wikilinks found across the entire corpus.
const _CORPUS_ALL_WIKILINKS = _CORPUS_ALL_TEXT.match(/\[\[[^\]]+\]\]/g) ?? [];

// [[unknown]] occurrences — must be zero.
const _CORPUS_UNKNOWN_LINKS = _CORPUS_ALL_WIKILINKS.filter((l) => l === '[[unknown]]');

// Path-qualified [[folder/name]] links — must be zero.
const _CORPUS_PATH_QUALIFIED_LINKS = _CORPUS_ALL_TEXT.match(/\[\[[^[\]]*\/[^[\]]*\]\]/g) ?? [];

// Wikilinks that do NOT match the bare-basename form (no / inside brackets).
// /^\[\[[^/\]]+\]\]$/ asserts: [[ + one-or-more non-slash non-] chars + ]]
const _CORPUS_NON_BARE_LINKS = _CORPUS_ALL_WIKILINKS.filter((l) => !/^\[\[[^/\]]+\]\]$/.test(l));

describe('dangling-links corpus sweep: 0-dangling assertion (Task 1)', () => {
  it('emits zero [[unknown]] links across all 6 fixture renders', () => {
    expect(_CORPUS_UNKNOWN_LINKS).toHaveLength(0);
  });

  it('emits exactly 4 wikilinks total: 2 from fixture A (semantic) + 2 from fixture E (legacy HHmm)', () => {
    expect(_CORPUS_ALL_WIKILINKS).toHaveLength(4);
  });

  it('all emitted wikilinks target only the two known-resolvable sessions (sorted equality)', () => {
    expect(_CORPUS_ALL_WIKILINKS.slice().sort()).toEqual([
      '[[main-2026-04-23-1255]]',
      '[[main-2026-04-23-1255]]',
      '[[main-2026-06-11-deep-1]]',
      '[[main-2026-06-11-deep-1]]',
    ]);
  });
});

describe('dangling-links corpus sweep: bare-link lockdown guard (Task 2)', () => {
  it('no corpus render emits a path-qualified [[folder/name]] link', () => {
    // Catches e.g. [[50-sessions/main-2026-06-11-deep-1]] or [[01-projects/slug]]
    expect(_CORPUS_PATH_QUALIFIED_LINKS).toHaveLength(0);
  });

  it('no corpus render contains the substring "[[50-sessions/"', () => {
    expect(_CORPUS_ALL_TEXT).not.toContain('[[50-sessions/');
  });

  it('no corpus render contains the substring "[[01-projects/"', () => {
    expect(_CORPUS_ALL_TEXT).not.toContain('[[01-projects/');
  });

  it('every emitted wikilink matches /^\\[\\[[^/\\]]+\\]\\]$/ — bare basename, no / between brackets', () => {
    // Guard: ensures we are actually asserting against real links (not an empty corpus).
    expect(_CORPUS_ALL_WIKILINKS).toHaveLength(4);
    // The non-bare set must be empty — any path-qualified link would appear here.
    expect(_CORPUS_NON_BARE_LINKS).toHaveLength(0);
  });
});
