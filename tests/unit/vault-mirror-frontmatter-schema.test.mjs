import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatter,
  buildTag,
  slugifyTagSegment,
  slugifyIdSafe,
  TAG_MAX_LENGTH,
} from '../../scripts/lib/vault-mirror/utils.mjs';
import {
  generateSessionNote,
  generateSessionNoteV2,
  generateSessionNoteV3,
} from '../../scripts/lib/vault-mirror/render-sessions.mjs';
import {
  generateLearningNote,
  generateLearningNoteV2,
} from '../../scripts/lib/vault-mirror/render-learnings.mjs';

// #602: vault-mirror generators emitted RAW interpolated `id` (carrying ISO
// uppercase T/Z/:/.) and RAW tag segments (non-kebab, un-capped). These violate
// the authoritative vault frontmatter schema, causing vault-sync's hard gate to
// reject the generated notes (35 errors observed in agents/vault deep-1).
//
// The authoritative regexes live (vendored, between GENERATED-SCHEMA sentinels)
// in skills/vault-sync/validator.mjs:
//   id  → slugRegex      /^[a-z0-9]+(?:-[a-z0-9]+)*$/         (min 2, max 128)
//   tag → tagPathRegex   /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/...)*$/ (each tag max 64)
// They are duplicated here (not imported — validator.mjs does not export the
// schema) so this regression test asserts the REAL generator output parses, and
// fails loudly if a future refactor re-introduces raw interpolation.
const ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/** Split a parseFrontmatter `tags` string (`"[a, b, c]"`) into segments. */
function parseTags(raw) {
  return String(raw)
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Assert a parsed frontmatter object satisfies the id + tag schema regexes. */
function assertSchemaValid(fm) {
  expect(ID_REGEX.test(fm.id)).toBe(true);
  expect(fm.id.length).toBeGreaterThanOrEqual(2);
  expect(fm.id.length).toBeLessThanOrEqual(128);
  for (const tag of parseTags(fm.tags)) {
    expect(TAG_REGEX.test(tag)).toBe(true);
    expect(tag.length).toBeLessThanOrEqual(64);
  }
}

// ── Fixtures (mirror tests/unit/vault-mirror.test.mjs schema requirements) ──
function v1Session(overrides = {}) {
  return {
    session_id: '2026-05-23-deep',
    session_type: 'deep',
    started_at: '2026-05-23T08:00:00Z',
    completed_at: '2026-05-23T10:00:00Z',
    duration_seconds: 7200,
    total_waves: 3,
    total_agents: 6,
    total_files_changed: 12,
    agent_summary: { complete: 5, partial: 1, failed: 0, spiral: 0 },
    waves: [{ wave: 1, role: 'Planning', agent_count: 1, files_changed: 2, quality: 'ok' }],
    effectiveness: { planned_issues: 3, completed: 3, carryover: 0, emergent: 1, completion_rate: 1.0 },
    ...overrides,
  };
}

function v2Session(overrides = {}) {
  return {
    session_id: '2026-05-23-feature',
    session_type: 'feature',
    started_at: '2026-05-23T08:00:00Z',
    completed_at: '2026-05-23T10:00:00Z',
    duration_seconds: 3600,
    waves: [{ wave: 1, role: 'Impl', agents: 3, agents_done: 3, agents_partial: 0, agents_failed: 0 }],
    files_changed: 8,
    effectiveness: { completion_rate: 1.0, carryover: 0 },
    ...overrides,
  };
}

function v3Session(overrides = {}) {
  return {
    session_id: '2026-05-23-deep-3',
    session_type: 'deep',
    started_at: '2026-05-23T08:00:00Z',
    completed_at: '2026-05-23T10:00:00Z',
    duration_minutes: 120,
    waves: 5,
    agents_dispatched: 18,
    effectiveness: { completion_rate: 1.0, carryover: 0 },
    ...overrides,
  };
}

function v1Learning(overrides = {}) {
  return {
    id: 'my-pattern',
    type: 'proven-pattern',
    subject: 'caching',
    insight: 'x'.repeat(50),
    evidence: 'observed in production',
    confidence: 0.9,
    source_session: 'session-2026-05-23',
    created_at: '2026-05-23T10:00:00Z',
    ...overrides,
  };
}

function v2Learning(overrides = {}) {
  return {
    id: 'my-v2-learning',
    type: 'anti-pattern',
    text: 'y'.repeat(50),
    scope: 'global',
    confidence: 0.9,
    first_seen: '2026-05-23T10:00:00Z',
    ...overrides,
  };
}

describe('vault-mirror utils — tag/id slug helpers (#602)', () => {
  it('slugifyTagSegment kebab-cases a single segment (whitespace → hyphen)', () => {
    expect(slugifyTagSegment('Deep Mode')).toBe('deep-mode');
  });

  it('slugifyTagSegment falls back to "unknown" for an empty result', () => {
    expect(slugifyTagSegment('###')).toBe('unknown');
  });

  it('buildTag slugifies each segment and preserves the hierarchy', () => {
    expect(buildTag(['session', 'DEEP Mode!!'])).toBe('session/deep-mode');
  });

  it('buildTag whitespace-collapses a multi-word segment to a single hyphen', () => {
    expect(buildTag(['learning', 'Anti Pattern!!'])).toBe('learning/anti-pattern');
  });

  it('buildTag keeps an already-valid tag unchanged', () => {
    expect(buildTag(['status', 'verified'])).toBe('status/verified');
  });

  it('buildTag replaces an empty variable segment with "unknown"', () => {
    expect(buildTag(['learning', '!!!'])).toBe('learning/unknown');
  });

  it('buildTag caps an over-length tag at TAG_MAX_LENGTH characters', () => {
    const tag = buildTag(['scope', 'X'.repeat(80)]);
    expect(tag.length).toBe(TAG_MAX_LENGTH);
    expect(tag.length).toBe(64);
  });

  it('buildTag output (even when capped) matches the tag schema regex', () => {
    expect(TAG_REGEX.test(buildTag(['scope', 'X'.repeat(80)]))).toBe(true);
  });

  it('buildTag returns "unknown" for an empty segment list', () => {
    expect(buildTag([])).toBe('unknown');
  });

  it('slugifyIdSafe pads a single-character slug to satisfy min-length-2', () => {
    expect(slugifyIdSafe('A')).toBe('a-x');
  });

  it('slugifyIdSafe returns null when nothing slugifiable remains', () => {
    expect(slugifyIdSafe('!!!')).toBeNull();
  });

  it('slugifyIdSafe kebab-cases an ISO-timestamp-laden id (drops uppercase T/Z/:/.)', () => {
    const id = slugifyIdSafe('2026-05-28T17:44:03.123Z-deep');
    expect(id).toBe('2026-05-28t174403-123z-deep');
    expect(ID_REGEX.test(id)).toBe(true);
    expect(id).not.toMatch(/[A-Z:.]/);
  });
});

describe('generateSessionNote (v1) emits schema-valid frontmatter (#602)', () => {
  it('produces schema-valid frontmatter for normal input', () => {
    const fm = parseFrontmatter(generateSessionNote(v1Session(), { repoNs: 'org-repo' }));
    assertSchemaValid(fm);
    expect(fm.id).toBe('org-repo-2026-05-23-deep');
    expect(parseTags(fm.tags)).toContain('session/deep');
    expect(parseTags(fm.tags)).toContain('status/verified');
    // #732: session notes emit `source-repo` (schema field, vaultFrontmatterSchema
    // declares it optional string) instead of the legacy raw `repo` field.
    expect(fm['source-repo']).toBe('org-repo');
    expect(fm['repo']).toBeUndefined();
  });

  it('slugifies an ISO-timestamp session_id so the id is a kebab slug', () => {
    const fm = parseFrontmatter(
      generateSessionNote(v1Session({ session_id: '2026-05-28T17:44Z-deep' }), { repoNs: 'org-repo' }),
    );
    expect(fm.id).not.toMatch(/[A-Z:.]/);
    assertSchemaValid(fm);
  });

  it('produces schema-valid frontmatter for hostile input (non-kebab type, raw ISO id)', () => {
    const fm = parseFrontmatter(
      generateSessionNote(
        v1Session({ session_id: '2026-05-28T17:44:03.123Z-deep', session_type: 'DEEP Mode!!' }),
        { repoNs: 'org-repo' },
      ),
    );
    assertSchemaValid(fm);
    // "DEEP Mode!!" → lowercase, whitespace→hyphen, "!!" stripped → "deep-mode".
    expect(parseTags(fm.tags)).toContain('session/deep-mode');
    // id: ISO uppercase T/Z/:/. all sanitized to a kebab slug.
    expect(fm.id).toBe('org-repo-2026-05-28t174403-123z-deep');
  });
});

describe('generateSessionNoteV2 emits schema-valid frontmatter (#602)', () => {
  it('produces schema-valid frontmatter for hostile non-kebab session_type', () => {
    const fm = parseFrontmatter(
      generateSessionNoteV2(v2Session({ session_type: 'Feature Branch!!' }), { repoNs: 'org-repo' }),
    );
    assertSchemaValid(fm);
    expect(parseTags(fm.tags)).toContain('session/feature-branch');
  });
});

describe('generateSessionNoteV3 emits schema-valid frontmatter (#602)', () => {
  it('produces schema-valid frontmatter for normal input', () => {
    const fm = parseFrontmatter(generateSessionNoteV3(v3Session(), { repoNs: 'org-repo' }));
    assertSchemaValid(fm);
    expect(fm.id).toBe('org-repo-2026-05-23-deep-3');
  });

  it('produces schema-valid frontmatter for hostile input (raw ISO id + non-kebab type)', () => {
    const fm = parseFrontmatter(
      generateSessionNoteV3(
        v3Session({ session_id: '2026-05-28T17:44:03.123Z-deep', session_type: 'DEEP Mode!!' }),
        { repoNs: 'org-repo' },
      ),
    );
    assertSchemaValid(fm);
    expect(parseTags(fm.tags)).toContain('session/deep-mode');
  });
});

describe('generateLearningNote (v1) emits schema-valid frontmatter (#602)', () => {
  it('produces schema-valid frontmatter for normal input', () => {
    const fm = parseFrontmatter(generateLearningNote(v1Learning(), 'my-pattern'));
    assertSchemaValid(fm);
    expect(parseTags(fm.tags)).toContain('learning/proven-pattern');
    expect(parseTags(fm.tags)).toContain('status/verified');
  });

  it('produces schema-valid frontmatter for hostile non-kebab type', () => {
    const fm = parseFrontmatter(
      generateLearningNote(v1Learning({ type: 'Anti Pattern!!' }), 'my-pattern'),
    );
    assertSchemaValid(fm);
    // "Anti Pattern!!" → whitespace→hyphen, "!!" stripped → "anti-pattern".
    expect(parseTags(fm.tags)).toContain('learning/anti-pattern');
  });
});

describe('generateLearningNoteV2 emits schema-valid frontmatter (#602)', () => {
  it('produces schema-valid frontmatter for hostile non-kebab type + long scope', () => {
    const fm = parseFrontmatter(
      generateLearningNoteV2(
        v2Learning({ type: 'Anti Pattern!!', scope: 'A'.repeat(90) }),
        'my-v2-learning',
      ),
    );
    assertSchemaValid(fm);
    expect(parseTags(fm.tags)).toContain('learning/anti-pattern');
  });
});

// #1601: the REAL vault-sync validator (yaml parse + zod `.max(128)` + `z.string()`)
// rejected generator output — a 200-char learning subject rendered a 200-char id,
// and an all-digit subject rendered `id: 433`, which YAML types as a number.
describe('generated ids pass the vault-sync validator of the same plugin (#1601)', () => {
  it('accepts the notes of a 200-char subject and an all-digit subject', () => {
    const vault = mkdtempSync(join(tmpdir(), 'vm-id-1601-'));
    try {
      mkdirSync(join(vault, '_meta'));
      const dir = join(vault, '40-learnings', 'org-repo');
      mkdirSync(dir, { recursive: true });
      const long = `${'a'.repeat(100)}-${'b'.repeat(99)}`;
      expect(long).toHaveLength(200);
      // The all-digit note is rendered WITHOUT a namespace: the repo prefix would
      // make the id non-numeric on its own, so only the quoting guards this shape.
      for (const [slug, repoNs] of [[long, 'org-repo'], ['433', undefined]]) {
        const note = generateLearningNote(v1Learning({ subject: slug }), slug, { repoNs });
        writeFileSync(join(dir, `${slug}.md`), note, 'utf8');
      }
      const validator = fileURLToPath(new URL('../../skills/vault-sync/validator.mjs', import.meta.url));
      const run = spawnSync(process.execPath, [validator], {
        encoding: 'utf8',
        env: { ...process.env, VAULT_DIR: vault },
      });
      expect(`${run.stdout}${run.stderr}`).not.toMatch(/at most 128|Expected string/);
      expect(run.status).toBe(0);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

// #1602: the id was the bare session id / subject slug, so the same session id
// (or learning subject) in two repo folders produced one vault id twice; #1601's
// cap must not merge two long slugs that share their first 128 chars.
describe('generated ids are unique across the vault (#1602)', () => {
  const longA = `${'x'.repeat(150)}-alpha`;
  const longB = `${'x'.repeat(150)}-beta`;
  it.each([
    ['same session id, two repos', () => generateSessionNoteV3(v3Session(), { repoNs: 'repo-a' }), () => generateSessionNoteV3(v3Session(), { repoNs: 'repo-b' })],
    ['same learning subject, two repos', () => generateLearningNote(v1Learning(), 'deep-session-sizing', { repoNs: 'repo-a' }), () => generateLearningNote(v1Learning(), 'deep-session-sizing', { repoNs: 'repo-b' })],
    ['two long subjects sharing a prefix, one repo', () => generateLearningNote(v1Learning(), longA, { repoNs: 'repo-a' }), () => generateLearningNote(v1Learning(), longB, { repoNs: 'repo-a' })],
  ])('%s → distinct ids', (_label, renderA, renderB) => {
    const a = parseFrontmatter(renderA());
    const b = parseFrontmatter(renderB());
    assertSchemaValid(a);
    assertSchemaValid(b);
    expect(a.id).not.toBe(b.id);
  });
});
