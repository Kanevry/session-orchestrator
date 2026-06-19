/**
 * scripts/lib/frontend-detect/detect.mjs
 *
 * Deterministic frontend-slop detector — orchestration layer over rules.mjs.
 *
 * Provides:
 *   - detectContent(content, filePath, opts) → Finding[]   (pure, no I/O)
 *   - detectFiles(paths, opts)               → Finding[]   (reads files)
 *   - SCANNABLE_EXTS                         → Set<string>
 *
 * No LLM, no network, no browser. Pure regex tier (see rules.mjs provenance).
 *
 * @typedef {Object} Rule
 * @property {string} id
 * @property {string} ruleRef
 * @property {'high'|'medium'|'low'} severity
 * @property {'ai-slop'|'quality'} category
 * @property {string} title
 * @property {string} recommendation
 * @property {'low'|'medium'|'high'} fpRisk
 * @property {(content: string) => Array<{line:number, snippet:string, value?:string}>} scan
 *
 * @typedef {Object} Finding
 * @property {string} rule
 * @property {string} ruleRef
 * @property {'high'|'medium'|'low'} severity
 * @property {'ai-slop'|'quality'} category
 * @property {string} title
 * @property {string} file
 * @property {number} line
 * @property {string} snippet
 * @property {string} recommendation
 * @property {'low'|'medium'|'high'} fpRisk
 */

import { readFileSync } from 'node:fs';
import { RULES } from './rules.mjs';

/** File extensions worth scanning for frontend slop. */
export const SCANNABLE_EXTS = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.htm',
  '.astro',
  '.vue',
  '.svelte',
  '.jsx',
  '.tsx',
]);

/**
 * Run the rule set over a single in-memory string.
 *
 * @param {string} content
 * @param {string} [filePath] — for finding provenance (default '<inline>')
 * @param {{ ignoreRules?: string[] }} [opts]
 * @returns {Finding[]}
 */
export function detectContent(content, filePath = '<inline>', opts = {}) {
  const ignore = new Set(opts.ignoreRules ?? []);
  const findings = [];
  for (const rule of RULES) {
    if (ignore.has(rule.id)) continue;
    let matches;
    try {
      matches = rule.scan(content) ?? [];
    } catch {
      // A rule must never crash the scan — fail-soft, skip this rule.
      continue;
    }
    for (const mt of matches) {
      findings.push({
        rule: rule.id,
        ruleRef: rule.ruleRef,
        severity: rule.severity,
        category: rule.category,
        title: rule.title,
        file: filePath,
        line: mt.line,
        snippet: mt.snippet,
        recommendation: rule.recommendation,
        fpRisk: rule.fpRisk,
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/**
 * Run the rule set over a list of file paths. Unreadable / non-scannable files
 * are skipped silently (fail-soft).
 *
 * @param {string[]} paths — absolute or cwd-relative file paths
 * @param {{ ignoreRules?: string[] }} [opts]
 * @returns {Finding[]}
 */
export function detectFiles(paths, opts = {}) {
  const findings = [];
  for (const p of paths) {
    const dot = p.lastIndexOf('.');
    const ext = dot === -1 ? '' : p.slice(dot).toLowerCase();
    if (!SCANNABLE_EXTS.has(ext)) continue;
    let content;
    try {
      content = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    findings.push(...detectContent(content, p, opts));
  }
  return findings;
}

/**
 * Aggregate findings into a summary roll-up by severity + category.
 * @param {Finding[]} findings
 */
export function summarize(findings) {
  const summary = {
    total: findings.length,
    high: 0,
    medium: 0,
    low: 0,
    aiSlop: 0,
    quality: 0,
    byRule: {},
  };
  for (const f of findings) {
    summary[f.severity]++;
    if (f.category === 'ai-slop') summary.aiSlop++;
    else summary.quality++;
    summary.byRule[f.rule] = (summary.byRule[f.rule] ?? 0) + 1;
  }
  return summary;
}
