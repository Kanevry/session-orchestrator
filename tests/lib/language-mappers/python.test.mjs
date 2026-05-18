/**
 * tests/lib/language-mappers/python.test.mjs
 *
 * Unit tests for scripts/lib/language-mappers/python.mjs
 *
 * Tests verify behavioral contracts (input → output), not regex internals.
 * Expected values are hardcoded literals per test-quality.md rules.
 * All fixtures are inline strings — no fixture files required.
 *
 * Test inventory (15 cases):
 *  1.  bare import `import os` → export slice, exported:false
 *  2.  bare multi-import `import os, sys` → 2 export slices
 *  3.  from import single `from os import path` → export slice, exported:false
 *  4.  from import multi `from os import path, getcwd` → 2 export slices
 *  5.  multi-line paren import `from x import (\n  a,\n)` → NOT emitted (skipped)
 *  6.  module-level `def foo()` → function slice, exported:true (no underscore)
 *  7.  private `def _helper()` → function slice, exported:false
 *  8.  module-level `class Foo:` → class slice, exported:true
 *  9.  `__all__` single-line → refines exported flags for named functions
 * 10.  `__all__` multiline → same effect
 * 11.  SCREAMING_SNAKE constant → export slice, exported:true
 * 12.  nested `def` inside class body (indented) → NOT emitted
 * 13.  `if TYPE_CHECKING:` indented import → NOT emitted
 * 14.  empty file → []
 * 15.  line numbers are 1-based and correct
 *
 * Issue #450 — language-mappers Phase 2.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const MODULE_PATH = path.join(
  REPO_ROOT,
  'scripts',
  'lib',
  'language-mappers',
  'python.mjs',
);

async function importSut() {
  const mod = await import(MODULE_PATH + `?t=${Date.now()}`);
  return mod;
}

async function parse(content, file = 'test.py') {
  const { extractPythonSlices } = await importSut();
  return extractPythonSlices(file, content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractPythonSlices', () => {
  it('bare `import os` → 1 export slice with exported:false', async () => {
    const slices = await parse('import os');
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('export');
    expect(slices[0].name).toBe('os');
    expect(slices[0].exported).toBe(false);
    expect(slices[0].file).toBe('test.py');
  });

  it('bare `import os, sys` → 2 export slices', async () => {
    const slices = await parse('import os, sys');
    expect(slices.filter((s) => s.kind === 'export')).toHaveLength(2);
    const names = slices.map((s) => s.name);
    expect(names).toContain('os');
    expect(names).toContain('sys');
  });

  it('`from os import path` → 1 export slice with source:os and exported:false', async () => {
    const slices = await parse('from os import path');
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('export');
    expect(slices[0].name).toBe('os.path');
    expect(slices[0].exported).toBe(false);
    expect(slices[0].source).toBe('os');
  });

  it('`from os import path, getcwd` → 2 export slices', async () => {
    const slices = await parse('from os import path, getcwd');
    expect(slices).toHaveLength(2);
    const names = slices.map((s) => s.name);
    expect(names).toContain('os.path');
    expect(names).toContain('os.getcwd');
  });

  it('multi-line paren import → NOT emitted (limitation documented)', async () => {
    const src = [
      'from os import (',
      '    path,',
      '    getcwd,',
      ')',
    ].join('\n');
    const slices = await parse(src);
    // The paren form is intentionally skipped — no slices for these imports
    const fromImports = slices.filter((s) => s.source === 'os');
    expect(fromImports).toHaveLength(0);
  });

  it('module-level `def foo():` → function slice with exported:true (no underscore)', async () => {
    const slices = await parse('def foo():\n    pass\n');
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('function');
    expect(slices[0].name).toBe('foo');
    expect(slices[0].exported).toBe(true);
    expect(slices[0].isNested).toBe(false);
  });

  it('`def _helper():` → function slice with exported:false (underscore prefix)', async () => {
    const slices = await parse('def _helper():\n    pass\n');
    const fn = slices.find((s) => s.kind === 'function');
    expect(fn).toBeDefined();
    expect(fn.name).toBe('_helper');
    expect(fn.exported).toBe(false);
  });

  it('module-level `class Foo:` → class slice with exported:true', async () => {
    const slices = await parse('class Foo:\n    pass\n');
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('class');
    expect(slices[0].name).toBe('Foo');
    expect(slices[0].exported).toBe(true);
  });

  it('`__all__` single-line → refines exported for listed names only', async () => {
    const src = [
      '__all__ = ["public_fn", "PublicClass"]',
      '',
      'def public_fn():',
      '    pass',
      '',
      'def _hidden():',
      '    pass',
      '',
      'class PublicClass:',
      '    pass',
      '',
      'class _HiddenClass:',
      '    pass',
    ].join('\n');
    const slices = await parse(src);
    const fns = slices.filter((s) => s.kind === 'function');
    const cls = slices.filter((s) => s.kind === 'class');

    const publicFn = fns.find((s) => s.name === 'public_fn');
    const hiddenFn = fns.find((s) => s.name === '_hidden');
    const publicCls = cls.find((s) => s.name === 'PublicClass');
    const hiddenCls = cls.find((s) => s.name === '_HiddenClass');

    expect(publicFn?.exported).toBe(true);
    expect(hiddenFn?.exported).toBe(false);
    expect(publicCls?.exported).toBe(true);
    expect(hiddenCls?.exported).toBe(false);
  });

  it('`__all__` multiline → same exported refinement', async () => {
    const src = [
      '__all__ = [',
      '    "only_this",',
      ']',
      '',
      'def only_this():',
      '    pass',
      '',
      'def not_exported():',
      '    pass',
    ].join('\n');
    const slices = await parse(src);
    const fns = slices.filter((s) => s.kind === 'function');
    const listed = fns.find((s) => s.name === 'only_this');
    const unlisted = fns.find((s) => s.name === 'not_exported');
    expect(listed?.exported).toBe(true);
    expect(unlisted?.exported).toBe(false);
  });

  it('SCREAMING_SNAKE constant → export slice with exported:true', async () => {
    const src = 'MAX_RETRIES = 3\nDEFAULT_TIMEOUT = 30\n';
    const slices = await parse(src);
    const constants = slices.filter((s) => s.kind === 'export' && s.exported);
    expect(constants).toHaveLength(2);
    const names = constants.map((s) => s.name);
    expect(names).toContain('MAX_RETRIES');
    expect(names).toContain('DEFAULT_TIMEOUT');
  });

  it('nested def inside class body (indented) → NOT emitted', async () => {
    const src = [
      'class Processor:',
      '    def process(self):',
      '        pass',
      '    def _internal(self):',
      '        pass',
    ].join('\n');
    const slices = await parse(src);
    // Only the class-level slice should appear; indented methods are excluded
    const methods = slices.filter((s) => s.kind === 'function');
    expect(methods).toHaveLength(0);
    const classes = slices.filter((s) => s.kind === 'class');
    expect(classes).toHaveLength(1);
    expect(classes[0].name).toBe('Processor');
  });

  it('`if TYPE_CHECKING:` indented import → NOT emitted', async () => {
    const src = [
      'from __future__ import annotations',
      'import os',
      '',
      'if TYPE_CHECKING:',
      '    from typing import Optional',
    ].join('\n');
    const slices = await parse(src);
    // The indented `from typing import Optional` must NOT appear
    const typingImport = slices.find((s) => s.source === 'typing');
    expect(typingImport).toBeUndefined();
    // The column-0 imports must still appear
    const osImport = slices.find((s) => s.name === 'os');
    expect(osImport).toBeDefined();
  });

  it('empty file → empty array', async () => {
    const slices = await parse('');
    expect(slices).toEqual([]);
  });

  it('line numbers are 1-based and correct', async () => {
    const src = [
      'import os',
      '',
      'def my_function():',
      '    pass',
      '',
      'class MyClass:',
      '    pass',
    ].join('\n');
    const slices = await parse(src);
    const importSlice = slices.find((s) => s.name === 'os');
    const fnSlice = slices.find((s) => s.kind === 'function' && s.name === 'my_function');
    const clsSlice = slices.find((s) => s.kind === 'class' && s.name === 'MyClass');
    expect(importSlice?.line).toBe(1);
    expect(fnSlice?.line).toBe(3);
    expect(clsSlice?.line).toBe(6);
  });
});
