/**
 * Buffered HTTP response subset for hook networking (#1612). Stdlib requests
 * avoid Undici async-handle teardown crashes on Windows at process.exit().
 * Internal configured endpoints only; no redirects are followed (SEC-014).
 */
import http from 'node:http';
import https from 'node:https';

export async function httpRequest(url, {
  method = 'GET', headers = {}, body, timeoutMs = 3000, maxBytes = 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid maxBytes');
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('HTTP request requires http: or https:');
  }
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, { method, headers, agent: false }, res => {
      const chunks = [];
      let bytes = 0;
      let overflow = false;
      res.on('data', chunk => {
        if (overflow) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          overflow = true;
          chunks.length = 0;
          const error = new Error(`HTTP response exceeded maxBytes (${maxBytes})`);
          clearTimeout(timer);
          reject(error);
          res.destroy();
          req.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        if (overflow) return;
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    // Wall-clock ceiling includes DNS, connection and body, unlike a socket
    // inactivity timeout. Destroying closes the socket even for a stalled body.
    const timer = setTimeout(() => {
      req.destroy(new Error('HTTP request timed out'));
    }, timeoutMs);
    req.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}
