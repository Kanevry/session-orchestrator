/**
 * design-review.mjs — Parser for the top-level `design-review:` YAML block (#1452).
 *
 * Drives the default-on design review: the wave step that reviews the rendered
 * result after a UI-touching implementation wave, and the close gate that
 * refuses `/close` when UI changed, a render is possible and no review covers
 * the change.
 *
 * Returns `{ enabled, include, exclude, designer }`. DEFAULT ON — only an
 * explicit `enabled: false` (or `off`/`no`/`0`) turns it off (the #1121 lesson:
 * an opt-in trigger never fires). `include` / `exclude` are glob lists, inline
 * (`[a, b]`) or as `- item` lines; empty means "use the defaults" of
 * `scripts/lib/ui-touch.mjs`. `designer` is the path of an agentic-designer
 * `designer` executable for hosts where it is not on PATH. `act-on-verdicts`
 * (default `false`) decides whether that reviewer's verdicts create work: off,
 * they are recorded and shown only, because its first production run measured
 * 23 wrong of 37 findings (agentic-designer#85).
 *
 * The parser stays pure (committed value). Host-local values come from
 * {@link resolveDesignReviewSettings}: env > `owner.yaml` > committed > default.
 * `close-gate` (`warn` | `refuse`, default `warn`) decides whether the close
 * gate refuses or only prints "would refuse" (no automatic switch, #1452).
 *
 * Consumer: `scripts/design-review.mjs`.
 */

import { matchBlockHeader } from './block-header.mjs';
import { preprocessBlockLines } from './block-preprocess.mjs';

const OFF = ['false', 'off', 'no', '0'];
const ON = ['true', 'on', 'yes', '1'];

/**
 * Split an inline list on top-level commas only, so a brace glob such as
 * `**\/*.{tsx,css}` stays one item.
 *
 * @param {string} value — e.g. `[src/**\/*.{tsx,css}, app/**]`
 * @returns {string[]}
 */
export function splitInlineGlobList(value) {
  const inner = String(value).trim().replace(/^\[/, '').replace(/\]$/, '');
  const items = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items.map(unquote).filter((s) => s.length > 0);
}

function unquote(s) {
  return s.trim().replace(/^["'](.*)["']$/, '$1');
}

const CLOSE_GATE_MODES = ['warn', 'refuse'];

/**
 * @param {string} content — full CLAUDE.md / AGENTS.md content
 * @returns {{ enabled: boolean, include: string[], exclude: string[], designer: string|null,
 *   'act-on-verdicts': boolean, 'close-gate': 'warn'|'refuse', warnings: string[] }}
 *   `warnings` names values the parser did not understand (they keep the default).
 */
export function _parseDesignReview(content) {
  const result = {
    enabled: true, include: [], exclude: [], designer: null, 'act-on-verdicts': false, 'close-gate': 'warn', warnings: [],
  };

  const lines = preprocessBlockLines(content);
  let inBlock = false;
  const blockLines = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'design-review')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  let listKey = null;
  for (const rawLine of blockLines) {
    // Strip a trailing comment only when `#` follows whitespace: globs never contain ` #`.
    const clean = rawLine.replace(/\s+#.*$/, '').replace(/\s+$/, '');
    const item = clean.match(/^\s+-\s+(.+)$/);
    if (item && listKey) {
      result[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const value = unquote(raw);
    listKey = null;
    if (key === 'enabled' || key === 'act-on-verdicts') {
      const sw = toSwitch(value);
      if (sw === undefined) result.warnings.push(`design-review.${key}: unknown value "${value}" ignored`);
      else result[key] = sw;
    }
    if (key === 'close-gate') {
      if (CLOSE_GATE_MODES.includes(value.toLowerCase())) result['close-gate'] = value.toLowerCase();
      else result.warnings.push(`design-review.close-gate: unknown value "${value}" ignored (warn|refuse)`);
    }
    if (key === 'designer' && value && value !== 'null') result.designer = value;
    if (key === 'include' || key === 'exclude') {
      if (value.startsWith('[')) result[key] = splitInlineGlobList(value);
      else if (value === '') listKey = key;
    }
  }
  return result;
}

function toSwitch(value) {
  if (typeof value === 'boolean') return value;
  const v = String(value ?? '').trim().toLowerCase();
  if (ON.includes(v)) return true;
  if (OFF.includes(v)) return false;
  return undefined;
}

/**
 * Effective settings, each with its source: env > `owner.yaml` > committed >
 * default (the dispatcher-autonomy pattern). Env and `owner.yaml` are
 * host-local, so a broken guard can be switched without a commit.
 *
 *   - `enabled` — `SO_DESIGN_REVIEW`, default on.
 *   - `act_on_verdicts` — `SO_DESIGN_REVIEW_ACT_ON_VERDICTS`, default off: review
 *     findings of BOTH reviewers are recorded and shown, not turned into work
 *     (agentic-designer#85: 23 of 37 `designer critique` findings wrong; no
 *     calibration of `ux-evaluator` rubric-v2 on real pages exists).
 *   - `close_gate` — `SO_DESIGN_REVIEW_CLOSE_GATE`, default `warn`: the close
 *     gate prints "would refuse" and exits 0 until `close-gate: refuse` is set (#1452).
 *
 * An unknown value is ignored and named in `warnings`.
 *
 * @param {{ committed: ReturnType<typeof _parseDesignReview>, env?: NodeJS.ProcessEnv, ownerBlock?: object|null }} opts
 */
export function resolveDesignReviewSettings({ committed, env = process.env, ownerBlock = null }) {
  const warnings = [...(committed.warnings ?? [])];
  const pick = (envKey, ownerKey, committedValue, parse) => {
    const rawEnv = env?.[envKey];
    if (rawEnv !== undefined && String(rawEnv).trim() !== '') {
      const v = parse(rawEnv);
      if (v !== undefined) return { value: v, source: 'env' };
      warnings.push(`${envKey}: unknown value "${rawEnv}" ignored`);
    }
    const rawOwner = ownerBlock && typeof ownerBlock === 'object' ? ownerBlock[ownerKey] : undefined;
    if (rawOwner !== undefined && rawOwner !== null) {
      const v = parse(rawOwner);
      if (v !== undefined) return { value: v, source: 'owner.yaml' };
      warnings.push(`owner.yaml design-review.${ownerKey}: unknown value "${rawOwner}" ignored`);
    }
    return { value: committedValue, source: 'committed' };
  };
  const mode = (v) => (CLOSE_GATE_MODES.includes(String(v).trim().toLowerCase()) ? String(v).trim().toLowerCase() : undefined);
  const enabled = pick('SO_DESIGN_REVIEW', 'enabled', committed.enabled !== false, toSwitch);
  const act = pick('SO_DESIGN_REVIEW_ACT_ON_VERDICTS', 'act-on-verdicts', committed['act-on-verdicts'] === true, toSwitch);
  const gate = pick('SO_DESIGN_REVIEW_CLOSE_GATE', 'close-gate', committed['close-gate'] ?? 'warn', mode);
  return {
    enabled: enabled.value,
    enabled_source: enabled.source,
    act_on_verdicts: act.value,
    act_on_verdicts_source: act.source,
    close_gate: gate.value,
    close_gate_source: gate.source,
    warnings,
  };
}
