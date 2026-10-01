/** IndexNow guards: all HTTP is injected; temporary site fixtures are removed after each test. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../site/seo/indexnow.mjs';
import { makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ORIGIN = 'https://session-orchestrator.com';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const KEY = '0123456789abcdef0123456789abcdef';
const URLS = [`${ORIGIN}/`, `${ORIGIN}/guide`];
const SITEMAP = `<urlset>${URLS.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;

const tmpDirs = [];

function fixture(options = {}) {
  const siteDir = makeTmpDir('so-indexnow-');
  tmpDirs.push(siteDir);
  const keys = options.keys ?? [[KEY, `${KEY}\n`]];
  for (const [key, body] of keys) writeFileSync(join(siteDir, `${key}.txt`), body);
  const calls = [];
  const output = [];
  const errors = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    let response;
    if (url === `${ORIGIN}/${KEY}.txt`) {
      response = options.live ?? { status: 200, body: ` ${KEY}\n` };
    } else if (url === `${ORIGIN}/sitemap.xml`) {
      response = options.sitemap ?? { status: 200, body: SITEMAP };
    } else if (url === ENDPOINT && init.method === 'POST') {
      response = options.post ?? { status: 202, body: '' };
    } else {
      throw new Error(`unexpected request: ${url}`);
    }
    if (response instanceof Error) throw response;
    return { status: response.status, text: async () => response.body };
  };
  return {
    calls,
    output,
    errors,
    run: (argv = [], env = {}) =>
      main({
        argv: ['--site', ORIGIN, ...argv],
        env,
        siteDir,
        fetchImpl,
        stdout: { write: (line) => output.push(line) },
        stderr: { write: (line) => errors.push(line) },
      }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dir of tmpDirs.splice(0)) removeTree(dir);
});

describe('IndexNow accidental submissions and invalid keys', () => {
  it('prevents POST without --send and preserves sitemap URLs in one JSON line', async () => {
    const f = fixture();
    expect(await f.run()).toBe(0);
    expect(f.calls.map(({ method }) => method)).toEqual(['GET', 'GET']);
    expect(f.calls.map(({ url }) => url)).toEqual([
      `${ORIGIN}/${KEY}.txt`,
      `${ORIGIN}/sitemap.xml`,
    ]);
    expect(f.calls[0].redirect).toBe('manual');
    expect(f.output).toHaveLength(1);
    expect(f.output[0].split('\n')).toHaveLength(2);
    expect(JSON.parse(f.output[0])).toEqual({
      mode: 'dry-run',
      endpoint: ENDPOINT,
      payload: {
        host: 'session-orchestrator.com',
        key: KEY,
        keyLocation: `${ORIGIN}/${KEY}.txt`,
        urlList: URLS,
      },
    });
    expect(f.errors).toEqual([]);
  });

  it.each([200, 202])('accepts HTTP %i without dropping POST payload fields', async (status) => {
    const f = fixture({ post: { status } });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    expect(await f.run(['--send'])).toBe(0);
    const post = f.calls.find(({ method }) => method === 'POST');
    expect(post.url).toBe(ENDPOINT);
    expect(post.headers).toEqual({ 'content-type': 'application/json; charset=utf-8' });
    expect(JSON.parse(post.body)).toEqual({
      host: 'session-orchestrator.com',
      key: KEY,
      keyLocation: `${ORIGIN}/${KEY}.txt`,
      urlList: URLS,
    });
    expect(timeout.mock.calls).toEqual([[15000], [15000], [15000]]);
    expect(f.calls.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
    expect(f.output).toEqual([`${JSON.stringify({ mode: 'send', status, urls: 2 })}\n`]);
    expect(f.errors).toEqual([]);
  });

  it.each([400, 403, 422, 429, 500])(
    'does not report rejected HTTP %i as success',
    async (status) => {
      const f = fixture({ post: { status } });
      expect(await f.run(['--send'])).toBe(1);
      expect(f.calls.filter(({ method }) => method === 'POST')).toHaveLength(1);
      expect(f.output).toEqual([]);
      expect(f.errors).toHaveLength(1);
      expect(f.errors[0]).toMatch(new RegExp(`^indexnow: HTTP ${status}: [^\\n]+\\n$`));
    },
  );

  it('does not report a POST network failure as success or emit multiline diagnostics', async () => {
    const f = fixture({ post: new Error('offline\nconnection lost') });
    expect(await f.run(['--send'])).toBe(1);
    expect(f.output).toEqual([]);
    expect(f.errors).toEqual(['indexnow: offline connection lost\n']);
  });

  const invalid = [
    ...[
      'https://www.session-orchestrator.com',
      'http://session-orchestrator.com',
      'https://session-orchestrator-git-x.vercel.app',
      `${ORIGIN}/`,
      'http://localhost',
      `${ORIGIN}/guide`,
      '',
    ].map((site) => ({
      name: `origin ${site || '(empty)'}`,
      argv: ['--site', site],
      noFetch: true,
    })),
    { name: 'missing --site', argv: ['--site'], noFetch: true },
    { name: 'unknown argument', argv: ['--unknown'], noFetch: true },
    { name: 'missing local key', options: { keys: [] }, noFetch: true },
    {
      name: 'two local keys',
      options: {
        keys: [
          [KEY, KEY],
          ['a'.repeat(32), 'other'],
        ],
      },
      noFetch: true,
    },
    { name: 'local key differs from filename', options: { keys: [[KEY, 'wrong']] }, noFetch: true },
    { name: 'live 404', options: { live: { status: 404, body: KEY } }, keyOnly: true },
    { name: 'live redirect 308', options: { live: { status: 308, body: KEY } }, keyOnly: true },
    { name: 'live wrong key', options: { live: { status: 200, body: 'wrong' } }, keyOnly: true },
    { name: 'live network failure', options: { live: new Error('offline') }, keyOnly: true },
    { name: 'sitemap 500', options: { sitemap: { status: 500, body: SITEMAP } } },
    { name: 'sitemap without loc', options: { sitemap: { status: 200, body: '<urlset/>' } } },
    {
      name: 'sitemap with only foreign URLs',
      options: { sitemap: { status: 200, body: '<loc>https://example.com/</loc>' } },
    },
    { name: 'sitemap network failure', options: { sitemap: new Error('offline') } },
    { name: 'CI submission', env: { CI: 'true' }, noFetch: true },
    { name: 'foreign --url', argv: ['--url', 'https://example.com/'], keyOnly: true },
    { name: 'relative --url', argv: ['--url', '/guide'], keyOnly: true },
  ];
  it.each(invalid)(
    'blocks POST for $name',
    async ({ options, argv = [], env, noFetch, keyOnly }) => {
      const f = fixture(options);
      expect(await f.run(['--send', ...argv], env)).toBe(2);
      expect(f.calls.filter(({ method }) => method === 'POST')).toEqual([]);
      if (noFetch) expect(f.calls).toEqual([]);
      if (keyOnly) expect(f.calls.map(({ url }) => url)).toEqual([`${ORIGIN}/${KEY}.txt`]);
      expect(f.output).toEqual([]);
      expect(f.errors).toHaveLength(1);
      expect(f.errors[0]).toMatch(/^indexnow: [^\r\n]+\n$/);
    },
  );

  it('does not replace repeated --url with sitemap URLs and allows an empty CI value', async () => {
    const urls = [`${ORIGIN}/de`, `${ORIGIN}/guide?x=1&y=2`];
    const f = fixture();
    expect(await f.run(['--send', ...urls.flatMap((url) => ['--url', url])], { CI: '' })).toBe(0);
    expect(f.calls.map(({ url }) => url)).toEqual([`${ORIGIN}/${KEY}.txt`, ENDPOINT]);
    expect(JSON.parse(f.calls[1].body).urlList).toEqual(urls);
  });

  it('excludes foreign sitemap URLs and decodes XML query separators', async () => {
    const f = fixture({
      sitemap: {
        status: 200,
        body: `<loc>https://example.com/</loc><loc>${ORIGIN}/guide?a=1&amp;b=2</loc>`,
      },
    });
    expect(await f.run()).toBe(0);
    expect(JSON.parse(f.output[0]).payload.urlList).toEqual([`${ORIGIN}/guide?a=1&b=2`]);
  });

  it('catches a second deployed key or a deployed filename/content mismatch before a live 403', () => {
    const site = join(REPO_ROOT, 'site');
    const keys = readdirSync(site).filter((name) => /^[0-9a-f]{32}\.txt$/.test(name));
    expect(keys).toHaveLength(1);
    expect(readFileSync(join(site, keys[0]), 'utf8').trim()).toBe(keys[0].slice(0, -4));
  });

  it('does not fetch or exit when imported by another module', async () => {
    vi.resetModules();
    const fetch = vi.fn(() => {
      throw new Error('import attempted network IO');
    });
    vi.stubGlobal('fetch', fetch);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('import exited');
    });
    await import('../../site/seo/indexnow.mjs');
    expect(fetch).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
