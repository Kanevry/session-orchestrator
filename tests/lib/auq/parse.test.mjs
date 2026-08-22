/**
 * parse.test.mjs — pinnt den toleranten AUQ-Extraktor (#1107).
 *
 * ## TV-001: die konkreten Fehler, die diese Tests fangen
 *
 * Jede Fixture unten ist WÖRTLICH aus dem Repo kopiert (Datei + Zeile stehen
 * jeweils dabei). Das ist Absicht: eine handgeschriebene Wunschform pinnt die
 * Annahme des Parsers, nicht die Wirklichkeit des Korpus — und genau diese
 * Wirklichkeit ist an sieben Stellen widerspenstiger als jedes Wunschformat.
 *
 * Die benannten Defekte, die sonst NICHTS im Repo sieht:
 *
 *   1. UNVERANKERTER ZAUN. Ein Segmentierer, der Code-Zäune mit /```/ ohne
 *      Zeilenanfangs-Anker sucht, schließt den Block MITTEN im Fragetext von
 *      `skills/discovery/SKILL.md:373` — dort stehen zwei literale ``` im
 *      String. Ergebnis: die Frage wird abgeschnitten und ihre vier Optionen
 *      verschwinden lautlos.
 *
 *   2. NUR-DOPPELTE-ANFÜHRUNGSZEICHEN. `question: "` findet 33 von 42 Fragen.
 *      Die fehlenden 9 stehen in Backticks und sind die fachwortdichtesten im
 *      Repo — ein Extraktor, der sie verliert, meldet ausgerechnet die
 *      schlimmsten Fragen als nicht vorhanden. Zusätzlich zerreißt jeder Split
 *      auf Anführungszeichen `skills/session-start/SKILL.md:161`, weil dessen
 *      `${…}` ein Ternary mit einfachen Anführungszeichen enthält.
 *
 *   3. KOMMENTAR ALS LABEL. `phase-2-5-docs-planning.md:60` trägt einen
 *      Zeilenkommentar, der SELBST `"(Recommended)"` in Anführungszeichen
 *      enthält. Wer das letzte Literal der Zeile nimmt, extrahiert den
 *      Kommentar als Label.
 *
 *   4. ELLIPSEN-FRAGMENT. `skills/reconcile/SKILL.md:253` macht den Block zu
 *      ungültigem JavaScript. Ein AST-Parser wirft; ein zeilenweiser Paarbilder
 *      liefert stillschweigend eine FALSCHE Optionszahl, aus der H2 dann einen
 *      Verstoß baut, den es nicht gibt.
 *
 *   5. MEHRZEILIGE OPTIONS-OBJEKTE. 20 von 138 `label:`-Zeilen haben ihr
 *      `description:` auf einer anderen Zeile. Ein zeilenweiser Paarbilder
 *      paart sie mit der NACHBAROPTION — die Beschreibung landet an der
 *      falschen Option, und beide Befunde sind danach falsch adressiert.
 *
 *   6. EMPFEHLUNG AM FALSCHEN FELD. `dispatcher-autonomy-capture.mjs:59` setzt
 *      `(Recommended)` in die `description`. Jeder Ausdruck der Form
 *      `label:.*\(Recommended\)` übersieht diese Frage vollständig.
 *
 *   7. GLOBALES STERNCHEN-STRIPPEN. In der Fallback-Liste von
 *      `phase-2-5-docs-planning.md:81` steht `docs/dev/**, docs/adr/**` — ein
 *      globales Entfernen der Markdown-Auszeichnung zerstört diese Pfade.
 *
 *   8. INFORMATIVE NUMMERNLISTE ALS AUSWAHL. `.cursor/rules/050-plan.mdc:81`
 *      („## Answers So Far") ist eine Zusammenfassung. Zählt sie als Frage mit,
 *      wandert eine erfundene Vorlage samt Note in den Bericht.
 *
 *   9. FREMDES `question:`-FELD. `scripts/lib/state-md/body-sections.mjs` führt
 *      `question:` in einer STATE.md-Datenstruktur. Ein Extraktor ohne
 *      Struktur-Test nimmt STATE.md-Datensätze als Operator-Fragen auf.
 *
 * @see scripts/lib/auq/parse.mjs
 * @see Issue #1107
 */

import { describe, expect, it } from 'vitest';

