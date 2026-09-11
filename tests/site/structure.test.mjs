/**
 * tests/site/structure.test.mjs
 *
 * Structural guards over the five SHIPPED pages of `site/`. There is no build
 * step and no shared layout: five hand-authored HTML files are the whole site,
 * so nothing but a test connects them. Every `describe` below names the concrete
 * regression it catches (`.claude/rules/test-value.md` TV-001); none pins prose.
 *
 * Deliberately NOT covered here, because another file already owns it (TV-004):
 *   - the Vercel insights snippet, the same-origin script rule and the
 *     /datenschutz section numbering -> tests/docs/site-analytics-parity.test.mjs
 *   - the `data-metric` VALUES against `site/_census.json` -> tests/scripts/site-numbers.test.mjs
 * This file asserts the EN/DE data-metric values agree with EACH OTHER, which is
 * a different claim: numbers are not translated, so a regenerate that reached
 * only one page is invisible to a census check that looks at one page at a time.
 *
 * The tests read the real files on purpose: every claim is about what is SERVED,
 * so a fixture copy would make all of them vacuous.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Never process.cwd(): the pre-push gate runs the suite from $TMPDIR.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SITE = join(REPO_ROOT, 'site');

const EN = 'site/index.html';
const DE = 'site/de/index.html';
const GUIDE = 'site/guide/index.html';
const IMPRESSUM = 'site/impressum/index.html';
const DATENSCHUTZ = 'site/datenschutz/index.html';

/** The five hand-authored pages, with the per-page facts a page owns alone. */
const PAGES = [
  { file: EN, lang: 'en', route: 'https://session-orchestrator.com/' },
  { file: DE, lang: 'de', route: 'https://session-orchestrator.com/de' },
  { file: GUIDE, lang: 'en', route: 'https://session-orchestrator.com/guide' },
  { file: IMPRESSUM, lang: 'de', route: 'https://session-orchestrator.com/impressum' },
  { file: DATENSCHUTZ, lang: 'de', route: 'https://session-orchestrator.com/datenschutz' },
];

const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const all = (re, s) => [...s.matchAll(re)].map((m) => m[1]);

const sectionIds = (s) => all(/<section\b[^>]*\sid="([^"]+)"/g, s);
const metrics = (s) =>
  Object.fromEntries(
    [...s.matchAll(/data-metric="([^"]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]),
  );
// Scoped to ONE figure: the lazy [\s\S]*? used to run past a figure that has no
// <img> (the campaign-film figure is one) and adopt the next figure's image.
const figureSrcs = (s) =>
  [...s.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/g)]
    .map((m) => m[1].match(/<img\b[^>]*\ssrc="([^"]+)"/)?.[1])
    .filter((src) => src !== undefined);
