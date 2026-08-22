#!/usr/bin/env node
/**
 * pre-auq-clarity.mjs — PreToolUse hook on `AskUserQuestion`.
 *
 * Checks the questions this system is about to put in front of the operator,
 * at the moment they are asked, and blocks the two that the tool itself
 * mangles: a header longer than the tool renders (H1) and an option count /
 * recommendation placement the operator cannot weigh (H2).
 *
 * ## Why this exists beside the template gate
 *
 * Wave 2 built the deterministic scorer (`scripts/lib/auq/`), wave 3 brought all
 * 72 TEMPLATES in the repo to 100 %, and a sibling gate now stops a NEW template
 * landing with a broken hurdle. All three act on text that sits in a file.
 *
 * The other half never does: the coordinator formulates questions freshly in
 * every session, from prose, and no template gate can see them. This hook is the
 * only point at which a runtime-composed question can be measured before the
 * operator reads it.
 *
 * ## EVIDENCE STATUS — code-evidence, not runtime-evidence
 *
 * That `AskUserQuestion` reaches `PreToolUse` at all was read out of the shipped
 * Claude Code bundle (2.1.239): exactly one tool is exempted from the hook path
 * (`EndConversation`), and the stdin envelope carries `tool_name` +
 * `tool_input`, with the whole `questions` array inside `tool_input`.
 *
 * **No hook with a matcher of `AskUserQuestion` has ever run in this repo.** The
 * end-to-end proof needs a session restart and is OUTSTANDING. What IS proven
 * without one is everything downstream of stdin — the hook was driven with real
 * envelopes on stdin and its allow/deny envelopes read back (see the test file).
 * Treat the delivery of the envelope as expected-but-unconfirmed and the
 * decision logic as measured.
 *
 * ## What blocks, and what deliberately does not
 *
 *   | class                                  | decision | why |
 *   |----------------------------------------|----------|-----|
 *   | H1 — header over 12 codepoints         | **DENY** | the tool truncates it, INVISIBLY: the operator sees a mangled headline and cannot tell it was cut. Auto-shortening loses meaning the same invisible way — a model can write a good short header, a regex cannot. |
 *   | H2 — options per question / recommendation not first | **DENY** | dropping or reordering options is a meaning decision, never a normalisation |
 *   | K1, K3, K4, K7, K8 (content criteria)  | ALLOW    | measured false-positive rates 14–25 %. A hook that blocks one correct question in four is switched off within a month — and takes the hard limits with it. Reported on stderr, never denied. |
 *   | K2, and every `warn` finding           | ALLOW    | advisory by construction (`CRITERIA.K2.weight === 0`) |
 *   | anything this hook cannot fully parse  | ALLOW    | see § Fail direction |
 *
 * ## Fail direction — this guard fails OPEN, on purpose
 *
 * A false positive here destroys the operator's question: `emitDeny` blocks the
 * tool call, so the card is never rendered and the operator is never asked. A
 * false negative is a badly-worded question the operator can still answer. The
 * blast radius is asymmetric, so every doubt resolves to ALLOW: an unrecognised
 * payload shape, a malformed option, a scorer throw, a module that fails to
 * load, an unreadable stdin. None of them denies.
 *
 * That extends to this hook's own adapter. A question is analysed only when its
 * shape is FULLY recognised — `questions` an array, `options` an array, every
 * option an object with a string label. Dropping one malformed option out of two
 * would turn a legal question into an H2 break ("fewer than 2 options"), i.e. a
 * deny manufactured by the adapter rather than found in the question. So a
 * partially-recognised question is skipped whole.
 *
 * ## Why `emitRewrite` is NOT wired here
 *
 * `emitRewrite` (scripts/lib/io.mjs) can replace the tool input outright, which
 * would let this hook repair instead of refuse. It is deliberately unused,
 * because every repair the two hurdles admit costs meaning that the operator
 * cannot see going missing:
 *
 *   - shortening a 23-character header — which 11 characters are the ones to
 *     lose? The operator would read a truncated headline and have no way to know
 *     it was truncated. That is the exact failure H1 exists to prevent, moved
 *     one layer earlier.
 *   - moving the recommended option to position 1 — the ORDER is content. A
 *     description written for position 3 can refer to the options above it;
 *     lifting it changes what the operator reads first, silently.
 *   - deleting the 5th option, or one of two `(Recommended)` markers — which
 *     one was meant? Only the author knows.
 *
 * NAMED TRIGGER for switching it on: a finding whose repair has exactly ONE
 * admissible target form AND removes, reorders or rewrites no model-authored
 * text — i.e. a pure character normalisation inside a single field. None of the
 * eight criteria currently produces one. Should `scripts/lib/auq/` ever gain such
 * a finding class (a literal `\n` escape where a line break was meant is the
 * shape to watch for), route exactly that class through `emitRewrite` and leave
 * everything else on `emitDeny` — because for every other finding the MODEL can
 * make the judgement call and a transform cannot.
 *
 * ## stdout discipline
 *
 * Under the exit-0 PreToolUse protocol (#906, ADR-0011) allow and deny share
 * exit code 0; the decision lives only in the stdout JSON. `emitAllow` writes
 * nothing, `emitDeny` writes through `writeStdoutLineSync` and clamps at
 * 16 000 chars. This module never calls `console.log`. Diagnostics go to stderr,
 * which under exit 0 is a DEBUG LOG ONLY — invisible to the operator (see
 * `docs/plugin-architecture-v3.md`). Nothing here may rely on being read.
 *
 * ## Cost
 *
 * The protocol caps a call at 4 questions × 4 options
 * (`.claude/rules/ask-via-tool.md` § AUQ-003); scoring that is microseconds. The
 * only real cost is process start plus parsing the two `auq/` modules. No file
 * is read, no subprocess is spawned, no git command runs — `hooks.json` allows
 * 5 s and this path does not approach it.
 *
 * ## PSA
 *
 * No git command, read-only or otherwise (PSA-007). No filesystem write.
 *
 * hooks.json registration is NOT part of this file's change set — see the
 * sibling agent's wiring change.
 */

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

