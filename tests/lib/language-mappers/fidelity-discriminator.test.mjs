/**
 * tests/lib/language-mappers/fidelity-discriminator.test.mjs
 *
 * Verifies that every SemanticSlice emitted by every language-mapper
 * carries a correct `fidelity` discriminator (#474 MED-3) and that the
 * dispatcher's unsupported-extension error message lists keys derived
 * from EXT_TO_LANG, not a hardcoded literal substring (#474 LOW-9).
 *
 * Fidelity values:
 *   - 'ast'   for typescript / markdown (real parser AST walk)
 *   - 'regex' for swift / python        (column-0 regex protos)
 *
 * Tests verify behavioral contracts: pick fixtures that exercise each
 * push-site shape (function, class, interface, type, export, section),
 * then assert every returned slice carries the expected fidelity.
 *
 * Issue #474 architecture polish — MED-3 + LOW-9.
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
  // Cache-bust per call so language-mapper changes pick up cleanly.
  const mod = await import(MODULE_PATH + `?t=${Date.now()}`);
  return mod;
}

// ---------------------------------------------------------------------------
// Fixtures — each fixture exercises a single mapper and guarantees at least
// one slice of each kind the mapper can emit (so we can assert fidelity on
// every push-site shape, not just the first one).
// ---------------------------------------------------------------------------

const TS_FIXTURE = `
import foo from './foo';
export { bar } from './bar';
export * from './baz';

export function helloFn() {}
export const arrowFn = () => {};
export class Service {
  doWork() {}
}
export interface IFoo { x: number }
export type Alias = string;
export default function defaultFn() {}
`.trim();

const TSX_FIXTURE = `
export const Comp = () => <div>hi</div>;
export function widget() { return <span/>; }
`.trim();

const MD_FIXTURE = `
# Top

Some text.

## Sub-A

Body of A.

## Sub-B

Body of B.
`.trim();

const SWIFT_FIXTURE = `
import Foundation
@_exported import UIKit

public func greet() {}
public class NetworkManager {}
public struct Token {}
public enum Status {}
public let MAX_RETRIES = 3
`.trim();

const PY_FIXTURE = `
import os
from os import path
def hello():
    pass
class Foo:
    pass
MAX_RETRIES = 3
`.trim();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('language-mappers fidelity discriminator (#474 MED-3)', () => {
  it("typescript slices all carry fidelity:'ast'", async () => {
    const { extractSemanticSlices } = await importSut();
    const slices = await extractSemanticSlices('fixture.ts', TS_FIXTURE);
    expect(slices.length).toBeGreaterThan(0);
    for (const slice of slices) {
      expect(slice.fidelity).toBe('ast');
    }
  });

  it("tsx slices all carry fidelity:'ast'", async () => {
    const { extractSemanticSlices } = await importSut();
    const slices = await extractSemanticSlices('fixture.tsx', TSX_FIXTURE);
    expect(slices.length).toBeGreaterThan(0);
    for (const slice of slices) {
      expect(slice.fidelity).toBe('ast');
    }
  });

  it("markdown slices all carry fidelity:'ast'", async () => {
    const { extractSemanticSlices } = await importSut();
    const slices = await extractSemanticSlices('fixture.md', MD_FIXTURE);
    expect(slices.length).toBeGreaterThan(0);
    for (const slice of slices) {
      expect(slice.fidelity).toBe('ast');
    }
  });

  it("swift slices all carry fidelity:'regex'", async () => {
    const { extractSemanticSlices } = await importSut();
    const slices = await extractSemanticSlices('Fixture.swift', SWIFT_FIXTURE);
    expect(slices.length).toBeGreaterThan(0);
    for (const slice of slices) {
      expect(slice.fidelity).toBe('regex');
    }
  });

  it("python slices all carry fidelity:'regex'", async () => {
    const { extractSemanticSlices } = await importSut();
    const slices = await extractSemanticSlices('fixture.py', PY_FIXTURE);
    expect(slices.length).toBeGreaterThan(0);
    for (const slice of slices) {
      expect(slice.fidelity).toBe('regex');
    }
  });

  it('typescript class with nested methods — both class slice and nested method slices carry fidelity:ast', async () => {
    // Guards against missing the walkClassMethods push site specifically.
    const { extractSemanticSlices } = await importSut();
    const src = `
export class MyService {
  alpha() {}
  beta() {}
}
`.trim();
    const slices = await extractSemanticSlices('cls.ts', src);
    const classSlice = slices.find((s) => s.kind === 'class');
    const nestedMethods = slices.filter((s) => s.isNested === true);
    expect(classSlice).toBeDefined();
    expect(classSlice.fidelity).toBe('ast');
    expect(nestedMethods.length).toBe(2);
    for (const m of nestedMethods) {
      expect(m.fidelity).toBe('ast');
    }
  });
});

describe('dispatcher error message uses EXT_TO_LANG keys (#474 LOW-9)', () => {
  it('unsupported extension error lists every key registered in EXT_TO_LANG', async () => {
    // The dispatcher must derive its "supports" list from EXT_TO_LANG, not
    // from a hardcoded literal — otherwise adding a new extension to the
    // map without updating the error message creates silent drift.
    //
    // We assert presence of every extension currently in the canonical set;
    // adding a new extension to EXT_TO_LANG and forgetting to update this
    // test's CANONICAL list will then surface the drift here (test is the
    // canary).
    const { extractSemanticSlices } = await importSut();
    const CANONICAL_EXTENSIONS = [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.md',
      '.mdx',
      '.swift',
      '.py',
    ];

    let caught;
    try {
      await extractSemanticSlices('app.rb', 'def foo; end');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toMatch(/unsupported language/);
    for (const ext of CANONICAL_EXTENSIONS) {
      expect(caught.message).toContain(ext);
    }
  });
});
