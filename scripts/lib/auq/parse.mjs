/**
 * auq/parse.mjs — der tolerante Extraktor für die AUQ-Klarheitsmessung (#1107).
 *
 * Findet Operator-Frage-Vorlagen im Repo und liefert `AuqBlock`/`AuqQuestion`/
 * `AuqOption`-Datensätze aus `./schema.mjs`. **Er bewertet nichts** — jede
 * Schwelle, jedes Kriterium und jede Note gehören `clarity.mjs`.
 *
 * ## Warum zeilen- und zeichenbasiert und NICHT über einen AST
 *
 * Weil der Korpus stellenweise gar kein gültiges JavaScript ist. Drei
 * Vorlagen kürzen ihre Optionsliste mit einem Auslassungs-Fragment ab:
 *
 *     skills/reconcile/SKILL.md:253      ...up to 4 options per batch...
 *     skills/evolve/SKILL.md:258         ...
 *     agents/memory-proposal-collector.md  ...
 *
 * `acorn` oder `JSON.parse` werfen dort, und zwar auf genau den Blöcken, die
 * am dringendsten gemessen werden wollen. Ein Parser, der an drei echten
 * Fundstellen aussteigt, misst nicht das Repo, sondern seine eigene Toleranz.
 * Der Preis dafür ist bewusst: wir lesen Zeichen, kein Syntaxbaum, und jede
 * Frage, deren Optionszahl durch so ein Fragment unbekannt wird, trägt
 * `optionCountUnknown: true` (siehe unten) statt einer erfundenen Zahl.
 *
 * ## Die sechs Fallen, gegen die hier gebaut ist (alle am Korpus belegt)
 *
 * 1. **Verschachtelter Code-Zaun IM Fragetext.** `skills/discovery/SKILL.md:373`
 *    trägt zwei literale ``` mitten im `question`-String. Ein Segmentierer, der
 *    Zäune mit /```/ ohne Zeilenanfangs-Anker sucht, schließt den Block mitten
 *    in der Frage. Hier ist der Anker `^[ \t]*```` — Pflicht, nicht Stil.
 * 2. **Template-Literale.** Gemessen 2026-08-22: 9 der Fragen stehen in
 *    Backticks, und das sind ausgerechnet die fachwortdichtesten im Repo. Wer
 *    nur `question: "` sucht, verliert sie. `readStringLiteral()` liest alle
 *    drei Anführungsformen und überspringt `${…}` samt darin verschachtelter
 *    Strings und Ternaries (`skills/session-start/SKILL.md:161` hat ein `===`
 *    im `${…}` — ein Split auf Anführungszeichen zerreißt die Zeile).
 * 3. **Mehrzeilige Options-Objekte.** 20 der 138 `label:`-Zeilen (14,5 %) haben
 *    ihr `description:` NICHT auf derselben Zeile. Darum paart dieses Modul
 *    Schlüssel nach POSITION im Segment, nie zeilenweise.
 * 4. **JS-Kommentar auf der Feldzeile.** `skills/session-start/phase-2-5-docs-planning.md:60`
 *    hat `label: "Dev (Recommended)",   // add "(Recommended)" to each …` — der
 *    Kommentar trägt selbst ein Anführungspaar. `stripComments()` entfernt ihn
 *    VOR dem Lesen, und gelesen wird das ERSTE Literal nach dem Schlüssel.
 * 5. **Ellipsen-Fragmente** — siehe oben, der Grund gegen den AST.
 * 6. **Zaun-Sprache uneinheitlich.** Nur 11 der 40 Blöcke stehen in ```js
 *    (27,5 %), 29 in einem sprachlosen Zaun. Es wird deshalb nie auf die
 *    Sprache gefiltert, sondern immer auf den Inhalt.
 * 7. **`multiSelect` fehlt** in mehreren Blöcken. Optional, Vorgabe `false` —
 *    das erledigt `makeQuestion` an einer Stelle für alle.
 *
 * ## Die Umkehrfalle bei der Empfehlung
 *
 * `scripts/lib/config/dispatcher-autonomy-capture.mjs:59` setzt `(Recommended)`
 * in die **description**, während die Labels nackte Enum-Werte sind (`off` /
 * `advisory` / `autonomous-gated`). Ein Ausdruck, der `label:.*\(Recommended\)`
 * sucht, übersieht die Frage vollständig. `isRecommended` wird darum aus BEIDEN
 * Feldern abgeleitet, und der Fall wird zusätzlich als Warnung durchgereicht
 * (`recommended-in-description`), damit „Empfehlung vorhanden, aber am falschen
 * Feld" sichtbar bleibt statt still zu verschwinden.
 *
 * ## Eine bekannte Untergrenze, die dieses Modul NICHT beheben kann
 *
 * Die 9 Backtick-Fragen enthalten `${…}`-Interpolationen. Die gerenderte Frage
 * ist LÄNGER als ihr Quelltext — `${blockingSession.worktreePath}` (28 Zeichen
 * Quelltext) expandiert zu einem absoluten Pfad von leicht 60+ Zeichen. Jede
 * Längenmessung auf dem hier gelieferten Text ist für genau diese Fragen also
 * ZU LAX; ein Befund ist echt, ein Nicht-Befund beweist nichts.
 *
 * @see ./schema.mjs — der eingefrorene Vertrag (Feldnamen, Aufzählungen, Fabriken)
 * @see .claude/rules/ask-via-tool.md — die Regel, die gemessen wird
 * @see Issue #1107
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  makeBlock,
  makeOption,
  makeQuestion,
  emptyCorpus,
  RECOMMENDED_MARKERS,
  isRecommendedOption,
} from './schema.mjs';
import { scanFenceBlocks } from '../validate/markdown-fences.mjs';

// ---------------------------------------------------------------------------
// Korpus-Abgrenzung
// ---------------------------------------------------------------------------

/**
 * Verzeichnisse, in denen Population A/B leben. `.md` ausserhalb davon
 * (README, CHANGELOG, docs/) beschreibt das Werkzeug, statt den Operator zu
 * fragen — es sind keine Vorlagen, die je gestellt werden.
 */
