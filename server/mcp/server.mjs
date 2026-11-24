#!/usr/bin/env node
/**
 * server/mcp/server.mjs — public, read-only MCP server for the OpenAI plugin
 * directory (#2260). Dependency-free: node:http only.
 *
 * Transport: MCP Streamable HTTP in its stateless form. Every POST /mcp carries
 * exactly one JSON-RPC message and gets a JSON response; there are no sessions
 * and no server-initiated streams, so GET /mcp answers 405. Batches are
 * refused: one request must cost one rate-limit count, and a batch of twenty
 * tool calls turned a 2 KB request into a 1 MB response (security review).
 *
 * Privacy invariants (load-bearing, stated in pages.mjs):
 *   - no request body, tool input or IP address is logged or written anywhere;
 *   - the IP is used only as the in-memory rate-limit key (rate-limit.mjs),
 *     for at most 60 seconds: the window is clamped, because the privacy page
 *     states that number;
 *   - /healthz exposes counters of status codes and tool names, nothing else.
 */
import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientKey, createRateLimiter } from './rate-limit.mjs';
import { createTools } from './tools.mjs';
import { renderPages, resolveOperator } from './pages.mjs';

/** Protocol revisions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS =
  'Read-only reference for Session Orchestrator, a session harness for coding agents. ' +
  'Call search, then fetch with a result id to read a section in full. ' +
  'Use check_session_config for a Session Config block the user pastes, list_skills to find a skill, ' +
  'get_release_notes for versions. Answers describe the plugin version named in each result; cite the returned URLs.';

const num = (raw, fallback) => {
  const n = Number((raw || '').trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Pure environment resolution; whitespace-only values count as unset. */
