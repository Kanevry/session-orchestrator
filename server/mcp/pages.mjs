/**
 * server/mcp/pages.mjs — the two public pages the plugin listing links to
 * (#2260): privacy policy and terms of use of this documentation server. The
 * text names no client and no directory: any MCP client can call the server.
 *
 * The privacy text describes what server.mjs does. Change the server's
 * logging, storage or hosting and this text changes in the same commit.
 */

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Who runs this instance. The code is open source and names no operator; the
 * host sets these in its environment. Without a name, postal address and
 * e-mail there is no valid privacy policy, so the pages are not served.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ name: string, address: string, email: string, imprintUrl: string, processor: string, region: string } | null}
 */
export function resolveOperator(env) {
  const read = (key) => (env[key] || '').trim();
  const operator = {
    name: read('SO_MCP_OPERATOR_NAME'),
    address: read('SO_MCP_OPERATOR_ADDRESS'),
    email: read('SO_MCP_OPERATOR_EMAIL'),
    imprintUrl: read('SO_MCP_OPERATOR_IMPRINT_URL'),
    // The hosting company that processes requests on the operator's behalf.
    processor: read('SO_MCP_HOSTING_PROCESSOR'),
    // Where that processing happens, e.g. "the European Union"; the page claims a region only when set.
    region: read('SO_MCP_HOSTING_REGION'),
  };
  const complete = operator.name && operator.address && /^[^\s@]+@[^\s@]+$/.test(operator.email) && operator.processor;
  if (operator.imprintUrl && !/^https:\/\/\S+$/.test(operator.imprintUrl)) return null;
  return complete ? operator : null;
}

const controllerHtml = (o) =>
  `${esc(o.name)}, ${esc(o.address)} · <a href="mailto:${esc(o.email)}">${esc(o.email)}</a>` +
  (o.imprintUrl ? ` · <a href="${esc(o.imprintUrl)}">Imprint</a>` : '');