import { shouldRunHook } from './_lib/profile-gate.mjs';

// ---------------------------------------------------------------------------
// Late-bound repo dependencies (#993)
//
// Static imports fail at ESM LINK time: node exits 1 with 0 bytes on stdout, and
// under the exit-0 protocol a 0-byte stdout is indistinguishable from an explicit
// allow — the guard would fail open AND silently. Binding late turns the
// link-time crash into a catchable runtime error, which is what makes the GUARD
// INACTIVE banner reachable at all.
// ---------------------------------------------------------------------------
/** @type {typeof import('../scripts/lib/io.mjs').readStdin} */ let readStdin;
/** @type {typeof import('../scripts/lib/io.mjs').emitAllow} */ let emitAllow;
/** @type {typeof import('../scripts/lib/io.mjs').emitDeny} */ let emitDeny;
/** @type {typeof import('../scripts/lib/auq/schema.mjs')} */ let schemaMod;
/** @type {typeof import('../scripts/lib/auq/clarity.mjs')} */ let clarityMod;

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

/** This hook's name — threaded into the guard banner (#993: no hard-wired literal). */
const HOOK_NAME = 'pre-auq-clarity';

/** The only tool this hook acts on. Everything else allows immediately. */
const AUQ_TOOL = 'AskUserQuestion';

/**
 * `file` recorded on the synthesised `AuqQuestion`. The scorer's schema requires
 * one; a runtime question has no source file, and a fake path would read as a
 * real location in the finding text the model gets back.
 */
export const RUNTIME_ORIGIN = '<AskUserQuestion>';

