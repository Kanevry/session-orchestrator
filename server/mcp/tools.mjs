/**
 * server/mcp/tools.mjs — the tools of the remote MCP server (#2260).
 *
 * Every tool is read-only and answers from the corpus built at image build
 * (build-corpus.mjs). No tool reaches the network, a database or the file
 * system, and no tool input is stored or logged: `check_session_config` is the
 * only tool that receives user content, and it only returns its findings.
 */
import { collectTopLevelKeyLines, collectUnparsableLines, isSessionConfigHeading } from '../../scripts/lib/config/section-extractor.mjs';

/** Longest text a single tool result carries; longer sections are cut with a note. */
export const MAX_TEXT_CHARS = 12_000;
/** Longest Session Config text `check_session_config` accepts. */
export const MAX_CONFIG_CHARS = 20_000;
/** Most findings of one kind `check_session_config` lists; the rest is a count. */
export const MAX_FINDINGS = 25;
/** Most distinct words of a query that `search` scores. */
export const MAX_QUERY_TERMS = 12;
// A key is echoed back only in this shape. Anything else is user text that
// would return to the calling model as tool output, so it is described, not quoted.
const ECHOABLE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true };

const STOPWORDS = new Set(
  'a an and are as at be by do does for from how i in is it my of on or that the this to what when where which with'.split(' '),
);

/** Lower-case word tokens without stopwords. */
export function tokenize(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? [])
    .map((t) => t.replace(/[.-]+$/, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Rank corpus sections for a query. A term found in the title counts five
 * times a term found in the body, a term the section defines (table row or
 * code at line start) four times; body hits are capped so one long section
 * that repeats a word does not outrank a section named after it.
 *
 * Deliberately a plain word search over ~230 sections (BV-004): no stemming,
 * no index. Revisit when users demonstrably miss sections that exist.
 */
export function searchDocuments(documents, query, limit) {
  const terms = [...new Set(tokenize(query))].slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) return [];
  const scored = [];
  for (const doc of documents) {
    const title = doc.title.toLowerCase();
    const body = doc.text.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const inTitle = title.includes(term);
      const bodyHits = Math.min(body.split(term).length - 1, 5);
      // A term set in code (`agents-per-wave`) or opening a table row is what the section defines.
      const defined = body.includes(`| \`${term}\``) || body.includes(`\n\`${term}\``);
      if (inTitle || bodyHits > 0) matched++;
      score += (inTitle ? 5 : 0) + bodyHits + (defined ? 4 : 0);
    }
    if (matched === 0) continue;
    scored.push({ doc, score: score * (matched / terms.length) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ doc }) => ({
    id: doc.id,
    title: doc.title,
    url: doc.url,
    snippet: snippetFor(doc.text, terms),
  }));
}

function snippetFor(text, terms) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = Math.max(0, at - 80);
  const cut = text.slice(start, start + 280).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${cut}${start + 280 < text.length ? '…' : ''}`;
}

function clip(text) {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_TEXT_CHARS)}\n\n[cut after ${MAX_TEXT_CHARS} characters; open the URL for the full section]`, truncated: true };
}

// Words every question about skills carries; they would match almost every skill.
const SKILL_NOISE = new Set(['skill', 'skills', 'session', 'orchestrator', 'help', 'helps', 'me', 'can', 'use', 'need', 'want']);

/**
 * Skills for a query, best match first. Without usable words: all skills, by
 * name. A skill is ranked by how many of the query's words it covers (a word
 * counts when a word of the skill starts with it), then by hits in its name.
 * Skills covering fewer than half as many words as the best one are dropped, so
 * a task question returns the few skills that fit, not the alphabetical list.
 */
export function rankSkills(skills, query) {
  const terms = [...new Set(tokenize(query))].filter((t) => !SKILL_NOISE.has(t)).slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) return skills;
  const scored = skills
    .map((skill) => {
      const nameWords = skill.name.toLowerCase().split('-');
      const words = [...nameWords, ...tokenize(skill.description)];
      const covered = terms.filter((t) => words.some((w) => w.startsWith(t))).length;
      const inName = terms.filter((t) => nameWords.some((w) => w.startsWith(t))).length;
      return { skill, covered, inName };
    })
    .filter((x) => x.covered > 0)
    .sort((a, b) => b.covered - a.covered || b.inName - a.inName);
  const floor = (scored[0]?.covered ?? 0) / 2;
  return scored.filter((x) => x.covered >= floor).slice(0, 10).map((x) => x.skill);
}

