// Sweep test for issue #33 — AGENTS.md alias coverage across skills/scripts/commands/hooks.
//
// Every file that mentions `CLAUDE.md` MUST also mention `AGENTS.md` (or be on
// the EXCEPTIONS list below). This enforces the alias rule documented in
// `skills/_shared/instruction-file-resolution.md`.
//
// NOTE: This test is expected to FAIL on initial commit (Wave 1). Wave 2 of
// issue #33 will sweep the ~32 offending files to drive it green. The failure
// output (offending file list) is the actionable todo for Wave 2.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

// Repo-relative paths that intentionally name CLAUDE.md only.
//
// Keep this list TIGHT. Default to adding `AGENTS.md` to the file instead of
// adding it here. Acceptable reasons for an exception:
//   - The file IS the SSOT for the alias rule itself (its filename / heading
//     references CLAUDE.md as the well-known name).
//   - Banner copy that intentionally names a single platform.
//   - Vendored upstream content that must not diverge from its source.
const EXCEPTIONS = new Set([
  // The alias-rule SSOT names both files exhaustively but its title /
  // navigation references CLAUDE.md as the canonical Claude-side name.
  // The doc DOES mention AGENTS.md throughout — listed here defensively in
  // case future edits trim it. Remove if AGENTS.md remains present.
  // 'skills/_shared/instruction-file-resolution.md',
]);

const SCAN_DIRS = ['skills', 'scripts', 'commands', 'hooks'];
const SCAN_EXTS = new Set(['.md', '.mjs', '.sh', '.js']);

/**
 * Recursively collect files under `dir` matching SCAN_EXTS.
 * Skips node_modules, .git, dist, build, coverage.
 */
function collectFiles(dir) {
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SCAN_EXTS.has(ext)) {
        try {
          if (statSync(full).size > 0) out.push(full);
        } catch {
          // skip unreadable
        }
      }
    }
  }
  return out;
}

describe('issue #33 — AGENTS.md alias coverage sweep', () => {
  it('every file referencing CLAUDE.md also references AGENTS.md (or is on the exception list)', () => {
    const offenders = [];

    for (const subdir of SCAN_DIRS) {
      const abs = path.join(repoRoot, subdir);
      const files = collectFiles(abs);
      for (const file of files) {
        const rel = path.relative(repoRoot, file);
        if (EXCEPTIONS.has(rel)) continue;
        let body;
        try {
          body = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (body.includes('CLAUDE.md') && !body.includes('AGENTS.md')) {
          offenders.push(rel);
        }
      }
    }

    // Sort for stable, diff-friendly output.
    offenders.sort();

    expect(
      offenders,
      `These files reference CLAUDE.md without AGENTS.md. Either add the alias mention or extend EXCEPTIONS in this test:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the alias-rule SSOT exists and names both file kinds', () => {
    const ssotPath = path.join(repoRoot, 'skills/_shared/instruction-file-resolution.md');
    const body = readFileSync(ssotPath, 'utf8');
    expect(body).toMatch(/CLAUDE\.md/);
    expect(body).toMatch(/AGENTS\.md/);
  });
});
