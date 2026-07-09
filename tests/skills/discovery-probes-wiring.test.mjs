// Wiring guard for the /discovery scope-enum + probe-category surface.
//
// scope-enum SSOT (#762): the canonical scope token set (code, infra, ui,
// arch, session, audit, vault, feature) lives in exactly ONE place -- the
// scope-arg line in `skills/discovery/SKILL.md`, marked with an inline
// "scope-enum SSOT (#762)" HTML comment directly above it. This test DERIVES
// SCOPE_TOKENS from that single canonical line at runtime (see
// `deriveScopeTokens()` below) instead of hand-maintaining a 10th copy of the
// same list here, then GUARDS that the derived set is mirrored across the
// other 8 tracked markdown surfaces (the scope-arg family, the
// discovery-probes config-doc family, and the gitlab-ops Category-field
// family) plus a per-category `skills/discovery/probes-<category>.md` file.
// Nothing previously caught a surface falling out of sync, or a probe file
// going missing/empty while still referenced from
// `skills/discovery/SKILL.md`.
//
// See issue #762 (single-source mechanism) and issue #753 (Epic #750,
// original 9-surface guard this mechanism hardens).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// ---------------------------------------------------------------------------
// Shared: derive the probe-category list from SKILL.md's Phase 3 dispatch
// bullets, rather than hardcoding it. This is what makes block 1 a genuine
// wiring guard: if a probe file is renamed/removed without updating the
// Phase 3 dispatch text (or vice versa), the derived list and the filesystem
// disagree and the test fails.
// ---------------------------------------------------------------------------

const skillMdContent = readFileSync(join(REPO_ROOT, 'skills/discovery/SKILL.md'), 'utf8');

function extractPhase3DispatchBody(content) {
  const startMarker = '## Phase 3: Probe Execution';
  const endMarker = '## Phase 4: Verification & Scoring';
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Could not locate the Phase 3 dispatch section in skills/discovery/SKILL.md');
  }
  return content.slice(start, end);
}

function deriveCategoriesFromDispatchBullets(dispatchBody) {
  const categories = new Set();

  // (a) explicit `probes-<name>.md` filename mentions -- catches categories
  // whose dispatch bullet names the file directly (vault, supply-chain,
  // feature).
  for (const match of dispatchBody.matchAll(/probes-([a-z][a-z-]*)\.md/g)) {
    // probes-intro.md is explicitly documented in the same dispatch bullet
    // ("`probes-intro.md` (confidence scoring reference)") as the SHARED
    // reference doc every probe agent also receives -- not a per-category
    // probe file, and it carries no "## Category:" header of its own.
    if (match[1] === 'intro') continue;
    categories.add(match[1]);
  }

  // (b) bullet-prose mentions of the form "- **<Name> probes agent**" --
  // catches categories dispatched WITHOUT a probes-<name>.md filename token
  // in the Phase 3 text (code, infra, ui, arch, session, audit). Filename
  // extraction (a) alone misses 6 of 9 real probe files -- this is the union
  // that closes that gap.
  for (const match of dispatchBody.matchAll(/\*\*([A-Za-z][A-Za-z-]*) probes agent\*\*/g)) {
    categories.add(match[1].toLowerCase());
  }

  return [...categories].sort();
}

const phase3DispatchBody = extractPhase3DispatchBody(skillMdContent);
const dispatchedCategories = deriveCategoriesFromDispatchBullets(phase3DispatchBody);