/** Levenshtein distance, used to suggest the key a typo meant. */
export function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function suggestKey(key, known) {
  let best = null;
  for (const candidate of known) {
    const d = editDistance(key, candidate);
    if (d <= Math.max(2, Math.floor(key.length / 4)) && (best === null || d < best.d)) best = { candidate, d };
  }
  return best?.candidate ?? null;
}

/**
 * Check a Session Config block against the keys this plugin version reads.
 * Accepts the block with or without its `## Session Config` heading, or a whole
 * CLAUDE.md / AGENTS.md. Pure: returns findings, keeps nothing.
 */
export function checkSessionConfig(configText, config) {
  const hasHeading = configText.split('\n').some((line) => isSessionConfigHeading(line));
  const content = hasHeading ? configText : `## Session Config\n\n${configText}`;
  const offset = hasHeading ? 0 : 2;
  const known = new Set(config.known_keys);
  const keyLines = collectTopLevelKeyLines(content);
  const keys = keyLines.map((k) => k.key);
  // Bounded on purpose: suggesting a key costs a distance against every known
  // key, and unbounded lists let one request burn CPU and echo its input back tenfold.
  const allUnknown = keyLines.filter((k) => !known.has(k.key));
  const unknownKeys = allUnknown.slice(0, MAX_FINDINGS).map((k) => {
    const echoable = ECHOABLE_KEY.test(k.key);
    return {
      key: echoable ? k.key : `(invalid key, ${k.key.length} characters)`,
      line: k.line - offset,
      suggestion: echoable && k.key.length <= 40 ? suggestKey(k.key, known) : null,
    };
  });
  const seen = new Set();
  const duplicateKeys = [...new Set(keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false))))]
    .filter((k) => ECHOABLE_KEY.test(k))
    .slice(0, MAX_FINDINGS);
  const allUnparsable = collectUnparsableLines(content);
  // Only where and how long: an unparsable line is free text from the input and is never quoted back.
  const unparsableLines = allUnparsable.slice(0, MAX_FINDINGS).map((l) => ({ line: l.line - offset, length: l.text.length }));
  const starterKeys = collectTopLevelKeyLines(`## Session Config\n\n${config.starter_block}`).map((k) => k.key);
  const missingStarterKeys = starterKeys.filter((k) => !keys.includes(k));
  return {
    plugin_version: config.plugin_version,
    heading_found: hasHeading,
    keys_found: keys.length,
    unknown_keys: unknownKeys,
    unknown_keys_omitted: allUnknown.length - unknownKeys.length,
    duplicate_keys: duplicateKeys,
    unparsable_lines: unparsableLines,
    unparsable_lines_omitted: allUnparsable.length - unparsableLines.length,
    missing_starter_keys: missingStarterKeys,
    ok: keys.length > 0 && allUnknown.length === 0 && duplicateKeys.length === 0 && allUnparsable.length === 0,
    reference_url: config.reference_url,
  };
}