import {
  corpusKindOf,
  fencesOf,
  parseFile,
  readStringLiteral,
  splitNumberedItem,
  stripComments,
} from '../../../scripts/lib/auq/parse.mjs';

/** Kurzhelfer: erste Frage des ersten Blocks. */
function firstQuestion(res) {
  return res.blocks[0]?.questions[0];
}

// ---------------------------------------------------------------------------
// Falle 1 — der Code-Zaun IM Fragetext
// ---------------------------------------------------------------------------

// Wörtlich aus skills/discovery/SKILL.md:370-383.
const DISCOVERY_FENCE = [
  '```',
  'AskUserQuestion({',
  '  questions: [{',
  '    question: "<finding title>\\n\\n<file_path>:<line_number>\\n```\\n<matched_text with +/-3 lines context>\\n```\\n\\n<description>\\n\\nRecommended fix: <recommended_fix>",',
  '    header: "<severity>",',
  '    options: [',
  '      { label: "Create issue (<severity>)", description: "Create a priority::<severity> issue for this finding" },',
  '      { label: "Adjust priority", description: "Create issue with different priority" },',
  '      { label: "Dismiss -- intentional", description: "This is by design, skip" },',
  '      { label: "Dismiss -- false positive", description: "Detection was wrong, skip" }',
  '    ]',
  '  }]',
  '})',
  '```',
].join('\n');

describe('Falle 1 — verschachtelter Zaun im Fragetext', () => {
  it('schließt den Zaun am Zeilenanfang, nicht am ``` mitten im String', () => {
    const fences = fencesOf(DISCOVERY_FENCE);
    expect(fences).toHaveLength(1);
    // Ohne ^-Anker endete der Block bei Zeile 4 (dem ``` im Fragetext).
    expect(fences[0].openLine).toBe(1);
    expect(fences[0].closeLine).toBe(14);
  });

  it('liefert die vollständige Frage samt ihrer vier Optionen', () => {
    const q = firstQuestion(parseFile({ file: 'skills/discovery/SKILL.md', content: DISCOVERY_FENCE }));
    expect(q.options).toHaveLength(4);
    expect(q.question).toContain('```');
    expect(q.question).toContain('Recommended fix: <recommended_fix>');
    expect(q.header).toBe('<severity>');
    // multiSelect fehlt in diesem Block (Falle 7) — Vorgabe, kein Verwerfen.
    expect(q.multiSelect).toBe(false);
    expect(q.population).toBe('A');
    expect(q.quoting).toBe('double');
  });
});

// ---------------------------------------------------------------------------
// Falle 2 — Template-Literale mit ${…}
// ---------------------------------------------------------------------------

// Wörtlich aus skills/session-start/SKILL.md:158-170 (Einrückung erhalten).
const BACKTICK_FENCE = [
  '     ```js',
  '     AskUserQuestion({',
  '       questions: [{',
  "         question: `Stale session lock found (started ${ageHours}h ago, ttl=${existingLock.ttl_hours}h). Process pid=${existingLock.pid} on host=${existingLock.host} is ${reason === 'stale-pid-dead' ? 'confirmed dead' : 'still running or status unknown'}. Reclaim the lock?`,",
  '         header: "Stale Session Lock",',
  '         multiSelect: false,',
  '         options: [',
  '           { label: "Reclaim (Recommended)", description: "Overwrite the stale lock and continue. Safe when the previous session is no longer active." },',
  '           { label: "Abort — investigate manually", description: "Stop here. Inspect .orchestrator/session.lock before proceeding." },',
  '         ],',
  '       }],',
  '     });',
  '     ```',
].join('\n');

