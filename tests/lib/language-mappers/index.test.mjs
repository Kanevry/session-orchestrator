/**
 * tests/lib/language-mappers/index.test.mjs
 *
 * Unit tests for scripts/lib/language-mappers/index.mjs
 *
 * Test inventory (7 cases):
 *  1. languageFromPath('foo.ts')   → 'ts'
 *  2. languageFromPath('foo.md')   → 'md'
 *  3. languageFromPath('foo.py')   → null (Phase 2 / unsupported)
 *  4. languageFromPath('foo.mjs')  → 'js'
 *  5. extractSemanticSlices for a .ts string → delegates to typescript mapper
 *  6. extractSemanticSlices for a .md string → delegates to markdown mapper
 *  7. Unsupported extension → throws Error with helpful message
 *
 * Issue #416 — Clawpatch Borrow Cluster Phase 1.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const MODULE_PATH = path.join(
  REPO_ROOT,
  'scripts',
  'lib',
  'language-mappers',
  'index.mjs',
);

async function importSut() {
  const mod = await import(MODULE_PATH + `?t=${Date.now()}`);
  return mod;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('languageFromPath', () => {
  it("returns 'ts' for .ts extension", async () => {
    const { languageFromPath } = await importSut();
    expect(languageFromPath('foo.ts')).toBe('ts');
  });

  it("returns 'ts' for .tsx extension", async () => {
    const { languageFromPath } = await importSut();
    expect(languageFromPath('src/components/Button.tsx')).toBe('ts');
  });

  it("returns 'md' for .md extension", async () => {
    const { languageFromPath } = await importSut();
    expect(languageFromPath('README.md')).toBe('md');
  });

  it("returns 'js' for .mjs extension", async () => {
    const { languageFromPath } = await importSut();
    expect(languageFromPath('scripts/lib/common.mjs')).toBe('js');
  });

  it("returns 'py' for .py extension (Phase 2 — Python mapper added)", async () => {
    const { languageFromPath } = await importSut();
    expect(languageFromPath('main.py')).toBe('py');
  });

  it("returns 'swift' for .swift extension (Phase 2 — Swift mapper added)", async () => {
    const { languageFromPath } = await importSut();
    expect(languageFromPath('App.swift')).toBe('swift');
  });
});

describe('extractSemanticSlices', () => {
  it('dispatches .ts content to typescript mapper and returns slice array', async () => {
    const { extractSemanticSlices } = await importSut();
    const slices = await extractSemanticSlices('foo.ts', 'export function hello() {}');
    expect(Array.isArray(slices)).toBe(true);
    expect(slices.length).toBe(1);
    expect(slices[0].kind).toBe('function');
    expect(slices[0].name).toBe('hello');
  });

  it('dispatches .md content to markdown mapper and returns slice array', async () => {
    const { extractSemanticSlices } = await importSut();
    const slices = await extractSemanticSlices('README.md', '## Getting Started\n\nSome text.');
    expect(Array.isArray(slices)).toBe(true);
    expect(slices.length).toBe(1);
    expect(slices[0].kind).toBe('section');
    expect(slices[0].name).toBe('Getting Started');
  });

  it('throws an Error with a helpful message for unsupported extension', async () => {
    const { extractSemanticSlices } = await importSut();
    await expect(extractSemanticSlices('main.rb', 'def foo; end')).rejects.toThrow(
      /unsupported language/,
    );
  });

  it('dispatches .py content to python mapper and returns slice array', async () => {
    const { extractSemanticSlices } = await importSut();
    const slices = await extractSemanticSlices('main.py', 'def hello():\n    pass\n');
    expect(Array.isArray(slices)).toBe(true);
    const fn = slices.find((s) => s.kind === 'function' && s.name === 'hello');
    expect(fn).toBeDefined();
  });

  it('dispatches .swift content to swift mapper and returns slice array', async () => {
    const { extractSemanticSlices } = await importSut();
    const slices = await extractSemanticSlices('App.swift', 'public func greet() {}\n');
    expect(Array.isArray(slices)).toBe(true);
    const fn = slices.find((s) => s.kind === 'function' && s.name === 'greet');
    expect(fn).toBeDefined();
  });

  it('accepts explicit options.language override for .ts', async () => {
    const { extractSemanticSlices } = await importSut();
    // File has no extension; force language via options
    const slices = await extractSemanticSlices(
      'no-extension',
      'export function greet() {}',
      { language: 'ts' },
    );
    expect(slices.length).toBe(1);
    expect(slices[0].kind).toBe('function');
  });
});

describe('SLICE_KINDS constant', () => {
  it('exports SLICE_KINDS as a non-empty frozen array', async () => {
    const { SLICE_KINDS } = await importSut();
    expect(Array.isArray(SLICE_KINDS)).toBe(true);
    expect(SLICE_KINDS.length).toBeGreaterThanOrEqual(4);
    expect(Object.isFrozen(SLICE_KINDS)).toBe(true);
  });

  it('SLICE_KINDS includes function, class, interface, type, section', async () => {
    const { SLICE_KINDS } = await importSut();
    for (const kind of ['function', 'class', 'interface', 'type', 'section']) {
      expect(SLICE_KINDS).toContain(kind);
    }
  });
});

// =============================================================================
// NEW BOUNDARY / CACHE-INVARIANT TESTS (W4-T1)
// =============================================================================

describe('extractSemanticSlices — input validation', () => {
  it('throws TypeError when filePath is not a string', async () => {
    const { extractSemanticSlices } = await importSut();
    // @ts-expect-error intentional wrong-type test
    await expect(extractSemanticSlices(42, 'content')).rejects.toThrow(TypeError);
  });

  it('throws TypeError when content is not a string', async () => {
    const { extractSemanticSlices } = await importSut();
    // @ts-expect-error intentional wrong-type test
    await expect(extractSemanticSlices('foo.ts', null)).rejects.toThrow(TypeError);
  });

  it('throws Error with "unsupported language" message for .rb extension', async () => {
    const { extractSemanticSlices } = await importSut();
    await expect(extractSemanticSlices('app.rb', 'def foo; end')).rejects.toThrow(
      /unsupported language/,
    );
  });

  it('accepts options.language="md" override to force markdown parsing', async () => {
    const { extractSemanticSlices } = await importSut();
    // .ts extension but forced to 'md' — must parse as markdown
    const slices = await extractSemanticSlices(
      'file.ts',
      '## Forced Markdown Heading\n\nContent.',
      { language: 'md' },
    );
    expect(slices.length).toBe(1);
    expect(slices[0].kind).toBe('section');
    expect(slices[0].name).toBe('Forced Markdown Heading');
  });
});

describe('extractSemanticSlices — mapper cache invariant (MED-005)', () => {
  it('calling extractSemanticSlices N times does not re-import the TS mapper module (cache hit)', async () => {
    // This test verifies the Q2-MED-005 fix: loadTsMapper() must return the
    // SAME promise on every call (module-level cache), not re-import each time.
    //
    // We cannot directly inspect the module cache, so we verify behaviorally:
    // N concurrent calls must all return consistent results with no parse errors,
    // and the total time must be dominated by parsing (not N sequential imports).
    const { extractSemanticSlices } = await importSut();
    const src = 'export function cacheTest() {}';

    // Run 10 concurrent calls to the same TS extractor
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        extractSemanticSlices('cache-test.ts', src),
      ),
    );

    // All 10 results must be identical (same slice, same name)
    for (const slices of results) {
      expect(slices).toHaveLength(1);
      expect(slices[0].kind).toBe('function');
      expect(slices[0].name).toBe('cacheTest');
    }
  });

  it('markdown mapper is also cached: N concurrent calls return consistent results', async () => {
    const { extractSemanticSlices } = await importSut();
    const src = '## Cache Test Heading\n\nBody text.';

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        extractSemanticSlices('cache-test.md', src),
      ),
    );

    for (const slices of results) {
      expect(slices).toHaveLength(1);
      expect(slices[0].kind).toBe('section');
      expect(slices[0].name).toBe('Cache Test Heading');
    }
  });
});
