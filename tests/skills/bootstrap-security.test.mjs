/**
 * tests/skills/bootstrap-security.test.mjs
 *
 * Regression tests for bootstrap security hardening (#108 LOW-severity follow-ups):
 *   Finding 1 — atomic bootstrap.lock write (mktemp + mv) in fast/standard/deep templates
 *   Finding 2 — claude init overwrite guard ([[ ! -f CLAUDE.md ]]) in public-fallback + fast-template
 *   Finding 3 — cp -rP (no-dereference) symlink-traversal fix in public-fallback Standard tier
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// ─── Finding 1: Atomic lock-file write ───────────────────────────────────────

describe('Finding 1 — atomic bootstrap.lock write (#108)', () => {
  it.each(['fast-template.md', 'standard-template.md', 'deep-template.md'])(
    '%s uses mktemp + mv for bootstrap.lock',
    (template) => {
      const body = read(`skills/bootstrap/${template}`);
      // Must use mktemp to create a temp file in the same directory.
      expect(body).toMatch(/mktemp "\$REPO_ROOT\/\.orchestrator\/bootstrap\.lock\./);
      // Must rename atomically.
      expect(body).toMatch(/mv "\$_LOCK_TMP" "\$REPO_ROOT\/\.orchestrator\/bootstrap\.lock"/);
      // Must NOT write directly to the final path with a plain redirect.
      expect(body).not.toMatch(/^cat > "\$REPO_ROOT\/\.orchestrator\/bootstrap\.lock"/m);
    },
  );
});

// ─── Finding 2: claude init overwrite guard ──────────────────────────────────

describe('Finding 2 — claude init overwrite guard (#108)', () => {
  it('public-fallback.md Fast Tier guards claude init with [[ ! -f CLAUDE.md ]] check', () => {
    const body = read('skills/bootstrap/public-fallback.md');
    // Guard must exist before the claude init call
    expect(body).toMatch(/\[\[ ! -f "\$REPO_ROOT\/CLAUDE\.md" \]\]/);
    // claude init must still appear (just now guarded)
    expect(body).toMatch(/claude init/);
  });
});

// ─── Finding 3: cp -rP symlink-traversal fix ─────────────────────────────────

describe('Finding 3 — cp symlink-traversal fix (#108)', () => {
  it('public-fallback.md Standard tier uses cp -rP instead of cp -r', () => {
    const body = read('skills/bootstrap/public-fallback.md');
    // Must use -P flag (no-dereference) for template copy
    expect(body).toMatch(/cp -rP "\$TMPL_DIR\/\." "\$REPO_ROOT\/"/);
    // Must NOT use bare cp -r for the template copy line (guard against regression).
    expect(body).not.toMatch(/cp -r(?!P) "\$TMPL_DIR\/\." "\$REPO_ROOT\/"/);
  });
});
