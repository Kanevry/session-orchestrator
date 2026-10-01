/**
 * node site/seo/indexnow.mjs --site https://session-orchestrator.com [--send] [--url URL]...
 * Exit: 0 success, 1 submission failed, 2 invalid arguments or prerequisites.
 *
 * Run by hand only after a production deploy. Dry-run is the default; --send submits. Both first
 * require the live key file to serve the local key, so before the deploy that ships it: exit 2.
 * This file is served publicly from site/ (vercel.json outputDirectory) and holds no secret.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMainModule } from '../../scripts/lib/is-main-module.mjs';

const ORIGIN = 'https://session-orchestrator.com';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const SITE_DIR = fileURLToPath(new URL('..', import.meta.url));
const POST_ERRORS = {
  400: 'Format ungültig',
  403: 'Schlüssel ungültig',
  422: 'URL/Host passt nicht',
  429: 'zu viele Meldungen',
};

function sameOrigin(url) {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
}

function decodeXml(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity, code) => {
    if (code.startsWith('#')) {
      return String.fromCodePoint(
        code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)),
      );
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[code] ?? entity;
  });
}

/** Validate prerequisites and optionally submit URLs using injectable IO; return the exit code. */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  siteDir = SITE_DIR,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let failureCode = 2;
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        site: { type: 'string' },
        send: { type: 'boolean', default: false },
        url: { type: 'string', multiple: true },
      },
    });
    if (values.site !== ORIGIN) throw new Error(`--site muss ${ORIGIN} sein`);
    if (values.send && env.CI) throw new Error('--send ist in CI gesperrt');

    const keys = readdirSync(siteDir, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && /^[0-9a-f]{32}\.txt$/.test(entry.name),
    );
    if (keys.length !== 1) throw new Error('genau eine lokale Schlüsseldatei erforderlich');
    const key = keys[0].name.slice(0, -4);
    if (readFileSync(join(siteDir, keys[0].name), 'utf8').trim() !== key) {
      throw new Error('lokaler Schlüssel stimmt nicht mit Dateinamen überein');
    }
    const keyLocation = `${ORIGIN}/${key}.txt`;
    const live = await fetchImpl(keyLocation, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    if (live.status !== 200 || (await live.text()).trim() !== key) {
      throw new Error('Live-Schlüsselprüfung fehlgeschlagen');
    }

    let urlList = values.url;
    if (urlList) {
      if (urlList.some((url) => !sameOrigin(url))) throw new Error('--url hat fremden Ursprung');
    } else {
      const sitemap = await fetchImpl(`${ORIGIN}/sitemap.xml`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      if (sitemap.status !== 200) throw new Error(`Sitemap HTTP ${sitemap.status}`);
      urlList = [...(await sitemap.text()).matchAll(/<loc\b[^>]*>([^<]*)<\/loc>/g)]
        .map((match) => decodeXml(match[1].trim()))
        .filter(sameOrigin);
    }
    if (!urlList.length) throw new Error('keine URLs gefunden');
    const payload = { host: new URL(ORIGIN).host, key, keyLocation, urlList };
    if (!values.send) {
      stdout.write(`${JSON.stringify({ mode: 'dry-run', endpoint: ENDPOINT, payload })}\n`);
      return 0;
    }

    failureCode = 1;
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status !== 200 && response.status !== 202) {
      throw new Error(
        `HTTP ${response.status}: ${POST_ERRORS[response.status] ?? 'Meldung abgelehnt'}`,
      );
    }
    stdout.write(
      `${JSON.stringify({ mode: 'send', status: response.status, urls: urlList.length })}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`indexnow: ${String(error.message).replace(/[\r\n]+/g, ' ')}\n`);
    return failureCode;
  }
}

// realpath on both sides: a launch through a symlinked path (/tmp, /var on macOS) must still run.
if (isMainModule(import.meta.url)) {
  // exitCode, not exit(): a hard exit can drop stdout still queued on a pipe.
  process.exitCode = await main();
}
