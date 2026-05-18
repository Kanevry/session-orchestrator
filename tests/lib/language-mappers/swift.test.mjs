/**
 * tests/lib/language-mappers/swift.test.mjs
 *
 * Unit tests for scripts/lib/language-mappers/swift.mjs
 *
 * Tests verify behavioral contracts (input → output), not regex internals.
 * Expected values are hardcoded literals per test-quality.md rules.
 * All fixtures are inline strings — no fixture files required.
 *
 * Test inventory (12 cases):
 *  1.  public func → 1 function slice, exported:true
 *  2.  open func → 1 function slice, exported:true
 *  3.  public class → 1 class slice, exported:true
 *  4.  public struct → 1 class slice (struct maps to 'class' kind)
 *  5.  public actor → 1 class slice
 *  6.  public enum → 1 type slice, exported:true
 *  7.  plain import → 1 export slice, exported:false
 *  8.  @_exported import → 1 export slice, exported:true
 *  9.  public func with generic params → detected (name includes <T>)
 * 10.  @available + public func → decorator tolerated, function detected
 * 11.  extension member (indented func) → NOT emitted as slice
 * 12.  empty file → []
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
  'swift.mjs',
);

async function importSut() {
  const mod = await import(MODULE_PATH + `?t=${Date.now()}`);
  return mod;
}

async function parse(content, file = 'Test.swift') {
  const { extractSwiftSlices } = await importSut();
  return extractSwiftSlices(file, content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractSwiftSlices', () => {
  it('public func → 1 function slice with exported:true', async () => {
    const slices = await parse('public func greet() -> String { return "hi" }');
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('function');
    expect(slices[0].name).toBe('greet');
    expect(slices[0].exported).toBe(true);
    expect(slices[0].isNested).toBe(false);
    expect(slices[0].file).toBe('Test.swift');
  });

  it('open func → 1 function slice with exported:true', async () => {
    const slices = await parse('open func configure(with options: Options) {}');
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('function');
    expect(slices[0].name).toBe('configure');
    expect(slices[0].exported).toBe(true);
  });

  it('public class → 1 class slice with kind:class and exported:true', async () => {
    const slices = await parse('public class NetworkManager {}');
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('class');
    expect(slices[0].name).toBe('NetworkManager');
    expect(slices[0].exported).toBe(true);
  });

  it('public struct → 1 slice with kind:class (struct maps to class kind)', async () => {
    const slices = await parse('public struct UserProfile {}');
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('class');
    expect(slices[0].name).toBe('UserProfile');
    expect(slices[0].exported).toBe(true);
  });

  it('public actor → 1 slice with kind:class', async () => {
    const slices = await parse('public actor DataStore {}');
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('class');
    expect(slices[0].name).toBe('DataStore');
    expect(slices[0].exported).toBe(true);
  });

  it('public enum → 1 type slice with exported:true', async () => {
    const slices = await parse('public enum Direction { case north, south }');
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('type');
    expect(slices[0].name).toBe('Direction');
    expect(slices[0].exported).toBe(true);
  });

  it('plain import → 1 export slice with exported:false', async () => {
    const slices = await parse('import Foundation');
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('export');
    expect(slices[0].name).toBe('Foundation');
    expect(slices[0].exported).toBe(false);
  });

  it('@_exported import → 1 export slice with exported:true', async () => {
    const slices = await parse('@_exported import MyFramework');
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('export');
    expect(slices[0].name).toBe('MyFramework');
    expect(slices[0].exported).toBe(true);
  });

  it('public func with generic param → detected (name captures generic bracket)', async () => {
    const src = 'public func swap<T>(a: T, b: T) -> (T, T) {}';
    const slices = await parse(src);
    const fn = slices.find((s) => s.kind === 'function');
    expect(fn).toBeDefined();
    // Name includes the generic suffix — acceptable for regex proto
    expect(fn.name).toMatch(/^swap/);
    expect(fn.exported).toBe(true);
  });

  it('@available decorator before public func → function still detected', async () => {
    const src = [
      '@available(iOS 15, *)',
      'public func modernFeature() {}',
    ].join('\n');
    const slices = await parse(src);
    const fn = slices.find((s) => s.kind === 'function' && s.name === 'modernFeature');
    expect(fn).toBeDefined();
    expect(fn.exported).toBe(true);
  });

  it('extension member (indented func) → NOT emitted as slice', async () => {
    const src = [
      'extension NetworkManager {',
      '    public func retry() {}',
      '}',
    ].join('\n');
    // The `public func` inside the extension is indented — column-0 anchor excludes it
    const slices = await parse(src);
    const fn = slices.find((s) => s.kind === 'function' && s.name === 'retry');
    expect(fn).toBeUndefined();
  });

  it('empty file → empty array', async () => {
    const slices = await parse('');
    expect(slices).toEqual([]);
  });

  it('line numbers are 1-based and correct', async () => {
    const src = [
      'import UIKit',
      '',
      'public class AppDelegate {}',
      'public func bootstrap() {}',
    ].join('\n');
    const slices = await parse(src);
    const importSlice = slices.find((s) => s.name === 'UIKit');
    const classSlice = slices.find((s) => s.name === 'AppDelegate');
    const fnSlice = slices.find((s) => s.name === 'bootstrap');
    expect(importSlice?.line).toBe(1);
    expect(classSlice?.line).toBe(3);
    expect(fnSlice?.line).toBe(4);
  });

  it('private/internal declarations → NOT emitted', async () => {
    const src = [
      'private func secret() {}',
      'internal func alsoHidden() {}',
      'func packageLevel() {}',
      'public func visible() {}',
    ].join('\n');
    const slices = await parse(src);
    const fnNames = slices.filter((s) => s.kind === 'function').map((s) => s.name);
    expect(fnNames).toEqual(['visible']);
  });

  it('public let/var properties → export slices with exported:true', async () => {
    const src = [
      'public let version: String = "1.0"',
      'public var isEnabled: Bool = false',
    ].join('\n');
    const slices = await parse(src);
    const exports = slices.filter((s) => s.kind === 'export' && s.exported);
    expect(exports).toHaveLength(2);
    const names = exports.map((s) => s.name);
    expect(names).toContain('version');
    expect(names).toContain('isEnabled');
  });
});