const countOf = (needle, s) => s.split(needle).length - 1;
const authorHrefs = (s) => all(/<a\b[^>]*\shref="([^"]+)"[^>]*\srel="author"/g, s);
const alternates = (s) =>
  [...s.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map(
    (m) => `${m[1]} -> ${m[2]}`,
  );

/** Root-relative asset references that name a FILE (a dot in the last segment). */
function assetRefs(html) {
  const refs = new Set();
  for (const p of all(/(?:src|href|poster)="(\/[^"]*)"/g, html)) refs.add(p);
  for (const set of all(/srcset="([^"]+)"/g, html)) {
    for (const cand of set.split(',')) {
      const url = cand.trim().split(/\s+/)[0];
      if (url.startsWith('/')) refs.add(url);
    }
  }
  return [...refs].map((p) => p.split(/[?#]/)[0]).filter(
    // /_vercel/* is served by the platform, not by this repo; extension-less
    // paths ("/de", "/guide") are ROUTES, resolved by vercel.json, not files.
    (p) => !p.startsWith('/_vercel/') && /\.[a-z0-9]+$/i.test(p.split('?')[0]),
  );
}

describe('site: EN/DE mirror parity', () => {
  // The DE page was written by copying the EN skeleton. A section added to one
  // page only, or a metric span that reached one page only, breaks the mirror
  // silently: each page on its own still looks complete.
  const en = read(EN);
  const de = read(DE);

  it('both pages carry the same ordered list of section ids', () => {
    expect(sectionIds(de), `${DE} sections vs. ${EN}`).toEqual(sectionIds(en));
  });

  it('both pages carry the same data-metric ids with identical values', () => {
    // Numbers are not translated: a regenerate that reached only one page shows
    // up here and nowhere else.
    expect(metrics(de), `${DE} data-metric values vs. ${EN}`).toEqual(metrics(en));
  });

  it('both pages carry the same number of FAQ items', () => {
    expect(countOf('faq-item', de), `${DE} faq-item count`).toBe(countOf('faq-item', en));
  });

  it('both pages carry the same figures in the same order', () => {
    expect(figureSrcs(de), `${DE} <figure class="fig"> image srcs vs. ${EN}`).toEqual(
      figureSrcs(en),
    );
  });

  it('both pages carry the brand mark and a complete language switch', () => {
    const missing = [EN, DE].filter((f) => {
      const html = f === EN ? en : de;
      const lang = html.match(/<p class="lang">[\s\S]*?<\/p>/)?.[0] ?? '';
      return (
        !html.includes('class="brand"') ||
        !lang.includes('href="/"') ||
        !lang.includes('href="/de"')
      );
    });
    expect(missing, 'pages missing class="brand" or a two-way .lang switch').toEqual([]);
  });
});

describe('site: hreflang and canonical', () => {
  // Google reads the hreflang triple bidirectionally: a page that names itself
  // but not its sibling drops the pair, and a stray hreflang on an EN-only page
  // advertises a translation that does not exist.
  const TRIPLE = [
    'en -> https://session-orchestrator.com/',
    'de -> https://session-orchestrator.com/de',
    'x-default -> https://session-orchestrator.com/',
  ];

  it.each([EN, DE])('%s carries exactly the en/de/x-default triple', (file) => {
    expect(alternates(read(file)), `${file} rel=alternate hreflang links`).toEqual(TRIPLE);
  });

  it.each([GUIDE, IMPRESSUM, DATENSCHUTZ])('%s carries no hreflang at all', (file) => {
    expect(alternates(read(file)), `${file} must not advertise a translation`).toEqual([]);
  });

  it.each(PAGES)('$file declares its own canonical URL', ({ file, route }) => {
    // /de canonicalises WITHOUT a trailing slash — the trailing-slash variant is
    // a second URL for the same page and splits the ranking signal.
    expect(
      read(file).match(/<link rel="canonical" href="([^"]+)">/)?.[1],
      `${file} canonical`,
    ).toBe(route);
  });
});

describe('site: per-page document shape', () => {
  it.each(PAGES)('$file has exactly one <h1>', ({ file }) => {
    expect(countOf('<h1', read(file)), `${file} <h1> count`).toBe(1);
  });

  it.each(PAGES)('$file declares <html lang="$lang">', ({ file, lang }) => {
    expect(read(file).match(/<html lang="([^"]+)">/)?.[1], `${file} <html lang>`).toBe(lang);
  });

  it.each(PAGES)('$file gives every <img> a non-empty alt', ({ file }) => {
    const bad = [...read(file).matchAll(/<img\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => !/\salt="[^"]+"/.test(tag));
    expect(bad, `${file}: <img> tags without a non-empty alt`).toEqual([]);
  });

  it.each(PAGES)('$file loads the shared stylesheet and behaviour script', ({ file }) => {
    const html = read(file);
    expect(
      /<link rel="stylesheet" href="\/assets\/site\.css(?:\?[^"\s]+)?">/.test(html),
      `${file} site.css`,
    ).toBe(true);
    expect(/<script src="\/assets\/ui\.js(?:\?[^"\s]+)?" defer><\/script>/.test(html), `${file} ui.js`).toBe(
      true,
    );
  });

  it.each(PAGES)('$file keeps its CSS in site.css — no inline <style>', ({ file }) => {
    // An inline <style> also needs a CSP style-src exemption; keeping the count
    // at zero is what lets vercel.json stay strict.
    expect(countOf('<style', read(file)), `${file} inline <style> elements`).toBe(0);
  });

  it.each(PAGES)('$file declares an og:image', ({ file }) => {
    expect(
      /<meta property="og:image" content="https:\/\/session-orchestrator\.com\/[^"]*\.png">/.test(
        read(file),
      ),
      `${file} og:image`,
    ).toBe(true);
  });

  it.each(PAGES)('$file declares og:image dimensions 1200x630', ({ file }) => {
    // The pair is what makes the card render at full width in Slack/LinkedIn
    // instead of as a thumbnail; a missing width is invisible until someone
    // shares the link. /impressum and /datenschutz were the two pages missing
    // it as of 2026-09-07 08:26Z and gained it minutes later, mid-wave.
    const html = read(file);
    expect(
      html.match(/<meta property="og:image:width" content="([^"]+)">/)?.[1],
      `${file} og:image:width`,
    ).toBe('1200');
    expect(
      html.match(/<meta property="og:image:height" content="([^"]+)">/)?.[1],
      `${file} og:image:height`,
    ).toBe('630');
  });
});

