/**
 * tests/hooks/_lib/atomic-json.test.mjs
 *
 * Unit tests for hooks/_lib/atomic-json.mjs (issue #1197).
 *
 * Each test names the concrete bug it catches (TV-001):
 *   (a) unparsable existing file  → the OLD (pre-#1197) four private copies of
 *       atomicMutateJson treated ANY read/parse failure as "file absent" and
 *       silently overwrote the real content with defaultValue-derived JSON.
 *       Proven against the actual old copy (extracted from git HEAD
 *       936dae8a's hooks/cwd-change-restore.mjs) before this fix landed:
 *       the unparsable fixture below was replaced with
 *       `{"mutated":true}\n` — see the F-H finding in issue #1197.
 *   (b) EISDIR (filePath is a directory) — same silent-overwrite class as
 *       (a), via a different underlying errno.
 *   (c) ENOENT — the ONE legitimate "start fresh" case; must still work
 *       exactly as before (regression guard on the fix itself).
 *   (d) normal mutate round-trip — basic contract sanity.
 *   (e) tmp file never left behind on failure — a non-ENOENT failure must
 *       return before ever creating a `.tmp-*` sibling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicMutateJson } from '../../../hooks/_lib/atomic-json.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'atomic-json-test-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

/** Lists any `.tmp-*` sibling artifacts left behind next to `filePath`. */
function tmpArtifacts(dir) {
  return readdirSync(dir).filter((name) => name.includes('.tmp-'));
}

describe('atomicMutateJson', () => {
  it('(a) unparsable existing file: does NOT replace it, returns not-ok', async () => {
    const filePath = join(tmp, 'current-session.json');
    const original = '{ this is not valid json !!! unparsable-marker-xyz';
    writeFileSync(filePath, original, 'utf8');

    const result = await atomicMutateJson(filePath, {}, (current) => ({
      ...current,
      mutated: true,
    }));

    expect(result.ok).toBe(false);
    const after = readFileSync(filePath, 'utf8');
    expect(after).toBe(original); // byte-identical — the F-H bug replaced this with defaultValue JSON
    expect(tmpArtifacts(tmp)).toEqual([]);
  });

  it('(b) EISDIR (path is a directory): not ok, nothing written', async () => {
    const filePath = join(tmp, 'current-session.json');
    mkdirSync(filePath); // filePath now points at a directory, not a file

    const result = await atomicMutateJson(filePath, {}, (current) => ({
      ...current,
      mutated: true,
    }));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EISDIR');
    // Still a directory — never replaced with a JSON file.
    expect(existsSync(filePath)).toBe(true);
    expect(readdirSync(filePath)).toEqual([]);
    expect(tmpArtifacts(tmp)).toEqual([]);
  });

  it('(c) ENOENT: applies defaultValue and creates the file', async () => {
    const filePath = join(tmp, 'nested', 'current-session.json');

    const result = await atomicMutateJson(filePath, { seed: true }, (current) => ({
      ...current,
      created: true,
    }));

    expect(result.ok).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed).toEqual({ seed: true, created: true });
  });

  it('(d) normal mutate round-trip on an existing valid file', async () => {
    const filePath = join(tmp, 'current-session.json');
    writeFileSync(filePath, JSON.stringify({ count: 1 }), 'utf8');

    const result = await atomicMutateJson(filePath, {}, (current) => ({
      ...current,
      count: current.count + 1,
    }));

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ count: 2 });
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed).toEqual({ count: 2 });
  });

  it('(e) tmp file never left behind on a read/parse failure', async () => {
    const filePath = join(tmp, 'current-session.json');
    writeFileSync(filePath, 'not json at all', 'utf8');

    await atomicMutateJson(filePath, {}, (current) => current, 'zzz');

    expect(tmpArtifacts(tmp)).toEqual([]);
  });
});
