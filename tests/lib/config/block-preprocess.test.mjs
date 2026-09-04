/**
 * block-preprocess.test.mjs — Unit tests for scripts/lib/config/block-preprocess.mjs
 *
 * Every test names the bug it catches (TV-001). The module is the CONTRACT the
 * ~36 block parsers under scripts/lib/config/ migrate onto (#1162), so the two
 * things pinned here are (a) the two defects the preprocessor exists to fix and
 * (b) the two limits that make the NoDash variant necessary rather than
 * decorative.
 */

import { describe, it, expect } from 'vitest';
import {
  stripHtmlCommentBlocks,
  findUnterminatedComment,
  normalizeBoldSubkeys,
  preprocessBlockLines,
  preprocessBlockLinesNoDash,
} from '@lib/config/block-preprocess.mjs';

describe('stripHtmlCommentBlocks', () => {
  it('#1162a: drops a commented-out block so it cannot be read as live config', () => {
    // Bug: `<!--\nvault-integration:\n  enabled: true\n-->` was parsed as live
    // config by every raw-split parser — commenting a key out ARMED it.
    const lines = ['persistence: true', '<!--', 'vault-integration:', '  enabled: true', '-->', 'waves: 5'];
    expect(stripHtmlCommentBlocks(lines)).toEqual(['persistence: true', 'waves: 5']);
  });

  it('leaves a mid-line comment opener alone — it must NOT swallow the following lines', () => {
    // Bug: treating `waves: 5 <!--` as an opener would delete every following
    // key, which is the failure mode `htmlCommentSkipper`'s anchored `/^\s*<!--/`
    // ceiling exists to prevent. Single-line trailing comments are this repo's
    // own documented convention on heading and key lines.
    const lines = ['waves: 5 <!-- a note', 'enforcement: warn'];
    expect(stripHtmlCommentBlocks(lines)).toEqual(lines);
  });

  it('KEEPS a self-closing single-line `<!-- … -->` and the line after it', () => {
    // Measured behaviour of `htmlCommentSkipper`: a line that opens AND closes
    // on itself is not treated as an opener at all, so it is returned verbatim
    // and no state is carried. Harmless downstream — it matches no key regex —
    // and pinning it here is what makes "byte-identical to the skipper" checkable.
    const lines = ['<!-- a full-line note -->', 'waves: 5'];
    expect(stripHtmlCommentBlocks(lines)).toEqual(lines);
  });

  it('does NOT strip inside a fenced code block — parsers are fence-unaware by contract', () => {
    // Pinned limitation: tests/lib/config/frontend-slop-hook.test.mjs:134 asserts
    // a ```-fenced block IS parsed. Adding fence-awareness here would silently
    // change ~36 parsers at once, which is out of this contract's scope.
    const lines = ['```yaml', '<!--', 'enabled: true', '-->', '```'];
    expect(stripHtmlCommentBlocks(lines)).toEqual(['```yaml', '```']);
  });

  it('never touches a `- ` list marker', () => {
    const lines = ['  - alias: m5', '  - alias: m6'];
    expect(stripHtmlCommentBlocks(lines)).toEqual(lines);
  });

  it('carries no state between calls (fresh closure per call)', () => {
    // Bug: a shared skipper instance leaks an unterminated comment from one
    // document into the next, blanking the following document entirely. The
    // FIRST call's own result is the fail-closed contract below (unfiltered);
    // the subject here is that nothing of it survives into the SECOND call.
    expect(stripHtmlCommentBlocks(['<!--', 'enabled: true'])).toEqual(['<!--', 'enabled: true']);
    expect(stripHtmlCommentBlocks(['enabled: true'])).toEqual(['enabled: true']);
  });

  it('FAILS CLOSED on an unterminated `<!--`: returns the input unfiltered', () => {
    // Bug this catches: the skipper stays in the swallowing state to EOF, so
    // every block below a stray opener disappears and each parser falls back to
    // its default — config-protection silently degrading strict → warn, a guard
    // disarmed by a typo with no error anywhere. Unfiltered means nothing can
    // vanish; the opener is treated as literal text (pre-#1162 behaviour).
    const lines = ['waves: 5', '<!-- dangling', 'config-protection:', '  mode: strict'];
    expect(stripHtmlCommentBlocks(lines)).toEqual(lines);
  });

  it('reports the unterminated opener via onUnterminated and findUnterminatedComment', () => {
    // Bug this catches: failing closed silently would keep the config correct
    // and leave the operator unaware the document is malformed — no surface
    // could warn. Both the callback and the standalone predicate must name the
    // 1-based opener line.
    const lines = ['waves: 5', '<!-- dangling', 'config-protection:'];
    const seen = [];
    stripHtmlCommentBlocks(lines, (lineNo) => seen.push(lineNo));
    expect(seen).toEqual([2]);
    expect(findUnterminatedComment(lines)).toBe(2);
  });

  it('still strips a TERMINATED comment and reports no defect', () => {
    // The discriminator: fail-closed must not degrade into never-stripping.
    const lines = ['<!-- dead', '  enabled: true', '-->', 'waves: 5'];
    const seen = [];
    expect(stripHtmlCommentBlocks(lines, (n) => seen.push(n))).toEqual(['waves: 5']);
    expect(seen).toEqual([]);
    expect(findUnterminatedComment(lines)).toBeNull();
  });
});

