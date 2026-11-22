import { readHtml, readSitemap } from './readers.mjs';
import { readFileSync } from 'node:fs';
const crawlers = JSON.parse(
  readFileSync(new URL('./crawler-identifiers.json', import.meta.url), 'utf8'),
);

/** No source references are fetched. The shipped crawler identities remain unverified. */
export async function measureResources({
  manifest,
  pageResults,
  coreUrl = manifest.pages[0].url,
  fetcher,
  clock = () => new Date().toISOString(),
}) {
  const results = [];
  const now = () => new Date(clock()).toISOString();
  const emit = (checkId, state, response, value, reason, category = 'error', sources) => {
    const url = response.finalUrl || response.url;
    const timestamp = response.timestamp || now();
    results.push({
      checkId,
      state,
      url,
      timestamp,
      ...(value !== undefined ? { value, sources: sources || [{ url, timestamp }] } : {}),
      ...(reason ? { reason } : {}),
      ...(state === 'finding' ? { category } : {}),
    });
  };
  const availability = (r) =>
    r.state !== 'ok' ? r.state : r.status === 429 || r.status >= 500 ? 'unavailable' : null;
  const success = (r) => !availability(r) && r.status >= 200 && r.status < 300;
  const get = async (url, options) => {
    try {
      return await fetcher.fetch(url, options);
    } catch {
      return { state: 'unavailable', url, timestamp: now(), reason: 'Resource request failed' };
    }
  };
  const sitemapSources = [];
  const seen = new Set();
  const entries = [];
  let incomplete;
  const walk = async (url) => {
    // Traversal is bounded independently of the per-host request budget; revisit with streamed XML.
    if (seen.has(url) || seen.size >= 100) {
      incomplete ||= { state: 'not-measurable', reason: 'Sitemap cycle or traversal limit' };
      return;
    }
    seen.add(url);
    const r = await get(url);
    sitemapSources.push({ url: r.finalUrl || url, timestamp: r.timestamp || now() });
    if (!success(r)) {
      incomplete ||= {
        state: availability(r) || 'not-measurable',
        reason: r.reason || `Sitemap HTTP ${r.status}`,
      };
      return;
    }
    const sitemap = readSitemap(r.body || '');
    if (!sitemap.measurable) {
      incomplete ||= { state: 'not-measurable', reason: sitemap.reason || 'Unsupported sitemap' };
      return;
    }
    if (sitemap.kind === 'sitemapindex' || sitemap.kind === 'index') {
      for (const entry of sitemap.entries) {
        try {
          await walk(new URL(entry.loc, r.finalUrl || url).href);
        } catch {
          incomplete ||= { state: 'not-measurable', reason: 'Invalid sitemap location' };
        }
      }
    } else if (sitemap.kind === 'urlset') {
      for (const entry of sitemap.entries) {
        try {
          const loc = new URL(entry.loc);
          if (!['http:', 'https:'].includes(loc.protocol) || loc.username || loc.password)
            throw Error('Invalid location');
          entries.push({
            ...entry,
            loc: loc.href,
            source: { url: r.finalUrl || url, timestamp: r.timestamp || now() },
          });
        } catch {
          incomplete ||= { state: 'not-measurable', reason: 'Invalid sitemap page location' };
        }
      }
    } else incomplete ||= { state: 'not-measurable', reason: 'Unknown sitemap kind' };
  };
  const sitemapUrl = manifest.sitemapUrl || new URL('/sitemap.xml', manifest.baseUrl).href;
  await walk(sitemapUrl);
  const sitemapResponse = { url: sitemapUrl, timestamp: sitemapSources[0]?.timestamp || now() };
  emit(
    'sitemap.traversal',
    incomplete?.state || 'ok',
    sitemapResponse,
    {
      observedUrls: new Set(entries.map((entry) => entry.loc)).size,
      observedEntries: entries.length,
      observedDocuments: seen.size,
      complete: !incomplete,
    },
    incomplete?.reason,
    'error',
    sitemapSources,
  );
  const invalidDates = entries
    .filter((entry) => {
      if (!entry.lastmod) return false;
      if (
        !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
          entry.lastmod,
        )
      )
        return true;
      const date = new Date(entry.lastmod);
      if (!Number.isFinite(date.getTime())) return true;
      const prefix = entry.lastmod.slice(0, 10);
      // Date.parse rolls February 30 into March; validate the local calendar independently.
      return new Date(`${prefix}T00:00:00Z`).toISOString().slice(0, 10) !== prefix;
    })
    .map((entry) => entry.loc);
  const validDates = entries
    .filter((entry) => entry.lastmod && !invalidDates.includes(entry.loc))
    .map((entry) => entry.lastmod)
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  emit(
    'sitemap.lastmod',
    invalidDates.length ? 'finding' : incomplete?.state || 'ok',
    sitemapResponse,
    {
      invalid: invalidDates,
      ...(validDates.length ? { latestLastmod: validDates[0] } : {}),
      missingLastmod: entries.filter((entry) => !entry.lastmod).length,
      observedEntries: entries.length,
      complete: !incomplete,
    },
    invalidDates.length ? 'Invalid sitemap lastmod dates' : incomplete?.reason,
    'error',
    sitemapSources,
  );
  const languages = manifest.languages || [];
  const languageGaps = entries
    .filter((entry) => languages.length > 1 || entry.alternates.length > 0)
    .map((entry) => ({
      url: entry.loc,
      missing: languages.filter(
        (lang) => !entry.alternates.some((alt) => alt.lang.toLowerCase() === lang.toLowerCase()),
      ),
    }))
    .filter((entry) => entry.missing.length);
  emit(
    'sitemap.languages',
    languageGaps.length ? 'finding' : incomplete?.state || 'ok',
    sitemapResponse,
    { gaps: languageGaps, complete: !incomplete },
    languageGaps.length ? 'Missing sitemap language alternates' : incomplete?.reason,
    'opportunity',
    sitemapSources,
  );

  const robotsUrl = new URL('/robots.txt', manifest.baseUrl).href;
  const robots = await get(robotsUrl);
  // Prefix paths only: wildcard/end-anchor/encoding ambiguities are explicitly unsupported.
  const groups = [];
  let group;
  let unsupported = robots.bodyKind === 'binary';
  if (success(robots))
    for (const raw of (robots.body || '').split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      const match = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
      if (!match) {
        unsupported = true;
        continue;
      }
      const field = match[1].toLowerCase();
      const value = match[2].trim();
      if (field === 'user-agent') {
        if (!group || group.rules.length) {
          group = { agents: [], rules: [] };
          groups.push(group);
        }
        group.agents.push(value.toLowerCase());
      } else if (field === 'allow' || field === 'disallow') {
        if (!group) {
          unsupported = true;
          continue;
        }
        if (value && (!value.startsWith('/') || /[*$%]/.test(value))) unsupported = true;
        group.rules.push({ allow: field === 'allow', path: value });
      } else if (field !== 'sitemap') unsupported = true;
    }
  for (const crawler of crawlers) {
    const value = {
      userAgent: crawler.userAgent,
      operator: crawler.operator,
      purpose: crawler.purpose,
      verification: crawler.verification,
      reference: crawler.source,
      referenceDate: crawler.date,
    };
    const robotState = availability(robots);
    if (robotState) emit('robots.policy', robotState, robots, value, robots.reason);
    else if (robots.status === 404)
      emit(
        'robots.policy',
        'ok',
        robots,
        { ...value, allowed: true },
        'No robots file; no policy rules observed',
      );
    else if (!success(robots) || unsupported)
      emit(
        'robots.policy',
        'not-measurable',
        robots,
        value,
        robots.bodyKind === 'binary'
          ? 'Binary robots body cannot be measured as a text policy'
          : 'Unsupported robots syntax or status',
      );
    else {
      const matches = groups.map((g) => ({
        ...g,
        length: Math.max(
          -1,
          ...g.agents.map((a) =>
            a === '*' ? 0 : crawler.userAgent.toLowerCase().includes(a) ? a.length : -1,
          ),
        ),
      }));
      const longest = Math.max(-1, ...matches.map((g) => g.length));
      const path = new URL(coreUrl).pathname + new URL(coreUrl).search;
      const rules = matches
        .filter((g) => g.length === longest && longest >= 0)
        .flatMap((g) => g.rules)
        .filter((rule) => rule.path && path.startsWith(rule.path))
        .sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
      const allowed = !rules.length || rules[0].allow;
      emit(
        'robots.policy',
        allowed ? 'ok' : 'finding',
        robots,
        { ...value, allowed, coreUrl },
        allowed
          ? 'Prefix policy permits configured core URL'
          : 'Prefix policy disallows configured core URL',
        'opportunity',
      );
    }
    const actual = await get(coreUrl, { userAgent: crawler.userAgent });
    emit(
      'crawler.response',
      availability(actual) || (success(actual) ? 'ok' : 'finding'),
      actual,
      { ...value, ...(actual.status === undefined ? {} : { status: actual.status }), coreUrl },
      actual.reason || 'Actual crawler GET; identity not verified',
      'opportunity',
    );
  }
  for (const { page, response, html: provided } of pageResults) {
    const failed = availability(response);
    if (failed || !success(response)) {
      emit(
        'head.resource',
        failed || 'not-measurable',
        response,
        undefined,
        response.reason || 'Page resource discovery unavailable',
      );
      continue;
    }
    const html = provided || readHtml(response.body || '');
    if (!html.measurable) {
      emit('head.resource', 'not-measurable', response, undefined, html.reason);
      continue;
    }
    const headLinks = (html.headLinks || []).filter(
      (link) => typeof link.href === 'string' && link.href.trim(),
    );
    const feeds = headLinks.filter(
      (link) =>
        /^(application\/(rss\+xml|atom\+xml|feed\+json)|application\/json\+feed)$/i.test(
          link.type || '',
        ) && (link.rel || '').toLowerCase().split(/\s+/).includes('alternate'),
    );
    emit(
      'feed.presence',
      feeds.length ? 'ok' : 'finding',
      response,
      { linkedFeeds: feeds.length },
      feeds.length
        ? 'Feed link present; availability measured separately'
        : 'No feed linked in head',
      'opportunity',
    );
    const resources = [];
    for (const kind of ['icon', 'apple-touch-icon', 'manifest', 'og-image']) {
      const links =
        kind === 'og-image'
          ? html.ogImage
            ? [{ href: html.ogImage }]
            : []
          : headLinks.filter((link) => (link.rel || '').toLowerCase().split(/\s+/).includes(kind));
      emit(
        `head.${kind}.presence`,
        links.length ? 'ok' : 'finding',
        response,
        { kind, pageType: page.type, linkedResources: links.length },
        links.length ? 'Resource linked in head' : `No ${kind} linked in head`,
        'opportunity',
      );
      resources.push(...links.map((link) => ({ href: link.href, kind, checkId: 'head.resource' })));
    }
    resources.push(
      ...feeds.map((link) => ({ href: link.href, kind: 'feed', checkId: 'feed.status' })),
    );
    for (const resource of resources) {
      let target;
      try {
        target = new URL(resource.href, response.finalUrl || page.url).href;
      } catch {
        emit(resource.checkId, 'not-measurable', response, undefined, 'Invalid head resource URL');
        continue;
      }
      const fetched = await get(target);
      emit(
        resource.checkId,
        availability(fetched) || (success(fetched) ? 'ok' : 'finding'),
        fetched,
        {
          kind: resource.kind,
          pageType: page.type,
          ...(fetched.status === undefined ? {} : { status: fetched.status }),
        },
        fetched.reason || 'Linked resource GET',
        'opportunity',
      );
    }
  }
  return results;
}
