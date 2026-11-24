/**
 * directory-preflight.mjs — measure a tree against the mechanical rules of the Claude
 * plugin directory scan (#2216, #824).
 *
 * The directory scans every commit of the public mirror on its own, and nobody is told
 * when a scan fails. This reports, before the export, what such a scan objects to as far
 * as a tree listing can show it. It removes nothing and blocks nothing by itself: the
 * caller picks the mode.
 *
 * Rule texts and limits: claude.com/docs/plugins/pre-submission-checklist § "Files in the
 * plugin folder" and the scan of 5.21.0 (commit a681a8bf, read 2026-11-22).
 * Ceiling: a tree listing shows sizes, names and three small files. What the scan derives
 * from reading code (launchers, credentials, download-and-run commands, hook decisions)
 * is not measured here; revisit when the directory publishes a validator one can run.
 */

export const MODES = ['off', 'warn', 'strict'];
export const FILE_LIMIT = 512;
export const TEXT_BYTE_LIMIT = 256 * 1024;

const IMAGE_OR_FONT = /\.(png|jpe?g|gif|webp|svg|woff2?|ttf|otf)$/i;
/** Binary kinds the checklist names as held; ceiling: by extension, not by content. */
const UNREADABLE_BINARY = /\.(ico|pdf|zip|mp4|webm|mov|gz|tgz|exe|dll|dylib|so|wasm)$/i;
const LINE_ENDING_ATTR = /^(-?text|text=.*|eol=.*|-?crlf|crlf=.*|-binary|!binary|binary=.*)$/;
/** Attributes that only switch line endings off; the scan accepts those. */
const SWITCHES_OFF = new Set(['-text', '-crlf', 'binary']);

/**
 * @typedef {{ path: string, size: number }} TreeEntry
 * @typedef {{ code: string, severity: 'blocking'|'hold', message: string, measured?: number, limit?: number, paths?: string[] }} Finding
 */

/**
 * Line-ending rules without `eol=lf` as the only eol setting on their own line.
 * @param {string} text content of a .gitattributes file
 * @returns {string[]} offending lines, trimmed
 */
export function lineEndingRulesWithoutLf(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    // A pattern with spaces is written in double quotes; its words are not attributes.
    const quoted = /^"(?:[^"\\]|\\.)*"/.exec(line);
    const attrs = (quoted ? line.slice(quoted[0].length) : line.replace(/^\S+/, '')).trim().split(/\s+/).filter(Boolean);
    const lineEnding = attrs.filter((a) => LINE_ENDING_ATTR.test(a) && !SWITCHES_OFF.has(a));
    if (lineEnding.length === 0) continue;
    const eols = attrs.filter((a) => a.startsWith('eol='));
    if (eols.length !== 1 || eols[0] !== 'eol=lf') out.push(line);
  }
  return out;
}

