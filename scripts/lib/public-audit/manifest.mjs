import { readFile } from 'node:fs/promises';
import * as yaml from 'js-yaml';
import { z } from 'zod';

const strings = z.array(z.string().trim().min(1));
const inputSchema = z.object({
  'base-url': z.string().trim().min(1),
  languages: strings.min(1),
  pages: z
    .array(
      z.object({
        type: z.string().trim().min(1),
        url: z.string().trim().min(1),
        'expected-schema-types': strings.optional(),
      }),
    )
    .min(1),
  'allowed-hosts': strings.optional(),
  'url-variants': strings.optional(),
  'sitemap-url': z.string().trim().min(1).optional(),
  'llms-paths': strings.optional(),
  'security-paths': strings.optional(),
  'indexnow-paths': strings.optional(),
});

/** Parse frontmatter only; notes and future stage fields have no operational effect. */
export function parseManifest(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024)
    throw new Error('Manifest exceeds supported size');
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('Manifest requires YAML frontmatter');
  const input = inputSchema.parse(yaml.load(match[1], { schema: yaml.JSON_SCHEMA, json: false }));
  const base = new URL(input['base-url']);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
    throw new Error('Only credential-free HTTP URLs are supported');
  const normalizeHost = (host) => {
    if (/[\s/@?#]/.test(host)) throw new Error('Invalid allowed host');
    const parsed = new URL(`https://${host}`);
    if (parsed.port || parsed.pathname !== '/')
      throw new Error('Allowed hosts must be hostnames without ports');
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  };
  const allowedHosts = [
    ...new Set([
      base.hostname.toLowerCase().replace(/\.$/, ''),
      ...(input['allowed-hosts'] ?? []).map(normalizeHost),
    ]),
  ];
  const resolve = (value) => {
    const url = new URL(value, base);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !allowedHosts.includes(url.hostname.toLowerCase().replace(/\.$/, ''))
    )
      throw new Error('URL is outside allowed HTTP hosts');
    url.hash = '';
    return url.href;
  };
  return {
    baseUrl: resolve(base.href),
    languages: [...new Set(input.languages)],
    pages: input.pages.map((page) => ({
      type: page.type,
      url: resolve(page.url),
      expectedSchemaTypes: page['expected-schema-types'] ?? [],
    })),
    allowedHosts,
    urlVariants: (input['url-variants'] ?? []).map(resolve),
    sitemapUrl: resolve(input['sitemap-url'] ?? '/sitemap.xml'),
    llmsPaths: (input['llms-paths'] ?? ['/llms.txt']).map(resolve),
    securityPaths: (input['security-paths'] ?? ['/.well-known/security.txt']).map(resolve),
    indexnowPaths: (input['indexnow-paths'] ?? []).map(resolve),
  };
}
export async function loadManifest(path) {
  return parseManifest(await readFile(path, 'utf8'));
}
