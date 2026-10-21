import { EventEmitter } from 'node:events';
import { afterEach, it, expect, vi } from 'vitest';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { httpRequest } from '@lib/http-request.mjs';

let server;
afterEach(async () => {
  vi.restoreAllMocks();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  server = undefined;
});
async function listen(handler) {
  server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

it('reads real JSON and text and sends method, headers and body without keep-alive', async () => {
  let received;
  const url = await listen((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received = { method: req.method, body, header: req.headers['x-test'], connection: req.headers.connection };
      res.end('{"version":"2.0.0"}');
    });
  });
  const response = await httpRequest(url, { method: 'POST', headers: { 'x-test': 'value' }, body: 'payload' });
  expect(response.ok).toBe(true);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ version: '2.0.0' });
  expect(await response.text()).toBe('{"version":"2.0.0"}');
  expect(received).toEqual({ method: 'POST', body: 'payload', header: 'value', connection: 'close' });
});
it('preserves non-2xx status instead of treating it as successful', async () => {
  const url = await listen((_req, res) => { res.writeHead(503); res.end('unavailable'); });
  const response = await httpRequest(url);
  expect(response.ok).toBe(false);
  expect(response.status).toBe(503);
});
it.each(['silent', 'partial'])('destroys a %s response at the wall-clock deadline', async mode => {
  const url = await listen((_req, res) => {
    if (mode === 'partial') res.write('incomplete');
  });
  const start = performance.now();
  await expect(httpRequest(url, { timeoutMs: 50 })).rejects.toThrow('timed out');
  expect(performance.now() - start).toBeGreaterThanOrEqual(40);
  expect(performance.now() - start).toBeLessThan(1000);
});
it('rejects unsupported URL schemes before issuing a request', async () => {
  await expect(httpRequest('file:///etc/passwd')).rejects.toThrow('http: or https:');
});
it('rejects interrupted responses rather than hanging until forced hook exit', async () => {
  const url = await listen((_req, res) => { res.write('partial'); setImmediate(() => res.destroy()); });
  await expect(httpRequest(url)).rejects.toThrow();
});

it.each([undefined, 64 * 1024])('R1-05 rejects and closes responses exceeding maxBytes %s', async maxBytes => {
  const limit = maxBytes ?? 1024 * 1024;
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const url = await listen((_req, res) => {
    res.on('close', closed);
    res.end(Buffer.alloc(limit + 1));
  });
  await expect(httpRequest(url, { maxBytes })).rejects.toThrow('maxBytes');
  await disconnected;
});

it('R1-05 bounds buffered bytes and destroys the transport without a listening socket', async () => {
  const req = new EventEmitter();
  req.destroy = vi.fn(error => { req.emit('error', error); });
  req.end = () => {};
  const res = new EventEmitter();
  res.statusCode = 200;
  res.destroy = vi.fn();
  vi.spyOn(http, 'request').mockImplementation((_url, _opts, receive) => {
    globalThis.queueMicrotask(() => {
      receive(res);
      res.emit('data', Buffer.alloc(1024 * 1024));
      res.emit('data', Buffer.from('x'));
      res.emit('end');
    });
    return req;
  });
  await expect(httpRequest('http://fixture.invalid')).rejects.toThrow('maxBytes');
  expect(req.destroy).toHaveBeenCalled();
});
