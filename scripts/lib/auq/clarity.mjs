/**
 * auq/clarity.mjs — der Bewerter der AUQ-Klarheitsmessung (#1107).
 *
 * ## Was dieses Modul tut, und was ausdrücklich nicht
 *
 * Es BEWERTET fertig geparste Fragen und PARST NICHTS. Kein Datei-IO, kein
 * Netz, kein LLM, keine neue Abhängigkeit — reine Funktion von `AuqQuestion`
 * nach `AuqScore`. Die Vorlagen findet `scripts/lib/auq/parse.mjs`, den Bericht
 * baut `scripts/auq-audit.mjs`.
 *
 * JEDE Schwelle, jedes Muster und jede Wortliste kommt aus `./schema.mjs`. Ein
 * Zahlenliteral in dieser Datei wäre ein zweiter Ort für dieselbe Schwelle —
 * und damit ein Defekt in Wartestellung: ändert sich die Registry, driftet der
 * Bewerter still. Die einzigen Zahlen hier sind `MAX_POINTS` (die Skala der
 * Punkteformel, die im Schema-Kopf steht) und die 0 der unteren Klemmung.
 *
 * ## Die Randbedingung, die über allen acht Kriterien steht
 *
 * Ein Prüfer, der korrekte Fragen anmeckert, wird abgeschaltet — und dann ist
 * jede richtig gefundene Schwäche mit ihm weg. Falsch-Positive kosten deshalb
 * mehr als Falsch-Negative. Gemessen haben nur K5 und H2 eine FP-Rate von 0 %;
 * alles andere liegt zwischen 14 % und 25 %. Konsequenzen im Code:
 *
 *   - Im Zweifel wird NICHT gemeldet (Platzhalter-Texte werden übersprungen,
 *     Aufzählungen zählen bei K1 nicht als Bericht, K3 ist eine Konjunktion).
 *   - Hart scheitert nur, was eine Hürde reißt (H1/H2). Die Punktzahl wird
 *     berichtet, nicht erzwungen — `--strict` ist in der CLI standardmäßig aus.
 *
 * ## Das Feld, an dem sich dieses Programm selbst misst
 *
 * `AuqFinding.message` steht später vor dem Operator. Deutsch, ohne Fachjargon,
 * und es nennt WAS gemessen wurde — nie die Kriteriums-ID. Eine Meldung wie
 * "K7 violation: unglossed identifier token" wäre genau die Ironie, an der ein
 * Klarheits-Prüfer scheitert.
 *
 * ## Der Schutz, der nicht wegoptimiert werden darf
 *
 * Ein Text, der auf `SAFETY_PATTERN` passt, ist von den LÄNGEN-Kriterien
 * (`LENGTH_CRITERIA` = K1, K6) befreit. Das ist hier STRUKTURELL verdrahtet,
 * nicht per Disziplin: `lengthFinding()` ist der einzige Weg, einen K1/K6-Befund
 * zu bauen, und wirft, wenn man ein anderes Kriterium hindurchschickt;
 * `finding()` wirft umgekehrt für K1/K6. Ein befreiter Befund wird auf `warn`
 * herabgestuft UND trägt `exempt: 'length'` — die Punkterechnung ignoriert
 * beides unabhängig voneinander, damit ein Ausrutscher an einer Stelle nicht
 * reicht, um eine Sicherheitswarnung wegkürzbar zu machen.
 *
 * K3/K4/K5/K7/K8 gelten für Sicherheitstexte WEITER. Sie fügen Information
 * hinzu (Grund, Preis, Erklärung) und nehmen keine weg — eine Warnung wird
 * durch einen genannten Grund besser, nicht kürzer.
 *
 * ## Woher die Zahlen in den Begründungen stammen
 *
 * Jede Quote unten ("44 % Falsch-Positive", "fünf von 120 Paaren") kommt aus der
 * Discovery-Zählung vom 2026-08-22 über 120 Optionen in 33 doppelt gequoteten
 * Fragen. Dieser Zensus wurde danach nach oben korrigiert: 42 Fragen (33 doppelt
 * gequotet + 9 in Backticks) mit 156 Optionen — ein zeilenverankertes grep hatte
 * drei kompakte Einzeiler in skills/plan/SKILL.md verloren.
 *
 * Die NENNER unten sind also die des kleineren Zensus. Sie stehen hier als
 * Begründung dafür, warum ein Kriterium so und nicht anders geschnitten ist,
 * nicht als aktueller Bestand — der lebt im Bericht, den `scripts/auq-audit.mjs`
 * erzeugt, und wird bei jeder Vorlagenänderung neu gemessen. Kein Test pinnt eine
 * dieser Gesamtzahlen; ein Zählstand in einem Unit-Test driftet garantiert.
 *
 * @see ./schema.mjs — der eingefrorene Vertrag (Kriterien, Schwellen, Fabriken)
 * @see .claude/rules/ask-via-tool.md — AUQ-001..005, die gemessene Regel
 */

import {
  CRITERIA,
  CRITERION_IDS,
  THRESHOLDS,
  HURDLES,
  LENGTH_CRITERIA,
  CODE_FENCE_PATTERN,
  TABLE_ROW_PATTERN,
  LIST_LINE_PATTERN,
  NEWLINE_PATTERN,
  MARKER_CLASSES,
  MARKER_CLASS_IDS,
  RECOMMENDED_MARKERS,
  STOPWORDS,
  HEADER_PLACEHOLDER_PATTERN,
  IDENTIFIER_PATTERNS,
  IDENTIFIER_ALLOWLIST,
  GLOSS_RULE,
  READ_IMPERATIVE_PATTERN,
  FIRST_PERSON_EXCLUSION_PATTERN,
  isLengthExempt,
  codepointLength,
  normalizeLiteralNewlines,
  globalOf,
  makeFinding,
  makeScore,
} from './schema.mjs';

// ---------------------------------------------------------------------------
// Struktur-Konstanten (KEINE Schwellen — die stehen alle in schema.mjs)
// ---------------------------------------------------------------------------

/**
 * Die Skala der Punkteformel aus dem Schema-Kopf: `points = 100 − Σ weight`.
 * Bewusst NICHT `TOTAL_WEIGHT`: dass die Gewichtssumme heute ebenfalls 100 ist,
 * ist eine Invariante der Registry, nicht die Definition der Skala. Würden die
 * beiden über `TOTAL_WEIGHT` gekoppelt, verschöbe eine Gewichtsänderung
 * stillschweigend auch die Notenbänder.
 */
const MAX_POINTS = 100;

