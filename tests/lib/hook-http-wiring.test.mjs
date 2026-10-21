import { EventEmitter } from 'node:events';
import { it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect the fixed registry URL at the transport seam; no new production
// option and no internet. A return to global fetch fails before any network.
vi.mock('@lib/http-request.mjs', async importOriginal => {
  const original = await importOriginal();
  return { ...original, httpRequest: vi.fn((url, options) => original.httpRequest(
    url.startsWith('https://registry.npmjs.org/') ? `${endpoint}/registry` : url, options,
  )) };
});
import { checkPluginUpdate } from '@lib/plugin-update-banner.mjs';
import { emitEvent } from '@lib/events.mjs';
import { httpRequest } from '@lib/http-request.mjs';

let endpoint;
let server;
let dir;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  if (dir) rmSync(dir, { recursive: true, force: true });
});
async function setup(handler) {
  dir = mkdtempSync(join(tmpdir(), 'hook-http-'));
  server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  endpoint = `http://127.0.0.1:${server.address().port}`;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('fetch forbidden in hooks (#1612)'); }));
}
it('plugin default transport reads and caches the registry response via Stdlib', async () => {
  await setup((_req, res) => res.end('{"version":"2.0.0"}'));
  writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0"}');
  const cacheDir = join(dir, 'cache');
  mkdirSync(cacheDir);
  const result = await checkPluginUpdate({ pluginRoot: dir, cacheDir, env: {} });
  expect(result?.latest).toBe('2.0.0');
  expect(httpRequest).toHaveBeenCalledOnce();
  await checkPluginUpdate({ pluginRoot: dir, cacheDir, env: {} });
  expect(httpRequest).toHaveBeenCalledOnce();
});
it('R1-03 emitEvent resolves before the server response, while the POST arrives', async () => {
  let finish;
  let received;
  const arrived = new Promise(resolve => { finish = resolve; });
  await setup((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received = { method: req.method, url: req.url, body: JSON.parse(body) };
      finish(res);
    });
  });
  vi.stubEnv('CLANK_EVENT_SECRET', 'fixture');
  vi.stubEnv('CLANK_EVENT_URL', endpoint);
  let settled = false;
  const pending = emitEvent('orchestrator.session.started', { session_id: 'fixture' }, { repoRoot: dir })
    .then(() => { settled = true; });
  const response = await arrived;
  try {
    const winner = await Promise.race([pending.then(() => 'resolved'),
      new Promise(resolve => setTimeout(() => resolve('blocked'), 100))]);
    expect(winner).toBe('resolved');
    expect(settled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    response.end('{}');
    await pending;
  }
  expect(received.method).toBe('POST');
  expect(received.url).toBe('/api/webhooks/events');
  expect(received.body.event_type).toBe('orchestrator.session.started');
  // No spy assertion here: events.mjs may already be loaded by the suite's setup
  // before this file's vi.mock applies. global fetch is stubbed to throw above,
  // so a POST that ARRIVED proves the Stdlib transport.
});

it('R1-03 returns before a held transport response without a listening socket', async () => {
  dir = mkdtempSync(join(tmpdir(), 'hook-http-'));
  vi.stubEnv('CLANK_EVENT_SECRET', 'fixture');
  vi.stubEnv('CLANK_EVENT_URL', 'http://fixture.invalid');
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('fetch forbidden'); }));
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.statusCode = 200;
  let receive;
  req.end = vi.fn(() => {});
  req.destroy = error => req.emit('error', error);
  vi.spyOn(http, 'request').mockImplementation((_url, _opts, callback) => { receive = callback; return req; });
  const pending = emitEvent('orchestrator.session.started', { session_id: 'fixture' }, { repoRoot: dir });
  try {
    expect(await Promise.race([pending.then(() => 'resolved'),
      // The server never answers before `finally`, so an awaited POST could not
      // resolve at all; the generous window only absorbs a loaded host (Opus N4).
      new Promise(resolve => setTimeout(() => resolve('blocked'), 5000))])).toBe('resolved');
    expect(JSON.parse(req.end.mock.calls[0][0]).event_type).toBe('orchestrator.session.started');
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    if (receive) { receive(res); res.emit('end'); }
    await pending;
  }
});
