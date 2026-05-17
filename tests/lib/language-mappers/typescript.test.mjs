/**
 * tests/lib/language-mappers/typescript.test.mjs
 *
 * Unit tests for scripts/lib/language-mappers/typescript.mjs
 *
 * Tests verify behavioral contracts (input → output), not AST internals.
 * Expected values are hardcoded literals per test-quality.md rules.
 *
 * Test inventory (12 cases):
 *  1. Single export function → 1 slice {kind:'function', exported:true}
 *  2. Multiple exports → correct slice count
 *  3. Class with 3 methods → 1 class + 3 nested method slices
 *  4. Interface declaration → 1 interface slice
 *  5. Type alias → 1 type slice
 *  6. Default export of arrow function → 1 export slice
 *  7. JSX-style syntax (.tsx) → parses without error
 *  8. Syntax error → throws identifiable Error
 *  9. Line numbers are correct
 * 10. Empty file → []
 * 11. Named function with params → params array populated
 * 12. Re-export specifier → export kind with correct name
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
  'typescript.mjs',
);

/** @returns {Promise<{extractTypeScriptSlices: (filePath: string, content: string) => Promise<any[]>}>} */
async function importSut() {
  const mod = await import(MODULE_PATH + `?t=${Date.now()}`);
  return mod;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function parse(content, file = 'test.ts') {
  const { extractTypeScriptSlices } = await importSut();
  return extractTypeScriptSlices(file, content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractTypeScriptSlices', () => {
  it('single exported function → 1 slice with kind function and exported true', async () => {
    const slices = await parse('export function hello() {}');
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('function');
    expect(slices[0].name).toBe('hello');
    expect(slices[0].exported).toBe(true);
    expect(slices[0].isNested).toBe(false);
    expect(slices[0].file).toBe('test.ts');
  });

  it('multiple exported functions → correct count of slices', async () => {
    const src = `
export function alpha() {}
export function beta() {}
export function gamma() {}
    `.trim();
    const slices = await parse(src);
    // 3 function slices
    const fns = slices.filter((s) => s.kind === 'function');
    expect(fns).toHaveLength(3);
    expect(fns.map((s) => s.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('class with 3 methods → 1 class slice plus 3 nested method slices', async () => {
    const src = `
export class MyService {
  constructor() {}
  doWork() {}
  getResult() {}
}
    `.trim();
    const slices = await parse(src);
    const classSlice = slices.find((s) => s.kind === 'class');
    expect(classSlice).toBeDefined();
    expect(classSlice.name).toBe('MyService');
    expect(classSlice.exported).toBe(true);

    const nested = slices.filter((s) => s.isNested === true && s.kind === 'function');
    expect(nested).toHaveLength(3);
    const nestedNames = nested.map((s) => s.name).sort();
    expect(nestedNames).toEqual(['constructor', 'doWork', 'getResult'].sort());
    nested.forEach((m) => expect(m.isNested).toBe(true));
  });

  it('interface declaration → 1 interface slice', async () => {
    const src = `export interface UserConfig { name: string; age: number; }`;
    const slices = await parse(src);
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('interface');
    expect(slices[0].name).toBe('UserConfig');
    expect(slices[0].exported).toBe(true);
  });

  it('type alias → 1 type slice', async () => {
    const src = `export type UserId = string;`;
    const slices = await parse(src);
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('type');
    expect(slices[0].name).toBe('UserId');
    expect(slices[0].exported).toBe(true);
  });

  it('default export of arrow function → 1 export slice with exported true', async () => {
    const src = `export default () => 42;`;
    const slices = await parse(src);
    expect(slices).toHaveLength(1);
    expect(slices[0].exported).toBe(true);
  });

  it('JSX/TSX syntax parses without throwing', async () => {
    const src = `
import React from 'react';
export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}
    `.trim();
    // Should not throw even when the file is .tsx
    const slices = await parse(src, 'Button.tsx');
    const fn = slices.find((s) => s.kind === 'function' && s.name === 'Button');
    expect(fn).toBeDefined();
    expect(fn.exported).toBe(true);
  });

  it('syntax error → throws an Error with message referencing the file', async () => {
    const src = `export function broken( {`;
    await expect(parse(src, 'bad.ts')).rejects.toThrow(/bad\.ts/);
  });

  it('line numbers are correct for a multi-line file', async () => {
    const src = [
      'const x = 1;',           // line 1 — not a function
      '',                        // line 2
      'export function foo() {', // line 3
      '  return x;',             // line 4
      '}',                       // line 5
    ].join('\n');
    const slices = await parse(src);
    const fn = slices.find((s) => s.kind === 'function' && s.name === 'foo');
    expect(fn).toBeDefined();
    expect(fn.line).toBe(3);
    expect(fn.endLine).toBe(5);
  });

  it('empty file → returns empty array', async () => {
    const slices = await parse('');
    expect(slices).toEqual([]);
  });

  it('named function with params → params array is populated', async () => {
    const src = `export function greet(name, age) {}`;
    const slices = await parse(src);
    const fn = slices.find((s) => s.kind === 'function');
    expect(fn).toBeDefined();
    expect(fn.params).toEqual(['name', 'age']);
  });

  it('re-export specifier → export kind slice with correct name', async () => {
    const src = `export { readFile } from 'node:fs';`;
    const slices = await parse(src);
    const exportSlice = slices.find((s) => s.kind === 'export' && s.name === 'readFile');
    expect(exportSlice).toBeDefined();
    expect(exportSlice.exported).toBe(true);
  });
});

// =============================================================================
// NEW BOUNDARY TESTS (W4-T1)
// =============================================================================

describe('extractTypeScriptSlices — re-exports, generics, decorators', () => {
  it('named re-export of multiple specifiers → one export slice per name', async () => {
    const src = `export { foo, bar, baz } from './other';`;
    const slices = await parse(src);
    const exports = slices.filter((s) => s.kind === 'export');
    expect(exports).toHaveLength(3);
    const names = exports.map((s) => s.name).sort();
    expect(names).toEqual(['bar', 'baz', 'foo']);
    exports.forEach((s) => expect(s.exported).toBe(true));
  });

  it('star re-export (ExportAllDeclaration) → no slice emitted (not handled in Phase 1)', async () => {
    // `export * from './x'` produces an ExportAllDeclaration AST node.
    // The current walkStatement switch does not handle this node type — it
    // falls to the default: break case and emits nothing.
    // This test documents the contract: zero slices for export-all.
    // Phase 2 may add ExportAllDeclaration support and should update this test.
    const src = `export * from './utils';`;
    const slices = await parse(src);
    // ExportAllDeclaration falls through to default → no slice
    expect(slices).toHaveLength(0);
  });

  it('namespace import does not produce a slice (only top-level exports matter)', async () => {
    // `import * as foo from './x'` is a pure import — no export slice expected
    const src = `import * as utils from './utils';\nexport function useIt() { return utils; }`;
    const slices = await parse(src);
    const fns = slices.filter((s) => s.kind === 'function');
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('useIt');
  });

  it('class with a decorator does not throw and emits a class slice', async () => {
    const src = [
      '@Injectable()',
      'export class MyService {',
      '  constructor() {}',
      '}',
    ].join('\n');
    const slices = await parse(src);
    const classSlice = slices.find((s) => s.kind === 'class');
    expect(classSlice).toBeDefined();
    expect(classSlice.name).toBe('MyService');
    expect(classSlice.exported).toBe(true);
  });

  it('generic function → function slice with correct name and params', async () => {
    const src = `export function identity<T>(x: T): T { return x; }`;
    const slices = await parse(src);
    const fn = slices.find((s) => s.kind === 'function' && s.name === 'identity');
    expect(fn).toBeDefined();
    expect(fn.exported).toBe(true);
    // x is the parameter name; T is a type parameter (not a runtime param)
    expect(fn.params).toEqual(['x']);
  });

  it('generic arrow function assigned to const → function slice', async () => {
    const src = `export const wrap = <T>(value: T): { value: T } => ({ value });`;
    const slices = await parse(src);
    const fn = slices.find((s) => s.kind === 'function' && s.name === 'wrap');
    expect(fn).toBeDefined();
    expect(fn.exported).toBe(true);
  });

  it('whitespace-only content → returns empty array', async () => {
    const slices = await parse('   \n\t\n   ');
    expect(slices).toEqual([]);
  });
});
