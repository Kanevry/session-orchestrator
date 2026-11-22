const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TOKENS = 50000;
const RAW = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
]);
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
class Unsupported extends Error {}
const fail = (message) => {
  throw new Unsupported(message);
};
function bounded(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES)
    fail('Document exceeds supported size');
}
/** Single forward tokenizer; quotes, comments and raw text never become tag boundaries. */
function tokenize(text, xml = false) {
  bounded(text);
  const tokens = [];
  let at = 0;
  function push(token) {
    if (tokens.length >= MAX_TOKENS) fail('Document token limit exceeded');
    tokens.push(token);
  }
  while (at < text.length) {
    if (text[at] !== '<') {
      const end = text.indexOf('<', at);
      push({ kind: 'text', text: text.slice(at, end < 0 ? text.length : end) });
      at = end < 0 ? text.length : end;
      continue;
    }
    if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4);
      if (end < 0 || (xml && text.slice(at + 4, end).includes('--')))
        fail('Unterminated or invalid comment');
      at = end + 3;
      continue;
    }
    if (!xml && /^<!doctype\s+html\s*>/i.test(text.slice(at, at + 64))) {
      at = text.indexOf('>', at) + 1;
      continue;
    }
    if (xml && at === 0 && text.startsWith('<?xml ', at)) {
      const end = text.indexOf('?>', at + 6);
      if (end < 0 || end > 256) fail('Unsupported XML declaration');
      at = end + 2;
      continue;
    }
    if (text.startsWith('<!', at) || text.startsWith('<?', at))
      fail('Unsupported document declaration');
    let cursor = at + 1;
    const closing = text[cursor] === '/';
    if (closing) cursor++;
    const nameMatch = /^[A-Za-z][A-Za-z0-9:_-]*/.exec(text.slice(cursor, cursor + 256));
    if (!nameMatch) fail('Unsupported tag syntax');
    const rawName = nameMatch[0];
    const name = xml ? rawName : rawName.toLowerCase();
    cursor += rawName.length;
    const attrs = Object.create(null);
    let selfClosing = false;
    let attributes = 0;
    while (true) {
      const space = cursor;
      while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
      if (text[cursor] === '>') {
        cursor++;
        break;
      }
      if (text[cursor] === '/' && text[cursor + 1] === '>') {
        selfClosing = true;
        cursor += 2;
        break;
      }
      if (cursor >= text.length || closing || cursor === space)
        fail('Malformed or unterminated tag');
      const attrMatch = /^[A-Za-z_:][A-Za-z0-9:_.-]*/.exec(text.slice(cursor, cursor + 256));
      if (!attrMatch || ++attributes > 100) fail('Unsupported attribute syntax or count');
      const attr = xml ? attrMatch[0] : attrMatch[0].toLowerCase();
      if (Object.hasOwn(attrs, attr)) fail('Duplicate attribute');
      cursor += attrMatch[0].length;
      const afterName = cursor;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
      let value = '';
      if (text[cursor] === '=') {
        cursor++;
        while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
        const quote = text[cursor];
        if (quote === '"' || quote === "'") {
          const end = text.indexOf(quote, cursor + 1);
          if (end < 0) fail('Unterminated quoted attribute');
          value = text.slice(cursor + 1, end);
          if (value.includes('<')) fail('Unsupported attribute content');
          cursor = end + 1;
        } else {
          if (xml) fail('XML attributes require quotes');
          const match = /^[^\s>"'`=<>]+/.exec(text.slice(cursor));
          if (!match) fail('Invalid attribute value');
          value = match[0];
          cursor += value.length;
        }
      } else if (xml) fail('XML attribute requires value');
      else cursor = afterName;
      attrs[attr] = value;
    }
    at = cursor;
    push({ kind: closing ? 'close' : 'open', name, attrs, selfClosing });
    if (!xml && !closing && RAW.has(name)) {
      const closePattern = new RegExp(`</${name}\\s*>`, 'ig');
      closePattern.lastIndex = at;
      const close = closePattern.exec(text);
      if (!close) fail('Unterminated raw text element');
      push({ kind: 'text', text: text.slice(at, close.index) });
      push({ kind: 'close', name, attrs: Object.create(null) });
      at = closePattern.lastIndex;
    }
  }
  return tokens;
}
const hasEntity = (value) => /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]*);?/i.test(value);
const rels = (value) => (value ?? '').toLowerCase().split(/\s+/).filter(Boolean);

