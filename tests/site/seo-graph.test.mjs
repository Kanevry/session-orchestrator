/**
 * tests/site/seo-graph.test.mjs
 *
 * The JSON-LD contract of the shipped pages. tests/site/structure.test.mjs
 * owns canonical, hreflang, h1, og:image, assets, sitemap and robots, but never
 * parses JSON-LD, so a broken block, a dangling @id or FAQ data that no longer
 * matches the visible FAQ would ship unnoticed. GitLab #1483.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Falsification seam: point at a mutated copy of site/ to prove a group goes red.
const SITE_DIR = process.env.SEO_GRAPH_SITE_DIR || join(REPO_ROOT, 'site');
const PAGES = [
  { file: 'site/index.html', route: 'https://session-orchestrator.com/', type: 'FAQPage' },
  { file: 'site/de/index.html', route: 'https://session-orchestrator.com/de', type: 'FAQPage' },
  {
    file: 'site/guide/index.html',
    route: 'https://session-orchestrator.com/guide',
    type: 'TechArticle',
  },
  {
    file: 'site/lead/index.html',
    route: 'https://session-orchestrator.com/lead',
    type: 'WebPage',
  },
  {
    file: 'site/impressum/index.html',
    route: 'https://session-orchestrator.com/impressum',
    type: 'WebPage',
  },
  {
    file: 'site/datenschutz/index.html',
    route: 'https://session-orchestrator.com/datenschutz',
    type: 'WebPage',
  },
  {
    file: 'site/commands/index.html',
    route: 'https://session-orchestrator.com/commands',
    type: 'WebPage',
  },
];
const read = (file) => readFileSync(join(SITE_DIR, file.slice('site/'.length)), 'utf8');
const blocks = (html) =>
  [
    ...html.matchAll(
      /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
    ),
  ].map((match) => match[1]);

function document(file) {
  const found = blocks(read(file));
  expect(found, `${file}: exactly one JSON-LD block`).toHaveLength(1);
  expect(() => JSON.parse(found[0]), `${file}: JSON-LD must parse`).not.toThrow();
  return JSON.parse(found[0]);
}

function objects(value) {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (value === null || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(objects)];
}

const hasType = (node, type) => [node['@type']].flat().includes(type);
const nodesOfType = (file, type) => objects(document(file)).filter((node) => hasType(node, type));

// Decode numeric references (including the shipped umlaut) and common named
// text entities after stripping markup, so escaped angle brackets stay text.
function text(html) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, name) => {
      if (!name.startsWith('#')) return named[name.toLowerCase()];
      const hex = name[1].toLowerCase() === 'x';
      const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

describe('site JSON-LD: 1. block integrity', () => {
  // An edit or regeneration leaves invalid JSON that Google silently discards.
  it.each(PAGES)('$file has exactly one parseable JSON-LD block', ({ file }) => {
    document(file);
  });
});

describe('site JSON-LD: 2. reference resolution', () => {
  // A crawler can read each entry page alone. The guide used to rely on
  // entities only defined on the homepage; the remaining pages retain their
  // existing cross-page contract until their own graphs are expanded.
  it.each(PAGES)('$file resolves every pure @id reference in its supported graph', ({ file }) => {
    const selfContained = PAGES.slice(0, 3).some((page) => page.file === file);
    const documents = (selfContained ? [{ file }] : PAGES).map((page) => document(page.file));
    const registry = new Set();
    for (const data of documents) {
      const topLevel = Array.isArray(data) ? data : (data['@graph'] ?? [data]);
      for (const node of objects(data)) {
        if ('@id' in node && (Object.keys(node).length > 1 || topLevel.includes(node))) {
          registry.add(node['@id']);
        }
      }
    }
    const unresolved = objects(document(file))
      .filter((node) => Object.keys(node).length === 1 && '@id' in node)
      .map((node) => node['@id'])
      .filter((id) => !registry.has(id));
    expect(
      unresolved,
      `${file}: unresolved ${selfContained ? 'local' : 'cross-page'} references`,
    ).toEqual([]);
  });
});

describe('site JSON-LD: 3. page identity', () => {
  // Copying a page retains another page's URL in its structured identity.
  it.each(PAGES)('$file uses its own URL for page identity', ({ file, route, type }) => {
    const nodes = objects(document(file));
    if (type) {
      expect(
        nodes.filter((node) => hasType(node, type)),
        `${file}: ${type} node`,
      ).toHaveLength(1);
    }
    const webPages = nodes.filter((entry) => hasType(entry, 'WebPage'));
    expect(webPages, `${file}: explicit WebPage identity`).toHaveLength(1);
    for (const node of webPages) {
      const fields = ['@id', 'url'].filter((key) => key in node);
      expect(fields.length, `${file}: WebPage needs @id or url`).toBeGreaterThan(0);
      for (const key of fields) {
        expect(node[key], `${file}: WebPage.${key}`).toBe(route);
      }
    }
    for (const node of nodes.filter((entry) => hasType(entry, 'TechArticle'))) {
      const identity = node.mainEntityOfPage;
      expect(
        typeof identity === 'object' && identity !== null ? identity['@id'] : identity,
        `${file}: TechArticle.mainEntityOfPage`,
      ).toBe(route);
    }
    // The FAQ is a fragment of this page, not a second canonical page.
    for (const node of nodes.filter((entry) => hasType(entry, 'FAQPage'))) {
      expect(String(node['@id']).split('#')[0], `${file}: FAQPage.@id page`).toBe(route);
    }
  });
});

// `sameAs` entries that name the node itself, in any spelling of the same
// page: scheme, `www.`, trailing slash, `#fragment` (its own `@id` included).
// A bare trailing-slash strip accepted `http://`, a dropped `www.` and an `@id`
// compared without its fragment as "different", so the self-reference passed.
const identity = (value) =>
  String(value)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/#.*$/, '')
    .replace(/\/+$/, '');
const selfReferences = (node) =>
  Array.isArray(node.sameAs)
    ? node.sameAs.filter((entry) =>
        [node.url, node['@id']]
          .filter((own) => typeof own === 'string')
          .some((own) => identity(entry) === identity(own)),
      )
    : [];

describe('site JSON-LD: sameAs', () => {
  // `sameAs` names the same entity ELSEWHERE; a node listing its own `url`
  // there broke the portfolio entity contract (#1771): the Person node
  // carried its hub URL in both fields.
  it.each(PAGES)('$file never repeats a node URL or @id in its own sameAs', ({ file }) => {
    const repeats = objects(document(file)).flatMap((node) =>
      selfReferences(node).map((entry) => `${node['@id']}: ${entry}`),
    );
    expect(repeats, `${file}: sameAs entries naming the node itself`).toEqual([]);
  });

  // The detector itself: each literal variant of the Person hub must be caught.
  it.each([
    'https://www.example.org',
    'https://www.example.org/',
    'http://www.example.org',
    'https://example.org',
    'https://www.example.org/#person',
  ])('flags %s as a self-reference of the Person node', (entry) => {
    const node = {
      '@id': 'https://www.example.org/#person',
      url: 'https://www.example.org',
      sameAs: [entry],
    };
    expect(selfReferences(node)).toEqual([entry]);
  });

  it('does not flag a distinct external profile', () => {
    const node = {
      '@id': 'https://www.example.org/#person',
      url: 'https://www.example.org',
      sameAs: ['https://github.com/Kanevry'],
    };
    expect(selfReferences(node)).toEqual([]);
  });

  // The exact Person contract of the two pages that carry one (#1771).
  it.each(['site/index.html', 'site/de/index.html'])('%s Person has its exact hub identity', (file) => {
    const people = nodesOfType(file, 'Person');
    expect(people).toHaveLength(1);
    // Canonical forms: https scheme, `www.` host, bare hub url, `/#person` fragment.
    expect(people[0].url).toMatch(/^https:\/\/www\.[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    expect(people[0]['@id']).toBe(`${people[0].url}/#person`);
    expect(people[0].sameAs).toEqual(['https://github.com/Kanevry']);
  });
});

describe('site JSON-LD: entry-page navigation', () => {
  // Copying a graph must not keep another page's breadcrumb or confuse the
  // translated page URL with the shared site's identity.
  it.each(PAGES.slice(0, 3))(
    '$file connects its page to the site and correct breadcrumb trail',
    ({ file, route }) => {
      const [page] = nodesOfType(file, 'WebPage');
      const websites = nodesOfType(file, 'WebSite');
      expect(websites, `${file}: WebSite`).toHaveLength(1);
      expect(websites[0].url).toBe('https://session-orchestrator.com/');
      expect(websites[0].alternateName).toEqual(expect.any(String));
      expect(websites[0].alternateName.trim()).not.toBe('');
      expect(page?.isPartOf?.['@id']).toBe(websites[0]['@id']);

      const breadcrumbs = nodesOfType(file, 'BreadcrumbList');
      expect(breadcrumbs, `${file}: BreadcrumbList`).toHaveLength(1);
      expect(page?.breadcrumb?.['@id']).toBe(breadcrumbs[0]['@id']);
      const items = breadcrumbs[0].itemListElement;
      const routes =
        route === 'https://session-orchestrator.com/'
          ? [route]
          : ['https://session-orchestrator.com/', route];
      expect(items.map((item) => item.item)).toEqual(routes);
      expect(items.map((item) => item.position)).toEqual(routes.map((_, index) => index + 1));
      for (const item of items) {
        expect(hasType(item, 'ListItem')).toBe(true);
        expect(item.name).toEqual(expect.any(String));
        expect(item.name.trim()).not.toBe('');
      }
    },
  );
});

describe('site JSON-LD: guide headline', () => {
  // Copying a visible heading's markup into JSON-LD exposes literal HTML to crawlers.
  it('represents the visible heading as plain text', () => {
    const file = 'site/guide/index.html';
    const [article] = nodesOfType(file, 'TechArticle');
    const heading = read(file).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    expect(heading, `${file}: visible heading`).toBeDefined();
    expect(article.headline).toBe(text(heading.replace(/<br\s*\/?\s*>/gi, ' ')));
  });
});

describe('site JSON-LD: 4. guide review date', () => {
  // Updating only the visible review date or only dateModified contradicts the page.
  it('site/guide/index.html dateModified matches its visible source review date', () => {
    const file = 'site/guide/index.html';
    const dates = [...read(file).matchAll(/<p\b[^>]*\bclass=["']meta["'][^>]*>([\s\S]*?)<\/p>/gi)]
      .map((match) => text(match[1]).match(/reviewed against source on (\d{4}-\d{2}-\d{2})\b/)?.[1])
      .filter(Boolean);
    expect(dates, `${file}: visible source review date`).toHaveLength(1);
    const articles = nodesOfType(file, 'TechArticle');
    expect(articles, `${file}: TechArticle`).toHaveLength(1);
    expect(articles[0].dateModified, `${file}: dateModified vs. visible review`).toBe(dates[0]);
  });
});

describe('site JSON-LD: 5. visible FAQ parity', () => {
  // Editing a visible question or answer without the JSON-LD (or the reverse)
  // breaks Google's rule that FAQ markup matches the visible content.
  it.each(PAGES.slice(0, 2))('$file FAQ data matches the visible FAQ in order', ({ file }) => {
    const faqs = nodesOfType(file, 'FAQPage');
    expect(faqs, `${file}: FAQPage`).toHaveLength(1);
    const questions = faqs[0].mainEntity;
    expect(Array.isArray(questions), `${file}: FAQPage.mainEntity array`).toBe(true);
    const visible = [
      ...read(file).matchAll(
        /<details\b[^>]*\bclass=["']faq-item["'][^>]*>([\s\S]*?)<\/details>/gi,
      ),
    ].map((match) => ({
      question: text(match[1].match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ?? ''),
      answer: text(match[1].match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? ''),
    }));
    expect(visible.length, `${file}: visible FAQ items`).toBeGreaterThan(0);
    for (const question of questions) {
      expect(hasType(question, 'Question'), `${file}: FAQ mainEntity must be Question`).toBe(true);
    }
    expect(
      questions.map((question) => text(question.name)),
      `${file}: FAQ question order`,
    ).toEqual(visible.map((item) => item.question));
    expect(
      questions.map((question) => text(question.acceptedAnswer?.text ?? '')),
      `${file}: FAQ answers`,
    ).toEqual(visible.map((item) => item.answer));
  });
});
