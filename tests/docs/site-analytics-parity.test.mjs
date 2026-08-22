/**
 * tests/docs/site-analytics-parity.test.mjs
 *
 * Three guards over the SHIPPED `site/` artefacts, added when Vercel Web
 * Analytics was wired in (2026-08-22). Each names the bug it catches
 * (`.claude/rules/test-value.md` TV-001); none pins prose.
 *
 *  1. EVERY page carries the measurement snippet. `site/guide/` was added on
 *     2026-08-19 to a site that had three pages — the next page is a matter of
 *     weeks, and a page that ships without the snippet is invisible in the
 *     dashboard while looking completely normal in the repo. There is no build
 *     step and no shared layout here: four hand-authored HTML files are the
 *     whole site, so nothing but this test connects them.
 *
 *  2. The snippet stays SAME-ORIGIN. `@vercel/analytics@2.0.1` ships two script
 *     URLs — `/_vercel/insights/script.js` for production and
 *     `https://va.vercel-scripts.com/v1/script.debug.js` for debug mode. Pasting
 *     the debug one (or any absolute URL) breaks two things at once and neither
 *     is visible locally: `vercel.json`'s CSP is `script-src 'self'`, so the
 *     browser blocks it and the dashboard silently stays at zero; and
 *     `/datenschutz` states that no request leaves this domain, which would
 *     become false. This test is the only place those two facts meet.
 *
 *  3. `/datenschutz` stays internally consistent. Its sections are hand-numbered
 *     (`<p class="mark">04 — …`), listed in a hand-numbered table of contents,
 *     and cross-referenced in prose as "Punkt 09". Inserting the analytics
 *     section renumbered seven of them; the next insertion will renumber more.
 *     A stale "Punkt 09" points the reader at the wrong section, which on a
 *     legal page is a defect rather than a typo.
 *
 * The tests read the real files on purpose: every claim above is about what is
 * SERVED, so a fixture copy would make all three vacuous.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Production script path. Same-origin by construction — no scheme, no host. */
const SCRIPT_SRC = '/_vercel/insights/script.js';

const PAGES = globSync('site/**/*.html', { cwd: REPO_ROOT }).sort();
const read = (rel) => readFileSync(new URL(rel, new URL('file://' + REPO_ROOT + '/')), 'utf8');

describe('site: Vercel Web Analytics wiring', () => {
  it('finds the hand-authored pages at all (guards the glob itself)', () => {
    // A glob that silently matches nothing would make every assertion below
    // pass over an empty list — the failure mode this file exists to prevent.
    expect(PAGES.length).toBeGreaterThanOrEqual(4);
    expect(PAGES).toContain('site/index.html');
  });

  it('every page loads the measurement script', () => {
    const missing = PAGES.filter((p) => !read(p).includes(`src="${SCRIPT_SRC}"`));
    expect(missing, `pages without ${SCRIPT_SRC}`).toEqual([]);
  });

  it('no page loads it from a foreign origin', () => {
    // Catches the debug URL and any other absolute src: both defeat the CSP and
    // falsify the "kein fremder Host" statement in /datenschutz.
    const foreign = [];
    for (const p of PAGES) {
      for (const m of read(p).matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) {
        if (!m[1].startsWith('/')) foreign.push(`${p}: ${m[1]}`);
      }
    }
    expect(foreign, 'script src values that are not same-origin').toEqual([]);
  });

  it("vercel.json's CSP permits the same-origin script and its beacon", () => {
    const csp = JSON.parse(read('vercel.json'))
      .headers.flatMap((h) => h.headers)
      .find((h) => h.key === 'Content-Security-Policy').value;
    const directive = (name) =>
      csp
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith(name + ' '));

    // script-src covers loading /_vercel/insights/script.js, connect-src covers
    // the beacon it sends to /_vercel/insights/view.
    expect(directive('script-src'), 'script-src').toContain("'self'");
    expect(directive('connect-src'), 'connect-src').toContain("'self'");
  });
});

describe('site/datenschutz: section numbering stays coherent', () => {
  const html = read('site/datenschutz/index.html');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const toc = [
    ...html.matchAll(/<li><span class="num">(\d+)<\/span><a href="#([^"]+)">([^<]+)<\/a><\/li>/g),
  ].map((m) => ({ num: m[1], id: m[2], label: m[3] }));

  it('the table of contents is numbered 01..N without a gap', () => {
    expect(toc.length).toBeGreaterThan(0);
    expect(toc.map((e) => e.num)).toEqual(
      toc.map((_, i) => String(i + 1).padStart(2, '0')),
    );
  });

  it('each entry points at a section whose own mark carries the same number', () => {
    const drift = toc
      .map((e) => {
        const body = html.split(`<section class="sec" id="${e.id}"`)[1] ?? '';
        const mark = body.match(/<p class="mark">(\d+) — /)?.[1];
        return mark === e.num ? null : `#${e.id}: TOC ${e.num} vs. mark ${mark ?? 'fehlt'}`;
      })
      .filter(Boolean);
    expect(drift, 'TOC number disagrees with the section mark').toEqual([]);
  });

  it('no in-page link — including the "Punkt NN" cross-references — dangles', () => {
    const targets = [...new Set([...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]))];
    expect(targets.filter((t) => !ids.has(t)), 'dangling anchors').toEqual([]);
  });
});
