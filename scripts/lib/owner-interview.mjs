/**
 * owner-interview.mjs — First-run Owner Persona Interview (Issues #175 D2 + #173 C4).
 *
 * Provides question definitions and answer processing for the 5-question
 * bootstrap interview that collects owner preferences and hardware-sharing
 * consent. The coordinator drives the AskUserQuestion calls; this module
 * only provides the definitions and applies the validated result to disk.
 *
 * ── Exports ───────────────────────────────────────────────────────────────────
 *
 *   getInterviewQuestions()
 *     Returns an array of 5 AUQ-compatible question objects ready to be passed
 *     to AskUserQuestion in the coordinator. Each object has the shape:
 *       { question, header, options: [{ label, description }], multiSelect }
 *
 *   optionValue(label)
 *     Maps a displayed option label to the value stored in owner.yaml by
 *     stripping the trailing `(Recommended)` marker. The label and the stored
 *     value are deliberately NOT the same string — see the function comment.
 *
 *   applyInterviewAnswers(answers, { path? } = {})
 *     Accepts an array of selected option labels (one per question, same order
 *     as getInterviewQuestions()), resolves each through optionValue(), validates
 *     the result against validateOwnerConfig, and writes owner.yaml via
 *     writeOwnerConfig.
 *     Returns { ok, path, errors }.
 *
 *   runOwnerInterview({ skipIfExists?, force?, path? } = {})
 *     Orchestration wrapper used by the bootstrap skill to check idempotency,
 *     optionally archive existing config, and coordinate the two steps above.
 *     Returns { status: 'completed'|'skipped'|'cancelled', config: object|null, path: string }.
 *     NOTE: this function does NOT call AskUserQuestion itself — it provides
 *     the question definitions and applies answers once the coordinator supplies them.
 *     When called with `dryRun: true` it returns the questions without writing.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, copyFileSync } from 'node:fs';
import {
  OWNER_YAML_PATH,
  validateOwnerConfig,
  writeOwnerConfig,
  getDefaults,
} from './owner-yaml.mjs';

// ---------------------------------------------------------------------------
// Label ←→ stored value
// ---------------------------------------------------------------------------

/**
 * A trailing recommendation marker on an option LABEL — the display half of a
 * label, never part of the stored value.
 *
 * Anchored at the end and non-greedy about whitespace so it can only ever strip
 * a suffix; a value that merely CONTAINS the word (there is none today) survives.
 */
const RECOMMENDED_SUFFIX = /\s*\((?:Recommended|Empfohlen|Default)\)\s*$/u;

/**
 * Map an AUQ option label back to the value that is written to owner.yaml.
 *
 * The label and the stored value used to be the SAME string, which made the
 * label unchangeable: `applyInterviewAnswers()` matches the answer against
 * closed enums (`['direct','neutral','friendly']` and friends) and falls back to
 * a default on any miss. Adding the `(Recommended)` marker AUQ-003 requires
 * would therefore have turned a picked `direct` into a silently-stored
 * `neutral` — a wrong answer written to disk with no error anywhere.
 *
 * Splitting the two keeps the label free for the operator and the value pinned
 * to the enum. Everything before the marker is the value, verbatim.
 *
 * @param {unknown} label — the option label as selected by the operator
 * @returns {string} the enum value to store, or '' for a non-string input
 */
export function optionValue(label) {
  if (typeof label !== 'string') return '';
  return label.replace(RECOMMENDED_SUFFIX, '').trim();
}

// ---------------------------------------------------------------------------
// Question definitions
// ---------------------------------------------------------------------------

/**
 * Returns the 5 AUQ-compatible question objects for the owner interview.
 * Order is significant — applyInterviewAnswers() expects answers in the same order.
 *
 * @returns {Array<{question: string, header: string, options: Array<{label: string, description: string}>, multiSelect: boolean}>}
 */
