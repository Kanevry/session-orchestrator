/**
 * tests/lib/common.test.mjs
 *
 * Vitest tests for scripts/lib/common.mjs
 *
 * Exports under test:
 *   makeTmpPath, utcTimestamp, epochMs, readJson, writeJson, appendJsonl
 *
 * Issue #136 — v3.0.0 Windows native migration.
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  makeTmpPath,
  utcTimestamp,
  epochMs,
  readJson,
  writeJson,
  appendJsonl,
} from '@lib/common.mjs';

// ---------------------------------------------------------------------------
// Cleanup tracking — remove all temp files/dirs created during tests
// ---------------------------------------------------------------------------

const tmpCreated = [];

afterEach(async () => {
  for (const p of tmpCreated.splice(0)) {
    await fs.rm(p, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// makeTmpPath
// ---------------------------------------------------------------------------

describe('makeTmpPath', () => {
  it('returns a path that starts with os.tmpdir()', () => {
    const p = makeTmpPath('test');
    expect(p.startsWith(os.tmpdir())).toBe(true);
  });

  it('returned path contains the given prefix', () => {
    const p = makeTmpPath('myprefix');
    expect(path.basename(p).startsWith('myprefix-')).toBe(true);
  });

  it('returned path ends with an 8-character hex suffix', () => {
    const p = makeTmpPath('test');
    const base = path.basename(p);
    // format: <prefix>-<timestamp>-<8hex>
    expect(base).toMatch(/^[^-]+-\d+-[0-9a-f]{8}$/);
  });

  it('two calls with the same prefix return different paths', () => {
    const p1 = makeTmpPath('dup');
    const p2 = makeTmpPath('dup');
    expect(p1).not.toBe(p2);
  });

  it('returns an absolute path', () => {
    const p = makeTmpPath('abs');
    expect(path.isAbsolute(p)).toBe(true);
  });

  it('throws TypeError when prefix is an empty string', () => {
    expect(() => makeTmpPath('')).toThrow(TypeError);
  });

  it('throws TypeError when prefix is not a string', () => {
    expect(() => makeTmpPath(42)).toThrow(TypeError);
  });

  it('throws TypeError when prefix is null', () => {
    expect(() => makeTmpPath(null)).toThrow(TypeError);
  });

  it('throws TypeError when prefix is undefined', () => {
    expect(() => makeTmpPath(undefined)).toThrow(TypeError);
  });

  it('error message mentions "prefix" and "non-empty"', () => {
    expect(() => makeTmpPath('')).toThrow(/prefix.*non-empty|non-empty.*prefix/i);
  });
});

// ---------------------------------------------------------------------------
// utcTimestamp
// ---------------------------------------------------------------------------

describe('utcTimestamp', () => {
  it('returns a string', () => {
    expect(typeof utcTimestamp()).toBe('string');
  });

  it('returns an ISO 8601 UTC string ending with "Z"', () => {
    expect(utcTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('returned value is parseable as a Date', () => {
    const ts = utcTimestamp();
    const d = new Date(ts);
    expect(isNaN(d.getTime())).toBe(false);
  });

  it('returned date is close to now (within 2 seconds)', () => {
    const before = Date.now();
    const ts = utcTimestamp();
    const after = Date.now();
    const parsed = new Date(ts).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after + 2000);
  });
});

// ---------------------------------------------------------------------------
// epochMs
// ---------------------------------------------------------------------------

describe('epochMs', () => {
  it('returns a number', () => {
    expect(typeof epochMs()).toBe('number');
  });

  it('returns a positive number', () => {
    expect(epochMs()).toBeGreaterThan(0);
  });

  it('is close to Date.now() within ±5000 ms', () => {
    const before = Date.now();
    const result = epochMs();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before - 5000);
    expect(result).toBeLessThanOrEqual(after + 5000);
  });

  it('returns an integer (millisecond precision)', () => {
    expect(Number.isInteger(epochMs())).toBe(true);
  });

  it('two successive calls are non-decreasing', () => {
    const first = epochMs();
    const second = epochMs();
    expect(second).toBeGreaterThanOrEqual(first);
  });
});

// ---------------------------------------------------------------------------
// readJson + writeJson — roundtrip
// ---------------------------------------------------------------------------

describe('readJson + writeJson — roundtrip', () => {
  it('reads back the same object that was written', async () => {
    const filePath = makeTmpPath('rjwj-test') + '.json';
    tmpCreated.push(filePath);
    const obj = { name: 'Alice', age: 30, active: true };

    await writeJson(filePath, obj);
    const result = await readJson(filePath);

    expect(result).toEqual({ name: 'Alice', age: 30, active: true });
  });

  it('written file contains pretty-printed JSON (2-space indent)', async () => {
    const filePath = makeTmpPath('pretty-test') + '.json';
    tmpCreated.push(filePath);

    await writeJson(filePath, { key: 'val' });
    const raw = await fs.readFile(filePath, 'utf8');

    // Pretty-printed JSON has newlines and spaces
    expect(raw).toContain('\n');
    expect(raw).toContain('  ');
  });

  it('written file ends with a newline', async () => {
    const filePath = makeTmpPath('newline-test') + '.json';
    tmpCreated.push(filePath);

    await writeJson(filePath, { x: 1 });
    const raw = await fs.readFile(filePath, 'utf8');

    expect(raw.endsWith('\n')).toBe(true);
  });

  it('roundtrips a nested object correctly', async () => {
    const filePath = makeTmpPath('nested') + '.json';
    tmpCreated.push(filePath);
    const obj = { outer: { inner: [1, 2, 3], flag: false } };

    await writeJson(filePath, obj);
    const result = await readJson(filePath);

    expect(result.outer.inner).toEqual([1, 2, 3]);
    expect(result.outer.flag).toBe(false);
  });

  it('roundtrips an array value correctly', async () => {
    const filePath = makeTmpPath('arr') + '.json';
    tmpCreated.push(filePath);

    await writeJson(filePath, [10, 20, 30]);
    const result = await readJson(filePath);

    expect(result).toEqual([10, 20, 30]);
  });
});

// ---------------------------------------------------------------------------
// writeJson — creates parent directory if missing
// ---------------------------------------------------------------------------

describe('writeJson — creates parent directory if missing', () => {
  it('creates all missing parent directories', async () => {
    const base = makeTmpPath('wjdir');
    tmpCreated.push(base);
    const filePath = path.join(base, 'deep', 'nested', 'file.json');

    await writeJson(filePath, { created: true });
    const result = await readJson(filePath);

    expect(result.created).toBe(true);
  });

  it('does not throw when parent already exists', async () => {
    const dir = makeTmpPath('existing-dir');
    tmpCreated.push(dir);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'file.json');

    await expect(writeJson(filePath, { x: 'y' })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readJson — error paths
// ---------------------------------------------------------------------------

describe('readJson — error paths', () => {
  it('throws when file does not exist (ENOENT)', async () => {
    const missing = path.join(os.tmpdir(), `missing-${Date.now()}.json`);
    await expect(readJson(missing)).rejects.toThrow(/ENOENT/);
  });

  it('thrown error code is ENOENT for missing file', async () => {
    const missing = path.join(os.tmpdir(), `missing-${Date.now()}.json`);
    try {
      await readJson(missing);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('ENOENT');
    }
  });

  it('throws SyntaxError for invalid JSON content', async () => {
    const filePath = makeTmpPath('invalid-json') + '.json';
    tmpCreated.push(filePath);
    await fs.writeFile(filePath, 'not valid json {{{', 'utf8');

    await expect(readJson(filePath)).rejects.toThrow(SyntaxError);
  });

  it('throws SyntaxError for an empty file', async () => {
    const filePath = makeTmpPath('empty-json') + '.json';
    tmpCreated.push(filePath);
    await fs.writeFile(filePath, '', 'utf8');

    await expect(readJson(filePath)).rejects.toThrow(SyntaxError);
  });

  it('throws SyntaxError for a file with only whitespace', async () => {
    const filePath = makeTmpPath('ws-json') + '.json';
    tmpCreated.push(filePath);
    await fs.writeFile(filePath, '   \n  ', 'utf8');

    await expect(readJson(filePath)).rejects.toThrow(SyntaxError);
  });
});

// ---------------------------------------------------------------------------
// appendJsonl
// ---------------------------------------------------------------------------

describe('appendJsonl', () => {
  it('appends two objects as two separate JSONL lines', async () => {
    const filePath = makeTmpPath('ajl') + '.jsonl';
    tmpCreated.push(filePath);

    await appendJsonl(filePath, { event: 'first', ts: 1 });
    await appendJsonl(filePath, { event: 'second', ts: 2 });

    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('first line is a valid JSON object with expected values', async () => {
    const filePath = makeTmpPath('ajl-parse') + '.jsonl';
    tmpCreated.push(filePath);

    await appendJsonl(filePath, { id: 1, type: 'start' });
    await appendJsonl(filePath, { id: 2, type: 'end' });

    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n');
    const first = JSON.parse(lines[0]);
    expect(first.id).toBe(1);
    expect(first.type).toBe('start');
  });

  it('second line is a valid JSON object with expected values', async () => {
    const filePath = makeTmpPath('ajl-second') + '.jsonl';
    tmpCreated.push(filePath);

    await appendJsonl(filePath, { seq: 10 });
    await appendJsonl(filePath, { seq: 20 });

    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n');
    const second = JSON.parse(lines[1]);
    expect(second.seq).toBe(20);
  });

  it('each JSONL line ends with a newline (no stray newlines in the middle)', async () => {
    const filePath = makeTmpPath('ajl-nl') + '.jsonl';
    tmpCreated.push(filePath);

    await appendJsonl(filePath, { a: 1 });
    const raw = await fs.readFile(filePath, 'utf8');

    // Should be exactly one line followed by '\n'
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n').filter((l) => l.trim()).length).toBe(1);
  });

  it('creates parent directory if missing', async () => {
    const base = makeTmpPath('ajldir');
    tmpCreated.push(base);
    const filePath = path.join(base, 'sub', 'events.jsonl');

    await appendJsonl(filePath, { created: true });

    const raw = await fs.readFile(filePath, 'utf8');
    const obj = JSON.parse(raw.trim());
    expect(obj.created).toBe(true);
  });

  it('does not overwrite existing content on second append', async () => {
    const filePath = makeTmpPath('ajl-noover') + '.jsonl';
    tmpCreated.push(filePath);

    await appendJsonl(filePath, { round: 1 });
    await appendJsonl(filePath, { round: 2 });
    await appendJsonl(filePath, { round: 3 });

    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).round).toBe(1);
    expect(JSON.parse(lines[2]).round).toBe(3);
  });
});