describe('site: author cross-promo link (GitLab #1237)', () => {
  // The author host is never spelled out in tracked test code (owner-leakage rule
  // CP7); it is DERIVED from the first rel="author" href on the EN page, and the
  // page is the only place it may appear.
  const AUTHOR_HOST = new URL(authorHrefs(read(EN))[0]).host;
  const AUTHOR_DOMAIN = AUTHOR_HOST.replace(/^www\./, '');

  // Two failure modes, both silent: an author link that loses its utm tags stops
  // being attributable, and the author domain leaking onto /guide turns a
  // product page into a personal-site referrer (CP7 leakage rule).
  it.each([EN, DE, IMPRESSUM, DATENSCHUTZ])('%s tags every rel="author" href', (file) => {
    const bad = authorHrefs(read(file)).filter(
      (href) =>
        !href.startsWith(`https://${AUTHOR_HOST}/`) ||
        !href.includes('utm_source=session-orchestrator') ||
        !href.includes('utm_medium=footer'),
    );
    expect(bad, `${file}: rel="author" hrefs missing the domain or the utm tags`).toEqual([]);
  });

  it('/ and /de carry the same number of author links, and at least one', () => {
    const enCount = authorHrefs(read(EN)).length;
    expect(enCount, `${EN} rel="author" anchors`).toBeGreaterThanOrEqual(1);
    expect(authorHrefs(read(DE)).length, `${DE} rel="author" anchors vs. ${EN}`).toBe(enCount);
  });

  it('/guide names the author domain nowhere', () => {
    expect(countOf(AUTHOR_DOMAIN, read(GUIDE)), `${GUIDE} occurrences of the author domain`).toBe(
      0,
    );
  });
});

describe('site: every referenced asset exists on disk', () => {
  // There is no bundler to fail: a renamed image or a moved font 404s only in a
  // browser, and the page still renders "fine" without it.
  it.each(PAGES)('$file references only files that exist under site/', ({ file }) => {
    const missing = assetRefs(read(file)).filter((p) => !existsSync(join(SITE, p.slice(1))));
    expect(missing, `${file}: referenced assets with no file under site/`).toEqual([]);
  });

  it('the three.js vendor pair ships complete', () => {
    // hero.js loads the module build, which imports the core build by relative
    // path — shipping one without the other leaves the hero permanently blank.
    const core = join(SITE, 'vendor/three.core.min.js');
    const module = join(SITE, 'vendor/three.module.min.js');
    expect(existsSync(core), 'site/vendor/three.core.min.js').toBe(true);
    expect(existsSync(module), 'site/vendor/three.module.min.js').toBe(true);
    expect(
      readFileSync(module, 'utf8').includes('./three.core.min.js'),
      'three.module.min.js must import ./three.core.min.js',
    ).toBe(true);
  });
});

describe('site: AI-image disclosure', () => {
  // The current landing-page figures are generated illustrations. Their
  // provenance must remain visible beside the image, regardless of layout
  // class or image-model version. Do not require an unverified model name.
  it.each([EN, DE])('%s labels its generated illustrations', (file) => {
    const html = read(file);
    const figures = [...html.matchAll(/<figure\b[^>]*>[\s\S]*?<\/figure>/g)].map((m) => m[0]);
    expect(figures.length, `${file} figure count`).toBeGreaterThanOrEqual(1);

    const undisclosed = figures.filter((f) => {
      const caption = f.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/)?.[1] ?? '';
      return !/\b(?:AI|KI)\b/.test(caption.replace(/<[^>]*>/g, ' '));
    });
    expect(undisclosed, `${file}: generated figures without visible AI/KI provenance`).toEqual([]);
  });
});