/**
 * Per-line ceiling for a rendered finding, in characters.
 *
 * The outer clamp in `emitDeny` (16 000) already keeps the ENVELOPE inside the
 * kernel pipe buffer, so this bound is not about delivery — it is about
 * ORDERING. A finding message interpolates model-authored text (`Die Kopfzeile
 * "…" hat N Zeichen`), so one pathological header could otherwise consume the
 * whole budget and push every other hurdle's line past the outer clamp. 300 is
 * ~1.5× the longest message this scorer produces at the protocol's own field
 * caps, so no legitimate line is ever clipped.
 */
export const MAX_LINE_CHARS = 300;

/**
 * Ceiling on rendered finding lines across the whole call.
 *
 * Worst case at the protocol caps (4 questions, 4 options each) is roughly
 * 4 × (1 header + 4 description + 1 payload + 1 count + 1 recommendation) = 32.
 * 16 keeps the reason readable while still naming more than any single question
 * can break; the overflow is COUNTED in the text, never silently dropped.
 */
export const MAX_FINDING_LINES = 16;

/**
 * The consequence block spliced VERBATIM into the GUARD INACTIVE banner (#993).
 */
const GUARD_CONSEQUENCE = {
  inactive: [
    '    Consequence: runtime AskUserQuestion clarity checking is OFF — a question',
    '    with a truncated header or an unweighable option set CAN now reach the',
    '    operator unchecked. Template-level checking is unaffected. This is a',
    '    BROKEN GUARD, not a policy decision — do not route around it, repair it.',
  ],
};

/**
 * Project dir for banner keying, resolved WITHOUT `platform.mjs` — that module
 * is one of the ones that may have failed to load.
 *
 * @returns {string}
 */
function bannerProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Bind every repo dependency late, making a load failure VISIBLE instead of a
 * silent exit-1 disarm. Throws on any load failure; the entry-point catch
 * banners. Banner-only: no module opts into the `git show HEAD:` fallback,
 * because failing open here is cheap (§ Fail direction) and a HEAD copy of a
 * scorer is not obviously better than no scorer.
 *
 * `requires` lists FUNCTION exports only — `assertShape` tests `typeof ===
 * 'function'`, so naming a frozen constant there would fail every load.
 *
 * @returns {Promise<void>}
 */
async function bootstrap() {
  const lib = (...seg) => pathToFileURL(path.join(PLUGIN_ROOT, 'scripts', 'lib', ...seg)).href;

  const { armGuard } = await import('./_lib/guard-source-loader.mjs');
  const { modules } = await armGuard(
    {
      io: { specifier: lib('io.mjs'), requires: ['readStdin', 'emitAllow', 'emitDeny'] },
      schema: {
        specifier: lib('auq', 'schema.mjs'),
        requires: ['makeQuestion', 'makeOption'],
      },
      clarity: { specifier: lib('auq', 'clarity.mjs'), requires: ['scoreQuestion'] },
    },
    {
      hookName: HOOK_NAME,
      repoRoot: PLUGIN_ROOT,
      projectDir: bannerProjectDir(),
      consequence: GUARD_CONSEQUENCE,
    },
  );

  ({ readStdin, emitAllow, emitDeny } = modules.io);
  schemaMod = modules.schema;
  clarityMod = modules.clarity;
}

// ---------------------------------------------------------------------------
// Adapter — runtime payload → the scorer's AuqQuestion
// ---------------------------------------------------------------------------

/**
 * Convert ONE runtime question from `tool_input.questions` into the frozen
 * `AuqQuestion` the scorer takes, or `null` when its shape is not fully
 * recognised.
 *
 * `null` means ALLOW, never "empty question" — see § Fail direction for why a
 * partially-recognised question is skipped whole rather than repaired.
 *
 * `isRecommended` is derived from the label because that is where the marker
 * lives at runtime; the marker list comes from the schema registry
 * (`RECOMMENDED_MARKERS`), so this adapter adds no second spelling of it. When
 * the registry is unavailable the derivation degrades to "no recommendation
 * detected", which can only REMOVE an H2 break, never invent one.
 *
 * @param {unknown} raw          one entry of `tool_input.questions`
 * @param {number} index         its position, recorded as the `line`
 * @param {object} schema        the `auq/schema.mjs` module namespace
 * @returns {object|null}
 */