describe('Falle 2 — Backtick-Fragen', () => {
  it('findet die Backtick-Frage, die ein "question: \\"" -Ausdruck verliert', () => {
    const q = firstQuestion(parseFile({ file: 'skills/session-start/SKILL.md', content: BACKTICK_FENCE }));
    expect(q.quoting).toBe('backtick');
    expect(q.options).toHaveLength(2);
    expect(q.options[0].isRecommended).toBe(true);
  });

  it('überspringt das Ternary mit einfachen Anführungszeichen im ${…}, statt daran zu zerreißen', () => {
    const q = firstQuestion(parseFile({ file: 'skills/session-start/SKILL.md', content: BACKTICK_FENCE }));
    // Der Text NACH der Interpolation ist der Beweis: ein Split auf
    // Anführungszeichen endet bei 'stale-pid-dead' und verliert alles danach.
    expect(q.question).toContain("${reason === 'stale-pid-dead' ?");
    expect(q.question.endsWith('. Reclaim the lock?')).toBe(true);
    expect(q.header).toBe('Stale Session Lock');
  });

  it('liest alle drei Anführungsformen und bildet einfache auf "double" ab', () => {
    expect(readStringLiteral('x = "abc";', 4)).toMatchObject({ value: 'abc', quoting: 'double' });
    expect(readStringLiteral("x = 'abc';", 4)).toMatchObject({ value: 'abc', quoting: 'double' });
    expect(readStringLiteral('x = `abc`;', 4)).toMatchObject({ value: 'abc', quoting: 'backtick' });
  });
});

// ---------------------------------------------------------------------------
// Falle 4 — der JS-Kommentar auf der Feldzeile
// ---------------------------------------------------------------------------

// Wörtlich aus skills/session-start/phase-2-5-docs-planning.md:53-73.
const COMMENT_FENCE = [
  '```js',
  'AskUserQuestion({',
  '  questions: [{',
  '    question: "Welche Audiences berührt dieser Scope? (Mehrfachauswahl möglich)",',
  '    header: "Audiences",',
  '    multiSelect: true,',
  '    options: [',
  '      {',
  '        label: "Dev (Recommended)",   // add "(Recommended)" to each detected audience',
  '        description: "Architektur-, Modul- oder Refactoring-Änderungen — aktualisiert CLAUDE.md (oder AGENTS.md auf Codex CLI), docs/dev/**, docs/adr/**."',
  '      },',
  '      {',
  '        label: "User",',
  '        description: "Öffentlich sichtbare Änderungen — aktualisiert README.md, docs/user/**, examples/**."',
  '      }',
  '    ]',
  '  }]',
  '})',
  '```',
].join('\n');

describe('Falle 4 — Kommentar auf der Feldzeile', () => {
  it('extrahiert das Label, nicht das Anführungspaar aus dem Kommentar', () => {
    const q = firstQuestion(parseFile({
      file: 'skills/session-start/phase-2-5-docs-planning.md',
      content: COMMENT_FENCE,
    }));
    expect(q.options[0].label).toBe('Dev (Recommended)');
    expect(q.options[0].isRecommended).toBe(true);
    expect(q.multiSelect).toBe(true);
  });

  it('stripComments ist längenerhaltend, damit Zeilennummern gültig bleiben', () => {
    const src = 'a: "x", // "y"\nb: 2';
    const out = stripComments(src);
    expect(out).toHaveLength(src.length);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).not.toContain('"y"');
  });
});

// ---------------------------------------------------------------------------
// Fallen 3 + 5 — mehrzeilige Optionen und das Ellipsen-Fragment
// ---------------------------------------------------------------------------

// Wörtlich aus skills/reconcile/SKILL.md:243-261.
const RECONCILE_FENCE = [
  '```',
  'AskUserQuestion({',
  '  questions: [{',
  '    question: "Which rule proposals should be written to .claude/rules/?  (batch K of N)",',
  '    header: "Reconcile — Approve Rule Proposals",',
  '    options: [',
  '      {',
  '        label: "<slug>.md (confidence: 0.72)",',
  '        description: "Learning: <learningKey> | Path: .claude/rules/<slug>.md | <first 100 chars of rendered content>"',
  '      },',
  '      ...up to 4 options per batch...',
  '      {',
  '        label: "Skip all in this batch",',
  '        description: "Decline all proposals in this batch — they are archived to the rejected log."',
  '      }',
  '    ],',
  '    multiSelect: true',
  '  }]',
  '})',
  '```',
].join('\n');