export const MD_CORPUS_PREFIXES = Object.freeze([
  'skills/',
  'commands/',
  'agents/',
  '.claude/rules/',
]);

/** Population C-mdc: die getrackten Cursor-Regeln. */
export const MDC_CORPUS_PREFIX = '.cursor/rules/';

/**
 * Population C-mjs: echtes Produktions-JavaScript. `tests/` ist ausgenommen —
 * eine Frage in einer Fixture wird niemandem gestellt.
 */
export const MJS_CORPUS_PREFIXES = Object.freeze(['scripts/', 'hooks/', 'skills/']);

/**
 * Gehört diese Datei in den Korpus?
 *
 * @param {string} file repo-relativer Pfad (POSIX-Trenner)
 * @returns {'md'|'mdc'|'mjs'|null} die Lesart, oder `null` = nicht im Korpus
 */
export function corpusKindOf(file) {
  if (typeof file !== 'string' || file === '') return null;
  const f = file.replace(/\\/gu, '/');
  if (f.endsWith('.mdc')) return f.startsWith(MDC_CORPUS_PREFIX) ? 'mdc' : null;
  if (f.endsWith('.md')) {
    return MD_CORPUS_PREFIXES.some((p) => f.startsWith(p)) ? 'md' : null;
  }
  if (f.endsWith('.mjs')) {
    if (f.startsWith('tests/')) return null;
    return MJS_CORPUS_PREFIXES.some((p) => f.startsWith(p)) ? 'mjs' : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Zeichen-Primitive: Kommentare, String-Literale, Schlüssel
// ---------------------------------------------------------------------------

/**
 * Ersetzt JS-Kommentare durch Leerzeichen — LÄNGENERHALTEND, damit jeder
 * Zeichen-Offset weiterhin auf dieselbe Zeile zeigt. Zeilenumbrüche bleiben.
 *
 * Nur so ist Falle 4 sauber lösbar: der Kommentar
 * `// add "(Recommended)" to each detected audience` trägt selbst ein
 * Anführungspaar, das jeder „nimm das letzte Literal der Zeile"-Ansatz als
 * Label extrahiert.
 *
 * @param {string} text
 * @returns {string} gleiche Länge, Kommentarinhalt durch Leerzeichen ersetzt
 */
export function stripComments(text) {
  if (typeof text !== 'string' || text === '') return '';
  const out = [...text];
  let i = 0;
  while (i < out.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const lit = readStringLiteral(text, i);
      i = lit ? lit.end : i + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < out.length && text[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < out.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < out.length) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Liest ein String-Literal ab `pos`. Beherrscht `"`, `'` und Backtick.
 *
 * In einem Backtick-Literal wird `${…}` mitsamt verschachtelter Klammern UND
 * verschachtelter Strings übersprungen und WÖRTLICH in den Wert übernommen —
 * der Quelltext ist das, was gemessen wird, und `skills/session-start/SKILL.md:161`
 * trägt ein Ternary mit `===` und einfachen Anführungszeichen in seiner
 * Interpolation.
 *
 * `"` und `'` bilden BEIDE auf `quoting: 'double'` ab: die Aufzählung
 * `QUOTINGS` kennt nur `double|backtick|prose`, und für die Auszugsform ist ein
 * einfach-zitiertes Literal (die Form in den `.mjs`-Dateien) mit einem
 * doppelt-zitierten identisch. Nur das Template-Literal verhält sich anders,
 * und genau das trennt `backtick` ab.
 *
 * @param {string} text
 * @param {number} pos Index des öffnenden Anführungszeichens
 * @returns {{value: string, quoting: 'double'|'backtick', end: number}|null}
 */
export function readStringLiteral(text, pos) {
  const q = text[pos];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  let i = pos + 1;
  let out = '';
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      const next = text[i + 1] ?? '';
      // Nur die Anführungs- und Backslash-Escapes auflösen. `\n` bleibt STEHEN,
      // weil schema.NEWLINE_PATTERN genau diese literale Form erkennt.
      out += '"\'`\\'.includes(next) ? next : c + next;
      i += 2;
      continue;
    }
    if (q === '`' && c === '$' && text[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      out += '${';
      while (j < text.length && depth > 0) {
        const d = text[j];
        if (d === '"' || d === "'" || d === '`') {
          const inner = readStringLiteral(text, j);
          if (inner) {
            out += text.slice(j, inner.end);
            j = inner.end;
            continue;
          }
        }
        if (d === '{') depth++;
        else if (d === '}') depth--;
        out += d;
        j++;
      }
      i = j;
      continue;
    }
    if (c === q) return { value: out, quoting: q === '`' ? 'backtick' : 'double', end: i + 1 };
    // Ein unbeendetes einzeiliges Literal ist ein abgeschnittenes Fragment,
    // kein Wert — lieber nichts liefern als den halben Rest des Blocks.
    if (q !== '`' && c === '\n') return null;
    out += c;
    i++;
  }
  return null;
}

/** Schlüssel, die in einer AUQ-Struktur überhaupt vorkommen. */
const KEY_PATTERN = /^[A-Za-z_$][\w$]*$/u;

/**
 * Sammelt alle Objektschlüssel (`name:`) in Reihenfolge und ÜBERSPRINGT dabei
 * String-Literale. Genau das trennt einen echten Schlüssel von einem Wort in
 * einem Fragetext (`"Answer the question: …"`) oder in einem Kommentar.
 *
 * @param {string} text kommentarfrei (siehe `stripComments`)
 * @returns {Array<{key: string, at: number, valueAt: number}>}
 */
export function scanKeys(text) {
  const keys = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const lit = readStringLiteral(text, i);
      i = lit ? lit.end : i + 1;
      continue;
    }
    if (/[A-Za-z_$]/u.test(c)) {
      let j = i;
      while (j < text.length && /[\w$]/u.test(text[j])) j++;
      const word = text.slice(i, j);
      let k = j;
      while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
      if (text[k] === ':' && KEY_PATTERN.test(word)) {
        let v = k + 1;
        while (v < text.length && /\s/u.test(text[v])) v++;
        keys.push({ key: word, at: i, valueAt: v });
      }
      i = j;
      continue;
    }
    i++;
  }
  return keys;
}

/**
 * Der String-Wert eines Schlüssels — oder `null`, wenn der Wert kein Literal
 * ist. `scripts/lib/config/dispatcher-autonomy-capture.mjs` legt den Wert auf
 * die NÄCHSTE Zeile; `valueAt` hat den Zeilenumbruch bereits übersprungen.
 *
 * @param {string} text
 * @param {{valueAt: number}} key
 * @returns {{value: string, quoting: 'double'|'backtick'}|null}
 */
function stringValueOf(text, key) {
  const lit = readStringLiteral(text, key.valueAt);
  return lit ? { value: lit.value, quoting: lit.quoting } : null;
}

/** `true`/`false` hinter einem Schlüssel; `null` wenn keins von beiden. */
function boolValueOf(text, key) {
  if (text.startsWith('true', key.valueAt)) return true;
  if (text.startsWith('false', key.valueAt)) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Zeilen-Werkzeug
// ---------------------------------------------------------------------------

/** Offsets der Zeilenanfänge — für Offset → 1-basierte Zeilennummer. */
function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** @param {number[]} starts @param {number} offset @returns {number} 1-basiert */
function lineOfOffset(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Zerlegt eine Markdown-Datei in Code-Zaun-Blöcke. **Zeilenanfangs- UND
 * -ende-verankert** (`{ wholeLine: true }`, gemeinsamer Zaun-Tracker
 * `../validate/markdown-fences.mjs`, #1181) — ohne den Anker schließt
 * `skills/discovery/SKILL.md:373` seinen eigenen Block mitten im Fragetext
 * (Falle 1).
 *
 * @param {string} content
 * @returns {Array<{openLine: number, closeLine: number, lang: string, bodyLines: string[], bodyStartLine: number}>}
 */
export function fencesOf(content) {
  return scanFenceBlocks(content, { wholeLine: true });
}

// ---------------------------------------------------------------------------
// Population A — der Tool-Aufruf
// ---------------------------------------------------------------------------

/** Der Aufruf selbst. Bewusst ohne Sprachfilter (Falle 6). */
export const AUQ_CALL_PATTERN = /AskUserQuestion\s*\(\s*\{/u;

/**
 * Eine Zeile, die nur aus einem Auslassungs-Fragment besteht (Falle 5).
 * `...up to 4 options per batch...` ebenso wie ein nacktes `...`.
 */
export const ELLIPSIS_LINE_PATTERN = /^[ \t]*(?:\.{3}|…)/u;

/**
 * Liest einen Population-A-Körper (JS-artig, aber nicht zwingend gültig).
 *
 * @param {string[]} bodyLines
 * @param {number} bodyStartLine 1-basierte Zeile der ersten Körperzeile
 * @returns {{questions: Array<object>, ellipsisLines: number[]}}
 */
function parseAuqBody(bodyLines, bodyStartLine) {
  const ellipsisLines = [];
  const kept = bodyLines.map((line, idx) => {
    if (ELLIPSIS_LINE_PATTERN.test(line) && !/[:{}[\]]/u.test(line.replace(/\.{3}|…/gu, ''))) {
      ellipsisLines.push(bodyStartLine + idx);
      return '';
    }
    return line;
  });

  const text = stripComments(kept.join('\n'));
  const starts = lineStartsOf(text);
  const keys = scanKeys(text);

  // Fragen-Segmente: jedes `question:` beginnt eines, das nächste beendet es.
  const questionIdx = keys.map((k, i) => (k.key === 'question' ? i : -1)).filter((i) => i >= 0);
  const out = [];

  for (let n = 0; n < questionIdx.length; n++) {
    const startKeyIdx = questionIdx[n];
    const endKeyIdx = n + 1 < questionIdx.length ? questionIdx[n + 1] : keys.length;
    const segment = keys.slice(startKeyIdx, endKeyIdx);
    const qKey = segment[0];
    const qVal = stringValueOf(text, qKey);
    if (!qVal) continue; // kein Literal → keine Vorlage (z. B. `question: m[2].trim()`)

    const headerKey = segment.find((k) => k.key === 'header');
    const header = headerKey ? stringValueOf(text, headerKey) : null;
    const msKey = segment.find((k) => k.key === 'multiSelect');
    const multiSelect = msKey ? boolValueOf(text, msKey) : null;

    const options = [];
    const labelPositions = segment
      .map((k, i) => (k.key === 'label' ? i : -1))
      .filter((i) => i >= 0);
    labelPositions.forEach((li, oi) => {
      const nextLi = oi + 1 < labelPositions.length ? labelPositions[oi + 1] : segment.length;
      const scope = segment.slice(li, nextLi);
      const label = stringValueOf(text, scope[0]);
      if (!label) return;
      const descKey = scope.find((k) => k.key === 'description');
      const prevKey = scope.find((k) => k.key === 'preview');
      const desc = descKey ? stringValueOf(text, descKey) : null;
      const prev = prevKey ? stringValueOf(text, prevKey) : null;
      options.push({
        label: label.value,
        description: desc ? desc.value : '',
        preview: prev ? prev.value : null,
        index: options.length,
      });
    });

    // Auslassungs-Fragmente INNERHALB dieses Segments machen die Optionszahl
    // unbekannt — H2 darf daraus keinen Verstoß bauen.
    const segStart = qKey.at;
    const segEnd = endKeyIdx < keys.length ? keys[endKeyIdx].at : text.length;
    const segFirstLine = lineOfOffset(starts, segStart) + bodyStartLine - 1;
    const segLastLine = lineOfOffset(starts, Math.max(segStart, segEnd - 1)) + bodyStartLine - 1;
    const optionCountUnknown = ellipsisLines.some((l) => l >= segFirstLine && l <= segLastLine);

    out.push({
      question: qVal.value,
      quoting: qVal.quoting,
      header: header ? header.value : null,
      multiSelect: multiSelect === true,
      options,
      line: segFirstLine,
      optionCountUnknown,
    });
  }

  return { questions: out, ellipsisLines };
}

// ---------------------------------------------------------------------------
// Population B / C-mdc / C-hybrid — die nummerierte Auswahlliste
// ---------------------------------------------------------------------------

/** Ein nummerierter Listenpunkt. */
export const NUMBERED_ITEM_PATTERN = /^[ \t]*(\d+)\.[ \t]+(\S.*)$/u;

/**
 * Der Anfang eines Fallback-Blocks — VIER Schreibweisen, alle im Korpus belegt.
 * Ein starrer H3-Matcher findet 2 von 11.
 */
export const FALLBACK_LEADIN_PATTERN =
  /numbered[ -]markdown[ -]list|numbered[ -]list|ask via numbered|present (?:all )?choices|reply with the number|askuserquestion/iu;

/**
 * Ein Hinweis INNERHALB des Zauns, dass hier gewählt wird: eine Zeile, die auf
 * `?` endet, oder eine Aufforderungszeile.
 *
 * Nötig, weil der Anfang zuverlässig ist, das ENDE aber nicht: drei Terminatoren
 * sind im Umlauf (`Reply with the number of your choice.`, eine multiSelect-
 * Variante, und GAR KEINER in `skills/session-end/phase-3-2-docs-verification.md`).
 * Das Ende wird deshalb am schließenden Zaun festgemacht, nie am Text.
 */
/**
 * Die Anlaufzeile kündigt einen ANDEREN Harness an — dann ist der Zaun der
 * Codex-/Cursor-Fallback (Population B), egal ob `AskUserQuestion` darin
 * vorkommt.
 */
export const FALLBACK_HARNESS_PATTERN = /\bfallback\b|\bCodex\b|\bCursor\b|\bPi\b/iu;

export const CHOICE_CUE_PATTERN = /^[ \t]*(?:Options|Choose one|Auswahl|Optionen)[ \t]*:?[ \t]*$/u;

/** Markdown-Auszeichnung im LABEL-Teil entfernen. */
function stripEmphasis(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/\*([^*\n]+)\*/gu, '$1')
    .replace(/^_([^_\n]+)_$/u, '$1')
    .trim();
}

/**
 * Zerlegt einen nummerierten Listenpunkt in Label und Beschreibung.
 *
 * Die Zeilenform variiert dreifach — schlicht (`1. Warten (Recommended) — wait…`),
 * fett (`1. **Behalten (Recommended)** — Keep…`) und mit der Empfehlung
 * AUSSERHALB der Fettung (`1. **Warn + carryover and close** *(Recommended)*`).
 * `(Recommended)` darf deshalb nicht als Teil des Labels vorausgesetzt werden.
 *
 * Auszeichnung wird NUR im Label-Teil entfernt: die Beschreibung trägt echte
 * Sternchen als Glob (`docs/dev/**, docs/adr/**`), die ein globales Strippen
 * zerstören würde.
 *
 * @param {string} itemText Text nach `N. `
 * @returns {{label: string, description: string}}
 */
export function splitNumberedItem(itemText) {
  const m = /\s(?:—|–|--)\s/u.exec(itemText);
  if (!m) return { label: stripEmphasis(itemText), description: '' };
  return {
    label: stripEmphasis(itemText.slice(0, m.index)),
    description: itemText.slice(m.index + m[0].length).trim(),
  };
}

/**
 * Findet in einem Zaun-Körper die nummerierten Auswahl-LÄUFE.
 *
 * Ein Lauf endet an einer Nicht-Listenzeile oder wenn die Nummerierung wieder
 * bei 1 beginnt — `.cursor/rules/040-discovery.mdc:184-192` trägt beide Fälle
 * in EINEM Zaun (erst eine Befundliste, dann die eigentliche Auswahl).
 *
 * @param {string[]} bodyLines
 * @returns {Array<{items: Array<{n: number, text: string, idx: number}>, startIdx: number}>}
 */
function numberedRunsOf(bodyLines) {
  const runs = [];
  let cur = null;
  bodyLines.forEach((line, idx) => {
    const m = NUMBERED_ITEM_PATTERN.exec(line);
    if (!m) {
      if (line.trim() !== '') cur = null;
      return;
    }
    const n = Number(m[1]);
    if (cur === null || n === 1 || n !== cur.items[cur.items.length - 1].n + 1) {
      cur = { items: [], startIdx: idx };
      runs.push(cur);
    }
    cur.items.push({ n, text: m[2].trim(), idx });
  });
  return runs.filter((r) => r.items.length >= 2);
}

/**
 * Der Fragetext zu einem Lauf: der letzte zusammenhängende Absatz oberhalb,
 * unter Überspringen einer reinen Aufforderungszeile (`Options:`). Findet sich
 * keiner im Zaun, dient die Anlaufzeile über dem Zaun als Frage.
 */
function questionTextForRun(bodyLines, run, leadIn) {
  let i = run.startIdx - 1;
  const skippable = (l) => l.trim() === '' || CHOICE_CUE_PATTERN.test(l) || NUMBERED_ITEM_PATTERN.test(l);
  // Leerzeilen, Aufforderungszeilen UND einen davorliegenden nummerierten Lauf
  // überspringen: `.cursor/rules/040-discovery.mdc:184` legt erst eine
  // Befundliste und dann `Options:` zwischen die Frage und die Auswahl. Ohne
  // dieses Überspringen bleibt der Fragetext leer.
  while (i >= 0 && skippable(bodyLines[i])) i--;
  const para = [];
  while (i >= 0 && bodyLines[i].trim() !== '' && !NUMBERED_ITEM_PATTERN.test(bodyLines[i])) {
    para.unshift(bodyLines[i].trim());
    i--;
  }
  const text = para.join(' ').trim();
  if (text !== '') return text;
  return leadIn.replace(/^[-*>\s]+/u, '').replace(/\*\*/gu, '').trim();
}

/**
 * Trägt dieser Zaun (oder seine Anlaufzeilen) einen Auswahl-Hinweis?
 *
 * Vier unabhängige Hinweise, weil KEINER allein reicht:
 *   (a) eine Aufforderungszeile (`Options:` / `Choose one:`)
 *   (b) eine Frage im Zaun (Zeile endet auf `?`)
 *   (c) ein Terminator (`Reply with the number …`)
 *   (d) ein kanonischer `(Recommended)`-Marker in einem Listenpunkt
 *   (e) eine Anlaufzeile, die den Fallback ankündigt
 *
 * (d) trägt allein zwei Fundstellen, die sonst durchfallen —
 * `.cursor/rules/050-plan.mdc:164` (Anlaufzeile „ask for final approval",
 * keine Frage im Zaun) und `.cursor/rules/040-discovery.mdc:196` (die Frage
 * endet auf `)` statt auf `?`).
 *
 * Der Gegentest ist ebenso wichtig: `.cursor/rules/050-plan.mdc:81`
 * („## Answers So Far") ist eine nummerierte ZUSAMMENFASSUNG, keine Auswahl —
 * sie erfüllt keinen der fünf Hinweise und fällt korrekt heraus.
 */
function hasChoiceCue(bodyLines, leadInLines, runs) {
  if (bodyLines.some((l) => CHOICE_CUE_PATTERN.test(l))) return true;
  if (bodyLines.some((l) => /\?[ \t]*$/u.test(l) && !NUMBERED_ITEM_PATTERN.test(l))) return true;
  if (bodyLines.some((l) => /reply with the number/iu.test(l))) return true;
  if (runs.some((r) => r.items.some((it) => hasRecommendedMarker(it.text)))) return true;
  return leadInLines.some((l) => FALLBACK_LEADIN_PATTERN.test(l));
}

// ---------------------------------------------------------------------------
// Vorlage vs. Illustration
// ---------------------------------------------------------------------------

/** Eine „so sieht das Format aus"-Vorzeile. */
export const EXAMPLE_LEADIN_PATTERN = /^[ \t>*_-]*(?:Example|Beispiel|Schema|Format)[ \t]*:?[ \t*_]*$/iu;

/** Reine Platzhalter-Labels: `X`, `Y`, `Option A`, `<foo>`, `[bar]`, `…`. */
const PLACEHOLDER_LABEL_PATTERN = /^(?:option\s+[a-z]|[a-z]|…|\.{3})$/iu;

/**
 * Ist dieser Block eine Format-Erläuterung statt einer echten Vorlage?
 *
 * Zwei mechanische Merkmale, beide mehrfach im Korpus belegt — KEINE Pfadliste:
 *
 * - `example-leadin`: eine Zeile `Example:` / `Beispiel:` unmittelbar über dem
 *   Zaun (trifft `skills/session-start/presentation-format.md` und
 *   `.cursor/rules/050-plan.mdc`).
 * - `placeholder-only`: Frage und/oder ALLE Labels bestehen nach Abzug von
 *   `<…>`, `[…]` und `…` nur noch aus Platzhaltern (trifft
 *   `.claude/rules/ask-via-tool.md`, `skills/_shared/platform-tools.md`,
 *   `.cursor/rules/000-session-orchestrator.mdc`).
 *
 * **Bekannte Lücke, bewusst offen:** `skills/grill/SKILL.md:66` ist eine
 * Illustration, weil ihre Domäne (Orders, line-item, partial-refund) im Repo
 * nicht existiert — gemessen 2026-08-22: `line-item` und `partial-refund`
 * kommen in 0 Dateien ausserhalb `skills/grill/` vor. Ein solcher
 * Begriffs-Erdungstest bräuchte einen repo-weiten Term-Index, träfe genau
 * EINE bekannte Stelle und würde jede Vorlage mit eigenem Fachbegriff
 * („Telemetrie", „worktree") falsch verdächtigen. Der Preis übersteigt den
 * Ertrag; die Stelle wird als `template` geführt und hier benannt.
 *
 * @returns {'template'|'illustration'}
 */
function classifyKind({ leadInLines, questionText, optionLabels }) {
  if (leadInLines.some((l) => EXAMPLE_LEADIN_PATTERN.test(l))) return 'illustration';

  // Leerraum wird VERDICHTET, nicht entfernt: `"Option A"` ohne Leerzeichen
  // wäre `OptionA` und fiele durch das Platzhaltermuster.
  const bare = (s) =>
    String(s)
      .replace(/<[^<>]{0,60}>/gu, ' ')
      .replace(/\[[^[\]]{0,60}\]/gu, ' ')
      .replace(/[…?.:!*_`"']/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();

  if (bare(questionText) === '') return 'illustration';
  if (optionLabels.length > 0 && optionLabels.every((l) => PLACEHOLDER_LABEL_PATTERN.test(bare(l)))) {
    return 'illustration';
  }
  return 'template';
}

// ---------------------------------------------------------------------------
// Empfehlung
// ---------------------------------------------------------------------------

/** Trägt der Text einen kanonischen Empfehlungs-Marker? */
function hasRecommendedMarker(text) {
  return RECOMMENDED_MARKERS.some((m) => String(text).includes(m));
}

/** `(Recommended for pros)` u. Ä. — Empfehlung gemeint, Marker nicht kanonisch. */
const NEAR_RECOMMENDED_PATTERN = /\((?:Recommended|Empfohlen)[^)]*\)/iu;

// ---------------------------------------------------------------------------
// parseFile
// ---------------------------------------------------------------------------

/**
 * Extrahiert alle Frage-Vorlagen aus EINER Datei.
 *
 * Wirft nie: eine unlesbare Struktur wird zur Warnung, nicht zum Abbruch — ein
 * Extraktor, der auf einer Datei stirbt, meldet den Rest des Repos als fehlerfrei.
 *
 * @param {{file: string, content: string}} arg
 * @returns {{blocks: import('./schema.mjs').AuqBlock[], warnings: string[]}}
 */
export function parseFile({ file, content } = {}) {
  const warnings = [];
  if (typeof file !== 'string' || typeof content !== 'string') {
    return { blocks: [], warnings: ['parseFile: file und content müssen Strings sein'] };
  }
  const kind = corpusKindOf(file);
  if (kind === null) return { blocks: [], warnings };

  try {
    if (kind === 'mjs') return { blocks: parseMjsFile(file, content, warnings), warnings };
    return { blocks: parseMarkdownFile(file, content, kind, warnings), warnings };
  } catch (err) {
    warnings.push(`${file}: Extraktion abgebrochen — ${err?.message ?? String(err)}`);
    return { blocks: [], warnings };
  }
}

/** Baut eine Frage über die Fabrik und hängt den Unbekannt-Merker an. */
function buildQuestion(rec, optionCountUnknown, warnings) {
  const options = rec.options.map((o) => {
    const recommendedInLabel = hasRecommendedMarker(o.label);
    const recommendedInDescription = hasRecommendedMarker(o.description);
    if (recommendedInDescription && !recommendedInLabel) {
      // Die Umkehrfalle: dispatcher-autonomy-capture.mjs setzt (Recommended)
      // in die description. Die Empfehlung ist DA, nur am falschen Feld.
      warnings.push(
        `${rec.file}:${rec.line}: recommended-in-description — Option ${o.index} („${o.label}") trägt (Recommended) in der Beschreibung statt im Label`,
      );
    } else if (
      !recommendedInLabel &&
      !recommendedInDescription &&
      (NEAR_RECOMMENDED_PATTERN.test(o.label) || NEAR_RECOMMENDED_PATTERN.test(o.description))
    ) {
      warnings.push(
        `${rec.file}:${rec.line}: near-recommended — Option ${o.index} („${o.label}") nutzt eine nicht-kanonische Empfehlungsform (erwartet: ${RECOMMENDED_MARKERS.join(' oder ')})`,
      );
    }
    // Ein Ort für das Prädikat (schema.mjs). Die beiden lokalen Flags bleiben, weil
    // die Warnungen oben zwischen „Marker im Label" und „Marker in der Beschreibung"
    // unterscheiden müssen — das Urteil selbst kommt aber aus dem geteilten Prädikat.
    return makeOption({ ...o, isRecommended: isRecommendedOption(o) });
  });

  const question = makeQuestion({ ...rec, options });
  // `optionCountUnknown` ist KEIN Vertragsfeld — schema.mjs friert AuqQuestion
  // ein und kennt es nicht. Es wird additiv angehängt (alle Vertragsfelder
  // stammen weiterhin unverändert aus der Fabrik), damit clarity.mjs die Hürde
  // H2 für ein abgekürztes Options-Fragment nicht als Verstoß meldet.
  return optionCountUnknown ? Object.freeze({ ...question, optionCountUnknown: true }) : question;
}

/** Population A/B/C-mdc/C-hybrid/C-prose. */
function parseMarkdownFile(file, content, kind, warnings) {
  const lines = content.split('\n');
  const fences = fencesOf(content);
  const blocks = [];
  const fenceRanges = fences.map((f) => [f.openLine, f.closeLine]);

  for (const fence of fences) {
    const leadInLines = lines.slice(Math.max(0, fence.openLine - 4), fence.openLine - 1);
    const body = fence.bodyLines;

    if (AUQ_CALL_PATTERN.test(body.join('\n'))) {
      const { questions } = parseAuqBody(body, fence.bodyStartLine);
      if (questions.length === 0) {
        warnings.push(`${file}:${fence.openLine}: AskUserQuestion-Zaun ohne lesbare Frage`);
        continue;
      }
      const built = questions.map((q) =>
        buildQuestion(
          {
            question: q.question,
            header: q.header,
            multiSelect: q.multiSelect,
            options: q.options,
            file,
            line: q.line,
            population: 'A',
            kind: classifyKind({
              leadInLines,
              questionText: q.question,
              optionLabels: q.options.map((o) => o.label),
            }),
            quoting: q.quoting,
          },
          q.optionCountUnknown,
          warnings,
        ),
      );
      blocks.push(makeBlock({ file, line: fence.openLine, questions: built }));
      continue;
    }

    const runs = numberedRunsOf(body);
    if (runs.length === 0 || !hasChoiceCue(body, leadInLines, runs)) continue;

    // Population: `.mdc` ist immer C-mdc. In `.md` entscheidet die Anlaufzeile,
    // und zwar in DIESER Reihenfolge — die Fallback-Ankündigung schlägt die
    // blosse Erwähnung des Werkzeugs:
    //   „Codex CLI / Cursor IDE fallback (numbered Markdown list)" → B
    //   „use `AskUserQuestion` with these options"                 → C-hybrid
    // Umgekehrt geprüft landeten `skills/_shared/platform-tools.md:39` und
    // `skills/session-start/SKILL.md:1069` fälschlich in C-hybrid: beide sind
    // Fallbacks, deren Anlaufzeile den Werkzeugnamen nur nennt, um ihn
    // auszuschliessen.
    const population =
      kind === 'mdc'
        ? 'C-mdc'
        : leadInLines.some((l) => FALLBACK_HARNESS_PATTERN.test(l))
          ? 'B'
          : leadInLines.some((l) => /AskUserQuestion/u.test(l))
            ? 'C-hybrid'
            : 'B';

    const built = runs.map((run) => {
      const questionText = questionTextForRun(body, run, leadInLines[leadInLines.length - 1] ?? '');
      const options = run.items.map((it, i) => ({ ...splitNumberedItem(it.text), preview: null, index: i }));
      return buildQuestion(
        {
          question: questionText,
          header: null,
          multiSelect: body.some((l) => /number\(s\)|comma-separated|Mehrfachauswahl/iu.test(l)),
          options,
          file,
          line: fence.bodyStartLine + run.startIdx,
          population,
          kind: classifyKind({
            leadInLines,
            questionText,
            optionLabels: options.map((o) => o.label),
          }),
          quoting: 'prose',
        },
        false,
        warnings,
      );
    });
    blocks.push(makeBlock({ file, line: fence.openLine, questions: built }));
  }

  // C-prose: eine Frage, die NUR im Fließtext beschrieben ist — erkennbar an
  // einer Zeile ausserhalb jedes Zauns, die den Tool-Namen UND ein `header:`
  // trägt (skills/session-end/phase-3-6-tail.md).
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (fenceRanges.some(([a, b]) => lineNo >= a && lineNo <= b)) return;
    if (!/AskUserQuestion/u.test(line) || !/\bheader\s*:/u.test(line)) return;
    const keys = scanKeys(stripComments(line));
    const headerKey = keys.find((k) => k.key === 'header');
    const header = headerKey ? stringValueOf(line, headerKey) : null;
    blocks.push(
      makeBlock({
        file,
        line: lineNo,
        questions: [
          buildQuestion(
            {
              question: line.trim(),
              header: header ? header.value : null,
              multiSelect: /multiSelect:\s*true/u.test(line),
              options: [],
              file,
              line: lineNo,
              population: 'C-prose',
              kind: 'template',
              quoting: 'prose',
            },
            false,
            warnings,
          ),
        ],
      }),
    );
  });

  return blocks;
}

/** Population C-mjs — echte JS-Objektliterale in Produktionscode. */
function parseMjsFile(file, content, warnings) {
  const text = stripComments(content);
  const starts = lineStartsOf(text);
  const keys = scanKeys(text);
  const questionIdx = keys.map((k, i) => (k.key === 'question' ? i : -1)).filter((i) => i >= 0);
  const blocks = [];

  for (let n = 0; n < questionIdx.length; n++) {
    const startKeyIdx = questionIdx[n];
    const endKeyIdx = n + 1 < questionIdx.length ? questionIdx[n + 1] : keys.length;
    const segment = keys.slice(startKeyIdx, endKeyIdx);
    const qVal = stringValueOf(text, segment[0]);
    if (!qVal) continue;

    const labelPositions = segment.map((k, i) => (k.key === 'label' ? i : -1)).filter((i) => i >= 0);
    // Ohne mindestens zwei beschriftete Optionen ist es keine Operator-Frage,
    // sondern ein gleichnamiges Feld — scripts/lib/state-md/body-sections.mjs
    // führt `question:` in einer STATE.md-Datenstruktur.
    if (labelPositions.length < 2) continue;

    const headerKey = segment.find((k) => k.key === 'header');
    const header = headerKey ? stringValueOf(text, headerKey) : null;
    const msKey = segment.find((k) => k.key === 'multiSelect');
    const options = [];
    labelPositions.forEach((li, oi) => {
      const nextLi = oi + 1 < labelPositions.length ? labelPositions[oi + 1] : segment.length;
      const scope = segment.slice(li, nextLi);
      const label = stringValueOf(text, scope[0]);
      if (!label) return;
      const descKey = scope.find((k) => k.key === 'description');
      const prevKey = scope.find((k) => k.key === 'preview');
      const desc = descKey ? stringValueOf(text, descKey) : null;
      const prev = prevKey ? stringValueOf(text, prevKey) : null;
      options.push({
        label: label.value,
        description: desc ? desc.value : '',
        preview: prev ? prev.value : null,
        index: options.length,
      });
    });

    const line = lineOfOffset(starts, segment[0].at);
    blocks.push(
      makeBlock({
        file,
        line,
        questions: [
          buildQuestion(
            {
              question: qVal.value,
              header: header ? header.value : null,
              multiSelect: msKey ? boolValueOf(text, msKey) === true : false,
              options,
              file,
              line,
              population: 'C-mjs',
              kind: classifyKind({
                leadInLines: [],
                questionText: qVal.value,
                optionLabels: options.map((o) => o.label),
              }),
              quoting: qVal.quoting,
            },
            false,
            warnings,
          ),
        ],
      }),
    );
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// parseRepo
// ---------------------------------------------------------------------------

/**
 * Die Dateiliste des Korpus. **`git ls-files`** — nur getrackte Dateien.
 *
 * Gemessen 2026-08-22 auf HEAD a4f93cf: `git ls-files | grep -c '^\.claude/worktrees/'`
 * liefert 0. Ungetrackte Arbeitsbäume sind damit STRUKTURELL ausgeschlossen,
 * nicht per Filter — ein Filter müsste gepflegt werden, die Trackung nicht.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function corpusFiles(repoRoot) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((f) => f !== '' && corpusKindOf(f) !== null);
}

/**
 * Extrahiert alle Frage-Vorlagen des Repos.
 *
 * @param {{repoRoot: string, files?: string[]}} arg
 * @returns {{blocks: import('./schema.mjs').AuqBlock[], corpus: Record<string, number>, warnings: string[]}}
 */
export function parseRepo({ repoRoot, files } = {}) {
  const warnings = [];
  const corpus = emptyCorpus();
  const blocks = [];

  let list = Array.isArray(files) ? files : null;
  if (list === null) {
    try {
      list = corpusFiles(repoRoot);
    } catch (err) {
      warnings.push(`parseRepo: git ls-files fehlgeschlagen — ${err?.message ?? String(err)}`);
      return { blocks, corpus, warnings };
    }
  }

  for (const file of list) {
    if (corpusKindOf(file) === null) continue;
    let content;
    try {
      content = readFileSync(path.join(repoRoot, file), 'utf8');
    } catch (err) {
      warnings.push(`${file}: nicht lesbar — ${err?.message ?? String(err)}`);
      continue;
    }
    const res = parseFile({ file, content });
    warnings.push(...res.warnings);
    for (const block of res.blocks) {
      blocks.push(block);
      // `corpus` zählt BLÖCKE je Population — die Herkunftsklasse ist per
      // Konstruktion für alle Fragen eines Blocks dieselbe, und die
      // Korpus-Erhebung vom 2026-08-22 ist ebenfalls in Blöcken angegeben.
      const population = block.questions[0]?.population;
      if (population !== undefined) corpus[population] += 1;
    }
  }

  return { blocks, corpus, warnings };
}
