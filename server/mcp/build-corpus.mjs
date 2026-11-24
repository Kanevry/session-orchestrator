#!/usr/bin/env node
/**
 * server/mcp/build-corpus.mjs — builds the read-only knowledge file the remote
 * MCP server answers from (#2260).
 *
 * The server never reads the repository at runtime: this script runs once at
 * image build, and its JSON output is the only content the container carries.
 * Every source must be part of the curated public export
 * (.orchestrator/policy/public-export.json), so the server can never answer
 * with a document the public GitHub mirror does not carry.
 *
 * Usage: node server/mcp/build-corpus.mjs --out <file> [--repo <root>]
 */
import { readFileSync, readdirSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownTemplateKeys, extractSessionConfigBlock } from '../../scripts/lib/config/template-keys.mjs';

/** Public home of the sources; every result links there so the user can open it. */
export const PUBLIC_REPO_URL = 'https://github.com/Kanevry/session-orchestrator';

/** Documents split into searchable sections. Order is the tie-break in search. */
export const DOC_SOURCES = [
  'README.md',
  'docs/install.md',
  'docs/codex-setup.md',
  'docs/session-config-template.md',
  'docs/session-config-reference.md',
  'docs/components.md',
  'docs/telemetry.md',
];

/** GitHub-style heading anchor: lower-case, drop punctuation (underscores stay), spaces to dashes. */
export function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/[`*]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/**
 * Split Markdown into sections at headings of level 1 to 3. Headings inside
 * fenced code blocks are text. Repeated headings get GitHub's -1, -2 suffix.
 * @returns {{ level: number, heading: string, anchor: string, trail: string[], text: string }[]}
 */
export function splitSections(markdown) {
  const sections = [];
  const seen = new Map();
  const trail = [];
  let current = null;
  let fence = null;
  for (const line of markdown.split('\n')) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
    }
    const h = fence === null && !fenceMatch ? /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (!h) {
      if (current) current.lines.push(line);
      continue;
    }
    const level = h[1].length;
    const heading = h[2].replace(/<!--.*?-->/g, '').trim();
    const base = slugify(heading);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    trail.length = level - 1;
    trail[level - 1] = heading;
    current = { level, heading, anchor: n === 0 ? base : `${base}-${n}`, trail: trail.filter(Boolean), lines: [] };
    sections.push(current);
  }
  return sections.map(({ lines, ...rest }) => ({ ...rest, text: lines.join('\n').trim() }));
}

/**
 * Read the YAML frontmatter keys this corpus needs. Handles plain, quoted and
 * folded (`>`, `>-`, `|`) scalars; nothing else occurs in skill frontmatter.
 */
export function readFrontmatter(markdown) {
  const m = /^---\n([\s\S]*?)\n---/.exec(markdown);
  const out = {};
  if (!m) return out;
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const parts = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        parts.push(lines[++i].trim());
      }
      value = parts.join(' ').replace(/\s+/g, ' ').trim();
    } else {
      const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
      if (quoted) value = quoted[2];
    }
    out[kv[1]] = value;
  }
  return out;
}

/** True when `path` is carried by the curated public export. */
export function isPublicPath(path, policy) {
  const covers = (entry) => (entry.path.endsWith('/') ? path.startsWith(entry.path) : path === entry.path);
  return policy.include.some(covers) && !(policy.exclude ?? []).some(covers);
}

/** Split CHANGELOG.md into one entry per released version. */
export function splitChangelog(markdown) {
  const entries = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    const h = /^## \[(\d+\.\d+\.\d+)\]\s*-\s*(\d{4}-\d{2}-\d{2})/.exec(line);
    if (h) {
      current = { version: h[1], date: h[2], lines: [] };
      entries.push(current);
    } else if (/^## /.test(line)) {
      current = null;
    } else if (current) {
      current.lines.push(line);
    }
  }
  return entries.map(({ lines, ...rest }) => ({ ...rest, text: lines.join('\n').trim() }));
}

/** Build the corpus object from a repository checkout. */
export function buildCorpus(repoRoot) {
  const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
  const policy = JSON.parse(read('.orchestrator/policy/public-export.json'));
  const assertPublic = (rel) => {
    if (!isPublicPath(rel, policy)) throw new Error(`build-corpus: ${rel} is not in the public export; refusing to serve it`);
  };
  const version = JSON.parse(read('package.json')).version;
  const blob = (rel, anchor) => `${PUBLIC_REPO_URL}/blob/main/${rel}${anchor ? `#${anchor}` : ''}`;

  const documents = [];
  for (const rel of DOC_SOURCES) {
    assertPublic(rel);
    const sections = splitSections(read(rel));
    const docTitle = sections[0]?.heading ?? rel;
    for (const s of sections) {
      if (!s.text) continue;
      documents.push({
        id: `${rel}#${s.anchor}`,
        title: s.level === 1 ? docTitle : [docTitle, ...s.trail.slice(1)].join(' › '),
        source: rel,
        url: blob(rel, s.anchor),
        text: s.text,
      });
    }
  }

  const skills = [];
  for (const dir of readdirSync(join(repoRoot, 'skills'), { withFileTypes: true })) {
    const rel = `skills/${dir.name}/SKILL.md`;
    if (!dir.isDirectory() || dir.name.startsWith('_') || !existsSync(join(repoRoot, rel))) continue;
    assertPublic(rel);
    const fm = readFrontmatter(read(rel));
    if (!fm.name || !fm.description) continue;
    skills.push({
      name: fm.name,
      description: fm.description,
      user_invocable: fm['user-invocable'] === 'true',
      argument_hint: fm['argument-hint'] ?? '',
      url: blob(rel),
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  assertPublic('CHANGELOG.md');
  const releases = splitChangelog(read('CHANGELOG.md')).map((r) => ({
    ...r,
    url: blob('CHANGELOG.md', slugify(`[${r.version}] - ${r.date}`)),
  }));

  const template = read('docs/session-config-template.md');
  const known = knownTemplateKeys(template);
  if (!known) throw new Error('build-corpus: docs/session-config-template.md has no starter and opt-in Session Config blocks');
  const starter = extractSessionConfigBlock(template, { occurrence: 'first' });

  return {
    version,
    built_at: new Date().toISOString(),
    documents,
    skills,
    releases,
    config: {
      known_keys: [...known].sort(),
      // The block body runs to the next `## ` heading; the copy-paste part ends at the closing fence.
      starter_block: (starter?.body ?? '').split('```')[0].trim(),
      reference_url: blob('docs/session-config-reference.md'),
      template_url: blob('docs/session-config-template.md'),
    },
  };
}

// realpath on both sides: under a symlinked directory the spellings differ and the CLI would silently do nothing.
// existsSync first: an argv[1] that names no file (node -e, a wrapper) must not make an import throw.
if (process.argv[1] && existsSync(resolve(process.argv[1])) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const repoRoot = resolve(opt('--repo', join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')));
  // No default target: the corpus is a build product and never lands in a checkout by accident.
  const outArg = opt('--out', '');
  if (!outArg) {
    process.stderr.write('build-corpus: --out <file> is required\n');
    process.exit(1);
  }
  const out = resolve(outArg);
  const corpus = buildCorpus(repoRoot);
  writeFileSync(out, JSON.stringify(corpus));
  process.stdout.write(
    `corpus ${corpus.version}: ${corpus.documents.length} sections, ${corpus.skills.length} skills, ` +
      `${corpus.releases.length} releases, ${corpus.config.known_keys.length} config keys -> ${out}\n`,
  );
}