describe('site: hero motion-toggle wiring', () => {
  // site/assets/ui.js:69-70 — `const base = video.dataset.<prop>` followed by
  // `if (!video || !button || !base) return` bails out of the whole click-handler
  // wiring with no error when the markup does not carry the attribute the JS
  // reads: the motion-toggle button simply never leaves `hidden`.
  // Nothing else in this file would catch that regression — the EN/DE parity
  // suite above only compares section ids, data-metric values, figure <img>
  // srcs and FAQ counts, and this <video> has none of those.
  //
  // The attribute name is asserted as a RELATIONSHIP, never as a literal: it is
  // READ OUT of ui.js and then looked for in the markup. A hardcoded
  // "data-video-base" on either side would go red on a legitimate asset rename
  // (catching no bug) while staying green on the real one — renaming
  // `dataset.videoBase` in ui.js and updating nothing else. No test in this repo
  // loads ui.js into a DOM, so the JS side is otherwise unexercised.
  const datasetProps = () =>
    all(/\bvideo\.dataset\.([A-Za-z0-9_$]+)/g, read('site/assets/ui.js'));
  const kebab = (prop) => `data-${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

  it('site/assets/ui.js reads exactly one dataset property off the hero video', () => {
    expect(datasetProps(), 'video.dataset.* reads in site/assets/ui.js').toHaveLength(1);
  });

  it.each([EN, DE])('%s carries the hero-video attribute ui.js reads, non-empty', (file) => {
    const attr = kebab(datasetProps()[0]);
    const value = read(file).match(
      new RegExp(`<figure class="hero-art">[\\s\\S]*?<video\\b[^>]*\\s${attr}="([^"]*)"`),
    )?.[1];
    expect(value, `${file} hero-art <video ${attr}> (name read from ui.js)`).toBeTruthy();
  });
});

describe('site: campaign film embed', () => {
  // The 34-second film is 18 MB of mp4 next to 16 MB of webm. Two regressions the
  // rest of this file cannot see, because the block adds no section id, no
  // data-metric, no faq-item and no <img>:
  //   1. the film reaches one page only (it lives in hand-copied markup),
  //   2. it ships with preload="auto"/autoplay and every visitor downloads 18 MB.
  const FILM = 'session-orchestrator-film';
  const filmVideo = (html) =>
    [...html.matchAll(/<video\b[^>]*>[\s\S]*?<\/video>/g)].find((m) => m[0].includes(FILM))?.[0];

  it.each([EN, DE])('%s embeds the film exactly once', (file) => {
    const html = read(file);
    expect(countOf(`<source src="/video/${FILM}.webm"`, html), `${file} webm source`).toBe(1);
    expect(countOf(`<source src="/video/${FILM}.mp4"`, html), `${file} mp4 source`).toBe(1);
    expect(filmVideo(html)?.includes(`poster="/video/${FILM}-poster.webp"`), `${file} poster`).toBe(
      true,
    );
  });

  it.each([EN, DE])('%s serves the film lazily, with controls and without autoplay', (file) => {
    const tag = filmVideo(read(file))?.match(/<video\b[^>]*>/)?.[0] ?? '';
    expect(/\spreload="none"/.test(tag), `${file} film <video> preload`).toBe(true);
    expect(/\scontrols(?=[\s>])/.test(tag), `${file} film <video> controls`).toBe(true);
    expect(/\sautoplay(?=[\s>])/.test(tag), `${file} film <video> must not autoplay`).toBe(false);
  });

  it('names the webm source before the mp4 source on both pages', () => {
    // Order is the format negotiation: the browser takes the first it can play,
    // and the webm is ~2 MB smaller.
    for (const file of [EN, DE]) {
      const html = read(file);
      expect(
        html.indexOf(`/video/${FILM}.webm`) < html.indexOf(`/video/${FILM}.mp4`),
        `${file} webm must precede mp4`,
      ).toBe(true);
    }
  });
});

describe('site: sitemap and robots', () => {
  it('sitemap.xml lists exactly the five pages', () => {
    const locs = all(/<loc>([^<]+)<\/loc>/g, read('site/sitemap.xml'));
    expect(locs, 'site/sitemap.xml <loc> entries').toEqual(PAGES.map((p) => p.route));
  });

  it('robots.txt points at that sitemap', () => {
    expect(read('site/robots.txt'), 'site/robots.txt Sitemap line').toContain(
      'Sitemap: https://session-orchestrator.com/sitemap.xml',
    );
  });
});
