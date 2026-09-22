/**
 * tests/lib/validate/check-hook-entry-guards.test.mjs
 *
 * Tests for scripts/lib/validate/check-hook-entry-guards.mjs (#1422) — the
 * recurrence guard for #1393.
 *
 * THE BUG THE WHOLE FILE IS ABOUT: a newly added (or reverted) hook that is
 * REGISTERED in a platform manifest but runs its handler at module top level.
 * A bare `import()` of such a file executes the handler, and — when the
 * profile gate also sits at top level — calls `process.exit(0)` on the
 * IMPORTING process. `check-entry-guard.mjs` (#1371) cannot see this class at
 * all: its oracle only inspects statement fragments that already mention the
 * invocation path, so a file with NO guard passes it trivially. The second
 * test below proves that complementarity on one shared fixture rather than
 * asserting it in prose.
 *
 *   0 = clean · 1 = finding(s) · 2 = tool error (incl. an empty census)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  analyzeHookSource,
  collectRegisteredHooks,
  scanHookEntryGuards,
  runCheckHookEntryGuards,
  MANIFESTS,
} from '@lib/validate/check-hook-entry-guards.mjs';
import { findFragileGuards } from '@lib/validate/check-entry-guard.mjs';

// The repo root is derived from this file's own URL, never from
// `process.cwd()`: the pre-push gate materialises the tree under $TMPDIR, so a
// cwd-derived root would silently measure the wrong checkout.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-hook-entry-guards.mjs');

const tmpRoots = [];

/**
 * Build a tmp repo root: `files` maps a path under `hooks/` to its source,
 * and every one of them is registered in a synthetic `hooks/hooks.json`
 * unless `manifest` is given explicitly.
 */
function makeFixture(files, manifest) {
  const root = mkdtempSync(join(tmpdir(), 'check-hook-entry-guards-'));
  tmpRoots.push(root);
  mkdirSync(join(root, 'hooks'), { recursive: true });
  for (const [rel, source] of Object.entries(files)) {
    const abs = join(root, 'hooks', rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, source, 'utf8');
  }
  const json =
    manifest ??
    {
      hooks: {
        Stop: [
          {
            hooks: Object.keys(files).map((rel) => ({
              type: 'command',
              command: `sh "$CLAUDE_PLUGIN_ROOT/hooks/run-node.sh" "$CLAUDE_PLUGIN_ROOT/hooks/${rel}"`,
            })),
          },
        ],
      },
    };
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify(json, null, 2), 'utf8');
  return root;
}

function run(repoRoot, ...args) {
  return spawnSync('node', [SCRIPT, repoRoot, ...args], { encoding: 'utf8', timeout: 20_000 });
}

/** A hook body with NO entry guard at all — the #1393 shape. */
const UNGUARDED = `
import { shouldRunHook } from './_lib/profile-gate.mjs';
async function main() { process.stdout.write('{}'); }
if (!shouldRunHook('demo')) process.exit(0);
main().catch(() => {}).finally(() => process.exit(0));
`;

/** The correct tail: guard first, profile gate inside it. */
const GUARDED = `
import { isMainModule } from '../scripts/lib/is-main-module.mjs';
import { shouldRunHook } from './_lib/profile-gate.mjs';
async function main() { process.stdout.write('{}'); }
if (isMainModule(import.meta.url)) {
  if (!shouldRunHook('demo')) process.exit(0);
  main().catch(() => {}).finally(() => process.exit(0));
}
`;

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The live repo
// ---------------------------------------------------------------------------