function summarizeCheck(r) {
  if (r.keys_found === 0) return 'No Session Config keys found in the text. A block is a list of top-level `key: value` lines under a `## Session Config` heading.';
  const parts = [`${r.keys_found} top-level keys checked against Session Orchestrator ${r.plugin_version}.`];
  for (const u of r.unknown_keys) {
    parts.push(`Line ${u.line}: unknown key \`${u.key}\` has no effect${u.suggestion ? `; did you mean \`${u.suggestion}\`?` : '.'}`);
  }
  if (r.unknown_keys_omitted > 0) parts.push(`${r.unknown_keys_omitted} more unknown keys not listed.`);
  for (const d of r.duplicate_keys) parts.push(`Key \`${d}\` appears more than once.`);
  for (const l of r.unparsable_lines) parts.push(`Line ${l.line} cannot be parsed (${l.length} characters); expected \`key: value\`.`);
  if (r.unparsable_lines_omitted > 0) parts.push(`${r.unparsable_lines_omitted} more unparsable lines not listed.`);
  if (r.missing_starter_keys.length > 0) parts.push(`Not set, defaults apply: ${r.missing_starter_keys.join(', ')}.`);
  if (r.ok) parts.push('No problems found.');
  return parts.join('\n');
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

/** Build the tool list and the call dispatcher for one corpus. */
export function createTools(corpus) {
  const byId = new Map(corpus.documents.map((d) => [d.id, d]));
  const config = { ...corpus.config, plugin_version: corpus.version };

  const tools = [
    {
      name: 'search',
      title: 'Search Session Orchestrator docs',
      description:
        'Use this when the user asks how Session Orchestrator works, how to install, upgrade or configure it, or what a Session Config key does. Searches the public documentation of the released plugin version and returns matching sections. Call `fetch` with a result id to read a section in full.',
      inputSchema: {
        type: 'object',
        properties: {
          query: str('Search words, for example "codex install marketplace" or "agents-per-wave".', { minLength: 2, maxLength: 200 }),
          limit: { type: 'integer', description: 'How many results to return (1 to 10, default 5).', minimum: 1, maximum: 10 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, snippet: { type: 'string' } },
              required: ['id', 'title', 'url'],
            },
          },
        },
        required: ['results'],
      },
      annotations: { ...READ_ONLY },
      handler({ query, limit }) {
        const results = searchDocuments(corpus.documents, query, limit ?? 5);
        const text = results.length
          ? results.map((r, i) => `${i + 1}. ${r.title}\n   id: ${r.id}\n   ${r.url}\n   ${r.snippet}`).join('\n')
          : `No documentation section matches "${query}". Try other words, or call list_skills.`;
        return { structuredContent: { results }, text };
      },
    },
    {
      name: 'fetch',
      title: 'Read a documentation section',
      description:
        'Use this after `search` to read one documentation section in full. Pass the `id` of a search result. Returns the section text and its public URL.',
      inputSchema: {
        type: 'object',
        properties: { id: str('The id of a section, exactly as returned by `search`.', { minLength: 3, maxLength: 300 }) },
        required: ['id'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          url: { type: 'string' },
          metadata: { type: 'object' },
        },
        required: ['id', 'title', 'text', 'url'],
      },
      annotations: { ...READ_ONLY },
      handler({ id }) {
        const doc = byId.get(id);
        if (!doc) return { isError: true, text: `No section with id "${id}". Call search first and pass one of its ids.` };
        const { text, truncated } = clip(doc.text);
        return {
          structuredContent: { id: doc.id, title: doc.title, text, url: doc.url, metadata: { source: doc.source, plugin_version: corpus.version, truncated } },
          text: `# ${doc.title}\n${doc.url}\n\n${text}`,
        };
      },
    },
    {
      name: 'list_skills',
      title: 'List Session Orchestrator skills',
      description:
        'Use this when the user asks which skills or commands Session Orchestrator has, or which one fits a task. Returns each skill with its description and whether the user can invoke it directly. With a query it returns the best-matching skills first; without one, all skills.',
      inputSchema: {
        type: 'object',
        properties: { query: str('Optional words to filter by, for example "debug" or "release".', { maxLength: 200 }) },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          plugin_version: { type: 'string' },
          skills: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                user_invocable: { type: 'boolean' },
                argument_hint: { type: 'string' },
                url: { type: 'string' },
              },
              required: ['name', 'description', 'url'],
            },
          },
        },
        required: ['plugin_version', 'skills'],
      },
      annotations: { ...READ_ONLY },
      handler({ query }) {
        const skills = rankSkills(corpus.skills, query ?? '');
        const text = skills.length
          ? skills.map((s) => `- ${s.name}${s.user_invocable ? ` (/${s.name}${s.argument_hint ? ` ${s.argument_hint}` : ''})` : ''}: ${s.description}`).join('\n')
          : `No skill matches "${query}".`;
        return { structuredContent: { plugin_version: corpus.version, skills }, text };
      },
    },
    {
      name: 'check_session_config',
      title: 'Check a Session Config block',
      description:
        'Use this when the user wants a Session Config block from CLAUDE.md or AGENTS.md checked. Pass the block text. Reports keys this plugin version does not read (with the likely intended key), duplicate keys, the line numbers of lines that cannot be parsed and starter keys left at their default. The text is checked in memory and is not stored.',
      inputSchema: {
        type: 'object',
        properties: {
          config_text: str('The Session Config block, with or without its "## Session Config" heading. Do not include secrets.', {
            minLength: 1,
            maxLength: MAX_CONFIG_CHARS,
          }),
        },
        required: ['config_text'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          plugin_version: { type: 'string' },
          ok: { type: 'boolean' },
          heading_found: { type: 'boolean' },
          keys_found: { type: 'integer' },
          unknown_keys: {
            type: 'array',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, line: { type: 'integer' }, suggestion: { type: ['string', 'null'] } },
              required: ['key', 'line'],
            },
          },
          unknown_keys_omitted: { type: 'integer' },
          unparsable_lines_omitted: { type: 'integer' },
          duplicate_keys: { type: 'array', items: { type: 'string' } },
          unparsable_lines: {
            type: 'array',
            items: { type: 'object', properties: { line: { type: 'integer' }, length: { type: 'integer' } }, required: ['line', 'length'] },
          },
          missing_starter_keys: { type: 'array', items: { type: 'string' } },
          reference_url: { type: 'string' },
        },
        required: ['plugin_version', 'ok', 'keys_found', 'unknown_keys', 'unparsable_lines'],
      },
      annotations: { ...READ_ONLY },
      handler({ config_text: configText }) {
        const result = checkSessionConfig(configText, config);
        return { structuredContent: result, text: summarizeCheck(result) };
      },
    },
    {
      name: 'get_release_notes',
      title: 'Get Session Orchestrator release notes',
      description:
        'Use this when the user asks what the latest Session Orchestrator version is, whether their version is current, or what changed in a release. Without a version it returns the latest release; with one it returns that release.',
      inputSchema: {
        type: 'object',
        properties: { version: str('A released version in X.Y.Z form. Omit for the latest release.', { pattern: '^\\d+\\.\\d+\\.\\d+$' }) },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          latest_version: { type: 'string' },
          version: { type: 'string' },
          date: { type: 'string' },
          notes: { type: 'string' },
          url: { type: 'string' },
          available_versions: { type: 'array', items: { type: 'string' } },
        },
        required: ['latest_version', 'available_versions'],
      },
      annotations: { ...READ_ONLY },
      handler({ version }) {
        const available = corpus.releases.map((r) => r.version);
        const latest = available[0] ?? corpus.version;
        const release = version ? corpus.releases.find((r) => r.version === version) : corpus.releases[0];
        if (!release) {
          return {
            structuredContent: { latest_version: latest, available_versions: available },
            text: `No release notes for ${version} here. Available: ${available.join(', ')}. Older versions: ${corpus.config.reference_url.replace(/docs\/.*$/, 'CHANGELOG.md')}`,
          };
        }
        const { text } = clip(release.text);
        return {
          structuredContent: { latest_version: latest, version: release.version, date: release.date, notes: text, url: release.url, available_versions: available },
          text: `Session Orchestrator ${release.version} (${release.date})${release.version === latest ? ', latest release' : `; latest is ${latest}`}\n${release.url}\n\n${text}`,
        };
      },
    },
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));

  return {
    /** Tool definitions as `tools/list` returns them (no handlers). */
    list: () => tools.map(({ handler: _handler, ...definition }) => definition),
    /**
     * Run one tool. Input is validated against the tool's own schema first;
     * a bad argument is a tool error the model can correct, not a crash.
     * @returns {{ content: object[], structuredContent?: object, isError?: boolean } | null} null = unknown tool
     */
    call(name, args) {
      const tool = byName.get(name);
      if (!tool) return null;
      const problem = validateArgs(tool.inputSchema, args ?? {});
      if (problem) return { content: [{ type: 'text', text: `Invalid arguments for ${name}: ${problem}` }], isError: true };
      const { text, structuredContent, isError } = tool.handler(args ?? {});
      return { content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}), ...(isError ? { isError: true } : {}) };
    },
  };
}

/** Minimal check of flat tool arguments: required, type, length, range, pattern, no extras. */
export function validateArgs(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  for (const key of schema.required ?? []) if (args[key] === undefined) return `"${key}" is required`;
  for (const [key, value] of Object.entries(args)) {
    // hasOwn: `constructor` or `__proto__` must not resolve to an inherited member.
    const prop = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : null;
    if (!prop) return `unknown argument "${String(key).slice(0, 40)}"`;
    if (prop.type === 'string') {
      if (typeof value !== 'string') return `"${key}" must be a string`;
      if (prop.minLength !== undefined && value.trim().length < prop.minLength) return `"${key}" is too short`;
      if (prop.maxLength !== undefined && value.length > prop.maxLength) return `"${key}" is longer than ${prop.maxLength} characters`;
      if (prop.pattern && !new RegExp(prop.pattern).test(value)) return `"${key}" has the wrong format`;
    } else if (prop.type === 'integer') {
      if (!Number.isInteger(value)) return `"${key}" must be an integer`;
      if (value < prop.minimum || value > prop.maximum) return `"${key}" must be between ${prop.minimum} and ${prop.maximum}`;
    }
  }
  return null;
}
