/**
 * markdown-fences.test.mjs — pins the shared fence tracker extracted from
 * four duplicated copies (#1181).
 *
 * ## TV-001: the concrete bugs each case catches
 *
 * (a) **The one real divergence the four original copies had.** Three
 *     copies (`check-doc-cli-commands.mjs`, `check-skill-script-paths.mjs`,
 *     `check-vcs-repo-flag.mjs`) anchor the fence-line regex only at the
 *     START of the line; `auq/parse.mjs`'s copy anchored at BOTH ends. A
 *     fence opener carrying trailing text after its info string
 *     (`` ```bash trailing note ``) is a recognised shell fence under the
 *     first reading and NOT a fence line at all under the second — and the
 *     second failure mode is not merely "wrong language classification", it
 *     is a structural misparse: the real CLOSING fence a few lines later
 *     gets misread as a fresh OPENER. Collapsing `wholeLine` into one
 *     hardcoded behaviour during the #1181 extraction would have silently
 *     changed one side or the other; these tests prove the two readings are
 *     NOT interchangeable and that both are reachable via the option.
 * (b) **Nested-fence and unterminated-fence handling**, at a scenario none
 *     of the four original per-caller suites pin: a document with TWO
 *     fences, the first closed cleanly, the second left open at EOF. A
 *     tracker whose state does not correctly reset between fences would
 *     either report the FIRST opener's line as unbalanced (stale state) or
 *     miss the second fence opening entirely.
 * (c) **Language-tag normalisation.** The capturing regex allows uppercase
 *     letters in the info string (`` ```Bash ``), and every original copy
 *     lowercased before comparing against `SHELL_LANGS`. A caller that
 *     forgets to normalise silently drops every uppercase-tagged shell
 *     fence from its census — `normalizeLang()` is the one place this now
 *     has to be gotten right.
 *
 * @see scripts/lib/validate/markdown-fences.mjs
 * @see Issue #1181
 */

import { describe, expect, it } from 'vitest';

import {
  SHELL_LANGS,
  matchFenceLine,
  closesFence,
  normalizeLang,
  stripBlockquote,
  forEachLine,
  scanFenceBlocks,
} from '../../../scripts/lib/validate/markdown-fences.mjs';

// ---------------------------------------------------------------------------
// (a) wholeLine divergence
// ---------------------------------------------------------------------------

describe('matchFenceLine — wholeLine divergence (census case a)', () => {
  const line = '```bash trailing note';

  it('start-anchored (check-*.mjs reading) recognizes it as an open bash fence', () => {
    expect(matchFenceLine(line)).toEqual({ marker: '`', length: 3, info: 'bash' });
  });

  it('whole-line-anchored (auq/parse.mjs reading) does not recognize it as a fence line at all', () => {
    expect(matchFenceLine(line, { wholeLine: true })).toBeNull();
  });
});

describe('scanFenceBlocks — wholeLine option propagates through the block scanner (census case a)', () => {
  const text = ['```bash trailing', 'echo hi', '```', 'after'].join('\n');

  it('start-anchored default finds the block, trailing info text tolerated', () => {
    expect(scanFenceBlocks(text)).toEqual([
      { openLine: 1, closeLine: 3, lang: 'bash', bodyLines: ['echo hi'], bodyStartLine: 2 },
    ]);
  });

  it('wholeLine:true finds no block — the unrecognized opener lets the real closer misread as a fresh opener', () => {
    expect(scanFenceBlocks(text, { wholeLine: true })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) nested / unterminated fence handling
// ---------------------------------------------------------------------------

describe('closesFence / forEachLine — nested and unterminated fences (census case b)', () => {
  it('a shorter nested fence marker inside a wider fence is content, not a close', () => {
    const text = ['````', 'echo hi', '```', 'echo ho', '````'].join('\n');
    /** @type {Array<{ raw: string, inFence: boolean }>} */
    const seen = [];
    const { unbalancedFenceLine } = forEachLine(text, (raw, state) => seen.push({ raw, ...state }));
    expect(unbalancedFenceLine).toBeNull();
    expect(seen).toEqual([
      { raw: 'echo hi', lineNumber: 2, inFence: true, lang: '' },
      { raw: '```', lineNumber: 3, inFence: true, lang: '' },
      { raw: 'echo ho', lineNumber: 4, inFence: true, lang: '' },
    ]);
  });

  it('fence state resets after a clean close, so a SECOND unterminated fence reports its own opener line, not the first', () => {
    const text = ['prose', '```', 'closed body', '```', 'prose2', '```bash', 'open tail'].join('\n');
    const { unbalancedFenceLine } = forEachLine(text, () => {});
    expect(unbalancedFenceLine).toBe(6);
  });

  it('closesFence rejects a shorter or differently-charred candidate', () => {
    const open = { marker: '`', length: 4 };
    expect(closesFence(open, { marker: '`', length: 3, info: '' })).toBe(false);
    expect(closesFence(open, { marker: '~', length: 4, info: '' })).toBe(false);
    expect(closesFence(open, { marker: '`', length: 4, info: '' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (c) language-tag normalisation
// ---------------------------------------------------------------------------

describe('normalizeLang (census case c)', () => {
  it('trims and lowercases the info string', () => {
    expect(normalizeLang('  Bash  ')).toBe('bash');
  });

  it('an un-normalised uppercase tag would silently miss SHELL_LANGS membership without it', () => {
    expect(SHELL_LANGS.has('Bash')).toBe(false);
    expect(SHELL_LANGS.has(normalizeLang('Bash'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stripBlockquote — check-skill-script-paths.mjs's own caller-specific need
// ---------------------------------------------------------------------------

describe('stripBlockquote', () => {
  it('strips a leading blockquote chain so a quoted fence line is still detected', () => {
    expect(matchFenceLine(stripBlockquote('> ```bash'))).toEqual({ marker: '`', length: 3, info: 'bash' });
  });
});
