import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readTailWindow } from '../../scripts/lib/tail-window.mjs';

describe('readTailWindow', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('cuts inside a multi-byte char mid-line: cut=true, remaining lines are whole records', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tail-window-'));
    const file = path.join(dir, 'ledger.jsonl');
    const lines = [];
    for (let i = 0; i < 40; i += 1) lines.push(JSON.stringify({ i, s: 'äöü€'.repeat(5) }));
    const content = lines.join('\n') + '\n';
    writeFileSync(file, content);

    // Place the window start on the 2nd byte of the first '€' (3-byte sequence)
    // of record 30 — mid-line AND mid-character.
    const prefix = Buffer.byteLength(lines.slice(0, 30).join('\n') + '\n');
    const inLine = Buffer.byteLength('{"i":30,"s":"äöü'); // bytes before the first '€'
    const start = prefix + inLine + 1;
    const total = Buffer.byteLength(content);

    const w = readTailWindow(file, total - start);
    expect(w.cut).toBe(true);
    expect(w.size).toBe(total);
    // The fragment starts at the 2nd byte of '€': two orphan continuation
    // bytes decode to two U+FFFD — pins the start offset to the exact byte.
    expect(w.text.split('\n')[0]).toBe('��' + 'äöü€'.repeat(4) + '"}');

    const recs = w.text.split('\n').slice(1).filter(Boolean).map((l) => JSON.parse(l));
    expect(recs.map((r) => r.i)).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39]);
  });

  it('file smaller than the window: cut=false, full text', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tail-window-'));
    const file = path.join(dir, 'small.jsonl');
    const text = '{"a":1}\n{"b":"€"}\n';
    writeFileSync(file, text);
    const w = readTailWindow(file, 64 * 1024);
    expect(w).toEqual({ text, cut: false, size: Buffer.byteLength(text) });
  });
});