describe('Fallen 3 + 5 — mehrzeilige Optionen, Ellipsen-Fragment', () => {
  it('stürzt am Ellipsen-Fragment nicht ab (deshalb kein AST-Parser)', () => {
    const res = parseFile({ file: 'skills/reconcile/SKILL.md', content: RECONCILE_FENCE });
    expect(res.blocks).toHaveLength(1);
    expect(res.blocks[0].questions).toHaveLength(1);
  });

  it('paart Label und Beschreibung über Zeilengrenzen hinweg korrekt', () => {
    const q = firstQuestion(parseFile({ file: 'skills/reconcile/SKILL.md', content: RECONCILE_FENCE }));
    expect(q.options).toHaveLength(2);
    // Der Paarungsfehler sähe so aus: Option 0 bekäme die Beschreibung von
    // Option 1 (oder eine leere), weil beide auf eigenen Zeilen stehen.
    expect(q.options[0].label).toBe('<slug>.md (confidence: 0.72)');
    expect(q.options[0].description).toContain('Learning: <learningKey>');
    expect(q.options[1].label).toBe('Skip all in this batch');
    expect(q.options[1].description).toContain('archived to the rejected log');
  });

  it('meldet die Optionszahl als UNBEKANNT, statt 2 zu behaupten', () => {
    const q = firstQuestion(parseFile({ file: 'skills/reconcile/SKILL.md', content: RECONCILE_FENCE }));
    // Ohne diesen Merker meldet H2 „2 Optionen" als vollständig — die Vorlage
    // hat aber ausdrücklich „up to 4 options per batch".
    expect(q.optionCountUnknown).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Falle 6 — die Empfehlung am falschen Feld (C-mjs)
// ---------------------------------------------------------------------------

// Wörtlich aus scripts/lib/config/dispatcher-autonomy-capture.mjs:47-80.
const CAPTURE_MJS = [
  '/**',
  ' * @returns {{ question: string, header: string, options: Array<{ label: string }> }}',
  ' */',
  'export function getDispatcherAutonomyQuestion() {',
  '  return {',
  '    question:',
  "      'Cross-repo dispatcher autonomy: how should this repo participate when the free-repo dispatcher routes work to it?',",
  "    header: 'Dispatcher Autonomy (one-time)',",
  '    options: [',
  '      {',
  "        label: 'off',",
  '        description:',
  "          '(Recommended) Fail-closed. The dispatcher never routes work to this repo automatically. No behaviour change.',",
  '      },',
  '      {',
  "        label: 'advisory',",
  '        description:',
  "          'The dispatcher surfaces ranked free-repo candidates for operator review — no automated dispatch.',",
  '      },',
  '    ],',
  '    multiSelect: false,',
  '  };',
  '}',
].join('\n');

describe('Falle 6 — (Recommended) in der description statt im label', () => {
  it('erkennt die Empfehlung, die ein label-Ausdruck vollständig übersieht', () => {
    const res = parseFile({
      file: 'scripts/lib/config/dispatcher-autonomy-capture.mjs',
      content: CAPTURE_MJS,
    });
    const q = firstQuestion(res);
    expect(q.population).toBe('C-mjs');
    expect(q.options[0].label).toBe('off');
    expect(q.options[0].isRecommended).toBe(true);
  });

  it('reicht den Fall als Warnung durch, statt ihn still zu heilen', () => {
    const res = parseFile({
      file: 'scripts/lib/config/dispatcher-autonomy-capture.mjs',
      content: CAPTURE_MJS,
    });
    expect(res.warnings.join('\n')).toContain('recommended-in-description');
  });

  it('nimmt die @returns-Signatur im JSDoc nicht als zweite Frage auf', () => {
    const res = parseFile({
      file: 'scripts/lib/config/dispatcher-autonomy-capture.mjs',
      content: CAPTURE_MJS,
    });
    // Zeile 2 trägt `question: string` in einem @returns. GEMESSEN (Fake-
    // Regression 2026-08-22): dagegen schützt hier NICHT das Kommentar-
    // Strippen, sondern die Regel „ein Schlüssel ohne String-Literal ist kein
    // Wert" — `question: string` hat kein Literal. Der Test pinnt deshalb
    // diese Regel, nicht die Kommentar-Entfernung.
    expect(res.blocks).toHaveLength(1);
  });

  it('nimmt einen AUSKOMMENTIERTEN Block nicht als lebende Vorlage auf', () => {
    // Synthetisch, und zwar notgedrungen: dieser Defekt steht heute in keiner
    // Repo-Datei — er ist einen einzigen `//` weit entfernt. Ohne
    // Kommentar-Entfernung im .mjs-Pfad wandert eine abgeschaltete Frage in
    // den Bericht und wird benotet, als würde sie gestellt.
    const content = [
      'export function getQuestion() {',
      "  // question: 'Alte, abgeschaltete Frage?',",
      "  // options: [{ label: 'Ja', description: 'x' }, { label: 'Nein', description: 'y' }],",
      '  return null;',
      '}',
    ].join('\n');
    expect(parseFile({ file: 'scripts/lib/config/x.mjs', content }).blocks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Falle 9 — ein fremdes `question:`-Feld ist keine Operator-Frage
// ---------------------------------------------------------------------------

describe('Falle 9 — fremdes question:-Feld', () => {
  it('nimmt eine STATE.md-Datenstruktur ohne Optionen nicht als Frage auf', () => {
    // Form aus scripts/lib/state-md/body-sections.mjs:451.
    const content = ['export function parseOpenQuestions(md) {', '  return {', '      question: m[2].trim(),', '      answered: false,', '  };', '}'].join('\n');
    const res = parseFile({ file: 'scripts/lib/state-md/body-sections.mjs', content });
    expect(res.blocks).toHaveLength(0);
  });

  it('schließt tests/ und nicht-Korpus-Pfade strukturell aus', () => {
    expect(corpusKindOf('tests/lib/state-md/body-sections.test.mjs')).toBeNull();
    expect(corpusKindOf('docs/session-config-reference.md')).toBeNull();
    expect(corpusKindOf('README.md')).toBeNull();
    expect(corpusKindOf('skills/plan/SKILL.md')).toBe('md');
    expect(corpusKindOf('.cursor/rules/050-plan.mdc')).toBe('mdc');
    expect(corpusKindOf('scripts/lib/owner-interview.mjs')).toBe('mjs');
  });
});

// ---------------------------------------------------------------------------
// Population B — drei Zeilenformen, ein Glob, kein Terminator
// ---------------------------------------------------------------------------

describe('Population B — nummerierte Fallback-Liste', () => {
  it('trennt Label und Beschreibung in allen drei belegten Zeilenformen', () => {
    // Zeilen wörtlich aus skills/_shared/parallel-aware-auq.md:50,
    // skills/session-end/SKILL.md:913 und
    // skills/session-end/phase-3-2-docs-verification.md:107.
    expect(splitNumberedItem('Warten (Recommended) — wait for the exclusive session to finish; re-run after it closes.'))
      .toEqual({ label: 'Warten (Recommended)', description: 'wait for the exclusive session to finish; re-run after it closes.' });
    expect(splitNumberedItem('**Behalten (Recommended)** — Keep the worktree as-is. No cleanup.'))
      .toEqual({ label: 'Behalten (Recommended)', description: 'Keep the worktree as-is. No cleanup.' });
    // Die Empfehlung steht AUSSERHALB der Fettung und kursiv — und es gibt
    // keine Beschreibung. Ein Ausdruck, der `(Recommended)` innerhalb der
    // Fettung erwartet, verliert die Markierung dieser Option.
    expect(splitNumberedItem('**Warn + carryover and close** *(Recommended)*'))
      .toEqual({ label: 'Warn + carryover and close (Recommended)', description: '' });
  });

  it('zerstört den Glob in der Beschreibung nicht beim Entfernen der Auszeichnung', () => {
    // Wörtlich aus skills/session-start/phase-2-5-docs-planning.md:81.
    const item = splitNumberedItem(
      '**Dev (Recommended)** — Architektur-, Modul- oder Refactoring-Änderungen. Targets: CLAUDE.md, docs/dev/**, docs/adr/**.',
    );
    expect(item.label).toBe('Dev (Recommended)');
    // Ein globales Sternchen-Strippen macht daraus `docs/dev/, docs/adr/.`
    expect(item.description).toContain('docs/dev/**');
    expect(item.description).toContain('docs/adr/**');
  });

  it('findet den Block ohne Terminator, weil das Ende am Zaun hängt', () => {
    // Wörtlich aus skills/session-end/phase-3-2-docs-verification.md:103-112 —
    // die einzige Fallback-Liste im Repo ganz OHNE „Reply with the number".
    const content = [
      '  - **Codex CLI / Cursor fallback:** render a numbered Markdown list:',
      '    ```markdown',
      '    ## Phase 3.2: Documentation Gaps Detected (mode=strict)',
      '',
      '    Choose one:',
      '    1. **Warn + carryover and close** *(Recommended)*',
      '    2. Override — close session with gaps (deviations will be logged)',
      '',
      '    Gap tasks: <list task IDs and target-patterns>',
      '    ```',
    ].join('\n');
    const res = parseFile({ file: 'skills/session-end/phase-3-2-docs-verification.md', content });
    const q = firstQuestion(res);
    expect(q.population).toBe('B');
    expect(q.options).toHaveLength(2);
    expect(q.options[0].isRecommended).toBe(true);
    expect(q.quoting).toBe('prose');
  });
});

// ---------------------------------------------------------------------------
// Falle 8 — eine informative Nummernliste ist keine Auswahl
// ---------------------------------------------------------------------------

describe('Falle 8 — informative Nummernliste', () => {
  it('nimmt die Antwort-Zusammenfassung nicht als Frage auf', () => {
    // Wörtlich aus .cursor/rules/050-plan.mdc:80-86.
    const content = [
      'After each wave, output a recap:',
      '```',
      '## Answers So Far (Wave N/M)',
      '1. Archetype: nextjs-saas',
      '2. Visibility: internal',
      '3. Audience: B2B customers',
      '```',
    ].join('\n');
    expect(parseFile({ file: '.cursor/rules/050-plan.mdc', content }).blocks).toHaveLength(0);
  });

  it('nimmt dieselbe Form MIT Auswahl-Hinweis sehr wohl auf', () => {
    // Wörtlich aus .cursor/rules/050-plan.mdc:27-35 — Gegenprobe, damit der
    // Ausschluss oben nicht einfach „findet nie etwas" bedeutet.
    const content = [
      'If no mode specified, ask via numbered list:',
      '',
      '```',
      'Which planning mode?',
      '',
      '1. new (Recommended) — Project kickoff (full PRD, repo setup, issue creation)',
      '2. feature — Feature PRD (compact scope, acceptance criteria, issues)',
      '3. retro — Retrospective (metrics analysis, reflection, improvement actions)',
      '```',
    ].join('\n');
    const q = firstQuestion(parseFile({ file: '.cursor/rules/050-plan.mdc', content }));
    expect(q.population).toBe('C-mdc');
    expect(q.question).toBe('Which planning mode?');
    expect(q.options).toHaveLength(3);
    expect(q.options[0].label).toBe('new (Recommended)');
  });
});

// ---------------------------------------------------------------------------
// Vorlage vs. Illustration
// ---------------------------------------------------------------------------

describe('kind — Vorlage vs. Format-Erläuterung', () => {
  it('erkennt den reinen Platzhalter-Block als Illustration', () => {
    // Wörtlich aus .claude/rules/ask-via-tool.md:27-32.
    const content = [
      '```',
      'AskUserQuestion({ questions: [{',
      '  question: "…?", header: "…",',
      '  options: [',
      '    { label: "X (Recommended)", description: "Why + cost + what it commits to." },',
      '    { label: "Y", description: "When Y applies + its cost." }',
      '  ], multiSelect: false }]})',
      '```',
    ].join('\n');
    expect(firstQuestion(parseFile({ file: '.claude/rules/ask-via-tool.md', content })).kind)
      .toBe('illustration');
  });

  it('erkennt die "Example:"-Vorzeile als Illustration', () => {
    // Wörtlich aus skills/session-start/presentation-format.md:64-78.
    const content = [
      'Example:',
      '```',
      'AskUserQuestion({',
      '  questions: [{',
      '    question: "Which session focus do you recommend?",',
      '    header: "Focus",',
      '    options: [',
      '      { label: "Issues #91 + #92 (Recommended)", description: "OpenTelemetry + OpenAPI — high synergy" },',
      '      { label: "Infra cleanup #44 + #60", description: "Close in-progress issues" }',
      '    ]',
      '  }]',
      '})',
      '```',
    ].join('\n');
    const q = firstQuestion(parseFile({ file: 'skills/session-start/presentation-format.md', content }));
    expect(q.kind).toBe('illustration');
  });

  it('hält eine echte Vorlage MIT Platzhaltern weiterhin für eine Vorlage', () => {
    // Gegenprobe: skills/discovery/SKILL.md:373 ist voller <platzhalter>, wird
    // aber wirklich gestellt. Ein zu grober Illustrations-Test nähme sie raus.
    const q = firstQuestion(parseFile({ file: 'skills/discovery/SKILL.md', content: DISCOVERY_FENCE }));
    expect(q.kind).toBe('template');
  });
});
