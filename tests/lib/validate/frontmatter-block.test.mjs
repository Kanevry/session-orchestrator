/**
 * tests/lib/validate/frontmatter-block.test.mjs
 *
 * Tests for scripts/lib/validate/frontmatter-block.mjs — the frontmatter-block
 * extraction primitive shared by check-skills.mjs and check-commands.mjs.
 *
 * Bug class this locks in (TV-001): the extraction stood VERBATIM in both checkers
 * (check-skills.mjs:64 and check-commands.mjs:40, bodies byte-identical, the only diff
 * being JSDoc prose). A change to the block format — BOM tolerance, a new delimiter
 * spelling, a different closer search — lands in one copy. From then on one gate accepts
 * what the other rejects, and NO test sees it, because each gate exercised its own copy
 * through its own fixtures. Hoisting the function is the fix; this file is the contract
 * the two callers now share, and the two-suite fake-regression (break this body → both
 * check-skills.test.mjs and check-commands.test.mjs go red) is the proof they share it.
 *
 * SCOPE: extraction only. The RULES of the three frontmatter checkers diverge on purpose
 * (check-agents bans `description: >`, check-skills requires allowing it) and are NOT
 * tested here — see the module header.
 *
 * The two sharp-edge cases below (`---` inside the block, CRLF) DOCUMENT the current
 * body rather than propose a better one. A behaviour change in a primitive sitting under
 * two gates is its own task; these assertions exist so that such a change cannot happen
 * silently.
 */

import { describe, it, expect } from 'vitest';

import { extractInitialFrontmatter } from '../../../scripts/lib/validate/frontmatter-block.mjs';

describe('extractInitialFrontmatter — well-formed block', () => {
  it('returns the inner text without the fences', () => {
    const content = '---\nname: demo\ndescription: Use when a control fixture is needed.\n---\n\n# Body\n';

    expect(extractInitialFrontmatter(content)).toEqual({
      ok: true,
      yamlText: 'name: demo\ndescription: Use when a control fixture is needed.',
    });
  });

  it('returns an empty yamlText for an empty block rather than failing', () => {
    expect(extractInitialFrontmatter('---\n---\n\n# Body\n')).toEqual({ ok: true, yamlText: '' });
  });

  it('preserves a folded block scalar verbatim — the SKILL.md repair form must survive extraction', () => {
    const content = '---\nname: demo\ndescription: >\n  Use when the text contains Iron Law: NO FIXES\n  and must not collide.\n---\n';

    expect(extractInitialFrontmatter(content)).toEqual({
      ok: true,
      yamlText: 'name: demo\ndescription: >\n  Use when the text contains Iron Law: NO FIXES\n  and must not collide.',
    });
  });
});

describe('extractInitialFrontmatter — the documented non-result', () => {
  it('reports a missing opening delimiter and carries NO yamlText to fall through to', () => {
    const result = extractInitialFrontmatter('# No Frontmatter\n\nBody only.\n');

    expect(result).toEqual({ ok: false, diagnostic: 'missing YAML frontmatter opening delimiter' });
    expect(result.yamlText).toBeUndefined();
  });

  it('treats a fence that is not the very first line as a missing opener', () => {
    expect(extractInitialFrontmatter('\n---\nname: demo\n---\n')).toEqual({
      ok: false,
      diagnostic: 'missing YAML frontmatter opening delimiter',
    });
  });

  it('reports a missing closing delimiter when the fence is never closed', () => {
    const result = extractInitialFrontmatter('---\nname: unclosed\ndescription: Use when the fence never closes.\n');

    expect(result).toEqual({ ok: false, diagnostic: 'missing YAML frontmatter closing delimiter' });
    expect(result.yamlText).toBeUndefined();
  });
});

describe('extractInitialFrontmatter — sharp edges pinned as-is (status quo, not endorsement)', () => {
  it('stops at a column-0 `---` INSIDE the block, leaking the remainder into the body', () => {
    // A `---` at column 0 inside a multi-line value ends the block early: the closer
    // search is a plain line-equality scan with no scalar-awareness. Documented, not
    // fixed — changing it changes what two gates accept in the same commit.
    const content = '---\nname: demo\nbanner: |\n---\nafter: leaked\n---\n';

    expect(extractInitialFrontmatter(content)).toEqual({
      ok: true,
      yamlText: 'name: demo\nbanner: |',
    });
  });

  it('does NOT stop at an indented `---`, because the scan requires exact line equality', () => {
    const content = '---\nname: demo\nbanner: |\n  ---\nafter: kept\n---\n';

    expect(extractInitialFrontmatter(content)).toEqual({
      ok: true,
      yamlText: 'name: demo\nbanner: |\n  ---\nafter: kept',
    });
  });

  it('accepts CRLF line endings and returns LF-normalised text', () => {
    const content = '---\r\nname: demo\r\ndescription: Use when the file has Windows line endings.\r\n---\r\n\r\n# Body\r\n';

    expect(extractInitialFrontmatter(content)).toEqual({
      ok: true,
      yamlText: 'name: demo\ndescription: Use when the file has Windows line endings.',
    });
  });

  it('rejects a leading BOM as a missing opener — the BOM is part of the first line', () => {
    // Constructed, never written literally: a raw U+FEFF in a tracked source file is an
    // invisible character that check-unicode-safety.mjs exists to keep out of this tree.
    const BOM = String.fromCharCode(0xfeff);

    expect(extractInitialFrontmatter(`${BOM}---\nname: demo\n---\n`)).toEqual({
      ok: false,
      diagnostic: 'missing YAML frontmatter opening delimiter',
    });
  });
});
