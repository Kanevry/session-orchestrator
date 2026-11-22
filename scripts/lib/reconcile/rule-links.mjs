import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseGlobsFrontmatter } from '../rule-loader.mjs';

/** Index generated rules by their provenance pairs for one mirror run. */
export function readRuleLinks(repoRoot) {
  const links = new Map();
  if (!repoRoot) return links;
  const dir = join(repoRoot, '.claude', 'rules');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return links;
  }
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  for (const name of names) {
    if (!/^[a-z0-9-]+\.md$/.test(name)) continue;
    try {
      const content = readFileSync(join(dir, name), 'utf8');
      const { meta } = parseGlobsFrontmatter(content);
      const { 'auto-generated': generated, confidence, 'expires-at': expires } = meta;
      if (generated !== true) continue;
      // Consolidated rules carry neither confidence nor always an expiry in the
      // frontmatter (7 of 9 generated files on 2026-11-19): both are optional.
      const facts = [
        Number.isFinite(confidence) ? `Konfidenz ${confidence}` : null,
        typeof expires === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expires) ? `läuft ab am ${expires}` : null,
      ].filter(Boolean);
      // Read the final provenance section, beyond the learned text and evidence.
      const [, ...sections] = content.split(/^## Provenance\r?$/m);
      const [provenance = ''] = sections.at(-1)?.split(/^#{1,2} /m) ?? [];
      const pairs = provenance.matchAll(/^- learning-key: `([^`\r\n]+)`[^\r\n]*\r?\n- learning-id: `([^`\r\n]+)`/gm);
      const line = `- **Kompiliert zu:** \`.claude/rules/${name}\`${facts.length ? ` (${facts.join(', ')})` : ''}`;
      for (const [, key, id] of pairs) {
        const records = links.get(key) ?? [];
        records.push({ id: id === 'n/a' ? undefined : id, line });
        links.set(key, records);
      }
    } catch {
      // An unreadable rule or invalid frontmatter does not block the mirror.
    }
  }
  return links;
}
