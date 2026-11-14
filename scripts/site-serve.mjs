#!/usr/bin/env node
/**
 * site-serve.mjs — serve `site/` locally the way Vercel serves it in production.
 *
 * Why: the site is static (no build), but `file://` differs from production in
 * two ways that matter for a visual check: clean URLs (`/guide` →
 * `site/guide/index.html`) and the response headers from `vercel.json`, above
 * all the Content-Security-Policy. A page that only works because `file://`
 * skips the CSP would pass a local check and break live. This script reads
 * `vercel.json` and applies its `headers` rules, so a screenshot taken against
 * it sees the production policy. Issue #1983 (viewport sign-off at 1440/390/320)
 * depends on having this path in the repo.
 *
 * Usage:
 *   node scripts/site-serve.mjs [--port 4173] [--host 127.0.0.1] [--root site]
 *
 * Prints one line `site-serve: http://<host>:<port>/` once listening.
 * Loopback by default; pass `--host 0.0.0.0` only on a trusted network.
 *
 * Ceiling (BV-004): only the `vercel.json` subset this repo uses is mirrored —
 * `cleanUrls`, `trailingSlash: false`, and `headers` sources of the form
 * `/prefix/(.*)`. Host-conditional `redirects` (www → apex) do not apply on
 * loopback and are ignored. One deliberate difference: the CSP directive
 * `upgrade-insecure-requests` is dropped, because over plain http on loopback
 * WebKit upgrades every same-origin request to https and the page loads without
 * styles (measured 2026-11-13, WebKit 27.2); Chromium exempts loopback. In
 * production the site is https only, so the directive changes nothing there.
 * Known local-only differences, not worth code: on a case-insensitive disk
 * (macOS) `/GUIDE` answers 200 where Vercel answers 404, and a redirect drops
 * the query string. Revisit if `vercel.json` gains `rewrites` or other
 * source patterns; `headerRulesFrom()` throws on a source it cannot translate
 * instead of silently skipping it.
 */
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/is-main-module.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
};

/** Translate the `headers` array of vercel.json into [{ test, headers }]. */
export function headerRulesFrom(vercelConfig) {
  return (vercelConfig.headers ?? []).map(({ source, headers }) => {
    const m = /^(\/[^()]*?)\(\.\*\)$/.exec(source);
    if (!m) throw new Error(`site-serve: unsupported vercel.json header source: ${source}`);
    const prefix = m[1];
    return { test: (p) => p.startsWith(prefix), headers };
  });
}

/** The header value as served locally: the CSP without `upgrade-insecure-requests`. */
export function localHeaderValue(key, value) {
  if (key.toLowerCase() !== 'content-security-policy') return value;
  return value
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && d.toLowerCase() !== 'upgrade-insecure-requests')
    .join('; ');
}

/**
 * Map a URL path to a file under root, following cleanUrls + trailingSlash:false.
 * Returns { file } or { redirect } or null (not found / outside root).
 */
export function resolveRequest(root, urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p.includes('\0')) return null;
  // Redirect targets come from the RAW (still percent-encoded) path: a decoded
  // target can hold characters Node refuses in a Location header (the process
  // crashed on /%E2%80%A6/) or turn /%2F%2Fhost/ into //host, which a browser
  // reads as another site. Leading slashes collapse to one for the same reason.
  const local = (target) => `/${target.replace(/^[/\\]+/, '')}`;
  if (urlPath.length > 1 && urlPath.endsWith('/'))
    return { redirect: local(urlPath.replace(/\/+$/, '')) };
  if (urlPath.endsWith('.html'))
    return { redirect: local(urlPath.replace(/(\/index)?\.html$/, '')) };
  const abs = normalize(join(root, p));
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  const candidates =
    abs === root ? [join(root, 'index.html')] : [abs, `${abs}.html`, join(abs, 'index.html')];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return { file: candidate };
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '4173' },
      host: { type: 'string', default: '127.0.0.1' },
      root: { type: 'string', default: 'site' },
    },
  });
  const root = resolve(REPO_ROOT, values.root);
  const rules = headerRulesFrom(JSON.parse(readFileSync(join(REPO_ROOT, 'vercel.json'), 'utf8')));
  const notFound = join(root, '404.html');

  const server = createServer((req, res) => {
    const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;
    for (const rule of rules) {
      if (!rule.test(urlPath)) continue;
      for (const { key, value } of rule.headers) res.setHeader(key, localHeaderValue(key, value));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const hit = resolveRequest(root, urlPath);
    if (hit?.redirect) {
      res.writeHead(308, { Location: hit.redirect }).end();
      return;
    }
    let file = hit?.file;
    let status = 200;
    if (!file) {
      status = 404;
      try {
        file = statSync(notFound).isFile() ? notFound : null;
      } catch {
        file = null;
      }
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found\n');
        return;
      }
    }
    const size = statSync(file).size;
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    // Range support: WebKit refuses to play <video> from a server without it.
    const range = status === 200 ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '') : null;
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      });
      if (req.method === 'HEAD') return void res.end();
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
    });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
  });

  server.listen(Number(values.port), values.host, () => {
    const { port } = server.address();
    process.stdout.write(`site-serve: http://${values.host}:${port}/\n`);
  });
}

if (isMainModule(import.meta.url)) main();