export function toAuqQuestion(raw, index, schema) {
  if (raw === null || typeof raw !== 'object') return null;
  if (typeof raw.question !== 'string') return null;
  if (!Array.isArray(raw.options)) return null;

  const options = [];
  for (let i = 0; i < raw.options.length; i += 1) {
    const o = raw.options[i];
    // One unrecognised option disqualifies the whole question: dropping it would
    // lower the option COUNT, which is itself an H2 hurdle — a deny invented by
    // this adapter rather than found in the question.
    if (o === null || typeof o !== 'object' || typeof o.label !== 'string') return null;
    options.push(schema.makeOption({
      label: o.label,
      description: typeof o.description === 'string' ? o.description : '',
      preview: typeof o.preview === 'string' ? o.preview : null,
      // Geteiltes Prädikat aus schema.mjs — NICHT `markers.some(m => label.includes(m))`.
      // Diese Zeile prüfte nur das Label und liess damit eine Frage durch, die der
      // Datei-Validator als H2-Bruch meldete: der Marker steht in manchen Vorlagen in
      // der Beschreibung. Zwei Ableitungen derselben Regel, gemessen divergent (W4-Q7).
      isRecommended: schema.isRecommendedOption(o),
      index: i,
    }));
  }

  return schema.makeQuestion({
    question: raw.question,
    header: typeof raw.header === 'string' ? raw.header : null,
    multiSelect: raw.multiSelect === true,
    options,
    file: RUNTIME_ORIGIN,
    // `line` is the schema's location field and must be an integer; the question's
    // 1-based position is the only location a runtime call has.
    line: index + 1,
    // The corpus populations describe where a question was FOUND. 'A' — an
    // executed tool call — is the one a runtime call actually is.
    population: 'A',
    kind: 'template',
    // 'prose' and not 'backtick': the text here is the real text, not a source
    // literal, so the escape-sequence lower-bound note must NOT fire.
    quoting: 'prose',
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Name the exact place a finding sits, so the second attempt lands on the same
 * field rather than somewhere adjacent.
 *
 * @param {object} f            an `AuqFinding`
 * @param {number} questionNo   1-based question position
 * @returns {string}
 */
function locationOf(f, questionNo) {
  // The JSON path INTO `tool_input`, not a prose location: the reader of this
  // text is the model that has to emit a corrected payload, and a path it can
  // address is what makes the second attempt land on the same field.
  const base = `questions[${questionNo - 1}]`;
  if (f.target === 'header') return `Frage ${questionNo} · ${base}.header`;
  if (f.target === 'option') return `Frage ${questionNo} · ${base}.options[${f.optionIndex}]`;
  return `Frage ${questionNo} · ${base}`;
}

/**
 * Render one finding as a single deny line.
 *
 * The measured value and the limit are appended MECHANICALLY from the finding's
 * own `measured`/`threshold` fields rather than trusted to appear in the prose.
 * The requirement is that a deny names the field, the actual value and the
 * limit; leaning on the message wording alone would make that requirement
 * dependent on a sentence a future edit could rephrase.
 *
 * @param {object} f
 * @param {number} questionNo
 * @returns {string}
 */
function renderFinding(f, questionNo) {
  const measured = f.measured === null ? '?' : String(f.measured);
  const threshold = f.threshold === null ? '?' : String(f.threshold);
  const head = `  • ${locationOf(f, questionNo)}: `;
  const tail = ` [gemessen: ${measured}, Grenze: ${threshold}]`;

  // Nur `f.message` wird geklippt — Ort und Messwerte sind reserviert.
  //
  // Vorher klippte diese Funktion die FERTIGE Zeile, und `clipLine` schneidet
  // von hinten. Der Messwert-Suffix steht am Ende, also fiel genau er als
  // erstes weg — und zwar UMSO SICHERER, je gravierender der Verstoß war.
  // Gemessen 2026-08-22 am echten Hook: Kopfzeile 100 und 150 Zeichen → Grund
  // trägt `[gemessen/Grenze]`; Kopfzeile 400 Zeichen → trägt es NICHT MEHR.
  // 400 ist der Fall, für den H1 überhaupt existiert.
  //
  // Der Schaden ist nicht Kosmetik: der Leser dieses Textes ist das Modell, das
  // eine korrigierte Nutzlast schicken muss. Ohne Ist-Wert und Grenze weiß es
  // nicht, WIE VIEL zu kürzen ist, rät, trifft dieselbe Wand — und der Operator
  // erfährt von keinem der beiden Anläufe.
  //
  // Gefunden vom QA-Review dieser Session (W4-Q6), koordinator-verifiziert.
  const room = Math.max(24, MAX_LINE_CHARS - [...head].length - [...tail].length);
  const msg = [...String(f.message ?? '')];
  const body = msg.length <= room ? msg.join('') : `${msg.slice(0, room - 1).join('')}…`;
  return `${head}${body}${tail}`;
}

// ---------------------------------------------------------------------------
// Decision — PURE. Returns a verdict; emits nothing, exits nothing.
//
// The purity is load-bearing: `emitDeny` and `emitAllow` both call
// `process.exit()` and never return, so an emit reached from inside the checking
// flow would terminate before a later question could be judged.
// ---------------------------------------------------------------------------

/**
 * @typedef {{action: 'allow'|'deny', reason?: string, suggestion?: string, notes: string[]}} Verdict
 */

/**
 * Decide whether this `AskUserQuestion` call may proceed.
 *
 * Denies if and only if at least one HARD HURDLE (H1/H2) is broken on at least
 * one question. Content criteria are collected into `notes` and never affect the
 * action.
 *
 * ## Known limitation, with its revisit trigger (BV-004)
 *
 * The registry maps a hurdle to a CRITERION (`CRITERIA.K5.hurdle === 'H1'`,
 * `CRITERIA.K6.hurdle === 'H2'`), not to an individual finding — so when H2 is
 * broken, the K6 `fail` findings listed alongside it may include two that carry
 * no hurdle of their own (a description over 150 characters, a question payload
 * over 650). They are listed, never decisive: without a broken hurdle they
 * cannot produce a deny at all. Every such line still names its field, value and
 * limit, so the reason stays actionable rather than merely longer.
 *
 * REVISIT TRIGGER: if `scripts/lib/auq/clarity.mjs` ever tags a finding with the
 * hurdle it breaks, switch the selection below from criterion to that tag and
 * delete this note.
 *
 * @param {object} input                  the parsed PreToolUse payload
 * @param {{schema: object, clarity: object}} lib  the two `auq/` module namespaces
 * @returns {Verdict}
 */
export function decide(input, lib) {
  const notes = [];
  const allow = () => ({ action: /** @type {'allow'} */ ('allow'), notes });

  if (input?.tool_name !== AUQ_TOOL) return allow();

  const schema = lib?.schema;
  const clarity = lib?.clarity;
  if (typeof schema?.makeQuestion !== 'function' || typeof clarity?.scoreQuestion !== 'function') {
    notes.push('Bewerter nicht verfügbar — Frage unverändert durchgelassen.');
    return allow();
  }

  const toolInput = input?.tool_input;
  if (toolInput === null || typeof toolInput !== 'object') return allow();
  if (!Array.isArray(toolInput.questions) || toolInput.questions.length === 0) return allow();

  const hurdles = schema.HURDLES ?? {};
  const criteria = schema.CRITERIA ?? {};

  // Grouped by hurdle, not by question: two questions breaking H1 are ONE
  // problem with two witnesses, and a reason that repeats the H1 heading twice
  // reads as two unrelated rules. Insertion order is the registry's (H1 then H2)
  // because that is the order the first breaking question hits them in.
  /** @type {Map<string, {title: string, lines: string[]}>} */
  const broken = new Map();
  /** @type {Map<string, number>} */
  const softByCriterion = new Map();
  let skipped = 0;

  toolInput.questions.forEach((raw, index) => {
    let score;
    try {
      const question = toAuqQuestion(raw, index, schema);
      if (question === null) { skipped += 1; return; }
      score = clarity.scoreQuestion(question, index);
    } catch {
      // A scorer throw is not a violation. Fail open, count it, move on.
      skipped += 1;
      return;
    }

    const findings = Array.isArray(score?.findings) ? score.findings : [];
    const questionNo = index + 1;

    for (const hurdleId of Array.isArray(score?.hurdlesBroken) ? score.hurdlesBroken : []) {
      const hurdle = hurdles[hurdleId];
      // Auf dem TAG des Befunds filtern, nicht auf dem Kriterium der Hürde.
      //
      // Vorher stand hier `f.criterion === hurdle.criterion`. Das griff über:
      // K6 erzeugt vier Befundklassen (Beschreibungslänge, Labellänge,
      // Nutzlast, Optionszahl) und nur die letzte reißt H2. Gemessen mit
      // 4 Fragen × 5 Optionen: unter der H2-Überschrift standen zehn
      // Beschreibungslängen-Zeilen und EINE, die den echten Bruch benannte —
      // die Brüche der Fragen 2 bis 4 fielen komplett aus dem Zeilenbudget.
      // Das Modell erfuhr von einem Bruch und musste dreimal nachliefern.
      //
      // `f.hurdle` wird seit dieser Session in `clarity.mjs` gesetzt, wo die
      // Zuordnung ohnehin entsteht. Der Rückfallpfad auf das Kriterium bleibt
      // für Befunde ohne Tag erhalten, damit ein älterer Bewerter nicht
      // stillschweigend leere Abschnitte erzeugt.
      const criterion = hurdle?.criterion;
      const tagged = findings.filter((f) => f.severity === 'fail' && f.hurdle === hurdleId);
      const pool = tagged.length > 0
        ? tagged
        : findings.filter((f) => f.severity === 'fail' && f.criterion === criterion);
      const lines = pool.map((f) => renderFinding(f, questionNo));
      // Nach FRAGE gebündelt, nicht flach angehängt. Das Budget wird unten
      // reihum vergeben, und dafür muss sichtbar bleiben, welche Zeile zu
      // welcher Frage gehört — sonst verdrängt eine geschwätzige Frage die
      // Brüche aller anderen (siehe die Begründung an der Vergabe unten).
      const group = broken.get(hurdleId);
      if (group === undefined) {
        broken.set(hurdleId, {
          title: typeof hurdle?.title === 'string' ? hurdle.title : hurdleId,
          perQuestion: [{ questionNo, lines: [...lines] }],
        });
      } else {
        group.perQuestion.push({ questionNo, lines: [...lines] });
      }
    }

    // Content criteria: counted for the stderr note, never decisive. A criterion
    // "carries a hurdle" per the registry (K5/K6); everything else is content.
    for (const f of findings) {
      if (f.severity !== 'fail') continue;
      if (criteria[f.criterion]?.hurdle) continue;
      softByCriterion.set(f.criterion, (softByCriterion.get(f.criterion) ?? 0) + 1);
    }
  });

  if (skipped > 0) {
    notes.push(`${skipped} Frage(n) nicht auswertbar — unverändert durchgelassen.`);
  }
  if (softByCriterion.size > 0) {
    const summary = [...softByCriterion.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, n]) => `${id}×${n}`)
      .join(', ');
    notes.push(
      `Inhaltliche Befunde (${summary}) — NICHT blockiert. Gemessene Falsch-Positiv-Rate ` +
      '14–25 %; nur die harten Grenzen H1/H2 blockieren.',
    );
  }

  if (broken.size === 0) return allow();

  const sections = [];
  let used = 0;
  let omitted = 0;
  // ZWEI Durchgänge: erst jede Gruppe mit mindestens einer Zeile bedienen, dann
  // den Rest auffüllen.
  //
  // Vorher lief das in EINEM Durchgang, und die erste Gruppe durfte das ganze
  // Budget verbrauchen. Gemessen 2026-08-22 mit 4 Fragen × 5 Optionen (alles
  // innerhalb der Protokollgrenzen): von 12 gezeigten H2-Zeilen benannten 10 die
  // Beschreibungslänge — ein Befund, der laut Registry gar keine eigene Hürde
  // trägt — und genau EINE den echten Optionszahl-Bruch, den von Frage 1. Die
  // Brüche der Fragen 2, 3 und 4 landeten vollständig im verworfenen Rest.
  //
  // Das Modell erfuhr also, dass Frage 1 zu viele Optionen hat, und nichts
  // darüber, dass drei weitere denselben Bruch tragen: zweiter Anlauf, zweite
  // Ablehnung, und der Operator sieht keine der beiden Fragen.
  //
  // Gefunden vom QA-Review dieser Session (W4-Q6), koordinator-verifiziert.
  const groups = [...broken.entries()];
  // Reihum über FRAGEN, nicht der Reihe nach über Zeilen: erst bekommt jede
  // Frage jeder Gruppe ihre erste Zeile, dann die zweite, und so fort bis das
  // Budget alle ist. Damit ist garantiert, dass jede Frage mit gerissener Hürde
  // benannt wird, solange überhaupt Platz für sie da ist.
  const taken = new Map();
  for (const [id, group] of groups) taken.set(id, group.perQuestion.map(() => 0));
  const depth = Math.max(0, ...groups.map(([, g]) => Math.max(0, ...g.perQuestion.map((q) => q.lines.length))));
  outer: for (let round = 0; round < depth; round += 1) {
    for (const [id, group] of groups) {
      const counts = taken.get(id);
      for (let qi = 0; qi < group.perQuestion.length; qi += 1) {
        if (used >= MAX_FINDING_LINES) break outer;
        if (group.perQuestion[qi].lines.length <= round) continue;
        counts[qi] += 1;
        used += 1;
      }
    }
  }
  for (const [hurdleId, group] of groups) {
    const counts = taken.get(hurdleId);
    const shown = [];
    group.perQuestion.forEach((q, qi) => {
      shown.push(...q.lines.slice(0, counts[qi]));
      omitted += q.lines.length - counts[qi];
    });
    sections.push(`${hurdleId} — ${group.title}\n${shown.join('\n')}`);
  }
  const tail = omitted > 0 ? `\n(+${omitted} weitere Befund(e) nicht gezeigt)` : '';

  // The FIRST LINE names the concrete break, because `emitDeny` derives the
  // operator-visible headline from it. A general preamble first would put a
  // sentence that is identical for every deny in front of the human, and the
  // one thing they need — WHICH limit broke — past the 200-char clip.
  const reason =
    `AskUserQuestion blockiert: harte Grenze ${[...broken.keys()].join(' + ')} gerissen — ` +
    'so erreicht die Frage den Operator nicht.\n\n' +
    'Das ist keine Stilfrage: das Tool schneidet eine zu lange Kopfzeile selbst ab, und ' +
    'mehr als vier Optionen kann niemand gegeneinander abwägen.\n\n' +
    `${sections.join('\n\n')}${tail}`;

  const suggestion =
    'Formuliere die Frage neu und stell sie noch einmal — dieser Hook kürzt nicht selbst, ' +
    'weil jedes automatische Kürzen oder Umsortieren Bedeutung verlöre, ohne dass der ' +
    'Operator es sehen könnte. Inhaltliche Kriterien (Grund/Preis/Folge je Option, Jargon, ' +
    '„geh selbst nachsehen") werden hier NICHT geprüft und sind kein Grund für diese Sperre.';

  return { action: 'deny', reason, suggestion, notes };
}

// ---------------------------------------------------------------------------
// Entry point — exactly ONE terminal emit
// ---------------------------------------------------------------------------

/**
 * Write diagnostics to stderr. Under exit 0 this channel is a DEBUG LOG ONLY —
 * it never reaches the operator, so nothing may depend on it being read.
 * Wrapped because stderr can be closed, and a throw here would unwind into the
 * fail-open catch below and cost the diagnostic AND the reason for it.
 *
 * @param {string[]} notes
 * @returns {void}
 */
function writeNotes(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return;
  try {
    process.stderr.write(`⚠ ${HOOK_NAME}: ${notes.join(' ')}\n`);
  } catch { /* stderr may be closed; the decision below is what matters */ }
}

async function main() {
  let input;
  try {
    input = await readStdin();
  } catch (err) {
    // Malformed / oversized / slow stdin is a harness quirk, not a bad question.
    // Denying here would destroy every question on a parse error.
    writeNotes([`stdin unlesbar (${String(err?.message ?? err).split('\n')[0]}) — durchgelassen.`]);
    return emitAllow();
  }
  if (!input) return emitAllow();

  // Cheap pre-check: the matcher in hooks.json is not the only line of defence.
  if (input.tool_name !== AUQ_TOOL) return emitAllow();

  const verdict = decide(input, { schema: schemaMod, clarity: clarityMod });
  writeNotes(verdict.notes);

  if (verdict.action === 'deny') return emitDeny(verdict.reason, verdict.suggestion);
  return emitAllow();
}

// ---------------------------------------------------------------------------
// Self-execution guard (§ Import safety).
//
// Without it, an `import` of this module runs `main()`, blocks 5 s on stdin and
// terminates the IMPORTING process with `exit 0` — which under ADR-0011 is
// itself an ALLOW. `process.argv[1]` carries the path as passed (symlink-bearing
// under a symlinked plugin install) while `import.meta.url` is realpath-resolved
// by node's default loader, so BOTH sides are realpath'd.
// ---------------------------------------------------------------------------
function invokedAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return entry === self;
  }
}

