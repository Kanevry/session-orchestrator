import { matchBlockHeader } from './block-header.mjs';

/**
 * memory.mjs — Parser for the top-level `memory:` YAML block.
 *
 * Drives:
 *   - memory-banner (issue #505) that surfaces at session-start when the
 *     operator has accumulated significant learnings.
 *   - memory-proposals (issue #501, F2.1) — agent-writable memory tool with
 *     per-wave quotas and a confidence floor.
 *
 * Returns:
 *   {
 *     banner: { enabled },
 *     proposals: { enabled, "quota-per-wave", "confidence-floor" }
 *   }
 *
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumers: `scripts/lib/memory-banner.mjs`, `scripts/parse-config.mjs`.
 */

/**
 * Parse the top-level `memory:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   memory.banner.enabled:           true
 *   memory.proposals.enabled:        true
 *   memory.proposals.quota-per-wave: 5    (integer ≥ 0)
 *   memory.proposals.confidence-floor: 0.5 (float 0.0..1.0)
 *
 * YAML shape:
 *   memory:
 *     banner:
 *       enabled: true
 *     proposals:
 *       enabled: true
 *       quota-per-wave: 5
 *       confidence-floor: 0.5
 *
 * @param {string} content — full file contents
 * @returns {{
 *   banner: { enabled: boolean },
 *   proposals: { enabled: boolean, "quota-per-wave": number, "confidence-floor": number }
 * }}
 */
export function _parseMemory(content) {
  const defaults = {
    banner: { enabled: true },
    proposals: {
      enabled: true,
      'quota-per-wave': 5,
      'confidence-floor': 0.5,
    },
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'memory')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let bannerEnabled = true;
  let proposalsEnabled = true;
  let proposalsQuotaPerWave = 5;
  let proposalsConfidenceFloor = 0.5;

  let inBannerBlock = false;
  let inProposalsBlock = false;

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    // Detect `  banner:` sub-block header (2-space indent)
    if (/^\s{2}banner:\s*$/.test(clean)) {
      inBannerBlock = true;
      inProposalsBlock = false;
      continue;
    }

    // Detect `  proposals:` sub-block header (2-space indent)
    if (/^\s{2}proposals:\s*$/.test(clean)) {
      inProposalsBlock = true;
      inBannerBlock = false;
      continue;
    }

    // If we hit a sibling top-level key inside the memory block, exit any sub-block
    if (/^\s{2}[a-zA-Z_-]+:/.test(clean) && !/^\s{4}/.test(clean)) {
      inBannerBlock = false;
      inProposalsBlock = false;
    }

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    if (inBannerBlock && k === 'enabled') {
      // Default is true → only flip to false on explicit "false"
      bannerEnabled = v.toLowerCase() !== 'false';
      continue;
    }

    if (inProposalsBlock) {
      switch (k) {
        case 'enabled':
          // Default is true → only flip to false on explicit "false"
          proposalsEnabled = v.toLowerCase() !== 'false';
          break;
        case 'quota-per-wave': {
          if (/^\d+$/.test(v)) {
            const n = parseInt(v, 10);
            if (n >= 0) proposalsQuotaPerWave = n;
          }
          break;
        }
        case 'confidence-floor': {
          const f = parseFloat(v);
          if (!isNaN(f) && f >= 0.0 && f <= 1.0) proposalsConfidenceFloor = f;
          break;
        }
      }
    }
  }

  return {
    banner: { enabled: bannerEnabled },
    proposals: {
      enabled: proposalsEnabled,
      'quota-per-wave': proposalsQuotaPerWave,
      'confidence-floor': proposalsConfidenceFloor,
    },
  };
}