describe('normalizeBoldSubkeys', () => {
  it.each([
    { why: '#1162b: `- **key:** value` (both markers inside)', input: '  - **enabled:** true', expected: '  enabled: true' },
    { why: '#1162b: `- **key**: value` (colon outside)', input: '  - **enabled**: true', expected: '  enabled: true' },
    { why: '#1162b: `**key:** value` (no dash)', input: '  **enabled:** true', expected: '  enabled: true' },
    { why: '#1162b: `**key**: value` (no dash, colon outside)', input: '  **enabled**: true', expected: '  enabled: true' },
  ])('$why', ({ input, expected }) => {
    expect(normalizeBoldSubkeys([input])).toEqual([expected]);
  });

  it('preserves leading indentation exactly — the indent IS the block membership test', () => {
    // Bug: every block parser breaks out of the block at the first non-indented
    // line, so an indent-eating rewrite would end the block one line early.
    expect(normalizeBoldSubkeys(['    - **mode:** strict'])).toEqual(['    mode: strict']);
    expect(normalizeBoldSubkeys(['- **mode:** strict'])).toEqual(['mode: strict']);
  });

  it('leaves a plain key line, a bare list item, and a blank line untouched', () => {
    const lines = ['  enabled: true', '  - infrastructure', ''];
    expect(normalizeBoldSubkeys(lines)).toEqual(lines);
  });

  it('normalises a valueless bold header to a bare `key:` (no trailing space)', () => {
    // A bold BLOCK header already matched via matchBlockHeader (#823); after
    // normalisation it is the plain form, which the same matcher still accepts.
    // The no-trailing-space shape matters: the header regexes end in `\s*$`, but
    // `NESTED_BLOCK_HEADER_RE` consumers read the same lines.
    expect(normalizeBoldSubkeys(['  - **vault-integration:**'])).toEqual(['  vault-integration:']);
  });

  it('does not touch `**` inside the VALUE', () => {
    expect(normalizeBoldSubkeys(['  - **note:** see **this**'])).toEqual(['  note: see **this**']);
  });
});

describe('preprocessBlockLines / preprocessBlockLinesNoDash', () => {
  it('preprocessBlockLines composes both passes on raw content', () => {
    const content = 'vault-integration:\r\n<!--\r\n  mode: strict\r\n-->\r\n  - **enabled:** true\r\n';
    expect(preprocessBlockLines(content)).toEqual(['vault-integration:', '  enabled: true', '']);
  });

  it('preprocessBlockLinesNoDash strips comments but leaves dash records intact', () => {
    // Bug this variant prevents: see the merge demo below.
    const content = '<!--\n  dead: true\n-->\nremote-hosts:\n  - **alias:** m5\n  - **alias:** m6\n';
    expect(preprocessBlockLinesNoDash(content)).toEqual([
      'remote-hosts:',
      '  - **alias:** m5',
      '  - **alias:** m6',
      '',
    ]);
  });

  it('DEMONSTRATES the documented merge risk: preprocessBlockLines de-dashes a record boundary', () => {
    // This is WHY preprocessBlockLinesNoDash exists. For custom-phases /
    // remote-hosts / evolve the `- ` marker IS the record separator; removing it
    // merges two records into one. Not a bug in this function — a named ceiling.
    const content = 'remote-hosts:\n  - **alias:** m5\n    roles-allowed: [test]\n  - **alias:** m6\n';
    const merged = preprocessBlockLines(content);
    expect(merged).toEqual(['remote-hosts:', '  alias: m5', '    roles-allowed: [test]', '  alias: m6', '']);
    // No line left carrying a record boundary → a dash-record parser sees ONE record.
    expect(merged.filter((l) => /^\s*-\s/.test(l))).toEqual([]);
  });

  it('returns an empty array for non-string content', () => {
    expect(preprocessBlockLines(undefined)).toEqual([]);
    expect(preprocessBlockLinesNoDash(null)).toEqual([]);
  });
});
