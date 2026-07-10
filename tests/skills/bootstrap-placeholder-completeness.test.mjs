// Regression guard for issue #794 Item 6 (P1-Note).
//
// `templates/_minimal/CLAUDE.md.tmpl` is the Public-Path Fast-tier synthesis
// source for Codex/Cursor bootstrap (see `skills/bootstrap/public-fallback.md`
// § "Public Path — Fast Tier" → "If PLATFORM = codex or PLATFORM = cursor").
// Every `{{PLACEHOLDER}}` token the template uses MUST have a matching
// substitution row in `public-fallback.md`'s Fast-tier substitution table —
// otherwise a real bootstrap run leaves the literal `{{TOKEN}}` string in the
// generated CLAUDE.md.
//
// This test computes the set of placeholders actually present in the
// template (never a hardcoded list) and asserts every one of them appears as
// a substitution key in public-fallback.md. The reverse direction (doc rows
// without a matching placeholder) is intentionally NOT asserted — aliases
// (e.g. `{{DESCRIPTION}}` alongside `{{PROJECT_DESCRIPTION}}`) are legitimate
// and a bidirectional check would be brittle.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

const TEMPLATE_PATH = path.join(repoRoot, 'templates', '_minimal', 'CLAUDE.md.tmpl');
const DOC_PATH = path.join(repoRoot, 'skills', 'bootstrap', 'public-fallback.md');

const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/g;

/** Extract the set of unique `{{TOKEN}}` placeholders present in `content`. */
function extractPlaceholders(content) {
  const matches = content.match(PLACEHOLDER_RE) ?? [];
  return new Set(matches);
}

describe('bootstrap placeholder completeness (issue #794 Item 6)', () => {
  it('every {{PLACEHOLDER}} in templates/_minimal/CLAUDE.md.tmpl has a substitution row in public-fallback.md', () => {
    const templateBody = readFileSync(TEMPLATE_PATH, 'utf8');
    const docBody = readFileSync(DOC_PATH, 'utf8');

    const templatePlaceholders = extractPlaceholders(templateBody);
    expect(templatePlaceholders.size).toBeGreaterThan(0);

    const missingFromDocTable = [...templatePlaceholders]
      .filter((token) => !docBody.includes(token))
      .sort();

    expect(
      missingFromDocTable,
      `These placeholders appear in templates/_minimal/CLAUDE.md.tmpl but have no ` +
        `substitution row in skills/bootstrap/public-fallback.md:\n  ${missingFromDocTable.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the template actually contains the expected placeholder tokens (sanity — not a stale/empty template)', () => {
    const templateBody = readFileSync(TEMPLATE_PATH, 'utf8');
    const templatePlaceholders = extractPlaceholders(templateBody);

    // A hand-picked sample of tokens that must always be present — guards
    // against the regex silently matching zero tokens due to a template
    // rewrite (e.g. switching to a different placeholder syntax).
    for (const expected of ['{{PROJECT_TITLE}}', '{{TEST_COMMAND}}', '{{PLAN_BASELINE_PATH}}']) {
      expect(templatePlaceholders.has(expected), `expected template to contain ${expected}`).toBe(true);
    }
  });
});
