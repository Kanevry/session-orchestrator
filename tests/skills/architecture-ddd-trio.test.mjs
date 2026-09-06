import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

const UPSTREAM_SHA = 'mattpocock/skills@90ea8ee';

// SHA-256 of the byte-identical sub-files vendored from
// mattpocock/skills@90ea8eec03d4ae8f43427aaf6fe4722653561a42 — Epic #309.
// Re-running `shasum -a 256` against /tmp/mattpocock-skills/<src> at that SHA
// reproduces these. If a vendor refresh is intentional, update both the file
// AND the hash below in the same commit.
//
// v4.0.0: `skills/domain-model/` was retired and merged into
// `skills/architecture/references/` (audit 2026-09-06 § 5A). The two format
// files moved byte-identically — the hashes below are unchanged, only the
// paths are. `skills/ubiquitous-language/` was removed outright.
const PINNED_HASHES = {
  'skills/architecture/LANGUAGE.md':
    '6feca2140439c54a774749e8367f18350899ff69c777144ed2248cd4407949fa',
  'skills/architecture/DEEPENING.md':
    '9577485f4fc32c0267639a9151bb41c8af0f8f6086e4bf8b84d5b236e30604e9',
  'skills/architecture/INTERFACE-DESIGN.md':
    '678c3e34f1339015053212b3316bf0b676c70aa251050a0613667d4e755fb35e',
  'skills/architecture/references/CONTEXT-FORMAT.md':
    '8f6baaa3b1c91644bd7c600196b1aee781d5f525c7c345db8cdfbfb368329a05',
  'skills/architecture/references/ADR-FORMAT.md':
    'f1f36cd3f8d3b6474ddd5855da4e233bfc4ae1a1c5024909ccf11871819a41b2',
};

function sha256(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

describe('Architecture vendored-material guards — Epic #309, post-4.0 merge', () => {
  // Machine contract: content-hash guard over the byte-identical vendored
  // sub-files. Any edit to a vendored file (or an intentional-but-unrecorded
  // vendor refresh) trips the SHA mismatch. This is the load-bearing keep for
  // this file; the frontmatter/body prose-presence pins that surrounded it were
  // removed (TV-002c — .md content assertions catch no bug).
  describe(`S2/S4 byte-equality of vendored sub-files (${UPSTREAM_SHA})`, () => {
    for (const [relPath, expectedHash] of Object.entries(PINNED_HASHES)) {
      it(`${relPath} matches pinned SHA-256 from ${UPSTREAM_SHA}`, () => {
        const abs = path.join(repoRoot, relPath);
        expect(existsSync(abs), `${relPath} must exist`).toBe(true);
        expect(sha256(abs)).toBe(expectedHash);
      });
    }
  });

  // MIT-redistribution set-drift invariant: every vendored sub-file MUST be
  // inventoried in the repo-root NOTICE. Adding a 6th vendored file (a new
  // PINNED_HASHES entry) without listing it in NOTICE is an attribution-
  // completeness regression this guard catches. Keyed on the file's BASENAME
  // rather than its repo path: NOTICE is outside this wave's file scope and
  // still carries the pre-4.0 `skills/domain-model/…` paths, so a path-exact
  // assertion would pin a stale inventory instead of guarding set drift.
  describe('NOTICE — MIT attribution inventory (set-drift)', () => {
    it('NOTICE inventories every byte-identical vendored sub-file', () => {
      const notice = readFileSync(path.join(repoRoot, 'NOTICE'), 'utf8');
      for (const rel of Object.keys(PINNED_HASHES)) {
        const base = path.basename(rel);
        expect(notice, `NOTICE must inventory ${base}`).toMatch(
          new RegExp(base.replace(/[.]/g, '\\.')),
        );
      }
    });

    it('NOTICE inventories the adapted architecture SKILL.md', () => {
      const notice = readFileSync(path.join(repoRoot, 'NOTICE'), 'utf8');
      expect(notice).toMatch(/skills\/architecture\/SKILL\.md/);
    });
  });

  // The domain-model body survived the merge as a reference file, NOT as a
  // skill: a SKILL.md (or any frontmatter `name:`) under references/ would be
  // re-registered by the plugin loader, resurrecting the surface 4.0 retired.
  describe('domain-model merge — reference, not skill', () => {
    it('references/domain-model.md exists and carries no skill frontmatter', () => {
      const abs = path.join(repoRoot, 'skills/architecture/references/domain-model.md');
      expect(existsSync(abs), 'references/domain-model.md must exist').toBe(true);
      expect(readFileSync(abs, 'utf8').startsWith('---')).toBe(false);
    });

    it('the retired skill directories are gone', () => {
      for (const dir of ['skills/domain-model', 'skills/ubiquitous-language']) {
        expect(existsSync(path.join(repoRoot, dir)), `${dir} must not exist`).toBe(false);
      }
    });
  });
});
