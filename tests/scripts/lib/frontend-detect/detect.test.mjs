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
  it('every rule has the required contract fields', () => {
    for (const r of RULES) {
      expect(typeof r.id, `id for ${r.id}`).toBe('string');
      expect(['high', 'medium', 'low']).toContain(r.severity);
      expect(['ai-slop', 'quality']).toContain(r.category);
      expect(['low', 'medium', 'high']).toContain(r.fpRisk);
      expect(typeof r.ruleRef, `ruleRef for ${r.id}`).toBe('string');
      expect(r.ruleRef.length).toBeGreaterThan(0);
      expect(typeof r.scan).toBe('function');
    }
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

describe('gradient-text', () => {
  it('FLAGS background-clip:text combined with a gradient', () => {
    const css = `.title {
      background: linear-gradient(90deg, #ff0080, #ffcc00);
      -webkit-background-clip: text;
      color: transparent;
    }`;
    expect(rulesFired(css)).toContain('gradient-text');
  });

  it('FLAGS the Tailwind bg-clip-text utility', () => {
    expect(rulesFired('<h1 class="bg-clip-text text-transparent bg-gradient-to-r">Hi</h1>', 'a.tsx')).toContain(
      'gradient-text',
    );
  });

  it('does NOT flag a gradient background without clip:text', () => {
    const css = `.hero { background: linear-gradient(90deg, #ff0080, #ffcc00); }`;
    expect(rulesFired(css)).not.toContain('gradient-text');
  });

  it('does NOT flag background-clip:border-box (the normal value)', () => {
    const css = `.box { background-clip: border-box; background: linear-gradient(0deg,#111,#222); }`;
    expect(rulesFired(css)).not.toContain('gradient-text');
  });
});

describe('side-stripe-border', () => {
  it('FLAGS border-left: 4px solid <color>', () => {
    expect(rulesFired('.alert { border-left: 4px solid #f59e0b; }')).toContain('side-stripe-border');
  });

  it('FLAGS Tailwind border-l-4', () => {
    expect(rulesFired('<div class="border-l-4 border-amber-500">', 'a.tsx')).toContain('side-stripe-border');
  });

  it('does NOT flag a 1px side border (legitimate hairline)', () => {
    expect(rulesFired('.cell { border-left: 1px solid #eee; }')).not.toContain('side-stripe-border');
  });

  it('does NOT flag a full 2px border (border:, not border-left:)', () => {
    expect(rulesFired('.btn { border: 2px solid #000; }')).not.toContain('side-stripe-border');
  });

  it('does NOT flag a transparent side border (spacing trick)', () => {
    expect(rulesFired('.x { border-left: 4px solid transparent; }')).not.toContain('side-stripe-border');
  });
});

describe('overused-font', () => {
  it('FLAGS Inter as the primary font', () => {
    expect(rulesFired('body { font-family: Inter, sans-serif; }')).toContain('overused-font');
  });

  it('FLAGS quoted "Roboto" primary', () => {
    expect(rulesFired('h1 { font-family: "Roboto", Arial, sans-serif; }')).toContain('overused-font');
  });

  it('does NOT flag Arial used only as a fallback', () => {
    expect(rulesFired('body { font-family: "Söhne", Arial, sans-serif; }')).not.toContain('overused-font');
  });
});

describe('bounce-easing', () => {
  it('FLAGS the keyword "bounce"', () => {
    expect(rulesFired('.x { animation: bounce 1s; }')).toContain('bounce-easing');
  });

  it('FLAGS an overshoot cubic-bezier (y > 1)', () => {
    expect(rulesFired('.x { transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1); }')).toContain(
      'bounce-easing',
    );
  });

  it('does NOT flag a standard ease-out cubic-bezier', () => {
    expect(rulesFired('.x { transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1); }')).not.toContain(
      'bounce-easing',
    );
  });
});

describe('ai-purple-gradient', () => {
  it('FLAGS a purple→blue gradient', () => {
    expect(rulesFired('.hero { background: linear-gradient(135deg, #8b5cf6, #3b82f6); }')).toContain(
      'ai-purple-gradient',
    );
  });

  it('FLAGS a two-purple gradient by name', () => {
    expect(rulesFired('.hero { background: linear-gradient(90deg, violet, purple); }')).toContain(
      'ai-purple-gradient',
    );
  });

  it('does NOT flag a single-color (non-purple) gradient', () => {
    expect(rulesFired('.hero { background: linear-gradient(90deg, #f97316, #fb923c); }')).not.toContain(
      'ai-purple-gradient',
    );
  });

  it('does NOT flag a single purple stop (could be brand)', () => {
    expect(rulesFired('.hero { background: linear-gradient(90deg, purple, #fff); }')).not.toContain(
      'ai-purple-gradient',
    );
  });
});

describe('pure-black-ink', () => {
  it('FLAGS color:#000', () => {
    expect(rulesFired('body { color: #000; }')).toContain('pure-black-ink');
  });

  it('FLAGS color: black', () => {
    expect(rulesFired('body { color: black; }')).toContain('pure-black-ink');
  });

  it('does NOT flag a tinted near-black ink', () => {
    expect(rulesFired('body { color: oklch(20% 0.02 260); }')).not.toContain('pure-black-ink');
  });

  it('does NOT flag a black BACKGROUND (rule targets text only)', () => {
    expect(rulesFired('body { background: #000; }')).not.toContain('pure-black-ink');
  });
});

describe('arbitrary-z-index', () => {
  it('FLAGS z-index: 9999', () => {
    expect(rulesFired('.toast { z-index: 9999; }')).toContain('arbitrary-z-index');
  });

  it('does NOT flag a small explicit z-index', () => {
    expect(rulesFired('.dropdown { z-index: 30; }')).not.toContain('arbitrary-z-index');
  });

  it('does NOT flag a semantic z-index variable', () => {
    expect(rulesFired('.modal { z-index: var(--z-modal); }')).not.toContain('arbitrary-z-index');
  });
});

describe('layout-property-transition', () => {
  it('FLAGS transition: width', () => {
    expect(rulesFired('.x { transition: width 200ms ease; }')).toContain('layout-property-transition');
  });

  it('does NOT flag transition: opacity/transform', () => {
    expect(rulesFired('.x { transition: opacity 200ms ease, transform 200ms ease; }')).not.toContain(
      'layout-property-transition',
    );
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
  it('SCANNABLE_EXTS covers the common frontend file types', () => {
    for (const ext of ['.css', '.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro']) {
      expect(SCANNABLE_EXTS.has(ext)).toBe(true);
    }
  });

  it('skips a non-existent / non-scannable path without throwing', () => {
    expect(() => detectFiles(['/nonexistent/file.css', '/x/readme.md'])).not.toThrow();
    expect(detectFiles(['/x/readme.md'])).toHaveLength(0);
  });
});
