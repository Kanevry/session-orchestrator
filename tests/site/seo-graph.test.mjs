/**
 * tests/site/seo-graph.test.mjs
 *
 * The JSON-LD contract of the five shipped pages. tests/site/structure.test.mjs
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
    file: 'site/impressum/index.html',
    route: 'https://session-orchestrator.com/impressum',
    type: 'WebPage',
  },
  {
    file: 'site/datenschutz/index.html',
    route: 'https://session-orchestrator.com/datenschutz',
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

describe('site JSON-LD: 2. cross-page reference resolution', () => {
  // A renamed node leaves a reference on another page pointing at nothing.
  it.each(PAGES)('$file resolves every pure @id reference across all five pages', ({ file }) => {
    const documents = PAGES.map((page) => document(page.file));
    const registry = new Set();
    for (const data of documents) {
      const topLevel = Array.isArray(data) ? data : (data['@graph'] ?? [data]);
      for (const node of objects(data)) {
        if ('@id' in node && (Object.keys(node).length > 1 || topLevel.includes(node))) {
          registry.add(node['@id']);
        }
      }
    }
    const unresolved = objects(documents[PAGES.findIndex((page) => page.file === file)])
      .filter((node) => Object.keys(node).length === 1 && '@id' in node)
      .map((node) => node['@id'])
      .filter((id) => !registry.has(id));
    expect(unresolved, `${file}: unresolved JSON-LD references`).toEqual([]);
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
    for (const node of nodes.filter((entry) => hasType(entry, 'WebPage'))) {
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
    // / and /de carry no WebPage node: the FAQPage @id is their page identity.
    for (const node of nodes.filter((entry) => hasType(entry, 'FAQPage'))) {
      expect(String(node['@id']).split('#')[0], `${file}: FAQPage.@id page`).toBe(route);
    }
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