describe('against the live repository', () => {
  it('every manifest-registered hook is guarded — the #1393 sweep does not silently regress', () => {
    const { findings, toolErrors, registered, guarded } = scanHookEntryGuards(REPO_ROOT);
    expect(toolErrors).toEqual([]);
    expect(findings).toEqual([]);
    expect(registered.length).toBeGreaterThan(0);
    expect(guarded).toBe(registered.length);
  });

  it('runCheckHookEntryGuards returns 0 in-process (importing the module runs nothing)', () => {
    expect(runCheckHookEntryGuards(REPO_ROOT)).toBe(0);
  });

  it('the census is the UNION of all four manifests, so a foreign-only hook cannot fall out', () => {
    const { files, manifests } = collectRegisteredHooks(REPO_ROOT);
    expect(manifests.map((m) => m.rel)).toEqual([...MANIFESTS]);
    expect(manifests.every((m) => m.present)).toBe(true);
    // Every foreign-manifest hook is also in the census (subset or not).
    expect(files).toContain('hooks/on-stop.mjs');
    expect(files.every((f) => f.startsWith('hooks/') && f.endsWith('.mjs'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The gap check-entry-guard leaves open
// ---------------------------------------------------------------------------

describe('missing-entry-guard — the class check-entry-guard passes trivially', () => {
  it('flags a registered hook whose main() runs at module top level with no guard', () => {
    const root = makeFixture({ 'demo.mjs': UNGUARDED });
    const { findings } = scanHookEntryGuards(root);
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain('missing-entry-guard');
    expect(findings.every((f) => f.file === 'hooks/demo.mjs')).toBe(true);
    expect(run(root).status).toBe(1);
  });

  it('check-entry-guard reports ZERO on the identical source — the two checkers are complements', () => {
    // Same bytes, both oracles. findFragileGuards judges the FORM of a guard
    // that exists; with no guard present it has nothing to judge, which is
    // exactly why #1393 needed a second checker.
    expect(findFragileGuards(UNGUARDED)).toEqual([]);
    expect(analyzeHookSource(UNGUARDED, 'hooks/demo.mjs').findings.length).toBeGreaterThan(0);
  });

  it('flags a SECOND main() call outside an otherwise-correct guard', () => {
    const source = `${GUARDED}\nmain();\n`;
    const { findings } = analyzeHookSource(source, 'hooks/demo.mjs');
    expect(findings.map((f) => f.kind)).toEqual(['missing-entry-guard']);
    expect(findings[0].line).toBeGreaterThan(1);
  });

  it('names the exact target form and the reason in the remedy — no second file to open', () => {
    const { findings } = analyzeHookSource(UNGUARDED, 'hooks/demo.mjs');
    const detail = findings.map((f) => f.detail).join('\n');
    expect(detail).toContain('isMainModule(import.meta.url)');
    expect(detail).toContain("shouldRunHook('demo')");
  });
});

// ---------------------------------------------------------------------------
// toplevel-profile-exit
// ---------------------------------------------------------------------------

describe('toplevel-profile-exit', () => {
  it('flags a top-level shouldRunHook()+process.exit — it kills the IMPORTING process', () => {
    const source = `
import { isMainModule } from '../scripts/lib/is-main-module.mjs';
import { shouldRunHook } from './_lib/profile-gate.mjs';
async function main() {}
if (!shouldRunHook('demo')) process.exit(0);
if (isMainModule(import.meta.url)) { main(); }
`;
    const { findings } = analyzeHookSource(source, 'hooks/demo.mjs');
    expect(findings.map((f) => f.kind)).toEqual(['toplevel-profile-exit']);
  });

  it('does NOT flag the gate when it sits inside the entry guard (the #1393 fix shape)', () => {
    expect(analyzeHookSource(GUARDED, 'hooks/demo.mjs').findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard forms that must stay clean
// ---------------------------------------------------------------------------

describe('recognised guard forms', () => {
  it('accepts the documented inline invokedAsScript() form (3 of the live hooks use it)', () => {
    const source = `
import { shouldRunHook } from './_lib/profile-gate.mjs';
function invokedAsScript() { return false; }
async function main() {}
if (invokedAsScript()) {
  if (!shouldRunHook('demo')) process.exit(0);
  main().catch(() => {}).finally(() => process.exit(0));
}
`;
    expect(analyzeHookSource(source, 'hooks/demo.mjs').findings).toEqual([]);
  });

  it('accepts the indirected `const isMain = invokedAsScript(); if (isMain)` form', () => {
    const source = `
import { shouldRunHook } from './_lib/profile-gate.mjs';
function invokedAsScript() { return false; }
async function main() {}
const isMain = invokedAsScript();
if (isMain) {
  if (!shouldRunHook('demo')) process.exit(0);
  main();
}
`;
    expect(analyzeHookSource(source, 'hooks/demo.mjs').findings).toEqual([]);
  });

  it('does not mistake a main() call INSIDE a function for a top-level entry', () => {
    const source = `${GUARDED}\nexport function restart() { main(); }\n`;
    expect(analyzeHookSource(source, 'hooks/demo.mjs').findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Population + vacuum guard
// ---------------------------------------------------------------------------

describe('population and vacuum guard', () => {
  it('exits 2 on an empty census — a checker that measured nothing must never report PASS', () => {
    const root = makeFixture({}, { hooks: {} });
    const r = run(root);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('empty census cannot be clean');
  });

  it('skips an absent foreign manifest instead of failing — a fork may ship fewer platforms', () => {
    const root = makeFixture({ 'demo.mjs': GUARDED });
    const { manifests } = collectRegisteredHooks(root);
    expect(manifests.filter((m) => m.present).map((m) => m.rel)).toEqual(['hooks/hooks.json']);
    expect(run(root).status).toBe(0);
  });

  it('exits 2 when a manifest registers a file that is not on disk — not a silent skip', () => {
    const root = makeFixture({ 'demo.mjs': GUARDED });
    rmSync(join(root, 'hooks', 'demo.mjs'));
    const r = run(root);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('registered but unreadable');
  });

  it('exits 2 when a registered hook does not PARSE — an unreadable top level must never count as guarded', () => {
    // THE BUG THIS CATCHES (q-6b): `scanHookEntryGuards` wraps `analyzeHookSource`
    // in a try/catch that pushes `parse failed: …` into `toolErrors` and `continue`s
    // (check-hook-entry-guards.mjs:520-523). Flip that catch to the obvious-looking
    // `return { findings: [] }` — the same "be tolerant" refactor that reads as
    // harmless — and the file falls into the `guarded += 1` branch: the census
    // reports PASS N/N for a hook whose top level NOBODY could read. That is the
    // #1393 class itself (a top-level handler that exits the importing process,
    // host-wide lock) shipping behind a green gate. The sibling branches are
    // pinned (:247 registered-but-not-on-disk → 2, empty census → 2); the parse
    // branch was not.
    //
    // The load-bearing assertion is `guarded`, not the exit code: a lenient catch
    // that still counted the file would keep exit 2 only by accident.
    const root = makeFixture({ 'broken.mjs': 'const x = ;\n', 'demo.mjs': GUARDED });

    const { toolErrors, registered, guarded, findings } = scanHookEntryGuards(root);
    expect(registered).toEqual(['hooks/broken.mjs', 'hooks/demo.mjs']);
    expect(guarded).toBe(1);
    expect(toolErrors).toHaveLength(1);
    expect(toolErrors[0].file).toBe('hooks/broken.mjs');
    expect(toolErrors[0].message).toContain('parse failed');
    // Not a finding either — a file we could not read is a TOOL error, so it can
    // never be silenced by the baseline mechanism.
    expect(findings).toEqual([]);

    const r = run(root);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('hooks/broken.mjs');
    expect(r.stdout).toContain('Results: 0 passed, 1 failed');
  });

  it('anchors on a whole `hooks` path segment — `subhooks/x.mjs` is not a registration', () => {
    const root = makeFixture(
      { 'demo.mjs': GUARDED },
      {
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'node "$ROOT/subhooks/ghost.mjs"' }] }],
        },
      },
    );
    expect(collectRegisteredHooks(root).files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Baseline mechanism + CLI surface
// ---------------------------------------------------------------------------

describe('baseline mechanism', () => {
  it('demotes a reasoned baselined file to WARN, so the gate can ship blocking', () => {
    const root = makeFixture({ 'demo.mjs': UNGUARDED });
    const baseline = new Map([['hooks/demo.mjs', 'pre-existing, see #1422']]);
    expect(runCheckHookEntryGuards(root, { baseline })).toBe(0);
  });

  it('FAILs a stale baseline entry, so a fixed file leaves no permanent exemption', () => {
    const root = makeFixture({ 'demo.mjs': GUARDED });
    const baseline = new Map([['hooks/demo.mjs', 'reason']]);
    const { baselineFindings } = scanHookEntryGuards(root, { baseline });
    expect(baselineFindings).toHaveLength(1);
    expect(baselineFindings[0].message).toContain('no longer matches');
  });

  it('FAILs a baseline entry with an empty reason — no reasonless suppression', () => {
    const root = makeFixture({ 'demo.mjs': UNGUARDED });
    const baseline = new Map([['hooks/demo.mjs', '   ']]);
    const { baselineFindings } = scanHookEntryGuards(root, { baseline });
    expect(baselineFindings[0].message).toContain('no reason');
  });
});

describe('CLI surface', () => {
  it('--help exits 0 and an unknown flag exits 1', () => {
    const help = spawnSync('node', [SCRIPT, '--help'], { encoding: 'utf8', timeout: 20_000 });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: check-hook-entry-guards.mjs');

    const bad = spawnSync('node', [SCRIPT, REPO_ROOT, '--nope'], { encoding: 'utf8', timeout: 20_000 });
    expect(bad.status).toBe(1);
  });

  it('prints the house result vocabulary against the live repo', () => {
    const r = run(REPO_ROOT);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ {2}PASS: /m);
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });
});
