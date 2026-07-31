import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

const UPSTREAM_SHA = 'mattpocock/skills@90ea8ee';

// SHA-256 of the byte-identical sub-files vendored from
// mattpocock/skills@90ea8eec03d4ae8f43427aaf6fe4722653561a42 — Epic #309.
// Re-running `shasum -a 256` against /tmp/mattpocock-skills/<src> at that SHA
// reproduces these. If a vendor refresh is intentional, update both the file
// AND the hash below in the same commit.
const PINNED_HASHES = {
  'skills/architecture/LANGUAGE.md':
    '6feca2140439c54a774749e8367f18350899ff69c777144ed2248cd4407949fa',
  'skills/architecture/DEEPENING.md':
    '9577485f4fc32c0267639a9151bb41c8af0f8f6086e4bf8b84d5b236e30604e9',
  'skills/architecture/INTERFACE-DESIGN.md':
    '678c3e34f1339015053212b3316bf0b676c70aa251050a0613667d4e755fb35e',
  'skills/domain-model/CONTEXT-FORMAT.md':
    '8f6baaa3b1c91644bd7c600196b1aee781d5f525c7c345db8cdfbfb368329a05',
  'skills/domain-model/ADR-FORMAT.md':
    'f1f36cd3f8d3b6474ddd5855da4e233bfc4ae1a1c5024909ccf11871819a41b2',
};

function sha256(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function parseFrontmatter(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
  if (!match) throw new Error(`No frontmatter in ${absPath}`);
  return yaml.load(match[1]);
}

describe('Architecture-DDD-Trio adoption — Epic #309 (#310/#311/#312)', () => {
  // Machine contract: content-hash guard over the byte-identical vendored
  // sub-files. Any edit to a vendored file (or an intentional-but-unrecorded
  // vendor refresh) trips the SHA mismatch. This is the load-bearing keep for
  // this file; the frontmatter/body prose-presence pins that surrounded it were
  // removed (TV-002c — .md content assertions catch no bug).
  describe('S2/S4 byte-equality of vendored sub-files (mattpocock@90ea8ee)', () => {
    for (const [relPath, expectedHash] of Object.entries(PINNED_HASHES)) {
      it(`${relPath} matches pinned SHA-256 from ${UPSTREAM_SHA}`, () => {
        const abs = path.join(repoRoot, relPath);
        expect(existsSync(abs), `${relPath} must exist`).toBe(true);
        expect(sha256(abs)).toBe(expectedHash);
      });
    }
  });

  // Behavioral-flag contract: `disable-model-invocation: true` controls whether
  // the skill may be auto-invoked by a model. Flipping it is a real runtime
  // behaviour change with no other falsifier (the dedicated
  // disable-model-invocation.test.mjs covers commands/, not skills/).
  describe('domain-model + ubiquitous-language — disable-model-invocation flag', () => {
    it('domain-model SKILL.md preserves disable-model-invocation: true', () => {
      const fm = parseFrontmatter(path.join(repoRoot, 'skills/domain-model/SKILL.md'));
      expect(fm.name).toBe('domain-model');
      expect(fm['disable-model-invocation']).toBe(true);
    });

    it('ubiquitous-language SKILL.md preserves disable-model-invocation: true', () => {
      const fm = parseFrontmatter(path.join(repoRoot, 'skills/ubiquitous-language/SKILL.md'));
      expect(fm.name).toBe('ubiquitous-language');
      expect(fm['disable-model-invocation']).toBe(true);
    });
  });

  // MIT-redistribution set-drift invariant: every vendored sub-file MUST be
  // inventoried in the repo-root NOTICE. Adding a 6th vendored file (a new
  // PINNED_HASHES entry) without listing it in NOTICE is an attribution-
  // completeness regression this guard catches. Not a single-sentence prose pin
  // — it iterates the PINNED_HASHES key set.
  describe('NOTICE — MIT attribution inventory (set-drift)', () => {
    it('NOTICE inventories all 5 byte-identical sub-files plus 3 adapted SKILL.md files', () => {
      const notice = readFileSync(path.join(repoRoot, 'NOTICE'), 'utf8');
      for (const rel of Object.keys(PINNED_HASHES)) {
        expect(notice).toMatch(new RegExp(rel.replace(/[.]/g, '\\.')));
      }
      expect(notice).toMatch(/skills\/architecture\/SKILL\.md/);
      expect(notice).toMatch(/skills\/domain-model\/SKILL\.md/);
      expect(notice).toMatch(/skills\/ubiquitous-language\/SKILL\.md/);
    });
  });
});
