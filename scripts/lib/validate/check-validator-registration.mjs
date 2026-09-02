#!/usr/bin/env node
/**
 * check-validator-registration.mjs — every `scripts/lib/validate/check-*.mjs`
 * must be referenced by basename from at least one of the three surfaces
 * that actually RUN a validator (`scripts/validate-plugin.mjs`,
 * `.husky/pre-commit`, `.gitlab-ci.yml`), or declare itself deliberately
 * standalone. #1184.
 *
 * THE CLASS. A checker with real detection logic and zero callers is built
 * work nobody ever runs — this repo's own `check-unwired-features.mjs`
 * census exists for a sibling shape of the same problem (config keys nobody
 * reads); this checker is that same discipline applied to the checkers
 * directory itself. `scripts/validate-plugin.mjs` is the canonical local
 * runner (`runCheck('check-foo.mjs')`); `.husky/pre-commit` and
 * `.gitlab-ci.yml` are the two OTHER surfaces some checkers wire into
 * directly instead of (or in addition to) the orchestrator —
 * `check-owner-leakage.mjs`, `check-test-fixture-shapes.mjs` and
 * `check-test-value-bans.mjs` all do this (verified live at HEAD 2ccea0f2).
 *
 * OPT-OUT. A checker that is deliberately CLI-only (invoked by a human or a
 * different tool, never by these three surfaces) declares itself with a
 * header-comment marker: `// registration: standalone <reason>`. The marker
 * makes the checker report PASS as "standalone", not merely silence a
 * warning — the same shape of inline self-declared exemption
 * `check-untracked-test-deps.mjs`'s `IGNORE_MARKER` and
 * `check-dead-bridge.mjs`'s `:ignore` marker already use in this directory.
 *
 * ORACLE. A plain substring match of the checker's own basename (e.g.
 * `"check-foo.mjs"`) against the COMMENT-STRIPPED text of the three surface
 * files — the same granularity `runCheck('check-foo.mjs')` calls and
 * `.husky`/CI script lines already use to name a checker. MEASURED (HEAD
 * 2ccea0f2, all 33 live `check-*.mjs` basenames): zero basenames are a
 * substring of another, so this match cannot cross-attribute one checker's
 * registration to a different one.
 *
 * COMMENT-STRIPPING (HIGH, qa review, #1184 FX-C). A basename referenced
 * ONLY inside a `//`/`#` line comment or a `/* *\/` block comment is NOT a
 * real registration — the surface text is stripped of comments (quote-aware,
 * so a `#`/`//` INSIDE a string — a URL fragment, a shell parameter
 * expansion `${VAR#pattern}` — is never mistaken for a comment start) before
 * matching. MEASURED before this fix: a fixture whose only reference to
 * `check-ghost.mjs` sat in `// runCheck('check-ghost.mjs'); // DISABLED`
 * reported `registered: true` (exit 0) — commenting a checker OUT silently
 * kept it PASSing. `scripts/validate-plugin.mjs` uses `//`+`/* *\/` (js);
 * `.husky/pre-commit` and `.gitlab-ci.yml` use `#` (sh/yaml) — see
 * {@link commentStyleForSurface}. The checker's OWN
 * `// registration: standalone` header marker is read from the CHECKER file
 * directly (never from a surface text) and is unaffected by this stripping.
 *
 * NAMED CEILING (BV-004): a checker referenced only in prose (a `.md` doc, a
 * skill body) and nowhere in the three RUN surfaces above still reports
 * UNREGISTERED — being documented is not being run. REVISIT if a fourth run
 * surface (a new CI job file, a different git hook) is ever added: extend
 * `RUN_SURFACES`, do not special-case it here. The comment stripper's own
 * quote-tracking is a single flat state — an escaped quote (`\"`) inside a
 * double-quoted string is not honoured, and a template-literal's `${...}`
 * interpolation is not walked separately. Both failure directions lean
 * toward treating MORE text as "inside a string" than a real parser would,
 * which can only make the stripper MISS a comment (false "still
 * registered"), never manufacture a false UNREGISTERED — the direction this
 * checker's own false-positive history (the paragraph above) already
 * measured as the live hazard.
 *
 * Usage: check-validator-registration.mjs <repo-root>
 * Output: `  PASS: …` / `  FAIL: …` lines (two leading spaces), then
 * `Results: N passed, M failed`. Exit 0 = every checker registered or
 * standalone, 1 = at least one unregistered checker, 2 = tool error.
 *
 * Import-safety: importing this module MUST NOT execute anything — the
 * isMain guard at the bottom is the only side-effecting path.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listRepoFiles } from './repo-files.mjs';

/** Marker line inside a checker's own header — declares deliberate CLI-only status. */
export const STANDALONE_MARKER = /^\s*\/\/\s*registration:\s*standalone\b(?:\s+(.*))?$/m;

/** The three surfaces that actually RUN a validator (not merely mention it). */
const RUN_SURFACES = Object.freeze([
  path.join('scripts', 'validate-plugin.mjs'),
  path.join('.husky', 'pre-commit'),
  path.join('.gitlab-ci.yml'),
]);