/** Server names of an `mcpServers` object, or [] for a path string or anything else. */
function serverNames(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

/** `null` for an absent file (`text` null) and for text that does not parse; callers tell the two apart. */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Files whose MCP declaration is compared below; one that exists but does not parse is not "absent". */
const MCP_FILES = ['.claude-plugin/plugin.json', '.mcp.json'];

/**
 * @param {object} input
 * @param {TreeEntry[]} input.entries every file of the tree
 * @param {(path: string) => string|null} input.read content of one file, null when it is
 *   not in the tree. A reader that cannot read a listed file must throw: null there would
 *   switch the check off.
 * @returns {Finding[]}
 */
export function findDirectoryFindings({ entries, read }) {
  /** @type {Finding[]} */
  const findings = [];
  const paths = new Set(entries.map((e) => e.path));

  if (entries.length > FILE_LIMIT) {
    findings.push({
      code: 'file-count', severity: 'hold', measured: entries.length, limit: FILE_LIMIT,
      message: `${entries.length} files; the directory reads ${FILE_LIMIT} and holds the rest for a reviewer (refused for organizations that are not Verified)`,
    });
  }

  const largeText = entries.filter((e) => e.size > TEXT_BYTE_LIMIT && !IMAGE_OR_FONT.test(e.path) && !UNREADABLE_BINARY.test(e.path));
  if (largeText.length > 0) {
    findings.push({
      code: 'large-text', severity: 'hold', measured: largeText.length, limit: TEXT_BYTE_LIMIT,
      message: `${largeText.length} file(s) over 256 KiB that are neither image nor font`,
      paths: largeText.map((e) => e.path),
    });
  }

  const binaries = entries.filter((e) => UNREADABLE_BINARY.test(e.path));
  if (binaries.length > 0) {
    findings.push({
      code: 'unreadable-binary', severity: 'hold', measured: binaries.length,
      message: `${binaries.length} binary file(s) the validator does not inspect (${Math.round(binaries.reduce((n, e) => n + e.size, 0) / 1048576)} MiB)`,
      paths: binaries.map((e) => e.path),
    });
  }

  // Claude Code loads a root .mcp.json and then the inline declaration; the scan refuses
  // a server name that appears in both (13 findings on 5.21.0).
  const mcpTexts = Object.fromEntries(MCP_FILES.map((p) => [p, read(p)]));
  const unparsable = MCP_FILES.filter((p) => mcpTexts[p] !== null && parseJson(mcpTexts[p]) === null);
  if (unparsable.length > 0) {
    // Not "no server declared": the duplicate check below could not look at these files.
    findings.push({
      code: 'mcp-unparsable', severity: 'blocking', measured: unparsable.length,
      message: `${unparsable.join(', ')} present but not valid JSON; the MCP duplicate check could not run on it`,
      paths: unparsable,
    });
  }
  const inline = serverNames(parseJson(mcpTexts['.claude-plugin/plugin.json'] ?? '')?.mcpServers);
  const rootFile = serverNames(parseJson(mcpTexts['.mcp.json'] ?? '')?.mcpServers);
  const repeated = inline.filter((name) => rootFile.includes(name));
  if (repeated.length > 0) {
    findings.push({
      code: 'mcp-declared-twice', severity: 'blocking', measured: repeated.length,
      message: `MCP server declared in .mcp.json and inline in .claude-plugin/plugin.json: ${repeated.join(', ')}`,
      paths: ['.mcp.json', '.claude-plugin/plugin.json'],
    });
  }

  const attrLines = [...paths].filter((p) => p === '.gitattributes' || p.endsWith('/.gitattributes'))
    .flatMap((p) => lineEndingRulesWithoutLf(read(p) ?? '').map((line) => `${p}: ${line}`));
  if (attrLines.length > 0) {
    findings.push({
      code: 'gitattributes-eol', severity: 'blocking', measured: attrLines.length,
      message: `${attrLines.length} line-ending rule(s) without eol=lf; the scanner refuses the commit before scanning`,
      paths: attrLines,
    });
  }

  if (paths.has('package.json') && ['package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb'].some((p) => paths.has(p))) {
    findings.push({
      code: 'lockfile-install', severity: 'hold',
      message: 'package.json beside a lockfile: Claude Code installs the packages at plugin install (refused for organizations that are not Verified)',
    });
  }

  return findings;
}

/**
 * Apply the mode ladder: `off` measures nothing, `warn` reports and stays green,
 * `strict` is red on a blocking finding. Holds never turn a run red: a reviewer
 * decides them, the project cannot clear them by itself.
 * @param {{ mode: string, entries: TreeEntry[], read: (path: string) => string|null }} input
 * @returns {{ mode: string, ok: boolean, checked: boolean, files: number|null, bytes: number|null, findings: Finding[], holds: string[] }}
 *   `checked: false` = nothing was measured (mode off or empty listing); `ok` is then an
 *   exit-code verdict only. `holds` lists the open hold codes: `ok` in strict is no listing
 *   clearance, a reviewer still decides them.
 */
export function runDirectoryPreflight({ mode, entries, read }) {
  if (!MODES.includes(mode)) throw new TypeError(`unknown mode '${mode}' (known: ${MODES.join(', ')})`);
  if (mode === 'off') return { mode, ok: true, checked: false, files: null, bytes: null, findings: [], holds: [] };
  const findings = findDirectoryFindings({ entries, read });
  // An empty listing measured nothing: every check above passes on it by absence.
  const checked = entries.length > 0;
  if (!checked) {
    findings.push({ code: 'empty-listing', severity: 'blocking', message: 'the tree listing is empty; nothing was measured' });
  }
  const ok = mode !== 'strict' || (checked && findings.every((f) => f.severity !== 'blocking'));
  const holds = findings.filter((f) => f.severity === 'hold').map((f) => f.code);
  return { mode, ok, checked, files: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0), findings, holds };
}