if (invokedAsScript()) {
  // Silent no-op when disabled via profile/env (#211).
  if (!shouldRunHook(HOOK_NAME)) process.exit(0);

  // -------------------------------------------------------------------------
  // TWO distinct failure classes, two distinct handlers — do NOT merge them:
  //
  //   1. LOAD failure (`bootstrap()` throws): the guard never armed. Exit 0
  //      (fail-OPEN — a broken module must not cost the operator's question, and
  //      `emitAllow` itself may be the symbol that failed to load) but SAY SO:
  //      GUARD INACTIVE.
  //   2. RUNTIME failure inside `main()`: the guard armed and then tripped. Also
  //      fail-open, for the asymmetry in § Fail direction — a wrongly-denied
  //      question is never asked, while an unchecked one is merely worse worded.
  // -------------------------------------------------------------------------
  try {
    await bootstrap();
  } catch (loadError) {
    try {
      const { emitGuardInactiveBanner } = await import('./_lib/guard-source-loader.mjs');
      emitGuardInactiveBanner({ hookName: HOOK_NAME, error: loadError, consequence: GUARD_CONSEQUENCE });
    } catch {
      // Last resort: even the banner helper failed to load. Emit unconditionally —
      // repeated noise beats a silent disarm.
      process.stderr.write(
        `🚨 ${HOOK_NAME}: GUARD INACTIVE — module load failed ` +
          `(${String(loadError?.message || loadError).split('\n')[0]}). ` +
          'Runtime AskUserQuestion clarity checking is OFF. See issue #992.\n',
      );
    }
    process.exit(0); // fail-open, but no longer fail-silent
  }

  main().catch((e) => {
    try {
      process.stderr.write(
        `⚠ ${HOOK_NAME}: internal hook error — question ALLOWED unchecked ` +
          `(${String(e?.message ?? e).split('\n')[0]})\n`,
      );
    } catch { /* stderr may be closed; the allow below is the decision */ }
    emitAllow();
  });
}
