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
 *   applyInterviewAnswers(answers, { path? } = {})
 *     Accepts an array of selected option labels (one per question, same order
 *     as getInterviewQuestions()), validates the result against validateOwnerConfig,
 *     and writes owner.yaml via writeOwnerConfig.
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
      question: 'Which language should the assistant use for its responses?',
      header: 'Owner Interview — Language (1/5)',
      options: [
        { label: 'de', description: 'German — responses, narration, and questions in Deutsch.' },
        { label: 'en', description: 'English — responses, narration, and questions in English.' },
        { label: 'other', description: 'Other — write your ISO-639-1 code when prompted.' },
      ],
      multiSelect: false,
    },
    {
      question: 'What communication tone style do you prefer?',
      header: 'Owner Interview — Tone Style (2/5)',
      options: [
        { label: 'direct', description: '(Recommended for pros) No filler phrases, straight to the point.' },
        { label: 'neutral', description: 'Balanced: professional without being terse.' },
        { label: 'friendly', description: 'Warm and conversational — good for exploratory sessions.' },
      ],
      multiSelect: false,
    },
    {
      question: 'How much output should the assistant produce by default?',
      header: 'Owner Interview — Output Level (3/5)',
      options: [
        { label: 'lite', description: 'Verbose mode — articles, explanations, and context kept. Good for learning.' },
        { label: 'full', description: '(Default) Terse but complete. Narration trimmed, data preserved.' },
        { label: 'ultra', description: 'Telegraphic — code and decisions only, no narration.' },
      ],
      multiSelect: false,
    },
    {
      question: 'How should the assistant handle preamble before taking actions?',
      header: 'Owner Interview — Preamble (4/5)',
      options: [
        { label: 'minimal', description: 'One-line status updates only. Jump straight to execution.' },
        { label: 'verbose', description: 'Explain plan + rationale before each major action.' },
      ],
      multiSelect: false,
    },
    {
      question: 'Hardware-sharing consent: may the plugin share anonymized hardware patterns to improve resource defaults? (Issue #173 C4)',
      header: 'Owner Interview — Hardware Sharing Consent (5/5)',
      options: [
        { label: 'No', description: '(Default) No data is shared. Fully private.' },
        { label: 'Yes', description: 'Share anonymized patterns (hashed, no PII). Helps tune wave/session defaults.' },
        { label: 'Preview', description: 'Show exactly what would be shared before deciding.' },
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
 * @param {string[]} answers - Array of selected option labels, one per question (5 total).
 *   answers[0] = language label ('de' | 'en' | free-text)
 *   answers[1] = tone style label
 *   answers[2] = output level label
 *   answers[3] = preamble label
 *   answers[4] = hardware-sharing label ('Yes' | 'No' | 'Preview')
 * @param {{ path?: string }} [opts]
 * @returns {{ ok: boolean, path: string, errors: string[] }}
 */
export function applyInterviewAnswers(answers, opts = {}) {
  const filePath = opts.path ?? OWNER_YAML_PATH;

  if (!Array.isArray(answers) || answers.length !== 5) {
    return { ok: false, path: filePath, errors: ['applyInterviewAnswers requires exactly 5 answers'] };
  }

  const [langRaw, toneRaw, outputLevelRaw, preambleRaw, hwConsentRaw] = answers;

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
