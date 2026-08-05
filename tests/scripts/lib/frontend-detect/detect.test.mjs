/**
 * tests/scripts/lib/frontend-detect/detect.test.mjs
 *
 * Fixture-first detector tests. Each rule MUST have:
 *   - at least one FLAG fixture (a real tell the rule must catch), and
 *   - at least one CLEAN fixture (a plausible shape the rule must NOT flag).
 *
 * This false-positive discipline is the load-bearing part — a heuristic
 * detector that only proves it catches positives is worthless, because it can
 * drift into flagging everything. Borrowed from impeccable's AGENTS.md TDD rule.
 */

import { describe, it, expect } from 'vitest';
import { detectContent, detectFiles, summarize, SCANNABLE_EXTS } from '@lib/frontend-detect/detect.mjs';
import { RULES, RULE_IDS } from '@lib/frontend-detect/rules.mjs';

/** Helper: which rule ids fired for this content. */
function rulesFired(content, file = 'x.css') {
  return new Set(detectContent(content, file).map((f) => f.rule));
}

describe('frontend-detect registry invariants', () => {
  it.each(RULES.map((r) => [r.id, r]))('rule %s carries the required contract fields', (_id, r) => {
    expect(typeof r.id).toBe('string');
    expect(['high', 'medium', 'low']).toContain(r.severity);
    expect(['ai-slop', 'quality']).toContain(r.category);
    expect(['low', 'medium', 'high']).toContain(r.fpRisk);
    expect(typeof r.ruleRef).toBe('string');
    expect(r.ruleRef.length).toBeGreaterThan(0);
    expect(typeof r.scan).toBe('function');
  });

  it('rule ids are unique', () => {
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
  });

  it('a clean, well-built stylesheet produces zero findings', () => {
    const clean = `
      :root { --ink: oklch(22% 0.02 260); --brand: oklch(62% 0.17 250); }
      body { color: var(--ink); font-family: "Söhne", Georgia, serif; }
      .card { border: 1px solid oklch(90% 0.01 260); border-radius: 12px; }
      .fade { transition: opacity 200ms cubic-bezier(0.22, 1, 0.36, 1); }
      .modal { z-index: var(--z-modal); }
    `;
    expect(detectContent(clean, 'clean.css')).toHaveLength(0);
  });
});

// Per-rule FLAG / CLEAN fixture pairs — the load-bearing contract from the
// docblock above, as two tables. Every rule id MUST appear in BOTH tables:
// FLAG rows are real tells the rule must catch, CLEAN rows are plausible shapes
// it must NOT flag. (`rulesFired` defaults the filename to x.css; rows that need
// a JSX/TSX-only tell pass their own.)

describe('per-rule FLAG fixtures — the rule must fire', () => {
  it.each([
    {
      rule: 'gradient-text',
      why: 'background-clip:text combined with a gradient',
      content: `.title {
      background: linear-gradient(90deg, #ff0080, #ffcc00);
      -webkit-background-clip: text;
      color: transparent;
    }`,
    },
    {
      rule: 'gradient-text',
      why: 'the Tailwind bg-clip-text utility',
      content: '<h1 class="bg-clip-text text-transparent bg-gradient-to-r">Hi</h1>',
      file: 'a.tsx',
    },
    { rule: 'side-stripe-border', why: 'border-left: 4px solid <color>', content: '.alert { border-left: 4px solid #f59e0b; }' },
    { rule: 'side-stripe-border', why: 'Tailwind border-l-4', content: '<div class="border-l-4 border-amber-500">', file: 'a.tsx' },
    { rule: 'overused-font', why: 'Inter as the primary font', content: 'body { font-family: Inter, sans-serif; }' },
    { rule: 'overused-font', why: 'quoted "Roboto" primary', content: 'h1 { font-family: "Roboto", Arial, sans-serif; }' },
    { rule: 'bounce-easing', why: 'the keyword "bounce"', content: '.x { animation: bounce 1s; }' },
    { rule: 'bounce-easing', why: 'an overshoot cubic-bezier (y > 1)', content: '.x { transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1); }' },
    { rule: 'ai-purple-gradient', why: 'a purple to blue gradient', content: '.hero { background: linear-gradient(135deg, #8b5cf6, #3b82f6); }' },
    { rule: 'ai-purple-gradient', why: 'a two-purple gradient by name', content: '.hero { background: linear-gradient(90deg, violet, purple); }' },
    { rule: 'pure-black-ink', why: 'color:#000', content: 'body { color: #000; }' },
    { rule: 'pure-black-ink', why: 'color: black', content: 'body { color: black; }' },
    { rule: 'arbitrary-z-index', why: 'z-index: 9999', content: '.toast { z-index: 9999; }' },
    { rule: 'layout-property-transition', why: 'transition: width', content: '.x { transition: width 200ms ease; }' },
  ])('$rule FLAGS $why', ({ rule, content, file }) => {
    expect(rulesFired(content, file)).toContain(rule);
  });
});