// BV-004: bounded HTML/XML subsets, no DOM recovery or entity expansion. Revisit
// with a maintained parser if real public documents repeatedly exceed these ceilings.
export function readHtml(text) {
  const result = {
    title: null,
    description: null,
    canonical: null,
    hreflang: [],
    h1Count: 0,
    jsonLd: [],
    headLinks: [],
    ogImage: null,
    scripts: [],
    measurable: true,
  };
  try {
    const tokens = tokenize(text);
    let inHead = false;
    let headSeen = false;
    const stack = [];
    const ignored = [];
    const inert = new Set(['svg', 'math', 'template', 'noscript']);
    const headElements = new Set([
      'head',
      'html',
      'base',
      'basefont',
      'bgsound',
      'link',
      'meta',
      'title',
      'noscript',
      'noframes',
      'style',
      'script',
      'template',
    ]);
    const metadata = (value) => {
      if (hasEntity(value)) fail('Entity-dependent metadata is unsupported');
      return value;
    };
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.kind === 'text') {
        if (inHead && !ignored.length && token.text.trim() && stack.at(-1) === 'head')
          inHead = false;
        continue;
      }
      if (ignored.length) {
        if (token.kind === 'close') {
          if (ignored.pop() !== token.name) fail('Ambiguous inert or foreign HTML nesting');
        } else if (!token.selfClosing && !VOID.has(token.name)) {
          ignored.push(token.name);
          if (ignored.length > 128) fail('Document nesting limit exceeded');
        }
        continue;
      }
      if (token.kind === 'open' && inHead && !headElements.has(token.name)) inHead = false;
      if (token.kind === 'open' && inert.has(token.name)) {
        if (!token.selfClosing) ignored.push(token.name);
        continue;
      }
      if (token.kind === 'close') {
        if (token.name === 'head') inHead = false;
        const position = stack.lastIndexOf(token.name);
        if (position >= 0) stack.length = position;
        continue;
      }
      const { name, attrs } = token;
      if (name === 'head') {
        if (headSeen) fail('Multiple head elements are unsupported');
        inHead = true;
        headSeen = true;
      }
      if (name === 'body') inHead = false;
      if (!VOID.has(name) && !token.selfClosing) {
        stack.push(name);
        if (stack.length > 128) fail('Document nesting limit exceeded');
      }
      if (name === 'h1') result.h1Count++;
      if (name === 'title' && inHead && result.title === null)
        result.title = metadata(tokens[index + 1]?.text ?? '').trim();
      if (name === 'meta' && inHead) {
        if ((attrs.name ?? '').toLowerCase() === 'description' && result.description === null)
          result.description = metadata(attrs.content ?? '');
        if ((attrs.property ?? '').toLowerCase() === 'og:image' && result.ogImage === null)
          result.ogImage = metadata(attrs.content ?? '');
      }
      if (name === 'link' && inHead) {
        const link = {
          rel: metadata(attrs.rel ?? ''),
          href: metadata(attrs.href ?? ''),
          type: metadata(attrs.type ?? ''),
        };
        result.headLinks.push(link);
        if (rels(link.rel).includes('canonical') && result.canonical === null)
          result.canonical = link.href;
        if (rels(link.rel).includes('alternate') && attrs.hreflang)
          result.hreflang.push({ lang: metadata(attrs.hreflang), url: link.href });
      }
      if (name === 'script') {
        const type = (attrs.type ?? '').trim().toLowerCase();
        const body = tokens[index + 1]?.text ?? '';
        result.scripts.push({ type, id: attrs.id ?? '', body });
        if (type === 'application/ld+json') {
          try {
            result.jsonLd.push(JSON.parse(body));
          } catch {
            result.jsonLd.push(body);
          }
        }
      }
      if (name === 'plaintext') fail('Unsupported plaintext HTML content');
    }
    if (ignored.length) fail('Unterminated inert or foreign HTML content');
  } catch (error) {
    result.measurable = false;
    result.reason = error.message;
  }
  return result;
}

