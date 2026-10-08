/**
 * tests/rules/sec-id-uniqueness.test.mjs — issue #1521 item 4.
 *
 * SEC-NNN identifiers are numbered across two corpora: the always-on
 * `.claude/rules/security.md` and the path-scoped `rules/opt-in-stack/*.md`.
 * The bug this catches: **one SEC ID defined for two different rules**. Until
 * #1521, `rules/opt-in-stack/security-web.md` headed "CSRF Protection (SEC-005)"
 * while `security.md` defines SEC-005 as the Secrets Inventory — a citation of
 * "SEC-005" could mean either, and nothing noticed because each file is
 * internally consistent.
 *
 * A definition is a heading carrying the ID in parentheses —
 * `## CSRF Protection (SEC-018)` or `## Authentication (SEC-004: Auth-at-Boundary)`.
 * Mentions in body text are cross-references and are not counted.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const DEFINITION_RE = /^#{2,4}\s+.*\((SEC-\d{3})[):]/gm;

/**
 * Same rule, deeper in a stack file — not a second allocation. `backend.md`'s
 * "Canonical API Response Envelope (SEC-009)" is the server-side form of
 * `security.md`'s "Error Exposure (SEC-009)" and cites SEC-009 in its body.
 */
const SAME_RULE_EXTENSIONS = new Map([
  ['SEC-009', new Set(['.claude/rules/security.md', 'rules/opt-in-stack/backend.md'])],
]);

function corpusFiles() {
  const stack = readdirSync(join(REPO_ROOT, 'rules', 'opt-in-stack'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `rules/opt-in-stack/${f}`);
  return ['.claude/rules/security.md', ...stack];
}

describe('SEC rule IDs (#1521)', () => {
  it('defines every SEC ID in exactly one place, except declared same-rule extensions', () => {
    /** @type {Map<string, string[]>} id → files defining it */
    const definedIn = new Map();
    for (const rel of corpusFiles()) {
      const content = readFileSync(join(REPO_ROOT, rel), 'utf8');
      for (const m of content.matchAll(DEFINITION_RE)) {
        definedIn.set(m[1], [...(definedIn.get(m[1]) ?? []), rel]);
      }
    }
    expect(definedIn.size).toBeGreaterThan(10); // census sanity: the regex still matches

    const collisions = [...definedIn]
      .filter(([, files]) => files.length > 1)
      .filter(([id, files]) => {
        const allowed = SAME_RULE_EXTENSIONS.get(id);
        return !(allowed && files.length === allowed.size && files.every((f) => allowed.has(f)));
      })
      .map(([id, files]) => `${id}: ${files.join(', ')}`);
    expect(collisions).toEqual([]);
  });
});
