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
  it('fast-template.md uses mktemp + mv for bootstrap.lock', () => {
    const body = read('skills/bootstrap/fast-template.md');
    // Must use mktemp to create a temp file in the same directory
    expect(body).toMatch(/mktemp "\$REPO_ROOT\/\.orchestrator\/bootstrap\.lock\./);
    // Must rename atomically
    expect(body).toMatch(/mv "\$_LOCK_TMP" "\$REPO_ROOT\/\.orchestrator\/bootstrap\.lock"/);
    // Must NOT write directly to the final path with a plain redirect
    expect(body).not.toMatch(/^cat > "\$REPO_ROOT\/\.orchestrator\/bootstrap\.lock"/m);
  });

  it('standard-template.md uses mktemp + mv for bootstrap.lock', () => {
    const body = read('skills/bootstrap/standard-template.md');
    expect(body).toMatch(/mktemp "\$REPO_ROOT\/\.orchestrator\/bootstrap\.lock\./);
    expect(body).toMatch(/mv "\$_LOCK_TMP" "\$REPO_ROOT\/\.orchestrator\/bootstrap\.lock"/);
    expect(body).not.toMatch(/^cat > "\$REPO_ROOT\/\.orchestrator\/bootstrap\.lock"/m);
  });

  it('deep-template.md uses mktemp + mv for bootstrap.lock', () => {
    const body = read('skills/bootstrap/deep-template.md');
    expect(body).toMatch(/mktemp "\$REPO_ROOT\/\.orchestrator\/bootstrap\.lock\./);
    expect(body).toMatch(/mv "\$_LOCK_TMP" "\$REPO_ROOT\/\.orchestrator\/bootstrap\.lock"/);
    expect(body).not.toMatch(/^cat > "\$REPO_ROOT\/\.orchestrator\/bootstrap\.lock"/m);
  });
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

  it('fast-template.md documents the claude init overwrite guard', () => {
    const body = read('skills/bootstrap/fast-template.md');
    // fast-template defers to public-fallback but must document the guard
    expect(body).toMatch(/claude init.*overwrite guard|overwrite guard.*claude init/i);
  });
});

// ─── Finding 3: cp -rP symlink-traversal fix ─────────────────────────────────

describe('Finding 3 — cp symlink-traversal fix (#108)', () => {
  it('public-fallback.md Standard tier uses cp -rP instead of cp -r', () => {
    const body = read('skills/bootstrap/public-fallback.md');
    // Must use -P flag (no-dereference) for template copy
    expect(body).toMatch(/cp -rP "\$TMPL_DIR\/\." "\$REPO_ROOT\/"/);
    // Must NOT use bare cp -r for the template copy line (guard against regression)
    // (The line with -rP is correct; bare cp -r without P would be a regression)
    const templateCopyLines = body
      .split('\n')
      .filter(l => l.includes('cp -r') && l.includes('TMPL_DIR') && l.includes('REPO_ROOT'));
    // Every template-copy line must use -rP
    for (const line of templateCopyLines) {
      expect(line).toMatch(/cp -rP/);
    }
  });

  it('public-fallback.md documents the symlink-traversal rationale', () => {
    const body = read('skills/bootstrap/public-fallback.md');
    // Must explain why -P is used
    expect(body).toMatch(/symlink|no-dereference|CWE-22/i);
  });
});
