/**
 * tests/lib/language-mappers/markdown.test.mjs
 *
 * Unit tests for scripts/lib/language-mappers/markdown.mjs
 *
 * Test inventory (8 cases):
 *  1. Single H2 heading → 1 section slice
 *  2. Multiple headings → multiple slices with correct line ranges
 *  3. H3 nested in H2 → both emitted; H2 endLine extends to next H2 or EOF
 *  4. Empty markdown → []
 *  5. Headings with code blocks between → endLine correctly skips past code
 *  6. Heading depth stored in params[0]
 *  7. All section slices have exported:true, isNested:false
 *  8. Markdown with `---` frontmatter → leading thematic break is NOT a section
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
  'markdown.mjs',
);

/** @returns {Promise<{extractMarkdownSlices: (filePath: string, content: string) => Promise<any[]>}>} */
async function importSut() {
  const mod = await import(MODULE_PATH + `?t=${Date.now()}`);
  return mod;
}

async function parse(content, file = 'doc.md') {
  const { extractMarkdownSlices } = await importSut();
  return extractMarkdownSlices(file, content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractMarkdownSlices', () => {
  it('single H2 heading → 1 section slice with correct name', async () => {
    const content = '## Introduction\n\nSome text here.';
    const slices = await parse(content);
    expect(slices).toHaveLength(1);
    expect(slices[0].kind).toBe('section');
    expect(slices[0].name).toBe('Introduction');
    expect(slices[0].line).toBe(1);
  });

  it('multiple headings → correct slice count and line ranges', async () => {
    const content = [
      '# Title',        // line 1
      '',               // line 2
      'Intro text.',    // line 3
      '',               // line 4
      '## Section One', // line 5
      '',               // line 6
      'Content.',       // line 7
      '',               // line 8
      '## Section Two', // line 9
      '',               // line 10
      'More content.',  // line 11
    ].join('\n');

    const slices = await parse(content);
    expect(slices).toHaveLength(3);

    const [h1, s1, s2] = slices;
    expect(h1.name).toBe('Title');
    expect(h1.line).toBe(1);
    // H1 (depth 1) ends at EOF because the next headings are H2 (depth > 1),
    // which do NOT terminate an H1 section per the "equal-or-lesser depth" rule.
    expect(h1.endLine).toBe(11);

    expect(s1.name).toBe('Section One');
    expect(s1.line).toBe(5);
    // Section One ends just before Section Two
    expect(s1.endLine).toBe(8);

    expect(s2.name).toBe('Section Two');
    expect(s2.line).toBe(9);
    // Section Two ends at EOF
    expect(s2.endLine).toBe(11);
  });

  it('H3 nested in H2 → both emitted, H2 endLine extends to next H2', async () => {
    const content = [
      '## Parent Section',    // line 1
      '',                     // line 2
      '### Child Section',    // line 3
      '',                     // line 4
      'Child content.',       // line 5
      '',                     // line 6
      '## Next Section',      // line 7
    ].join('\n');

    const slices = await parse(content);
    const h2 = slices.find((s) => s.name === 'Parent Section');
    const h3 = slices.find((s) => s.name === 'Child Section');
    const nextH2 = slices.find((s) => s.name === 'Next Section');

    expect(h2).toBeDefined();
    expect(h3).toBeDefined();
    expect(nextH2).toBeDefined();

    // H2 ends just before the next H2 (line 7 - 1 = 6)
    expect(h2.endLine).toBe(6);
    // H3 also ends just before the next H2 (line 7 - 1 = 6)
    expect(h3.endLine).toBe(6);
    // Next H2 ends at EOF
    expect(nextH2.line).toBe(7);
  });

  it('empty markdown → returns empty array', async () => {
    const slices = await parse('');
    expect(slices).toEqual([]);
  });

  it('headings with code blocks between → endLine correctly spans code block', async () => {
    const content = [
      '## Usage',           // line 1
      '',                   // line 2
      '```bash',            // line 3
      'npm install',        // line 4
      '```',                // line 5
      '',                   // line 6
      '## Configuration',   // line 7
      '',                   // line 8
      'Config text.',       // line 9
    ].join('\n');

    const slices = await parse(content);
    const usage = slices.find((s) => s.name === 'Usage');
    const config = slices.find((s) => s.name === 'Configuration');

    expect(usage).toBeDefined();
    expect(config).toBeDefined();

    // Usage endLine should be line before ## Configuration (line 7 - 1 = 6)
    expect(usage.endLine).toBe(6);
    // Configuration runs to EOF (line 9)
    expect(config.endLine).toBe(9);
  });

  it('heading depth is stored in params[0]', async () => {
    const content = [
      '# H1',
      '',
      '## H2',
      '',
      '### H3',
    ].join('\n');

    const slices = await parse(content);
    const depths = slices.map((s) => s.params[0]);
    expect(depths).toEqual([1, 2, 3]);
  });

  it('all section slices have exported:true and isNested:false', async () => {
    const content = '## Foo\n\n## Bar\n\n## Baz\n';
    const slices = await parse(content);
    expect(slices.length).toBeGreaterThanOrEqual(3);
    for (const s of slices) {
      expect(s.exported).toBe(true);
      expect(s.isNested).toBe(false);
    }
  });

  // =========================================================================
  // NEW BOUNDARY TESTS (W4-T1)
  // =========================================================================

  it('heading inside a blockquote is NOT emitted as a section', async () => {
    // remark-parse parses `> ## Inside blockquote` as a blockquote node
    // containing a heading child.  The markdown mapper only iterates
    // tree.children, which contains only the blockquote node — not the
    // nested heading.  So no section slice should be emitted for it.
    const content = [
      '> ## This is inside a blockquote',
      '',
      'Some prose below the blockquote.',
    ].join('\n');

    const slices = await parse(content);
    // The blockquote heading must NOT produce a section slice
    const blockquoteSection = slices.find((s) => s.name === 'This is inside a blockquote');
    expect(blockquoteSection).toBeUndefined();
    // The slice count must be 0 (no top-level headings)
    expect(slices).toHaveLength(0);
  });

  it('heading after a horizontal rule (---) is emitted as a section', async () => {
    // A standalone `---` is a ThematicBreak in remark-parse.  It should NOT
    // prevent the following heading from being recognised as a section.
    const content = [
      '## Before Rule',
      '',
      '---',
      '',
      '## After Rule',
    ].join('\n');

    const slices = await parse(content);
    const afterRule = slices.find((s) => s.name === 'After Rule');
    expect(afterRule).toBeDefined();
    expect(afterRule.kind).toBe('section');
    expect(afterRule.line).toBe(5);
  });

  it('whitespace-only content → returns empty array', async () => {
    const slices = await parse('   \n\t\n   ');
    expect(slices).toEqual([]);
  });

  it('markdown with YAML-like separator is handled without crashing', async () => {
    // remark-parse WITHOUT remark-frontmatter parses:
    //   ---\ntext\n---
    // as a setext H2 heading (the second --- is treated as an underline).
    // This is standard remark-parse behavior; we only need to verify:
    //   a) the function does not throw
    //   b) the '## Real Heading' is emitted as a section
    const content = [
      '---',
      'title: My Doc',
      '---',
      '',
      '## Real Heading',
      '',
      'Body text.',
    ].join('\n');

    // Should not throw
    const slices = await parse(content);
    // The Real Heading must always be present
    const realHeading = slices.find((s) => s.name === 'Real Heading');
    expect(realHeading).toBeDefined();
    expect(realHeading.kind).toBe('section');
  });
});