const VALIDATE_DIR_REL = path.join('scripts', 'lib', 'validate');

/**
 * Comment style for a RUN_SURFACES path, keyed on extension rather than
 * position — avoids a silent index-drift if `RUN_SURFACES` is ever
 * reordered. `.mjs` gets JS-shaped comments (`//`, `/* *\/`, quotes
 * `'`/`"`/`` ` ``); everything else (`.husky/pre-commit` has no extension,
 * `.gitlab-ci.yml`) gets shell/YAML-shaped comments (`#` only, quotes
 * `'`/`"`).
 *
 * @param {string} rel repo-relative surface path
 * @returns {{lineComment: string, blockComment: boolean, quoteChars: string[]}}
 */
function commentStyleForSurface(rel) {
  return rel.endsWith('.mjs')
    ? { lineComment: '//', blockComment: true, quoteChars: ['"', "'", '`'] }
    : { lineComment: '#', blockComment: false, quoteChars: ['"', "'"] };
}

/**
 * Strip comments from `text` so a checker basename mentioned only inside a
 * comment is never read as a real registration. Quote-aware: walks `'`/`"`
 * (and, for the js style, `` ` ``) spans without inspecting their contents,
 * so a comment marker INSIDE a string (a URL fragment `#frag`, a shell
 * parameter expansion `${VAR#pattern}`) is left untouched rather than
 * truncating the line early. See the header NAMED CEILING for what this
 * quote-tracking deliberately does not attempt.
 *
 * @param {string} text
 * @param {{lineComment: string, blockComment: boolean, quoteChars: string[]}} style
 * @returns {string}
 */
export function stripComments(text, { lineComment, blockComment, quoteChars }) {
  let out = '';
  let i = 0;
  let inQuote = null;
  while (i < text.length) {
    const ch = text[i];
    if (inQuote) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === inQuote) inQuote = null;
      i += 1;
      continue;
    }
    if (quoteChars.includes(ch)) {
      inQuote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (blockComment && ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith(lineComment, i)) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl; // keep the newline itself, drop the comment text
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * @typedef {{basename: string, registered: boolean, standalone: boolean, surfaces: string[]}} RegistrationResult
 */

/**
 * @param {string} repoRoot
 * @returns {RegistrationResult[]} sorted by basename
 */
export function scanValidatorRegistration(repoRoot) {
  const checkerFiles = listRepoFiles(repoRoot, { dirs: [VALIDATE_DIR_REL], exts: ['mjs'] }).filter(
    (f) => /^check-.*\.mjs$/.test(path.basename(f)),
  );

  // Comment-stripped before matching (HIGH, #1184 FX-C): a basename
  // referenced only inside a `//`/`#`/`/* *\/` comment is NOT a real
  // registration — see the header's COMMENT-STRIPPING paragraph.
  const surfaceTexts = RUN_SURFACES.map((rel) => {
    const abs = path.join(repoRoot, rel);
    try {
      const raw = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
      return stripComments(raw, commentStyleForSurface(rel));
    } catch {
      return '';
    }
  });

  /** @type {RegistrationResult[]} */
  const results = [];
  for (const abs of checkerFiles) {
    const basename = path.basename(abs);
    let source = '';
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      /* unreadable — no marker can be found, no surface reference can save it either */
    }
    const standalone = STANDALONE_MARKER.test(source);
    const surfaces = RUN_SURFACES.filter((_, i) => surfaceTexts[i].includes(basename));
    results.push({ basename, registered: surfaces.length > 0, standalone, surfaces });
  }
  return results.sort((a, b) => a.basename.localeCompare(b.basename));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Run the check against a repo root, printing the validate-plugin line
 * vocabulary.
 *
 * @param {string} repoRoot
 * @returns {number} 0 = every checker registered or standalone, 1 = finding(s), 2 = tool error
 */
export function runCheckValidatorRegistration(repoRoot) {
  console.log('--- Check: validator registration (check-*.mjs must be wired or standalone) ---');

  const results = scanValidatorRegistration(repoRoot);
  let pass = 0;
  let fail = 0;

  for (const r of results) {
    if (r.standalone) {
      console.log(`  PASS: ${r.basename} — declared standalone (registration: standalone)`);
      pass += 1;
    } else if (r.registered) {
      console.log(`  PASS: ${r.basename} — referenced in ${r.surfaces.join(', ')}`);
      pass += 1;
    } else {
      console.log(
        `  FAIL: ${r.basename} — referenced by NEITHER scripts/validate-plugin.mjs, .husky/pre-commit, NOR .gitlab-ci.yml, and carries no "registration: standalone" marker`,
      );
      fail += 1;
    }
  }

  console.log('');
  console.log(`Results: ${pass} passed, ${fail} failed`);
  return fail > 0 ? 1 : 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const root = process.argv[2];
  if (!root) {
    console.error('Usage: check-validator-registration.mjs <repo-root>');
    process.exit(2);
  }
  process.exit(runCheckValidatorRegistration(path.resolve(root)));
}