/**
 * Ein Platzhalter im Text: `<name>` oder `{{name}}`. Bewusst zeilenbegrenzt und
 * ohne Längengrenze, damit hier keine Zahl steht.
 *
 * Die eckige Klammer `[...]` aus `HEADER_PLACEHOLDER_PATTERN` ist hier ABSICHTLICH
 * NICHT dabei: in Kopfzeilen ist `[x]` ein Platzhalter, in Fragetexten ist es
 * echter Inhalt (`"- [X] critical"` in skills/discovery/SKILL.md). Sie mit
 * aufzunehmen würde reale Aufzählungen wegfiltern.
 */
const PLACEHOLDER_PATTERN = /<[^<>\n]+>|\{\{[^{}\n]+\}\}/u;

/** Die im Korpus verwendete Platzhalter-Floskel ohne Klammern. */
const PLACEHOLDER_PHRASE = 'one-line description';

/**
 * Satzgrenze: Punkt/Ausrufe-/Fragezeichen, Leerraum, und danach ein
 * GROSSBUCHSTABE oder eine öffnende Klammer.
 *
 * Die Großbuchstaben-Bedingung ist tragend, nicht kosmetisch: ohne sie zerfällt
 * `"… docs/prd/YYYY-MM-DD-<feature>.md — most precise decomposition."` am `.md `
 * in zwei Sätze, und die Glosse hinter dem Gedankenstrich landet in einem
 * anderen Satz als der Bezeichner, den sie erklärt. K7 meldete dann einen
 * Falsch-Positiv auf einer vorbildlich glossierten Option.
 */
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=["'([{\p{Lu}])/u;

/** Wortgrenze für Wortzählungen. */
const WHITESPACE = /\s+/u;

/** Alles, was kein Buchstabe und keine Ziffer ist, trennt Inhaltswörter. */
const NON_WORD = /[^\p{L}\p{N}]+/u;

/** Punkte werden aus dem K8-Abstand herausgerechnet (siehe THRESHOLDS.K8). */
const PERIOD = /\./u;

/**
 * Eine Einsetzung in einem Backtick-Literal: `${…}`.
 *
 * In einem doppelt gequoteten String ist dieselbe Zeichenfolge wörtlicher Text
 * und KEINE Einsetzung — deshalb wird zusätzlich `quoting === 'backtick'`
 * geprüft, statt allein auf dieses Muster zu gehen.
 */
const INTERPOLATION = /\$\{/u;

/**
 * Der Zusatz, der eine Längenangabe als UNTERGRENZE kennzeichnet.
 *
 * Neun Fragen im Korpus stehen in Backticks und setzen Werte ein
 * (`${blockingSession.worktreePath}` wird zu einem absoluten Pfad). Am
 * Quelltext gemessen ist die Zahl also kleiner als das, was der Operator sieht.
 *
 * WICHTIG, in welche Richtung das wirkt: die Unsicherheit ist EINSEITIG. Reißt
 * schon die Untergrenze eine Schwelle, ist der Verstoß sicher — er wird durch
 * die Einsetzung nur größer. Gefährlich ist allein der stumme Gegenfall: eine
 * Frage, die im Quelltext unter der Schwelle liegt und auf dem Schirm darüber.
 * Den kann dieses Modul nicht sehen, und es wird ihn nicht schätzen — ein
 * erfundener Expansionsfaktor wäre eine Zahl ohne Messung. Der Zusatz sorgt
 * dafür, dass ein späterer Leser die neun Werte nicht für exakt hält.
 *
 * @param {import('./schema.mjs').AuqQuestion} q
 * @param {string} text der Text, dessen Länge gemessen wurde
 * @returns {string} leerer String, wenn die Messung exakt ist
 */
function lowerBoundNote(q, text) {
  if (q.quoting !== 'backtick') return '';
  if (!INTERPOLATION.test(str(text))) return '';
  return (
    ' Die Vorlage setzt zur Laufzeit Werte ein — der gemessene Wert ist eine UNTERGRENZE, ' +
    'auf dem Schirm steht mehr.'
  );
}

/**
 * Satzzeichen am ENDE eines gefundenen Bezeichners.
 *
 * Das Pfadmuster ist gierig und verschluckt den Satzpunkt: aus
 * `"… via node scripts/telemetry.mjs."` wird das Token `scripts/telemetry.mjs.`.
 * Das ist nicht nur hässlich in der Meldung — die Allowlist vergleicht per
 * VERTRAG auf exakte Zeichengleichheit, also verfehlt `STATE.md.` am Satzende
 * den Eintrag `STATE.md` und K7 meldet einen ausdrücklich erlaubten Bezeichner
 * als unerklärt. Führende Punkte bleiben erhalten (`.orchestrator/session.lock`).
 */
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/u;

// ---------------------------------------------------------------------------
// Textprimitive
// ---------------------------------------------------------------------------

/** @param {unknown} v @returns {string} */
function str(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * Entfernt Platzhalter ERSATZLOS (nicht durch ein Leerzeichen).
 *
 * Ersatzlos ist der Punkt: `docs/prd/YYYY-MM-DD-<feature>.md` zerfällt sonst in
 * die zwei Bruchstücke `docs/prd/YYYY-MM-DD-` und `.md`, von denen die Glosse
 * hinter dem Gedankenstrich nur das zweite erreicht. Ein Platzhalter ist ein
 * zur Laufzeit gefülltes Loch, kein Wortende.
 *
 * @param {string} text
 * @returns {string}
 */
function stripPlaceholders(text) {
  return str(text).replace(globalOf(PLACEHOLDER_PATTERN), '');
}

/**
 * Entfernt `(Recommended)` / `(Empfohlen)` aus einem Label.
 * @param {string} text
 * @returns {string}
 */
function stripRecommendedMarkers(text) {
  let out = str(text);
  for (const marker of RECOMMENDED_MARKERS) out = out.split(marker).join('');
  return out;
}

/**
 * Ist der Text NUR ein Platzhalter (und damit nichts, was man bewerten kann)?
 *
 * Eine Vorlage wie `"<one-line description of what this tier scaffolds>"` ist
 * kein Verstoß gegen K3/K4 — sie ist noch gar kein Text. Ohne diese Prüfung
 * meldet der Bewerter genau die Stellen, an denen der Autor bereits weiß, dass
 * dort etwas hingehört: die teuerste Sorte Falsch-Positiv, weil sie den Prüfer
 * unglaubwürdig macht, ohne irgendetwas zu finden.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isPlaceholderOnly(text) {
  const s = str(text);
  if (s.toLowerCase().includes(PLACEHOLDER_PHRASE)) return true;
  return stripRecommendedMarkers(stripPlaceholders(s)).trim() === '';
}

/**
 * Zerlegt einen Text in Sätze. K7 und K8 messen JE SATZ — eine Erklärung im
 * nächsten Satz ist keine Glosse mehr, und ein Lese-Imperativ im vorigen Satz
 * zeigt nicht auf den Pfad im aktuellen.
 *
 * @param {string} text
 * @returns {string[]}
 */
function sentencesOf(text) {
  const flat = normalizeLiteralNewlines(str(text)).trim();
  if (flat === '') return [];
  return flat
    .split(SENTENCE_BOUNDARY)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** @param {string} text @returns {string[]} */
function wordsOf(text) {
  return str(text).trim().split(WHITESPACE).filter((w) => w !== '');
}

/**
 * Inhaltswörter eines Textes: kleingeschrieben, ohne Platzhalter, ohne
 * Empfehlungsmarker, ohne Stoppwörter, ohne zu kurze Token.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function contentTokens(text) {
  const out = new Set();
  const cleaned = stripRecommendedMarkers(stripPlaceholders(text)).toLowerCase();
  for (const token of cleaned.split(NON_WORD)) {
    if (token === '') continue;
    if (codepointLength(token) < THRESHOLDS.K3.tokenMinChars) continue;
    if (STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bezeichner-Erkennung (Stufe 1 des K7-Detektors, auch von K8 benutzt)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Span
 * @property {string} id     Die `id` des Musters aus `IDENTIFIER_PATTERNS`.
 * @property {string} token  Der gefundene Text.
 * @property {number} start  Index (UTF-16) im übergebenen Text.
 * @property {number} end    Index hinter dem letzten Zeichen.
 */

/**
 * Alle Bezeichner-Spannen eines Textes, ohne Doppelzählung.
 *
 * Mehrere Muster treffen denselben Text (`docs/telemetry.md` passt sowohl auf
 * das Verzeichnis-Präfix als auch auf die Dateiendung). Enthaltene Treffer
 * werden verworfen, sonst zählte ein Bezeichner zweimal und die K7-Meldung
 * nennte ihn dem Operator doppelt.
 *
 * @param {string} text
 * @returns {Span[]}
 */
function identifierSpans(text) {
  const found = [];
  for (const { id, pattern } of IDENTIFIER_PATTERNS) {
    const re = globalOf(pattern);
    let match = re.exec(text);
    while (match !== null) {
      if (match[0] === '') {
        re.lastIndex += 1;
      } else {
        // `start`/`end` bleiben am ROHEN Treffer: ein kleinerer Abstand zur
        // Glosse ist die FP-sichere Richtung. Getrimmt wird nur der Text, der
        // gegen die Allowlist geprüft und dem Operator genannt wird.
        const trimmed = match[0].replace(TRAILING_PUNCTUATION, '');
        found.push({
          id,
          token: trimmed === '' ? match[0] : trimmed,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
      match = re.exec(text);
    }
  }
  // Längste Spanne zuerst, damit die enthaltene und nicht die umfassende fällt.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  /** @type {Span[]} */
  const kept = [];
  for (const span of found) {
    const covered = kept.some((k) => span.start >= k.start && span.end <= k.end);
    if (!covered) kept.push(span);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Glossen-Erkennung (Stufe 3 des K7-Detektors)
// ---------------------------------------------------------------------------

/**
 * Alle Spannen, die von einem Trenner aus `GLOSS_RULE.delimiters` eingefasst
 * sind. Trenner ohne Schließzeichen (Gedankenstrich, Doppelpunkt) reichen bis
 * zum Satzende — genau so liest ein Mensch sie.
 *
 * @param {string} sentence
 * @returns {Array<{id: string, start: number, end: number}>}
 */
function delimitedSpans(sentence) {
  const spans = [];
  for (const delim of GLOSS_RULE.delimiters) {
    let from = 0;
    for (;;) {
      const open = sentence.indexOf(delim.open, from);
      if (open === -1) break;
      const innerStart = open + delim.open.length;
      if (delim.close === null) {
        spans.push({ id: delim.id, start: innerStart, end: sentence.length });
        from = innerStart;
      } else {
        const close = sentence.indexOf(delim.close, innerStart);
        if (close === -1) break;
        spans.push({ id: delim.id, start: innerStart, end: close });
        from = close + delim.close.length;
      }
    }
  }
  return spans;
}

/**
 * Die Spannen, die alle inhaltlichen Glossen-Bedingungen erfüllen (3 und 4 aus
 * `GLOSS_RULE`). Bedingung 4 ist die tragende: eine "Erklärung", die selbst aus
 * Bezeichnern besteht, verschiebt das Nachschlagen nur um ein Wort.
 *
 * @param {string} sentence
 * @returns {Array<{id: string, start: number, end: number}>}
 */
function qualifyingGlosses(sentence) {
  return delimitedSpans(sentence).filter((span) => {
    const inner = sentence.slice(span.start, span.end);
    if (wordsOf(inner).length < GLOSS_RULE.minWords) return false;
    if (GLOSS_RULE.mustContainNoIdentifiers && identifierSpans(inner).length > 0) return false;
    return true;
  });
}

/**
 * Bedingung 2 aus `GLOSS_RULE`: steht die Glosse dicht genug am Bezeichner?
 *
 * @param {Span} token
 * @param {Array<{start: number, end: number}>} glosses
 * @returns {boolean}
 */
function isGlossed(token, glosses) {
  return glosses.some((gloss) => {
    const after = gloss.start - token.end;
    if (after >= 0 && after <= GLOSS_RULE.maxGapChars) return true;
    const before = token.start - gloss.end;
    return before >= 0 && before <= GLOSS_RULE.maxGapChars;
  });
}

/**
 * Der dreistufige K7-Detektor: erkennen → Allowlist → Glossen-Regel.
 *
 * @param {string} text
 * @returns {string[]} die unerklärten Bezeichner, in Fundreihenfolge
 */
function unexplainedIdentifiers(text) {
  const out = [];
  for (const sentence of sentencesOf(stripPlaceholders(text))) {
    const glosses = qualifyingGlosses(sentence);
    for (const token of identifierSpans(sentence)) {
      if (IDENTIFIER_ALLOWLIST.has(token.token)) continue;
      if (isGlossed(token, glosses)) continue;
      out.push(token.token);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Befund-Fabriken — der strukturelle Ort der Sicherheits-Ausnahme
// ---------------------------------------------------------------------------

/**
 * Die Stufe, die ein Kriterium überhaupt erreichen KANN. K2 kann nie `fail`
 * werden, egal wie lang der Satz ist — das steht in der Registry und wird hier
 * erzwungen statt an acht Aufrufstellen wiederholt.
 *
 * @param {string} criterion
 * @param {'fail'|'warn'} wanted
 * @returns {'fail'|'warn'}
 */
function cappedSeverity(criterion, wanted) {
  return CRITERIA[criterion].severity === 'warn' ? 'warn' : wanted;
}

/**
 * Befund für ein Kriterium, das KEIN Längenkriterium ist.
 *
 * Wirft für K1/K6. Das ist die eine Hälfte der strukturellen Absicherung: ein
 * Längenbefund kann die Sicherheits-Ausnahme nicht versehentlich umgehen, weil
 * er hier gar nicht gebaut werden kann.
 *
 * @param {Parameters<typeof makeFinding>[0]} rec
 * @returns {import('./schema.mjs').AuqFinding}
 */
function finding(rec) {
  if (LENGTH_CRITERIA.includes(rec.criterion)) {
    throw new TypeError(
      `auq/clarity: ${rec.criterion} ist ein Längenkriterium und muss über lengthFinding() laufen`,
    );
  }
  return makeFinding({ ...rec, severity: cappedSeverity(rec.criterion, rec.severity) });
}

/**
 * Befund für ein Längenkriterium (K1/K6), mit angewandter Sicherheits-Ausnahme.
 *
 * `subject` ist der Text, dessen LÄNGE gemessen wurde. Passt er auf das
 * Sicherheits-Lexikon, wird der Befund auf `warn` herabgestuft und trägt
 * `exempt: 'length'`.
 *
 * Für Befunde ohne gemessenen Text — die Optionsanzahl je Frage — ist `subject`
 * der leere String. `isLengthExempt('')` ist per Vertrag `null`, also kann die
 * Ausnahme die Hürde H2 strukturell nicht aushebeln: eine ZAHL hat keinen Text,
 * der geschützt werden müsste, und ein Sicherheitswort in irgendeiner Option
 * darf nicht dazu führen, dass eine Frage mit 7 Optionen als in Ordnung gilt.
 *
 * @param {Parameters<typeof makeFinding>[0]} rec
 * @param {string} subject
 * @returns {import('./schema.mjs').AuqFinding}
 */
function lengthFinding(rec, subject) {
  if (!LENGTH_CRITERIA.includes(rec.criterion)) {
    throw new TypeError(
      `auq/clarity: ${rec.criterion} ist kein Längenkriterium und gehört nicht in lengthFinding()`,
    );
  }
  const exempt = isLengthExempt(subject);
  const severity = exempt === null ? cappedSeverity(rec.criterion, rec.severity) : 'warn';
  return makeFinding({ ...rec, severity, exempt });
}

// ---------------------------------------------------------------------------
// K1 — Payload-Form (Frage)
// ---------------------------------------------------------------------------

/**
 * Zählt die eingebetteten Zeilen, die ein BERICHT sind.
 *
 * Leerzeilen und Aufzählungszeilen zählen NICHT mit. Die Ausnahme ist tragend:
 * `"Ready to create [N] issues?\n\n- [X] critical\n- [Y] high…"` hat fünf
 * eingebettete Zeilen und ist trotzdem in Ordnung — die Liste IST die Tatsache,
 * die der Operator zum Entscheiden braucht. Ohne die Ausnahme meldet K1 die
 * bestgebaute Bestätigungsfrage im Repo als Verstoß.
 *
 * @param {string} text
 * @returns {number}
 */
function reportLines(text) {
  const segments = str(text).split(NEWLINE_PATTERN);
  let count = 0;
  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.trim() === '') continue;
    if (LIST_LINE_PATTERN.test(segment)) continue;
    count += 1;
  }
  return count;
}

/**
 * @param {import('./schema.mjs').AuqQuestion} q
 * @param {{file: string, line: number}} at
 * @returns {import('./schema.mjs').AuqFinding[]}
 */
function checkK1(q, at) {
  const raw = str(q.question);
  if (raw.trim() === '') return [];
  const out = [];
  const base = { criterion: 'K1', severity: /** @type {'fail'} */ ('fail'), target: /** @type {'question'} */ ('question'), ...at, excerpt: raw };

  const chars = codepointLength(normalizeLiteralNewlines(raw));
  if (chars > THRESHOLDS.K1.questionCharsFail) {
    out.push(
      lengthFinding(
        {
          ...base,
          message:
            `Die Frage ist ${chars} Zeichen lang. Über ${THRESHOLDS.K1.questionCharsFail} liest der ` +
            'Operator sie als Bericht, nicht als Frage — der Sachstand gehört in die Optionen.' +
            lowerBoundNote(q, raw),
          measured: chars,
          threshold: THRESHOLDS.K1.questionCharsFail,
        },
        raw,
      ),
    );
  }

  const lines = reportLines(raw);
  if (lines >= THRESHOLDS.K1.embeddedLinesFail) {
    out.push(
      lengthFinding(
        {
          ...base,
          message:
            `Die Frage bringt ${lines} zusätzliche Fließtextzeilen mit. Das ist ein Bericht mit ` +
            'Fragezeichen. (Aufzählungszeilen zählen nicht mit — die sind lesbare Struktur.)',
          measured: lines,
          threshold: THRESHOLDS.K1.embeddedLinesFail,
        },
        raw,
      ),
    );
  }

  if (CODE_FENCE_PATTERN.test(raw)) {
    out.push(
      lengthFinding(
        {
          ...base,
          message:
            'Die Frage enthält einen Codeblock. Der Operator soll entscheiden, nicht Quelltext lesen.',
          measured: 'Codeblock',
          threshold: 'kein Codeblock',
        },
        raw,
      ),
    );
  }

  if (TABLE_ROW_PATTERN.test(normalizeLiteralNewlines(raw))) {
    out.push(
      lengthFinding(
        {
          ...base,
          message:
            'Die Frage enthält eine Tabellenzeile. Eine Tabelle ist Material zum Nachschlagen, ' +
            'keine Frage.',
          measured: 'Tabellenzeile',
          threshold: 'keine Tabelle',
        },
        raw,
      ),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// K2 — Satzlänge (Frage, Gewicht 0, nur Hinweis)
// ---------------------------------------------------------------------------

/**
 * Nebensignal, absichtlich zahnlos.
 *
 * Der längste Satz im ganzen Korpus hat 27 Wörter: jede Schwelle feuert auf
 * 1–3 von 33 Fragen (Zensus siehe Kopf) und verfehlt die schlechteste Frage
 * vollständig. Als
 * Kriterium wäre das ein Zufallsgenerator, als Hinweis ist es brauchbar —
 * deshalb Gewicht 0 und `severity: 'warn'` in der Registry, was `cappedSeverity`
 * hier erzwingt. Sichtbar, nicht wirksam.
 *
 * @param {import('./schema.mjs').AuqQuestion} q
 * @param {{file: string, line: number}} at
 * @returns {import('./schema.mjs').AuqFinding[]}
 */
function checkK2(q, at) {
  const sentences = sentencesOf(q.question);
  if (sentences.length === 0) return [];
  let longest = '';
  let longestWords = 0;
  for (const sentence of sentences) {
    const count = wordsOf(sentence).length;
    if (count > longestWords) {
      longestWords = count;
      longest = sentence;
    }
  }
  if (longestWords <= THRESHOLDS.K2.sentenceWordsWarn) return [];
  return [
    finding({
      criterion: 'K2',
      severity: 'warn',
      target: 'question',
      ...at,
      message:
        `Der längste Satz der Frage hat ${longestWords} Wörter. Ab ` +
        `${THRESHOLDS.K2.sentenceWordsWarn} muss der Operator zweimal lesen — ein Hinweis, ` +
        'kein Fehler.',
      measured: longestWords,
      threshold: THRESHOLDS.K2.sentenceWordsWarn,
      excerpt: longest,
    }),
  ];
}

// ---------------------------------------------------------------------------
// K3 — Beschreibung wiederholt Label (Option)
// ---------------------------------------------------------------------------

/**
 * KONJUNKTION, nicht Disjunktion — das ist der ganze Inhalt dieses Kriteriums.
 *
 * Containment allein hat 100 % Falsch-Positive: fünf von 120 Paaren (Zensus siehe
 * Kopf) erreichen
 * containment 1.00, und alle fünf sind Einwort-Labels (`new`, `full`, `feature`,
 * `onboarding`), deren Beschreibung reichlich Substanz trägt. Erst
 * "sagt wenig Neues" UND "wiederholt das halbe Label" trifft den echten Fall.
 *
 * @param {import('./schema.mjs').AuqOption} option
 * @param {{file: string, line: number}} at
 * @returns {import('./schema.mjs').AuqFinding[]}
 */
function checkK3(option, at) {
  const label = str(option.label);
  const description = str(option.description);
  if (description.trim() === '') return [];
  if (isPlaceholderOnly(label) || isPlaceholderOnly(description)) return [];

  const labelTokens = contentTokens(label);
  if (labelTokens.size === 0) return [];
  const descriptionTokens = contentTokens(description);

  let repeated = 0;
  for (const token of labelTokens) if (descriptionTokens.has(token)) repeated += 1;
  const containment = repeated / labelTokens.size;

  let novelty = 0;
  for (const token of descriptionTokens) if (!labelTokens.has(token)) novelty += 1;

  if (novelty >= THRESHOLDS.K3.noveltyFailBelow) return [];
  if (containment < THRESHOLDS.K3.containmentFailAtOrAbove) return [];

  const percent = Math.round(containment * MAX_POINTS);
  return [
    finding({
      criterion: 'K3',
      severity: 'fail',
      target: 'option',
      optionIndex: option.index,
      ...at,
      message:
        `Die Beschreibung sagt kaum etwas Neues: ${novelty} neue Wörter, und sie wiederholt ` +
        `${percent} % des Labels. Der Operator erfährt hier nichts, was auf dem Knopf nicht ` +
        'schon steht.',
      measured: `novelty=${novelty} containment=${containment.toFixed(2)}`,
      threshold: `novelty<${THRESHOLDS.K3.noveltyFailBelow} und containment>=${THRESHOLDS.K3.containmentFailAtOrAbove}`,
      excerpt: `${label} → ${description}`,
    }),
  ];
}

// ---------------------------------------------------------------------------
// K4 — Empfehlung ohne Grund (Option)
// ---------------------------------------------------------------------------

/**
 * ALLE VIER Markerklassen, und zwar zwingend.
 *
 * Gemessen (Zensus siehe Kopf): mit drei Klassen sind 16 von 29
 * `(Recommended)`-Optionen markiert,
 * 7 davon falsch (44 % FP) — darunter "Fastest for file-disjoint tasks." und
 * "most precise decomposition", die beide sehr wohl einen Grund nennen, nämlich
 * einen Vergleich. Mit der vierten Klasse: 9 von 29, 1 davon falsch (14 %).
 *
 * @param {import('./schema.mjs').AuqOption} option
 * @param {{file: string, line: number}} at
 * @returns {import('./schema.mjs').AuqFinding[]}
 */
function checkK4(option, at) {
  if (option.isRecommended !== true) return [];
  const description = str(option.description);
  if (isPlaceholderOnly(description)) return [];

  const matched = MARKER_CLASS_IDS.filter((id) => MARKER_CLASSES[id].pattern.test(description));
  if (matched.length >= THRESHOLDS.K4.markersRequired) return [];

  const classNames = MARKER_CLASS_IDS.map((id) => MARKER_CLASSES[id].title).join(', ');
  return [
    finding({
      criterion: 'K4',
      severity: 'fail',
      target: 'option',
      optionIndex: option.index,
      ...at,
      message:
        'Diese Option ist als Empfehlung markiert, nennt aber keinen Grund, keinen Preis, keine ' +
        'Folge und keinen Vergleich. Eine Empfehlung ohne all das ist eine Behauptung, die der ' +
        'Operator nur glauben oder ignorieren kann.',
      measured: 0,
      threshold: `mindestens ${THRESHOLDS.K4.markersRequired} von: ${classNames}`,
      excerpt: `${str(option.label)} → ${description}`,
    }),
  ];
}

// ---------------------------------------------------------------------------
// K5 — Header-Grenze (Hürde H1)
// ---------------------------------------------------------------------------

/**
 * CODEPOINTS, nicht Bytes.
 *
 * `Buffer.byteLength('Evolve — Rev')` ist 14, die Kopfzeile hat aber 12 Zeichen:
 * bytebasiert gemessen reißt sie eine Grenze, die sie nicht reißt, und der
 * Bericht meldet eine Kopfzeile als abgeschnitten, die vollständig ankommt.
 *
 * @param {import('./schema.mjs').AuqQuestion} q
 * @param {{file: string, line: number}} at
 * @returns {{findings: import('./schema.mjs').AuqFinding[], hurdles: string[]}}
 */
function checkK5(q, at) {
  const header = q.header;
  if (typeof header !== 'string' || header.trim() === '') return { findings: [], hurdles: [] };

  const literal = codepointLength(header);

  if (HEADER_PLACEHOLDER_PATTERN.test(header)) {
    const worst = literal + THRESHOLDS.K5.placeholderPad;
    if (worst <= THRESHOLDS.K5.headerCharsFail) return { findings: [], hurdles: [] };
    return {
      findings: [
        finding({
          criterion: 'K5',
          severity: 'warn',
          target: 'header',
          ...at,
          message:
            `Die Kopfzeile enthält einen Platzhalter. Eingesetzt wird sie im ungünstigsten Fall ` +
            `${worst} Zeichen lang und damit über ${THRESHOLDS.K5.headerCharsFail} abgeschnitten — ` +
            'geprüft werden kann das erst zur Laufzeit.',
          measured: worst,
          threshold: THRESHOLDS.K5.headerCharsFail,
          excerpt: header,
        }),
      ],
      hurdles: [],
    };
  }

  if (literal <= THRESHOLDS.K5.headerCharsFail) return { findings: [], hurdles: [] };

  return {
    findings: [
      finding({
        criterion: 'K5',
        severity: 'fail',
        target: 'header',
        ...at,
        message:
          `Die Kopfzeile "${header}" hat ${literal} Zeichen. Das Tool zeigt nur ` +
          `${THRESHOLDS.K5.headerCharsFail} — den Rest sieht der Operator nie.`,
        measured: literal,
        threshold: THRESHOLDS.K5.headerCharsFail,
        hurdle: HURDLES.H1.id,
        excerpt: header,
      }),
    ],
    hurdles: [HURDLES.H1.id],
  };
}

// ---------------------------------------------------------------------------
// K6 — Längenbudget (Optionen, Nutzlast, Optionsanzahl = Hürde H2)
// ---------------------------------------------------------------------------

/**
 * Optionen zählen PRO FRAGE, nie pro Block.
 *
 * Blockweise gezählt meldet `skills/plan/SKILL.md:137` 14 Optionen und damit
 * einen H2-Bruch — es ist aber ein völlig legaler Vierfragen-Block mit je 3–4
 * Optionen. Ein Bewerter, der hier blockweise zählt, meldet den saubersten
 * mehrteiligen Dialog im Repo als schwersten Verstoß.
 *
 * @param {import('./schema.mjs').AuqQuestion} q
 * @param {{file: string, line: number}} at
 * @returns {{findings: import('./schema.mjs').AuqFinding[], hurdles: string[]}}
 */
function checkK6(q, at) {
  const options = Array.isArray(q.options) ? q.options : [];
  const findings = [];
  const hurdles = new Set();

  for (const option of options) {
    const label = str(option.label);
    const description = str(option.description);
    const base = { target: /** @type {'option'} */ ('option'), optionIndex: option.index, ...at };

    const descriptionChars = codepointLength(description);
    if (descriptionChars > THRESHOLDS.K6.descriptionCharsFail) {
      findings.push(
        lengthFinding(
          {
            ...base,
            criterion: 'K6',
            severity: 'fail',
            message:
              `Die Beschreibung hat ${descriptionChars} Zeichen. Ab ` +
              `${THRESHOLDS.K6.descriptionCharsFail} liest der Operator sie nicht mehr zu Ende — ` +
              'und entscheidet dann nach dem Label allein.' +
              lowerBoundNote(q, description),
            measured: descriptionChars,
            threshold: THRESHOLDS.K6.descriptionCharsFail,
            excerpt: description,
          },
          description,
        ),
      );
    } else if (descriptionChars > THRESHOLDS.K6.descriptionCharsWarn) {
      findings.push(
        lengthFinding(
          {
            ...base,
            criterion: 'K6',
            severity: 'warn',
            message:
              `Die Beschreibung hat ${descriptionChars} Zeichen und wird ab ` +
              `${THRESHOLDS.K6.descriptionCharsWarn} unhandlich.` +
              lowerBoundNote(q, description),
            measured: descriptionChars,
            threshold: THRESHOLDS.K6.descriptionCharsWarn,
            excerpt: description,
          },
          description,
        ),
      );
    }

    const labelChars = codepointLength(label);
    if (labelChars > THRESHOLDS.K6.labelCharsWarn) {
      findings.push(
        lengthFinding(
          {
            ...base,
            criterion: 'K6',
            severity: 'warn',
            message:
              `Das Label hat ${labelChars} Zeichen. Über ${THRESHOLDS.K6.labelCharsWarn} wird der ` +
              'Knopftext zum Fließtext.' +
              lowerBoundNote(q, label),
            measured: labelChars,
            threshold: THRESHOLDS.K6.labelCharsWarn,
            excerpt: label,
          },
          label,
        ),
      );
    }
  }

  // Nutzlast der ganzen Frage: Fragetext plus alle Labels plus alle Beschreibungen.
  const payloadParts = [str(q.question)];
  for (const option of options) payloadParts.push(str(option.label), str(option.description));
  const payloadText = payloadParts.join(' ');
  const payloadChars = payloadParts.reduce((sum, part) => sum + codepointLength(part), 0);

  if (payloadChars > THRESHOLDS.K6.questionPayloadFail) {
    findings.push(
      lengthFinding(
        {
          criterion: 'K6',
          severity: 'fail',
          target: 'question',
          ...at,
          message:
            `Die Frage bringt insgesamt ${payloadChars} Zeichen auf den Schirm (Fragetext und alle ` +
            `Optionen). Ab ${THRESHOLDS.K6.questionPayloadFail} ist das keine Entscheidung mehr, ` +
            'sondern eine Leseaufgabe.' +
            lowerBoundNote(q, payloadText),
          measured: payloadChars,
          threshold: THRESHOLDS.K6.questionPayloadFail,
          excerpt: str(q.question),
        },
        payloadText,
      ),
    );
  } else if (payloadChars > THRESHOLDS.K6.questionPayloadWarn) {
    findings.push(
      lengthFinding(
        {
          criterion: 'K6',
          severity: 'warn',
          target: 'question',
          ...at,
          message:
            `Die Frage bringt insgesamt ${payloadChars} Zeichen auf den Schirm. Ab ` +
            `${THRESHOLDS.K6.questionPayloadWarn} wird die Auswahl mühsam.` +
            lowerBoundNote(q, payloadText),
          measured: payloadChars,
          threshold: THRESHOLDS.K6.questionPayloadWarn,
          excerpt: str(q.question),
        },
        payloadText,
      ),
    );
  }

  // --- Hürde H2, Teil 1: Optionsanzahl JE FRAGE ---------------------------
  // NICHT PRÜFBAR ist nicht dasselbe wie VERSTOSSEN. parse.mjs hängt
  // `optionCountUnknown: true` an eine Frage, deren Vorlage ein Ellipsen-
  // Fragment enthält ("…up to 4 options per batch…") — die wahre Optionszahl
  // steht dort schlicht nicht. Drei Fragen im Korpus sind betroffen
  // (skills/reconcile/SKILL.md:246, skills/evolve/SKILL.md:251,
  // agents/memory-proposal-collector.md:139). Ein FAIL wäre dort drei erfundene
  // Verstöße — und Falsch-Positive sind für diesen Prüfer teurer als
  // Falsch-Negative. Also ein Hinweis, der die Lücke benennt, und keine Hürde.
  //
  // Das Feld ist ADDITIV: es steht nicht im eingefrorenen `AuqQuestion`-Vertrag,
  // `makeQuestion` kennt es nicht. Deshalb wird strikt auf `=== true` geprüft
  // statt auf Wahrheitswert — fehlt das Feld, ist `undefined` kein "unbekannt".
  const countUnknown = q.optionCountUnknown === true;

  // `subject` ist hier bewusst der leere String: eine ZAHL hat keinen Text, der
  // vor dem Kürzen geschützt werden müsste. So kann ein Sicherheitswort in
  // irgendeiner Beschreibung die Hürde strukturell nicht aushebeln.
  const count = options.length;
  if (countUnknown) {
    findings.push(
      lengthFinding(
        {
          criterion: 'K6',
          severity: 'warn',
          target: 'question',
          ...at,
          message:
            `In der Vorlage stehen ${count} Optionen, aber sie bricht mit einer Auslassung ab — ` +
            'wie viele es zur Laufzeit wirklich werden, steht nirgends. Die Grenze von ' +
            `${THRESHOLDS.K6.optionsMin} bis ${THRESHOLDS.K6.optionsMax} Optionen ist hier nicht ` +
            'prüfbar, nicht verletzt.',
          measured: 'unbekannt',
          threshold: `${THRESHOLDS.K6.optionsMin}-${THRESHOLDS.K6.optionsMax}`,
          excerpt: str(q.question),
        },
        '',
      ),
    );
  } else if (count > THRESHOLDS.K6.optionsMax) {
    findings.push(
      lengthFinding(
        {
          criterion: 'K6',
          severity: 'fail',
          target: 'question',
          ...at,
          message:
            `Diese Frage bietet ${count} Optionen an. Mehr als ${THRESHOLDS.K6.optionsMax} kann ` +
            'niemand gegeneinander abwägen — die hinteren werden überlesen.',
          measured: count,
          threshold: THRESHOLDS.K6.optionsMax,
          hurdle: HURDLES.H2.id,
          excerpt: str(q.question),
        },
        '',
      ),
    );
    hurdles.add(HURDLES.H2.id);
  } else if (count < THRESHOLDS.K6.optionsMin) {
    findings.push(
      lengthFinding(
        {
          criterion: 'K6',
          severity: 'fail',
          target: 'question',
          ...at,
          message:
            `Diese Frage bietet ${count} Option(en) an. Unter ${THRESHOLDS.K6.optionsMin} gibt es ` +
            'nichts zu entscheiden — dann ist es eine Mitteilung, keine Frage.',
          measured: count,
          threshold: THRESHOLDS.K6.optionsMin,
          hurdle: HURDLES.H2.id,
          excerpt: str(q.question),
        },
        '',
      ),
    );
    hurdles.add(HURDLES.H2.id);
  }

  // --- Hürde H2, Teil 2: die Empfehlung gehört auf Platz 1 ----------------
  // Bewusst NICHT geprüft: "gar keine Empfehlung". Ob eine Option als empfohlen
  // erkannt wurde, hängt daran, dass der Parser den Marker im Label findet — ein
  // fehlendes `isRecommended` kann also genauso gut eine Parser-Lücke oder eine
  // bewusst empfehlungsfreie Frage sein. Daraus einen harten F-Bruch zu machen,
  // hieße die einzige Hürde mit gemessener 0-%-FP-Rate zu verwässern.
  const recommended = options.filter((o) => o && o.isRecommended === true);
  if (recommended.length > 1) {
    findings.push(
      lengthFinding(
        {
          criterion: 'K6',
          severity: 'fail',
          target: 'question',
          ...at,
          message:
            `${recommended.length} Optionen sind als Empfehlung markiert. Genau eine gehört an die ` +
            'erste Stelle — zwei Empfehlungen sind keine Empfehlung.',
          measured: recommended.length,
          threshold: 1,
          hurdle: HURDLES.H2.id,
          excerpt: str(q.question),
        },
        '',
      ),
    );
    hurdles.add(HURDLES.H2.id);
  } else if (!countUnknown && recommended.length === 1 && options.indexOf(recommended[0]) > 0) {
    const position = options.indexOf(recommended[0]) + 1;
    findings.push(
      lengthFinding(
        {
          criterion: 'K6',
          severity: 'fail',
          target: 'question',
          ...at,
          message:
            `Die Empfehlung steht an Position ${position} statt an erster Stelle. Der Operator ` +
            'liest von oben und nimmt die erste Option als die gemeinte.',
          measured: position,
          threshold: 1,
          hurdle: HURDLES.H2.id,
          excerpt: str(recommended[0].label),
        },
        '',
      ),
    );
    hurdles.add(HURDLES.H2.id);
  }

  return { findings, hurdles: [...hurdles] };
}

// ---------------------------------------------------------------------------
// K7 — Unerklärter Bezeichner (Option)
// ---------------------------------------------------------------------------

/**
 * ABSOLUTE ZAHL, keine Dichte.
 *
 * Die gemessene Bezeichner-Dichte hat Median 0 und Maximum 0,44 und trennt
 * damit nichts. Schlimmer: eine Dichteschwelle versteckt `.orchestrator/session.lock`
 * in einem langen Satz — je mehr Prosa drumherum, desto unsichtbarer der
 * Bezeichner, obwohl der Operator ihn genauso nachschlagen muss.
 *
 * Sicherheitstexte sind hiervon NICHT befreit: K7 fügt Information hinzu und
 * nimmt keine weg. Deshalb läuft dieser Befund über `finding()`, nicht über
 * `lengthFinding()` — und `finding()` würde ein Längenkriterium ablehnen.
 *
 * @param {import('./schema.mjs').AuqOption} option
 * @param {{file: string, line: number}} at
 * @returns {import('./schema.mjs').AuqFinding[]}
 */
function checkK7(option, at) {
  const description = str(option.description);
  if (isPlaceholderOnly(description)) return [];

  const unexplained = unexplainedIdentifiers(description);
  if (unexplained.length < THRESHOLDS.K7.unexplainedFailAtOrAbove) return [];

  const named = unexplained.map((t) => `"${t}"`).join(', ');
  return [
    finding({
      criterion: 'K7',
      severity: 'fail',
      target: 'option',
      optionIndex: option.index,
      ...at,
      message:
        `Diese Option nennt ${named}, ohne daneben zu sagen, was das ist. Der Operator müsste ` +
        'erst nachschlagen, um überhaupt zu wissen, worüber er entscheidet.',
      measured: unexplained.length,
      threshold: THRESHOLDS.K7.unexplainedFailAtOrAbove,
      excerpt: description,
    }),
  ];
}

// ---------------------------------------------------------------------------
// K8 — "Geh selbst nachsehen" (Option)
// ---------------------------------------------------------------------------

/**
 * Die ICH-FORM-AUSSCHLUSSREGEL ist der eigentliche Inhalt dieses Kriteriums.
 *
 * "I will inspect the worktree before re-running /close." enthält einen
 * Lese-Imperativ und einen Pfad in Reichweite — aber dort sieht der AGENT nach,
 * nicht der Operator. Ohne den Ausschluss meldet K8 genau die Option als
 * Verstoß, die dem Operator die Arbeit ABNIMMT.
 *
 * @param {string} text
 * @returns {Array<{imperative: string, target: string, sentence: string}>}
 */
function selfServeHits(text) {
  const hits = [];
  for (const sentence of sentencesOf(stripPlaceholders(text))) {
    const targets = identifierSpans(sentence).filter((s) => s.id === 'path' || s.id === 'issue-ref');
    if (targets.length === 0) continue;

    const re = globalOf(READ_IMPERATIVE_PATTERN);
    let match = re.exec(sentence);
    while (match !== null) {
      if (match[0] === '') {
        re.lastIndex += 1;
        match = re.exec(sentence);
        continue;
      }
      const before = sentence.slice(0, match.index);
      const after = match.index + match[0].length;
      if (!FIRST_PERSON_EXCLUSION_PATTERN.test(before)) {
        const target = targets.find((t) => t.start >= after);
        if (target !== undefined) {
          const gap = sentence.slice(after, target.start).replace(globalOf(PERIOD), '');
          if (codepointLength(gap) <= THRESHOLDS.K8.proximityChars) {
            hits.push({ imperative: match[0], target: target.token, sentence });
          }
        }
      }
      match = re.exec(sentence);
    }
  }
  return hits;
}

/**
 * @param {import('./schema.mjs').AuqOption} option
 * @param {{file: string, line: number}} at
 * @returns {import('./schema.mjs').AuqFinding[]}
 */
function checkK8(option, at) {
  const description = str(option.description);
  if (isPlaceholderOnly(description)) return [];

  const hits = selfServeHits(description);
  if (hits.length < THRESHOLDS.K8.failAtOrAbove) return [];

  const first = hits[0];
  return [
    finding({
      criterion: 'K8',
      severity: 'fail',
      target: 'option',
      optionIndex: option.index,
      ...at,
      message:
        `Diese Option verlangt, dass der Operator erst "${first.target}" öffnet, um entscheiden zu ` +
        'können. Was dort steht, gehört in die Option — sonst ist die Frage nicht beantwortbar, ' +
        'ohne die Arbeit zu unterbrechen.',
      measured: hits.length,
      threshold: THRESHOLDS.K8.failAtOrAbove,
      excerpt: first.sentence,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Punkte
// ---------------------------------------------------------------------------

/**
 * `points = 100 − Σ CRITERIA[k].weight` über jedes Kriterium mit mindestens
 * einem NICHT befreiten `fail`-Befund. Jedes Kriterium zieht höchstens EINMAL
 * ab — sonst bestraft dieselbe Schwäche eine Vier-Options-Frage doppelt so hart
 * wie eine Zwei-Options-Frage.
 *
 * Die zwei Filter (`severity`, `exempt`) sind bewusst UNABHÄNGIG: ein befreiter
 * Befund wird bereits in `lengthFinding()` auf `warn` herabgestuft, aber wenn
 * dort je etwas durchrutscht, hält der `exempt`-Filter hier trotzdem.
 *
 * @param {import('./schema.mjs').AuqFinding[]} findings
 * @returns {number}
 */
function pointsFor(findings) {
  const failed = new Set();
  for (const f of findings) {
    if (f.severity !== 'fail') continue;
    if (f.exempt !== null) continue;
    failed.add(f.criterion);
  }
  let deduction = 0;
  for (const criterion of failed) deduction += CRITERIA[criterion].weight;
  return Math.max(0, Math.min(MAX_POINTS, MAX_POINTS - deduction));
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

/**
 * Bewertet EINE Frage gegen alle acht Kriterien und beide Hürden.
 *
 * @param {import('./schema.mjs').AuqQuestion} question
 * @param {number} [questionIndex] 0-basierte Position der Frage in ihrem Block.
 * @returns {import('./schema.mjs').AuqScore}
 */
export function scoreQuestion(question, questionIndex = 0) {
  if (question === null || typeof question !== 'object') {
    throw new TypeError('auq/clarity: scoreQuestion braucht eine AuqQuestion');
  }
  const at = { file: question.file, line: question.line };
  const options = Array.isArray(question.options) ? question.options : [];

  /** @type {Record<string, import('./schema.mjs').AuqFinding[]>} */
  const byCriterion = {};
  for (const id of CRITERION_IDS) byCriterion[id] = [];
  const hurdles = new Set();

  byCriterion.K1.push(...checkK1(question, at));
  byCriterion.K2.push(...checkK2(question, at));

  const k5 = checkK5(question, at);
  byCriterion.K5.push(...k5.findings);
  for (const h of k5.hurdles) hurdles.add(h);

  const k6 = checkK6(question, at);
  byCriterion.K6.push(...k6.findings);
  for (const h of k6.hurdles) hurdles.add(h);

  for (const option of options) {
    if (option === null || typeof option !== 'object') continue;
    byCriterion.K3.push(...checkK3(option, at));
    byCriterion.K4.push(...checkK4(option, at));
    byCriterion.K7.push(...checkK7(option, at));
    byCriterion.K8.push(...checkK8(option, at));
  }

  // Stabile Reihenfolge nach Kriterium — ein Bericht, dessen Befunde bei jedem
  // Lauf anders sortiert sind, lässt sich nicht diffen.
  const findings = CRITERION_IDS.flatMap((id) => byCriterion[id]);

  return makeScore({
    file: question.file,
    line: question.line,
    questionIndex,
    points: pointsFor(findings),
    hurdlesBroken: [...hurdles],
    findings,
  });
}

/**
 * Bewertet alle Fragen aller Blöcke, in Fundreihenfolge.
 *
 * `questionIndex` ist die Position INNERHALB des Blocks — nicht fortlaufend über
 * alle Blöcke, weil ein `AuqScore` sonst nicht mehr auf seine Frage zeigt.
 *
 * @param {import('./schema.mjs').AuqBlock[]} blocks
 * @returns {import('./schema.mjs').AuqScore[]}
 */
export function scoreBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const scores = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    const questions = Array.isArray(block.questions) ? block.questions : [];
    questions.forEach((question, index) => {
      if (question === null || typeof question !== 'object') return;
      scores.push(scoreQuestion(question, index));
    });
  }
  return scores;
}