export function resolveConfig(env = process.env) {
  return {
    port: num(env.PORT, 8788),
    host: (env.SO_MCP_HOST || '').trim() || '0.0.0.0',
    corpusPath: (env.SO_MCP_CORPUS || '').trim() || fileURLToPath(new URL('./corpus.json', import.meta.url)),
    bodyCap: num(env.SO_MCP_BODY_CAP, 64 * 1024),
    rateWindowMs: Math.min(num(env.SO_MCP_RATE_WINDOW_MS, 60_000), 60_000),
    // Per address and minute. Calls from ChatGPT arrive from few addresses shared by many users.
    rateLimit: num(env.SO_MCP_RATE_LIMIT, 240),
    maxTrackedIps: num(env.SO_MCP_MAX_TRACKED_IPS, 20_000),
    overflowLimit: num(env.SO_MCP_OVERFLOW_LIMIT, 600),
    // Addresses of the TLS edge. Only a request from one of them may name its client in X-Forwarded-For.
    trustedProxies: (env.SO_MCP_TRUSTED_PROXY || '').split(',').map((a) => a.trim()).filter(Boolean),
    // Domain-verification token for the OpenAI plugin portal; empty = route answers 404.
    challenge: (env.SO_MCP_OPENAI_CHALLENGE || '').trim(),
    // Who runs this instance; null leaves /privacy and /terms unserved (pages.mjs).
    operator: resolveOperator(env),
  };
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * Handle one JSON-RPC message. Returns the response object, or null for a
 * notification (which gets no response).
 */
export function handleRpc(message, { tools, version, onToolCall }) {
  if (message === null || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message?.id, -32600, 'Invalid Request');
  }
  const { id, method, params } = message;
  if (id === undefined) return null;
  // MCP forbids null as a request id; a message without an id is a notification.
  if (id === null || (typeof id !== 'string' && typeof id !== 'number')) return rpcError(null, -32600, 'Invalid Request');

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'session-orchestrator', title: 'Session Orchestrator', version },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: tools.list() });
    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string') return rpcError(id, -32602, 'tools/call needs a tool name');
      let result;
      try {
        result = tools.call(name, params.arguments);
      } catch {
        // Never echo the input or the error text: both can carry user content.
        onToolCall?.(name, 'error');
        return rpcResult(id, { content: [{ type: 'text', text: `The tool ${name} failed. Try again with simpler input.` }], isError: true });
      }
      if (result === null) return rpcError(id, -32602, `Unknown tool: ${name.slice(0, 80)}`);
      onToolCall?.(name, result.isError ? 'tool_error' : 'ok');
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method.slice(0, 80)}`);
  }
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
  res.countStatus?.(status);
}

/**
 * Read the body up to `cap` bytes; resolves null when the cap is exceeded. The
 * socket stays open so the caller can still answer 413 (a destroyed socket
 * gives a chunked upload an empty reply); the caller closes it afterwards.
 */
function readBody(req, cap) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > cap) {
        chunks.length = 0;
        resolveBody(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Build the HTTP server around a loaded corpus.
 * @param {{ config: ReturnType<typeof resolveConfig>, corpus: object }} deps
 */
export function createServer({ config, corpus }) {
  const tools = createTools(corpus);
  const rateLimiter = createRateLimiter({
    windowMs: config.rateWindowMs,
    limit: config.rateLimit,
    maxTracked: config.maxTrackedIps,
    overflowLimit: config.overflowLimit,
  });
  const stats = { started_at: new Date().toISOString(), http_status: {}, tool_calls: {} };
  const onToolCall = (name, outcome) => {
    const key = `${name}:${outcome}`;
    stats.tool_calls[key] = (stats.tool_calls[key] ?? 0) + 1;
  };
  const pages = renderPages(config.operator);
  const html = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' };

  async function handleMcpPost(req, res) {
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return send(res, 415, rpcError(null, -32600, 'Content-Type must be application/json'));
    }
    if (Number(req.headers['content-length']) > config.bodyCap) return send(res, 413, rpcError(null, -32600, 'Request too large'));
    const decision = rateLimiter.check(clientKey(req, config.trustedProxies));
    if (!decision.allowed) {
      return send(res, 429, rpcError(null, -32000, 'Too many requests; try again shortly'), { 'Retry-After': String(decision.retryAfter) });
    }
    const raw = await readBody(req, config.bodyCap);
    if (raw === null) {
      res.once('finish', () => req.destroy());
      return send(res, 413, rpcError(null, -32600, 'Request too large'), { Connection: 'close' });
    }
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return send(res, 400, rpcError(null, -32700, 'Parse error'));
    }
    const deps = { tools, version: corpus.version, onToolCall };
    if (Array.isArray(message)) return send(res, 400, rpcError(null, -32600, 'Batch requests are not supported; send one message per request'));
    const response = handleRpc(message, deps);
    return response ? send(res, 200, response) : send(res, 202, '');
  }

  const server = createHttpServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/healthz') {
      return send(res, 200, { status: 'ok', version: corpus.version, corpus_built_at: corpus.built_at, ...stats });
    }
    res.countStatus = (status) => {
      stats.http_status[status] = (stats.http_status[status] ?? 0) + 1;
    };
    const readOnly = req.method === 'GET' || req.method === 'HEAD';
    if (path === '/mcp') {
      if (req.method === 'POST') {
        return void handleMcpPost(req, res).catch(() => send(res, 400, rpcError(null, -32600, 'Invalid Request')));
      }
      return send(res, 405, rpcError(null, -32000, 'Method not allowed; POST JSON-RPC to this URL'), { Allow: 'POST' });
    }
    if (!readOnly) return send(res, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
    if (path === '/.well-known/openai-apps-challenge') {
      return config.challenge ? send(res, 200, config.challenge) : send(res, 404, 'Not found\n');
    }
    if (pages && path === '/privacy') return send(res, 200, pages.privacy, html);
    if (pages && path === '/terms') return send(res, 200, pages.terms, html);
    if (path === '/') return send(res, 302, '', { Location: 'https://session-orchestrator.com' });
    return send(res, 404, 'Not found\n');
  });

  // Slow-client bounds; the proxy in front adds its own.
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('close', () => rateLimiter.stop());
  return server;
}

// realpath on both sides: under a symlinked directory the spellings differ and the CLI would silently do nothing.
// existsSync first: an argv[1] that names no file (node -e, a wrapper) must not make an import throw.
if (process.argv[1] && existsSync(resolve(process.argv[1])) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const config = resolveConfig();
  const corpus = JSON.parse(readFileSync(config.corpusPath, 'utf8'));
  const server = createServer({ config, corpus });
  server.listen(config.port, config.host, () => {
    process.stdout.write(`so-mcp ${corpus.version} listening on ${config.host}:${config.port}\n`);
    if (!config.operator) process.stderr.write('so-mcp: operator not configured (SO_MCP_OPERATOR_*, SO_MCP_HOSTING_PROCESSOR); /privacy and /terms answer 404\n');
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