/** Strict sitemap subset: no DTD, entities, CDATA, recovery or arbitrary nested XML. */
export function readSitemap(text) {
  const result = { kind: null, entries: [], measurable: true };
  try {
    const tokens = tokenize(text, true);
    const stack = [];
    let rootClosed = false;
    let entry;
    let value = '';
    for (const token of tokens) {
      const parent = stack.at(-1);
      if (token.kind === 'text') {
        if (token.text.includes('&')) fail('XML entities are unsupported');
        if (parent === 'loc' || parent === 'lastmod') value += token.text;
        else if (!['priority', 'changefreq'].includes(parent) && token.text.trim())
          fail('Unsupported XML text');
        continue;
      }
      if (token.kind === 'close') {
        if (stack.pop() !== token.name) fail('Mismatched XML tags');
        if (token.name === 'loc' || token.name === 'lastmod') {
          if (!entry || !value.trim()) fail('Empty sitemap field');
          entry[token.name] = value.trim();
          value = '';
        }
        if (token.name === 'url' || token.name === 'sitemap') {
          if (!entry?.loc) fail('Sitemap entry lacks loc');
          result.entries.push(entry);
          entry = undefined;
        }
        if (!stack.length) rootClosed = true;
        continue;
      }
      if (Object.values(token.attrs).some((value) => value.includes('&')))
        fail('XML entities are unsupported');
      const name = token.name;
      if (!parent) {
        if (rootClosed || !['urlset', 'sitemapindex'].includes(name))
          fail('Unsupported sitemap root');
        result.kind = name;
        if (
          token.attrs.xmlns &&
          token.attrs.xmlns !== 'http://www.sitemaps.org/schemas/sitemap/0.9'
        )
          fail('Unsupported sitemap namespace');
      } else if (parent === result.kind) {
        if (name !== (result.kind === 'urlset' ? 'url' : 'sitemap'))
          fail('Unsupported sitemap entry');
        if (token.selfClosing) fail('Empty sitemap entry');
        entry = { loc: null, lastmod: null, alternates: [] };
      } else if (parent === 'url' || parent === 'sitemap') {
        if (name === 'loc' || name === 'lastmod') {
          if (entry[name] !== null || token.selfClosing) fail('Duplicate or empty sitemap field');
          value = '';
        } else if (name === 'xhtml:link' && parent === 'url') {
          if (
            !token.selfClosing ||
            token.attrs.rel !== 'alternate' ||
            !token.attrs.hreflang ||
            !token.attrs.href
          )
            fail('Unsupported sitemap alternate');
          entry.alternates.push({ lang: token.attrs.hreflang, url: token.attrs.href });
        } else if (['changefreq', 'priority'].includes(name) && parent === 'url') {
          // Accepted sitemap fields outside this measurement scope are consumed below.
          if (!token.selfClosing) {
            stack.push(name);
            continue;
          }
        } else fail('Unsupported sitemap field');
      } else fail('Unsupported nested sitemap field');
      if (!token.selfClosing) stack.push(name);
      else if (!parent) rootClosed = true;
    }
    if (!result.kind || stack.length) fail('Incomplete XML document');
  } catch (error) {
    result.measurable = false;
    result.reason = error.message;
  }
  return result;
}