describe('probes-<category>.md existence & anatomy', () => {
  it('derives at least 8 categories from the Phase 3 dispatch bullets (floor, not exact)', () => {
    expect(dispatchedCategories.length).toBeGreaterThanOrEqual(8);
  });

  it.each(dispatchedCategories)(
    'probes-%s.md exists, is non-empty, and declares a matching Category header',
    (category) => {
      const probePath = join(REPO_ROOT, `skills/discovery/probes-${category}.md`);
      expect(existsSync(probePath)).toBe(true);

      const content = readFileSync(probePath, 'utf8');
      expect(content.trim().length).toBeGreaterThan(0);
      expect(content).toContain('## Category: `' + category + '`');
    },
  );

  it('probes-feature.md exists and has 3+ probes (floor/ceiling — testing.md § Dynamic Artifact Counts)', () => {
    const content = readFileSync(join(REPO_ROOT, 'skills/discovery/probes-feature.md'), 'utf8');
    const probeHeadings = content.match(/^### Probe:/gm) || [];
    // Floor 3 (intent-drift, stubbed-dead-feature, feature-request-cluster #757);
    // ceiling 10 catches accidental duplication loops.
    expect(probeHeadings.length).toBeGreaterThanOrEqual(3);
    expect(probeHeadings.length).toBeLessThanOrEqual(10);
  });

  it('probes-docs.md exists and has 1 probe (docs-staleness)', () => {
    const content = readFileSync(join(REPO_ROOT, 'skills/discovery/probes-docs.md'), 'utf8');
    const probeHeadings = content.match(/^### Probe:/gm) || [];
    expect(probeHeadings.length).toBe(1);
    expect(content).toContain('### Probe: docs-staleness');
  });

  it('skills/discovery/probes/docs-staleness.mjs exists and exports runProbe', () => {
    const probeFilePath = join(REPO_ROOT, 'skills/discovery/probes/docs-staleness.mjs');
    expect(existsSync(probeFilePath)).toBe(true);
    const content = readFileSync(probeFilePath, 'utf8');
    expect(content).toContain('export async function runProbe');
  });
});

// ---------------------------------------------------------------------------
// Block 2 + 3: scope-enum consistency across the 9 tracked surfaces.
//
// 1 canonical source (skills/discovery/SKILL.md's scope-arg line, marked with
// the "scope-enum SSOT (#762)" comment) + 8 guarded mirror surfaces. The
// canonical surface is still listed in TRACKED_SURFACES below -- checking it
// against SCOPE_TOKENS derived FROM ITSELF is a trivial/vacuous pass, kept
// for symmetry with the other 8 real guards.
// ---------------------------------------------------------------------------

const TRACKED_SURFACES = [
  'skills/discovery/SKILL.md',
  'commands/discovery.md',
  'pi/prompts/discovery.md',
  '.cursor/rules/040-discovery.mdc',
  'docs/session-config-template.md',
  'docs/session-config-reference.md',
  'docs/USER-GUIDE.md',
  'skills/gitlab-ops/SKILL.md',
  '.cursor/rules/070-gitlab-ops.mdc',
];

// Derives SCOPE_TOKENS from the canonical scope-enum line in SKILL.md at
// runtime, rather than hand-maintaining a 10th hardcoded copy of the same
// list here (the pre-#762 state of this file). Anchors on the SSOT comment
// first (constraining the search so a stray same-pattern match elsewhere in
// the file can never win); falls back to a bare pattern search across the
// whole file if the comment marker itself has drifted or gone missing.
const SCOPE_ENUM_SSOT_MARKER = 'scope-enum SSOT (#762)';
const SCOPE_ENUM_LINE_PATTERN = /The `scope` argument accepts:([^\n]*)/;

function deriveScopeTokens(skillMdText) {
  const ssotIdx = skillMdText.indexOf(SCOPE_ENUM_SSOT_MARKER);
  const searchScope = ssotIdx === -1 ? skillMdText : skillMdText.slice(ssotIdx);
  const lineMatch = searchScope.match(SCOPE_ENUM_LINE_PATTERN);
  if (!lineMatch) {
    throw new Error(
      'canonical scope line not found/parsable -- check skills/discovery/SKILL.md SSOT marker ' +
        '(expected a line matching "The `scope` argument accepts:" near the "' +
        SCOPE_ENUM_SSOT_MARKER +
        '" comment)',
    );
  }

  // The enum line also carries a trailing formatting example ("...or
  // comma-separated like `code,session`.") -- strip everything from that
  // marker onward before token extraction, so the compound example isn't
  // mistaken for a scope token in its own right.
  let enumPortion = lineMatch[1];
  const exampleMarkerIdx = enumPortion.indexOf('comma-separated like');
  if (exampleMarkerIdx !== -1) {
    enumPortion = enumPortion.slice(0, exampleMarkerIdx);
  }

  const rawTokens = [...enumPortion.matchAll(/`([a-z][a-z-]*)`/g)].map((m) => m[1]);
  // `all` is a meta-token (the default/wildcard), not a discovery-probe
  // scope category -- exclude it from the derived enum.
  const derived = [...new Set(rawTokens)].filter((token) => token !== 'all');

  // Sanity-gate the derivation itself: a broken anchor/marker must fail LOUD
  // (a clear error) rather than silently producing an empty or nonsensical
  // token set that would make every downstream assertion vacuously pass.
  if (derived.length < 5 || derived.length > 20 || !derived.includes('feature') || !derived.includes('code')) {
    throw new Error(
      'canonical scope line not found/parsable -- check skills/discovery/SKILL.md SSOT marker ' +
        '(derived token set failed sanity bounds: ' +
        JSON.stringify(derived) +
        ')',
    );
  }

  return derived;
}

const SCOPE_TOKENS = deriveScopeTokens(skillMdContent);

// Extracts every line in `content` containing `marker`, joined with '\n'.
// Throws if zero lines match -- a failed extraction (the surface was
// reworded/restructured and the marker no longer appears) must be a loud
// test failure, never a silent empty string that would make every token
// assertion vacuously pass or vacuously fail on that surface.
function extractLinesContaining(content, marker, surfaceLabel) {
  const lines = content.split('\n').filter((line) => line.includes(marker));
  if (lines.length === 0) {
    throw new Error(
      `Line extractor for "${surfaceLabel}" found zero lines containing "${marker}" -- ` +
        'the extraction target likely drifted (surface reworded/restructured); update the extractor.',
    );
  }
  return lines.join('\n');
}

// One extractor per tracked surface, isolating ONLY the line(s) that carry
// the scope enum -- never the whole file. Scanning whole-file content is
// unsound: every scope token (code, ui, arch, feature, ...) is also an
// ordinary English word, so on a 1000+ line doc the token is virtually
// guaranteed to appear somewhere unrelated, masking a real single-row
// regression in the actual enum line (demonstrated: stripping `feature`
// from ONLY docs/session-config-reference.md:86 still "passed" a whole-file
// scan, because `feature` occurs 25 times elsewhere in that file).
const SURFACE_LINE_EXTRACTORS = {
  'skills/discovery/SKILL.md': (content) =>
    extractLinesContaining(content, 'The `scope` argument accepts', 'skills/discovery/SKILL.md'),
  'commands/discovery.md': (content) =>
    [
      extractLinesContaining(content, 'argument-hint:', 'commands/discovery.md'),
      extractLinesContaining(content, 'Valid scopes:', 'commands/discovery.md'),
    ].join('\n'),
  'pi/prompts/discovery.md': (content) =>
    extractLinesContaining(content, 'argument-hint:', 'pi/prompts/discovery.md'),
  '.cursor/rules/040-discovery.mdc': (content) =>
    extractLinesContaining(content, 'Scope accepts:', '.cursor/rules/040-discovery.mdc'),
  'docs/session-config-template.md': (content) =>
    extractLinesContaining(content, 'discovery-probes', 'docs/session-config-template.md'),
  'docs/session-config-reference.md': (content) =>
    extractLinesContaining(content, 'discovery-probes', 'docs/session-config-reference.md'),
  'docs/USER-GUIDE.md': (content) => extractLinesContaining(content, 'discovery-probes', 'docs/USER-GUIDE.md'),
  'skills/gitlab-ops/SKILL.md': (content) =>
    extractLinesContaining(content, '**Category:**', 'skills/gitlab-ops/SKILL.md'),
  '.cursor/rules/070-gitlab-ops.mdc': (content) =>
    extractLinesContaining(content, '**Category:**', '.cursor/rules/070-gitlab-ops.mdc'),
};

function loadSurfaceContents(repoRoot, relativePaths) {
  const map = new Map();
  for (const rel of relativePaths) {
    const fullContent = readFileSync(join(repoRoot, rel), 'utf8');
    const extractor = SURFACE_LINE_EXTRACTORS[rel];
    map.set(rel, extractor(fullContent));
  }
  return map;
}

// Within the extracted line(s), the enum is always rendered with one of
// three delimiter shapes: backtick-wrapped (`` `code` ``), pipe-delimited
// (`<code|...`, `...|feature>`, `| code |`), or a bare comma-separated word
// list ("... code, infra, ..."). This matcher requires one of those
// delimiter shapes on at least one side of the token — tolerant of the exact
// punctuation each surface happens to use, but precise enough not to match
// the token appearing as a substring of unrelated prose within the same
// line(s).
function tokenPattern(token) {
  return new RegExp(
    '(`' + token + '`)' + // `token`
      '|(\\|\\s*' + token + '\\b)' + // |token / | token
      '|(\\b' + token + '\\s*\\|)' + // token| / token |
      '|(,\\s*' + token + '\\b)', // , token
  );
}

function surfacesMissingToken(contentsMap, token) {
  const pattern = tokenPattern(token);
  const missing = [];
  for (const [surface, content] of contentsMap) {
    if (!pattern.test(content)) missing.push(surface);
  }
  return missing;
}

const surfaceContents = loadSurfaceContents(REPO_ROOT, TRACKED_SURFACES);

describe('scope-enum consistency across tracked surfaces', () => {
  it.each(SCOPE_TOKENS)('token "%s" appears on every tracked surface', (token) => {
    expect(surfacesMissingToken(surfaceContents, token)).toEqual([]);
  });
});

describe('fake-regression (guard bites)', () => {
  // GREEN baseline — same helper, same tokens, real extracted-line content.
  // Proves the RED cases below are exercising real drift, not a helper that
  // always reports "missing".
  it('GREEN baseline: no surface is missing the "feature" token', () => {
    expect(surfacesMissingToken(surfaceContents, 'feature')).toEqual([]);
  });

  // These RED cases strip the token from the EXTRACTED enum line(s) — the
  // realistic failure mode (someone edits the single row and drops a
  // token) — not from a whole-file copy. That is what proves the guard
  // survived the FIX-C false-positive: a whole-file scan let this exact
  // single-row strip pass silently because the token still occurred 25
  // times elsewhere in the file's unrelated prose.
  it('RED path (guard bites): reports the surface when "feature" is stripped from its extracted enum line', () => {
    const mutated = new Map(surfaceContents);
    const target = 'skills/discovery/SKILL.md';
    mutated.set(target, surfaceContents.get(target).split('feature').join(''));

    expect(surfacesMissingToken(mutated, 'feature')).toEqual([target]);
  });

  it('RED path (guard bites): reports a different surface when "vault" is stripped from its extracted enum line', () => {
    const mutated = new Map(surfaceContents);
    const target = 'docs/USER-GUIDE.md';
    mutated.set(target, surfaceContents.get(target).split('vault').join(''));

    expect(surfacesMissingToken(mutated, 'vault')).toEqual([target]);
  });
});

// ---------------------------------------------------------------------------
// Block 4: probe-file count sanity (floor/ceiling — Dynamic Artifact Counts
// carve-out in .claude/rules/testing.md; this set is expected to grow as new
// probe categories are added, so it is never pinned to an exact count).
// ---------------------------------------------------------------------------

describe('phase-4.2 dual verification path (#757 — prose-existence guard)', () => {
  it('SKILL.md documents the vcs-issue verification_method branch', () => {
    const skillMd = readFileSync(join(REPO_ROOT, 'skills/discovery/SKILL.md'), 'utf8');
    expect(skillMd).toContain('verification_method: vcs-issue');
  });
});

describe('probe-file count sanity', () => {
  it('skills/discovery/ has between 8 and 50 probes-*.md files (excluding probes-intro.md)', () => {
    const probeFiles = readdirSync(join(REPO_ROOT, 'skills/discovery')).filter(
      (name) => /^probes-.*\.md$/.test(name) && name !== 'probes-intro.md',
    );

    expect(probeFiles.length).toBeGreaterThanOrEqual(8);
    expect(probeFiles.length).toBeLessThanOrEqual(50);
  });
});
