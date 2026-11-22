import { createFetcher } from './fetch.mjs';
import { readHtml } from './readers.mjs';
import { measurePage } from './pages.mjs';
import { measureFiles } from './files.mjs';
import { measureResources } from './resources.mjs';

/** Sequential stage-O audit. Only measurements and provenance cross the report boundary. */
export async function audit(
  manifest,
  {
    fetcher: providedFetcher,
    clock = () => new Date(),
    maxDurationMs = 60000,
    ...fetchOptions
  } = {},
) {
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0 || maxDurationMs > 60000)
    throw new Error('Audit duration must be within sixty seconds');
  const timestamp = () => new Date(clock()).toISOString();
  const startedAt = Date.now();
  const reportTime = timestamp();
  const requestTimeout = Math.min(fetchOptions.timeoutMs ?? 5000, maxDurationMs / 4);
  const transport =
    providedFetcher ??
    createFetcher({
      ...fetchOptions,
      timeoutMs: requestTimeout,
      allowedHosts: manifest.allowedHosts,
      clock,
    });
  const cache = new Map();
  const responses = [];
  const measurements = [];
  const pageResults = [];
  const evidence = new Map();
  const keyPaths = (manifest.indexnowPaths ?? []).map((path) => {
    try {
      const url = new URL(path, manifest.baseUrl);
      return { url: url.href, path: url.pathname, filename: url.pathname.split('/').at(-1) };
    } catch {
      return { url: String(path), path: String(path), filename: '' };
    }
  });
  function redactText(value) {
    let text = value;
    for (const key of keyPaths) {
      for (const fragment of [key.url, key.path, key.filename].filter(Boolean))
        text = text.split(fragment).join('[configured-indexnow-path]');
    }
    return text;
  }
  function safeUrl(value) {
    try {
      const url = new URL(value);
      url.username = '';
      url.password = '';
      if (keyPaths.some((key) => url.pathname === key.path)) {
        url.pathname = '/[configured-indexnow-path]';
        url.search = '';
        url.hash = '';
      }
      return redactText(url.href);
    } catch {
      return '[invalid URL]';
    }
  }
  function sanitize(value) {
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value)) return safeUrl(value);
      return redactText(value);
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
    return value;
  }
  function record(response, requestUrl, before = {}) {
    responses.push(response);
    for (const [host, count] of Object.entries(transport.counts ?? {})) {
      const delta = count - (before[host] ?? 0);
      if (delta <= 0) continue;
      const sources = (response.chain ?? [])
        .filter((hop) => {
          try {
            return new URL(hop.url).hostname.toLowerCase().replace(/\.$/, '') === host;
          } catch {
            return false;
          }
        })
        .map(({ url, timestamp: time }) => ({ url, timestamp: time }));
      while (sources.length < delta) {
        const candidate = [response.finalUrl, requestUrl].find((url) => {
          try {
            return new URL(url).hostname.toLowerCase().replace(/\.$/, '') === host;
          } catch {
            return false;
          }
        });
        sources.push({ url: candidate ?? `https://${host}/`, timestamp: response.timestamp });
      }
      if (!evidence.has(host)) evidence.set(host, []);
      evidence.get(host).push(...sources.slice(0, delta));
    }
    return response;
  }
  const fetcher = {
    counts: transport.counts,
    fetch(url, options = {}) {
      const key = JSON.stringify([String(url), options.userAgent ?? 'PublicAudit/1.0']);
      if (!cache.has(key))
        cache.set(
          key,
          (async () => {
            // Do not race requests against the run deadline: native transport must finish/abort
            // before the next launch. Reserve its complete timeout rather than leave a socket.
            const before = { ...transport.counts };
            if (Date.now() - startedAt + 4 * requestTimeout > maxDurationMs)
              return record(
                {
                  state: 'not-fetched',
                  url: String(url),
                  finalUrl: String(url),
                  timestamp: timestamp(),
                  chain: [],
                  reason: 'Insufficient remaining audit time for a complete redirect chain',
                },
                String(url),
                before,
              );
            try {
              return record(await transport.fetch(url, options), String(url), before);
            } catch {
              return record(
                {
                  state: 'unavailable',
                  url: String(url),
                  finalUrl: String(url),
                  timestamp: timestamp(),
                  chain: [],
                  reason: 'Audit request failed',
                },
                String(url),
                before,
              );
            }
          })(),
        );
      return cache.get(key);
    },
  };
  const homepage =
    manifest.pages.find((page) => /^(home|homepage)$/i.test(page.type)) ?? manifest.pages[0];
  async function page(page) {
    const response = await fetcher.fetch(page.url);
    const html = response.state === 'ok' ? readHtml(response.body ?? '') : undefined;
    pageResults.push({ page, response, html });
    measurements.push(...measurePage({ page, response, manifest }));
  }
  await page(homepage);
  const localizedLlms =
    (manifest.llmsPaths ?? []).find((path) => {
      try {
        return new URL(path, manifest.baseUrl).pathname !== '/llms.txt';
      } catch {
        return false;
      }
    }) ?? manifest.llmsPaths?.[0];
  if (localizedLlms) await fetcher.fetch(new URL(localizedLlms, manifest.baseUrl).href);
  for (const configured of manifest.pages) if (configured !== homepage) await page(configured);
  for (const url of manifest.urlVariants ?? []) {
    const response = await fetcher.fetch(url);
    const success = response.state === 'ok' && response.status >= 200 && response.status < 300;
    measurements.push({
      checkId: 'http.variant',
      state: response.state !== 'ok' ? response.state : success ? 'ok' : 'finding',
      ...(response.state === 'ok' && !success ? { category: 'error' } : {}),
      url: response.finalUrl || response.url,
      timestamp: response.timestamp,
      ...(response.status === undefined
        ? {}
        : {
            value: { status: response.status },
            sources: [{ url: response.finalUrl || response.url, timestamp: response.timestamp }],
          }),
      ...(response.reason ? { reason: response.reason } : {}),
    });
  }
  measurements.push(...(await measureFiles({ manifest, pageResults, fetcher, clock })));
  measurements.push(
    ...(await measureResources({ manifest, pageResults, coreUrl: homepage.url, fetcher, clock })),
  );
  for (const response of responses) {
    // Every status is accompanied by its own hop URL/time, including failed chains.
    const hops = (response.chain ?? []).map(({ url, timestamp: time, status }) => ({
      url,
      timestamp: time,
      status,
    }));
    const configuredPage = manifest.pages.find((item) => item.url === response.url);
    measurements.push({
      checkId: 'http.chain',
      state: response.state,
      url: response.url,
      timestamp: response.timestamp,
      ...(configuredPage ? { pageType: configuredPage.type } : {}),
      value: { hops },
      sources: hops.length
        ? hops.map(({ url, timestamp: time }) => ({ url, timestamp: time }))
        : [{ url: response.url, timestamp: response.timestamp }],
      ...(response.reason ? { reason: response.reason } : {}),
    });
  }
  const budget = Object.entries(transport.counts ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, requests]) => ({
      host,
      requests,
      sources: evidence.get(host) ?? [{ url: manifest.baseUrl, timestamp: reportTime }],
    }));
  return sanitize({
    timestamp: reportTime,
    manifest: {
      baseUrl: manifest.baseUrl,
      languages: manifest.languages,
      pages: manifest.pages.map(({ type, url }) => ({ type, url })),
    },
    measurements,
    budget,
  });
}
