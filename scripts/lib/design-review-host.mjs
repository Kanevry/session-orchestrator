/**
 * design-review-host.mjs — host-local inputs of the design-review gate (#1452):
 * the `owner.yaml` `design-review` block, the session's steering mode, and the
 * session kind that decides whether an owner override may be recorded.
 *
 * Read tolerantly on purpose. `loadOwnerConfig()` discards the whole file to
 * defaults when a required section is invalid, and a file holding only the
 * `design-review` block is such a file — so the documented no-commit escape
 * (`design-review.enabled: false`) was silently inert (MR !413 review 2, M-2).
 * Here the raw mapping is parsed and only this block is taken; when the file
 * cannot be parsed, the reason is returned so the CLI can say "owner.yaml
 * ignored (<reason>)".
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'js-yaml';

import { resolvePrivateConfigDir } from './config/private-config-dir.mjs';
import { isCiEnv } from './telemetry/consent.mjs';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ block: object|null, note: string|null }}
 */
export function readOwnerDesignReviewBlock(env = process.env) {
  const file = join(resolvePrivateConfigDir({ env }), 'owner.yaml');
  if (!existsSync(file)) return { block: null, note: null };
  let doc;
  try {
    doc = YAML.load(readFileSync(file, 'utf8'));
  } catch (err) {
    return { block: null, note: `owner.yaml ignored (${String(err?.reason ?? err?.message ?? err).slice(0, 80)})` };
  }
  const block = doc && typeof doc === 'object' ? doc['design-review'] : undefined;
  if (block === undefined || block === null) return { block: null, note: null };
  if (typeof block !== 'object' || Array.isArray(block)) {
    return { block: null, note: 'owner.yaml design-review ignored (not a mapping)' };
  }
  return { block, note: null };
}

/**
 * The steering mode a fleet coordinator set for this session, from the HUD
 * steering files: `hud/steuerung/<session-id>.json` (`{"modus":"lead"|"ich"}`)
 * first, else `hud/steuerung/alle.json`. `null` when neither says.
 *
 * @param {{ sessionId?: string|null, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {'lead'|'ich'|null}
 */
export function readSteeringMode({ sessionId = null, env = process.env } = {}) {
  const dir = join(resolvePrivateConfigDir({ env }), 'hud', 'steuerung');
  const files = [...(sessionId && /^[A-Za-z0-9-]{8,64}$/.test(sessionId) ? [`${sessionId}.json`] : []), 'alle.json'];
  for (const name of files) {
    try {
      const modus = JSON.parse(readFileSync(join(dir, name), 'utf8'))?.modus;
      if (modus === 'lead' || modus === 'ich') return modus;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Who could give the owner's words in this session?
 *   - `lead-guided`: `--lead-guided`, or the steering files say `lead`.
 *   - `ci`: CI markers.
 *   - `headless`: `CLAUDE_CODE_ENTRYPOINT=sdk-*` (`claude -p`).
 *   - `unknown-harness`: no `CLAUDE_CODE_ENTRYPOINT` at all (codex exec, Cursor,
 *     Pi, cron) — nothing proves a person is present.
 *   - `interactive`: Claude Code `cli` and no `lead` steering.
 * Only `interactive` may record an owner override without an owner-queue
 * decision. The limit that remains: an interactive Claude Code tab whose
 * steering file is missing looks interactive.
 *
 * @param {{ leadGuidedFlag?: boolean, env?: NodeJS.ProcessEnv, sessionId?: string|null }} [opts]
 * @returns {{ kind: string, steering: 'lead'|'ich'|null }}
 */
export function sessionKind({ leadGuidedFlag = false, env = process.env, sessionId = null } = {}) {
  const steering = readSteeringMode({ sessionId: sessionId ?? env.CLAUDE_CODE_SESSION_ID ?? null, env });
  if (leadGuidedFlag || steering === 'lead') return { kind: 'lead-guided', steering };
  if (isCiEnv(env)) return { kind: 'ci', steering };
  const entrypoint = String(env.CLAUDE_CODE_ENTRYPOINT ?? '').trim().toLowerCase();
  if (!entrypoint) return { kind: 'unknown-harness', steering };
  if (entrypoint.startsWith('sdk')) return { kind: 'headless', steering };
  return { kind: 'interactive', steering };
}

/** Shape of an owner-queue decision id (the queue's ids are short tokens). */
export const DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,63}$/;