const page = (title, updated, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Session Orchestrator</title>
<style>
  body { font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a1a1a; background: #fff; max-width: 44rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.7rem; line-height: 1.25; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; }
  p, ul { margin: .5rem 0; }
  a { color: #0b57d0; }
  .meta { color: #555; font-size: .9rem; }
  nav { margin-top: 3rem; font-size: .9rem; }
</style>
</head>
<body>
<h1>${title}</h1>
<p class="meta">Session Orchestrator documentation server · Last updated ${updated}</p>
${body}
<nav><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of use</a> · <a href="https://session-orchestrator.com">session-orchestrator.com</a> · <a href="https://github.com/Kanevry/session-orchestrator/tree/main/server/mcp">Source code</a></nav>
</body>
</html>
`;

const privacyHtml = (o) => page(
  'Privacy policy',
  '2026-11-23',
  `
<h2>Who is responsible</h2>
<p>${controllerHtml(o)}</p>

<h2>What this covers</h2>
<p>This policy covers the Session Orchestrator documentation server at <code>mcp.session-orchestrator.com</code>. An AI assistant or coding agent that speaks the Model Context Protocol (MCP) can connect to it and ask it questions about the Session Orchestrator documentation. Where the server comes bundled in a plugin together with skills, the skills are written instructions that run inside your assistant; they send nothing to us.</p>

<h2>What the server receives</h2>
<p>When your assistant calls one of the server's tools, the server receives:</p>
<ul>
  <li>the name of the tool and its input: search words, the id of a documentation section, a word to filter skills by, a version number, or the text of a Session Config block you asked to have checked;</li>
  <li>the IP address and user agent of the system that connects. With a hosted assistant this is a server of its provider, not your own device; with a local agent it is your own connection.</li>
</ul>
<p>The server has no accounts and no sign-in, and it sets no cookies. It does not receive your name, your e-mail address, your conversation or your files.</p>

<h2>What the server does with it</h2>
<p>It answers the request from a fixed copy of the public Session Orchestrator documentation and forgets the input. A Session Config block is checked in memory and is not written anywhere.</p>
<ul>
  <li><strong>Nothing is stored.</strong> The server has no database and writes no files.</li>
  <li><strong>No access log.</strong> The server keeps no log of requests, inputs or IP addresses, and the proxy in front of it keeps no access log for this service. If the server cannot be reached or a response is cut off, the proxy writes a technical error line with time, status and at most the request path, without input and without IP address.</li>
  <li><strong>Requests that are not for this service.</strong> A request that carries a host name the proxy does not serve, for example a mistyped one, never reaches the server. The proxy records it in its general log with the IP address, as it does for any stray request, and that log is overwritten within a few days.</li>
  <li><strong>Rate limiting.</strong> To stop abuse, the server keeps a count of requests per IP address in memory for at most 60 seconds. The count is never written to disk.</li>
  <li><strong>Counters.</strong> The server counts how often each tool was called and which HTTP status codes it returned. These numbers contain no input and no address and are reset at every restart.</li>
</ul>
<p>The purpose is to answer the request and to keep the service running safely. The legal basis is Art. 6(1)(f) GDPR, our legitimate interest in operating a stable service.</p>

<h2>Recipients</h2>
<p>The server runs on infrastructure of ${esc(o.processor)}, which acts as our processor under Art. 28 GDPR. We do not pass data to anyone else, do not sell it and do not use it for advertising or profiling. ${o.region ? `Processing takes place in ${esc(o.region)}; we do not transfer data outside it.` : ''}</p>
<p>How the provider of your assistant handles your conversation, including what it sends to this server, is governed by that provider's own privacy policy.</p>

<h2>Retention</h2>
<p>None beyond the 60-second request count in memory and the proxy's general log for stray requests, both described above.</p>

<h2>Your choices and rights</h2>
<p>You decide in your assistant whether the server is connected and whether a tool call goes out. Under the GDPR you have the right to access, rectification, erasure, restriction, data portability and objection. Because the server stores no personal data, there is normally nothing to disclose or erase; write to the address above and we will confirm that. You can also lodge a complaint with the Austrian data protection authority (<a href="https://www.dsb.gv.at">dsb.gv.at</a>).</p>

<h2>The full plugin</h2>
<p>Session Orchestrator can also be installed from GitHub or npm as a full plugin with hooks. That version can send anonymous usage statistics, and only after you have agreed. It is described in the <a href="https://github.com/Kanevry/session-orchestrator/blob/main/docs/telemetry.md">telemetry documentation</a> and has nothing to do with this server.</p>
`,
);

const termsHtml = (o) => page(
  'Terms of use',
  '2026-11-23',
  `
<h2>Who provides this</h2>
<p>${controllerHtml(o)}</p>

<h2>What you get</h2>
<p>The Session Orchestrator documentation server at <code>mcp.session-orchestrator.com</code> lets an AI assistant or coding agent that speaks the Model Context Protocol search the public Session Orchestrator documentation, list its skills, check a Session Config block and read release notes. It only reads; it changes nothing on your side.</p>
<p>The server is free of charge. There is no account, no subscription and nothing to buy.</p>

<h2>Licence</h2>
<p>Session Orchestrator is open source under the <a href="https://github.com/Kanevry/session-orchestrator/blob/main/LICENSE">MIT licence</a>. The licence governs your use of the software and the documentation.</p>

<h2>Fair use</h2>
<p>Use the server through an MCP client for its purpose. Do not try to overload it, bypass its rate limit or probe it for weaknesses. If you find a security problem, please report it as described in the <a href="https://github.com/Kanevry/session-orchestrator/blob/main/SECURITY.md">security policy</a>. We may limit or block requests that endanger the service.</p>

<h2>No warranty on answers</h2>
<p>The answers come from the documentation of a specific plugin version and are given as they are. They can be out of date or wrong for your setup. Check a result before you rely on it, in particular before you change a configuration.</p>

<h2>Availability</h2>
<p>We run the server with care but do not promise that it is always available. We may change, pause or end it.</p>

<h2>Liability</h2>
<p>The service is provided free of charge. We are liable for damage caused by intent or gross negligence and for injury to life, body or health. Beyond that, liability is excluded as far as the law allows. Rights you have as a consumer under mandatory law remain unaffected.</p>

<h2>Law and contact</h2>
<p>Austrian law applies, without its conflict-of-law rules; if you are a consumer, the mandatory protections of the country you live in still apply. Questions go to <a href="mailto:${esc(o.email)}">${esc(o.email)}</a> or to the <a href="https://github.com/Kanevry/session-orchestrator/issues">issue tracker</a>.</p>
`,
);

/**
 * Render both pages for one operator.
 * @returns {{ privacy: string, terms: string } | null} null when the operator is not configured
 */
export function renderPages(operator) {
  return operator ? { privacy: privacyHtml(operator), terms: termsHtml(operator) } : null;
}