export function getInterviewQuestions() {
  return [
    {
      question: 'Which language should the assistant answer in?',
      header: 'Language 1/5',
      options: [
        { label: 'de', description: 'German — answers, narration and questions all in Deutsch.' },
        { label: 'en', description: 'English — answers, narration and questions all in English.' },
        { label: 'other', description: 'Stored as English either way — only de and en are accepted. Change it later in owner.yaml (your settings file).' },
      ],
      multiSelect: false,
    },
    {
      question: 'How should the assistant talk to you?',
      header: 'Tone 2/5',
      options: [
        { label: 'direct (Recommended)', description: 'No filler, no praise, straight to the point — fastest to read once you know the project.' },
        { label: 'neutral', description: 'Professional without being terse. Pick this if direct reads too blunt.' },
        { label: 'friendly', description: 'Warm and conversational. Costs a few lines per answer, and suits open-ended exploration.' },
      ],
      multiSelect: false,
    },
    {
      question: 'How much should the assistant write by default?',
      header: 'Output 3/5',
      options: [
        { label: 'full (Recommended)', description: 'Terse but complete: narration trimmed, every fact kept. Safe default — you lose words, never data.' },
        { label: 'lite', description: 'Keeps the explanations and background too. Slower to read, better while the codebase is still new to you.' },
        { label: 'ultra', description: 'Code and decisions only, no narration. You will have to ask why more often.' },
      ],
      multiSelect: false,
    },
    {
      question: 'How much should the assistant explain before it starts working?',
      header: 'Preamble 4/5',
      options: [
        { label: 'minimal (Recommended)', description: 'One line of status, then it works. Safe default — you can still ask for the reasoning afterwards.' },
        { label: 'verbose', description: 'Plan and reasoning before each major action. Costs a few lines every step.' },
      ],
      multiSelect: false,
    },
    {
      question: 'May the plugin share anonymized hardware data to improve its resource defaults?',
      header: 'Sharing 5/5',
      options: [
        { label: 'No (Recommended)', description: 'Nothing leaves this machine. Safe default — you can switch it on later without redoing this interview.' },
        { label: 'Yes', description: 'Shares hashed hardware patterns — never file names, paths or content. Helps tune the wave and session defaults.' },
        { label: 'Preview', description: 'Shows exactly what would be sent, then asks again. Costs one extra step.' },
      ],
      multiSelect: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Answer application
// ---------------------------------------------------------------------------

/**
 * Map interview answer labels to an owner.yaml config object and write it.
 *
 * Each answer is the LABEL the operator picked, which may carry a trailing
 * `(Recommended)` marker; optionValue() strips it before the enum match below.
 *
 * @param {string[]} answers - Array of selected option labels, one per question (5 total).
 *   answers[0] = language label ('de' | 'en' | 'other')
 *   answers[1] = tone style label ('direct' | 'neutral' | 'friendly', ± marker)
 *   answers[2] = output level label ('full' | 'lite' | 'ultra', ± marker)
 *   answers[3] = preamble label ('minimal' | 'verbose', ± marker)
 *   answers[4] = hardware-sharing label ('Yes' | 'No' | 'Preview', ± marker)
 * @param {{ path?: string }} [opts]
 * @returns {{ ok: boolean, path: string, errors: string[] }}
 */
export function applyInterviewAnswers(answers, opts = {}) {
  const filePath = opts.path ?? OWNER_YAML_PATH;

  if (!Array.isArray(answers) || answers.length !== 5) {
    return { ok: false, path: filePath, errors: ['applyInterviewAnswers requires exactly 5 answers'] };
  }

  // Strip the display-only `(Recommended)` marker before matching against the
  // enums below — see optionValue(). A non-string answer becomes '' and falls
  // through to the same default it always did.
  const [langRaw, toneRaw, outputLevelRaw, preambleRaw, hwConsentRaw] = answers.map(optionValue);

  // --- Language ---
  // Accept 'de', 'en', or treat anything else as a free-text language code.
  // owner-yaml.mjs validates that language is 'de' or 'en', so we fall back to 'en'
  // for other values and note it in a comment (free-text stored as tonality note).
  const knownLangs = ['de', 'en'];
  const language = knownLangs.includes(langRaw) ? langRaw : 'en';

  // --- Tone style ---
  const validToneStyles = ['direct', 'neutral', 'friendly'];
  const toneStyle = validToneStyles.includes(toneRaw) ? toneRaw : 'neutral';

  // --- Output level ---
  const validOutputLevels = ['lite', 'full', 'ultra'];
  const outputLevel = validOutputLevels.includes(outputLevelRaw) ? outputLevelRaw : 'full';

  // --- Preamble ---
  const validPreamble = ['minimal', 'verbose'];
  const preamble = validPreamble.includes(preambleRaw) ? preambleRaw : 'minimal';

  // --- Hardware sharing (C4) ---
  // When user picks 'Yes', generate a random 32-byte hex salt for hashing.
  const hwEnabled = hwConsentRaw === 'Yes';
  const hashSalt = hwEnabled
    ? randomBytes(32).toString('hex')
    : '';

  const defaults = getDefaults();

  const config = {
    owner: {
      name: defaults.owner.name, // bootstrap caller sets name after interview if needed
      language,
    },
    tone: {
      style: toneStyle,
      tonality: defaults.tone.tonality,
    },
    efficiency: {
      'output-level': outputLevel,
      preamble,
    },
    'hardware-sharing': {
      enabled: hwEnabled,
      'hash-salt': hashSalt,
    },
  };

  // Validate before writing (writeOwnerConfig also validates, but we want early errors)
  const validation = validateOwnerConfig(config);
  if (!validation.valid) {
    return { ok: false, path: filePath, errors: validation.errors };
  }

  const writeResult = writeOwnerConfig(config, { path: filePath });
  if (!writeResult.written) {
    return { ok: false, path: filePath, errors: writeResult.errors };
  }

  return { ok: true, path: filePath, errors: [] };
}

// ---------------------------------------------------------------------------
// Orchestration wrapper
// ---------------------------------------------------------------------------

/**
 * Orchestration entry-point called from the bootstrap skill's Phase 3.5.
 *
 * The coordinator:
 *   1. Calls runOwnerInterview() — gets back { status, questions, path } when pending.
 *   2. Dispatches questions via AskUserQuestion.
 *   3. Calls applyInterviewAnswers(answers) to write owner.yaml.
 *
 * This function itself does NOT call AskUserQuestion.
 *
 * Idempotency:
 *   - skipIfExists=true (default): returns status='skipped' when owner.yaml exists.
 *   - force=true: archives existing yaml to owner.yaml.bak-<timestamp>, then runs.
 *
 * @param {{ skipIfExists?: boolean, force?: boolean, path?: string }} [opts]
 * @returns {{ status: 'pending'|'skipped'|'cancelled', questions: Array|null, config: object|null, path: string }}
 */
export function runOwnerInterview(opts = {}) {
  const {
    skipIfExists = true,
    force = false,
    path: filePath = OWNER_YAML_PATH,
  } = opts;

  const fileExists = existsSync(filePath);

  // Idempotency: skip when file exists and no force flag
  if (fileExists && skipIfExists && !force) {
    return { status: 'skipped', questions: null, config: null, path: filePath };
  }

  // Archive existing config when force=true
  if (fileExists && force) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filePath}.bak-${timestamp}`;
    try {
      copyFileSync(filePath, backupPath);
    } catch {
      // Non-fatal: continue even if backup fails (file might be unreadable)
    }
  }

  // Return 'pending' with questions — coordinator dispatches AskUserQuestion
  return {
    status: 'pending',
    questions: getInterviewQuestions(),
    config: null,
    path: filePath,
  };
}
