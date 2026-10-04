#!/usr/bin/env node
/** Native, dependency-free MCP stdio transport. No shell, WSL, or jq required. */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isSessionConfigHeading } from './lib/config/section-extractor.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const SERVER_INFO = { name: 'session-orchestrator', version: '2.0.0' };
const TOOLS = [
  {
    name: 'session_config',
    description: 'Reads Session Config section from the project instruction file (CLAUDE.md or AGENTS.md alias)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'session_metrics',
    description: 'Reads the last 5 REAL session metrics entries from .orchestrator/metrics/sessions.jsonl (abandoned phantom stubs excluded)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];
const textContent = (text) => ({ content: [{ type: 'text', text }] });
const errorResponse = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Resolve the caller's repository without passing native paths through a shell. */
export function resolveProjectRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function isFile(path, nonempty = false) {
  try {
    const stat = statSync(path);
    return stat.isFile() && (!nonempty || stat.size > 0);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

/** Read the same raw config body as the legacy shell tool (including comments). */
export function readSessionConfig(root) {
  const file = ['CLAUDE.md', 'AGENTS.md'].map((name) => join(root, name))
    .find((path) => isFile(path, true));
  if (!file) return `No CLAUDE.md or AGENTS.md found at ${root}`;
  const body = [];
  let inSection = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (isSessionConfigHeading(line)) {
      inSection = true;
    } else if (line.startsWith('## ')) {
      inSection = false;
    } else if (inSection) {
      body.push(line);
    }
  }
  // Shell command substitution removes LF bytes, not spaces or CR bytes.
  return body.join('\n').replace(/\n+$/, '') || `No '## Session Config' section found in ${file}`;
}

/** Read the last five real records, with whole-ledger stub count and token coverage. */
export function readSessionMetrics(root) {
  const file = ['.orchestrator', '.claude'].map((dir) => join(root, dir, 'metrics', 'sessions.jsonl'))
    .find((path) => isFile(path));
  if (!file) return 'No metrics found (checked .orchestrator/metrics/ and .claude/metrics/)';
  const entries = [];
  let stubCount = 0;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    // Torn writes and non-record JSON must not hide subsequent valid sessions.
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    if (record.status === 'abandoned') { stubCount++; continue; }
    entries.push(record);
    if (entries.length > 5) entries.shift();
  }
  if (!entries.length) {
    return stubCount ? `No real sessions (abandoned stubs excluded: ${stubCount})`
      : 'No metrics found (file is empty)';
  }
  const record = entries.findLast((entry) => (entry.total_token_input !== null && entry.total_token_input !== undefined)
    || (entry.total_token_output !== null && entry.total_token_output !== undefined));
  const coverage = record?.subagents_with_tokens ?? 0;
  const summary = record
    ? `tokens: ${record.total_token_input ?? '?'} in / ${record.total_token_output ?? '?'} out`
      + ` (coverage: ${coverage} subagents)`
      + (coverage === 0 ? ' ⚠ partial — subagent token data missing; total is not a reliable cost estimate' : '')
      + ` [session: ${record.session_id ?? 'unknown'}]`
    : 'tokens: no token data in last 5 sessions (subagent telemetry not yet captured)';
  return entries.map((entry) => JSON.stringify(entry)).join('\n')
    + `\n\nabandoned stubs excluded: ${stubCount}\n\n--- token summary ---\n${summary}`;
}

/** Handle one JSON-RPC line. null means a notification or blank line, not a reply. */
export function handleLine(line, { cwd = process.cwd(), resolveRoot = resolveProjectRoot } = {}) {
  if (!line.trim()) return null;
  let request;
  try { request = JSON.parse(line); } catch { return errorResponse(null, -32700, 'Parse error'); }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return errorResponse(null, -32600, 'Invalid Request');
  }
  const hasId = Object.hasOwn(request, 'id');
  const validId = request.id === null || typeof request.id === 'string' || typeof request.id === 'number';
  const id = hasId && validId ? request.id : null;
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (hasId && !validId)) {
    return errorResponse(id, -32600, 'Invalid Request');
  }
  if (!hasId || request.method.startsWith('notifications/')) return null;
  let result;
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO };
      break;
    case 'tools/list':
      result = { tools: TOOLS };
      break;
    case 'tools/call': {
      const name = request.params?.name;
      if (typeof name !== 'string') return errorResponse(id, -32602, 'Invalid tool name');
      if (!TOOLS.some((tool) => tool.name === name)) return errorResponse(id, -32602, `Unknown tool: ${name}`);
      try {
        const root = resolveRoot(cwd);
        result = textContent(root
          ? (name === 'session_config' ? readSessionConfig(root) : readSessionMetrics(root))
          : 'Error: not inside a git repository');
      } catch {
        return errorResponse(id, -32603, 'Unable to read session data');
      }
      break;
    }
    default:
      return errorResponse(id, -32601, `Method not found: ${request.method}`);
  }
  return { jsonrpc: '2.0', id, result };
}

/** Start newline-delimited JSON-RPC on the supplied streams. */
export async function serve({ input = process.stdin, output = process.stdout, cwd = process.cwd() } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const response = handleLine(line, { cwd });
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

if (isMainModule(import.meta.url)) {
  serve().catch(() => {
    process.stderr.write('session-orchestrator: MCP stdio transport failed.\n');
    process.exitCode = 2;
  });
}