describe('per-rule CLEAN fixtures — the rule must NOT fire (false-positive guard)', () => {
  it.each([
    { rule: 'gradient-text', why: 'a gradient background without clip:text', content: '.hero { background: linear-gradient(90deg, #ff0080, #ffcc00); }' },
    { rule: 'gradient-text', why: 'background-clip:border-box (the normal value)', content: '.box { background-clip: border-box; background: linear-gradient(0deg,#111,#222); }' },
    { rule: 'side-stripe-border', why: 'a 1px side border (legitimate hairline)', content: '.cell { border-left: 1px solid #eee; }' },
    { rule: 'side-stripe-border', why: 'a full 2px border (border:, not border-left:)', content: '.btn { border: 2px solid #000; }' },
    { rule: 'side-stripe-border', why: 'a transparent side border (spacing trick)', content: '.x { border-left: 4px solid transparent; }' },
    { rule: 'overused-font', why: 'Arial used only as a fallback', content: 'body { font-family: "Söhne", Arial, sans-serif; }' },
    { rule: 'bounce-easing', why: 'a standard ease-out cubic-bezier', content: '.x { transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1); }' },
    { rule: 'ai-purple-gradient', why: 'a single-color (non-purple) gradient', content: '.hero { background: linear-gradient(90deg, #f97316, #fb923c); }' },
    { rule: 'ai-purple-gradient', why: 'a single purple stop (could be brand)', content: '.hero { background: linear-gradient(90deg, purple, #fff); }' },
    { rule: 'pure-black-ink', why: 'a tinted near-black ink', content: 'body { color: oklch(20% 0.02 260); }' },
    { rule: 'pure-black-ink', why: 'a black BACKGROUND (rule targets text only)', content: 'body { background: #000; }' },
    { rule: 'arbitrary-z-index', why: 'a small explicit z-index', content: '.dropdown { z-index: 30; }' },
    { rule: 'arbitrary-z-index', why: 'a semantic z-index variable', content: '.modal { z-index: var(--z-modal); }' },
    { rule: 'layout-property-transition', why: 'transition: opacity/transform', content: '.x { transition: opacity 200ms ease, transform 200ms ease; }' },
  ])('$rule does NOT flag $why', ({ rule, content, file }) => {
    expect(rulesFired(content, file)).not.toContain(rule);
  });
});

// Every registered rule id must own at least one FLAG and one CLEAN fixture
// above — this guard is what stops a newly registered rule from shipping
// with no fixture pair at all (the docblock contract, mechanically enforced).
describe('fixture-coverage contract', () => {
  it('every registered rule id appears in the fixture tables', () => {
    const covered = new Set([
      'gradient-text',
      'side-stripe-border',
      'overused-font',
      'bounce-easing',
      'ai-purple-gradient',
      'pure-black-ink',
      'arbitrary-z-index',
      'layout-property-transition',
    ]);
    expect(RULE_IDS.filter((id) => !covered.has(id))).toEqual([]);
  });
});

describe('detectContent — output shape + config', () => {
  it('reports correct line numbers', () => {
    const css = 'a{}\nb{}\n.alert { border-left: 4px solid red; }\n';
    const f = detectContent(css, 'x.css').find((x) => x.rule === 'side-stripe-border');
    expect(f).toBeDefined();
    expect(f.line).toBe(3);
  });

  it('honors ignoreRules', () => {
    const css = 'body { color: #000; }';
    expect(rulesFired(css)).toContain('pure-black-ink');
    const findings = detectContent(css, 'x.css', { ignoreRules: ['pure-black-ink'] });
    expect(findings.map((f) => f.rule)).not.toContain('pure-black-ink');
  });

  it('a single rule that throws does not crash the whole scan', () => {
    // Sanity: feeding adversarial input never throws.
    const weird = ' '.repeat(50) + 'cubic-bezier(' + 'x'.repeat(10);
    expect(() => detectContent(weird, 'x.css')).not.toThrow();
  });
});

describe('summarize', () => {
  it('rolls up severity + category counts', () => {
    const css = `
      .a { border-left: 4px solid red; }
      body { color: #000; }
      .t { background: linear-gradient(90deg,#8b5cf6,#6366f1); }
    `;
    const findings = detectContent(css, 'x.css');
    const s = summarize(findings);
    expect(s.total).toBe(findings.length);
    expect(s.high + s.medium + s.low).toBe(s.total);
    expect(s.aiSlop + s.quality).toBe(s.total);
    expect(s.byRule['side-stripe-border']).toBe(1);
  });
});

describe('detectFiles — extension gating', () => {
  it.each(['.css', '.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro'])(
    'SCANNABLE_EXTS covers %s',
    (ext) => {
      expect(SCANNABLE_EXTS.has(ext)).toBe(true);
    },
  );

  it('skips a non-existent / non-scannable path without throwing', () => {
    expect(() => detectFiles(['/nonexistent/file.css', '/x/readme.md'])).not.toThrow();
    expect(detectFiles(['/x/readme.md'])).toHaveLength(0);
  });
});
