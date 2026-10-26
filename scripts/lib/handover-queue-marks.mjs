/**
 * handover-queue-marks.mjs — pure core of the handover queue check (#1639).
 *
 * A fleet session writes its open points into a handover or train manifest
 * (`skills/_shared/fleet-protocol.md` § Übergabe und Zug-Manifest). A point
 * only reaches the coordinator's owner-queue when it carries a mark: measured
 * 2026-10-15, 35 of 111 open points (32 %) were recorded nowhere. This module
 * finds the unmarked points and inserts marks; the CLI
 * (`scripts/handover-queue-check.mjs`) files the queue items. No I/O here.
 *
 * Contract:
 *   - Open-point sections: a `##`–`####` heading whose text starts with
 *     `Offen`, `Nachkontrolle`, `Folge` or `Danach` (case-insensitive) and
 *     does not contain `erledigt`. Deeper headings inside it inherit it unless
 *     they say `erledigt`; the section ends at the next heading of the same or
 *     a higher level.
 *   - A point is a top-level list item (`- `, `* `, `1. `) in such a section;
 *     indented lines (continuation, nested bullets) belong to it.
 *   - A point is marked when its text carries `queue:#<id>` or `issue:#<iid>`,
 *     or when the heading directly above its block carries `queue:#<id>`
 *     (#1794). A block is the list items directly under one heading, up to the
 *     next heading of any level: a child heading needs its own mark. A point is
 *     done when it starts with `[x]`, `~~` or `Erledigt`. Everything else is
 *     unmarked.
 *   - An unmarked point is `info` when it is unambiguously an evidence line
 *     (`isInfoLine`): fleet-protocol 1a puts those under "Vollzogen", so the CLI
 *     reports them as a hint instead of filing a queue item (#1794).
 *   - CRLF files parse like LF files; inserted marks keep the line ending.
 */

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const OPEN_SECTION_RE = /^(offen|nachkontrolle|folge|danach)/i;
const DONE_TITLE_RE = /erledigt/i;
// Owner decisions need options and a class the text does not carry (#1639 F3).
// Narrow on purpose: "Offen (owner-queue, wartet auf Lead)" or "Owner-Direktive"
// are lead work and must still be filed.
const OWNER_SECTION_RE = /owner-?(?:entscheid|frage)|\bentscheide?\b|(?:beim|an den|für den) owner/i;
const ITEM_RE = /^(?:[-*]|\d+[.)])\s+(.*)$/;
const MARK_RE = /\b(?:queue|issue):#\d+\b/;
// Only a queue item covers a heading's block: an issue in a heading names a
// topic, not that every point below it is tracked.
const HEADING_MARK_RE = /\bqueue:#\d+\b/;
const DONE_RE = /^(?:\[[xX]\]|~~|erledigt\b)/i;
const FENCE_RE = /^\s*(```|~~~)/;
// Evidence lines under an open heading (#1794). Deliberately narrow, because a
// miss is cheap and a false hit is not: a line that does not match stays an
// open point and is filed. Only two shapes count — a bold label from a fixed
// set at the very start (`**MR:**`, `**Kopf**:`) followed by evidence tokens
// only (INFO_TOKEN_RE), or a bare whole-line `Pipeline <id> grün|green|
// success|passed`. A label alone does not make a line evidence: `**MR:** !44 —
// still need to rebase` is an action (#1794 review). Three broader read-side
// classifiers dropped real actions (LSO #808).
const INFO_LABEL_RE = /^\*\*(?:MR|MRs|Kopf|Head|Pipeline|Belege?|Gate)(?::\*\*|\*\*:)/i;
const INFO_PIPELINE_RE = /^Pipeline\s+#?\d+\s+(?:grün|green|success|passed)\.?$/i;
// One evidence token after the label (after splitting on whitespace and
// `,;()`, one trailing `.`/`:` and then one surrounding pair of backticks
// removed):
// an MR/issue ref with optional repo or group path, a SHA (hex with at least
// one digit, so an all-letter word such as `defaced` is not one), a number or
// pipeline id, a count like `22243/0`, a lone `:` or `/`, or a word from a
// tiny allowlist. Any other word — a verb, "still", "noch", "prüfen" — keeps
// the line an open point (fail-closed).
const INFO_TOKEN_RE =
  /^(?:(?:[\w.-]+\/)*[\w.-]*[!#]\d+|(?=[0-9a-f]*\d)[0-9a-f]{7,40}|#?\d+(?:\/\d+)*|[:/]|grün|green|success|passed|kopf|head|pipeline|sha)$/i;
// The coordinator CLI's `--ref` shape (lead-session-orchestrator
// src/owner-queue/typen.ts): a bare repo name, no group path, iid ≥ 1.
const CLI_REF_RE = /^[A-Za-z0-9._-]{1,100}[!#][1-9]\d{0,8}$/;

/**
 * @typedef {object} OpenPoint
 * @property {number} line      0-based index of the item's first line
 * @property {string} section   heading text of the enclosing open section
 * @property {string} text      item text, continuation lines joined by spaces
 * @property {boolean} marked
 * @property {boolean} done
 * @property {boolean} info    unmarked evidence line, see isInfoLine (#1794)
 */

/**
 * Lists every top-level list item in an open-point section.
 *
 * @param {string} content - raw markdown
 * @returns {OpenPoint[]}
 */
export function findOpenPoints(content) {
  const lines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  /** @type {OpenPoint[]} */
  const points = [];
  let root = null; // { level, title } of the enclosing open section
  let active = false; // inside root and not in an `erledigt` subsection
  // The heading directly above the current block carries `queue:#<id>`; a
  // mark covers only its own block, never a child heading's (#1794 review).
  let blockMarked = false;
  let current = null;
  let inFence = false;

  const close = () => {
    if (current) points.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (inFence) continue;
    const heading = HEADING_RE.exec(line);
    if (heading) {
      close();
      const level = heading[1].length;
      const title = heading[2].trim();
      if (root && level > root.level) {
        active = !DONE_TITLE_RE.test(title);
        blockMarked = HEADING_MARK_RE.test(title);
      } else {
        const open = level >= 2 && level <= 4 && OPEN_SECTION_RE.test(title) && !DONE_TITLE_RE.test(title);
        root = open ? { level, title } : null;
        active = open;
        blockMarked = open && HEADING_MARK_RE.test(title);
      }
      continue;
    }
    if (!active) continue;
    const item = ITEM_RE.exec(line);
    if (item) {
      close();
      current = {
        line: i,
        section: root.title,
        text: item[1].trim(),
        marked: false,
        done: false,
        info: false,
        headingMarked: blockMarked,
      };
    } else if (current && /^\s+\S/.test(line)) {
      current.text += ` ${line.trim()}`;
    } else if (current && line.trim() !== '') {
      close(); // unindented prose ends the item
    }
  }
  close();

  for (const p of points) {
    p.marked = p.headingMarked || MARK_RE.test(p.text);
    delete p.headingMarked;
    p.done = DONE_RE.test(p.text);
    p.info = !p.marked && !p.done && isInfoLine(p.text);
  }
  return points;
}

/**
 * True when an item text is unambiguously an evidence/info line (#1794).
 * Fail-closed: anything else is treated as an open point.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isInfoLine(text) {
  if (INFO_PIPELINE_RE.test(text)) return true;
  const label = INFO_LABEL_RE.exec(text);
  if (!label) return false;
  const tokens = text
    .slice(label[0].length)
    .split(/[\s,;()]+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.:]$/, '').replace(/^`(.*)`$/, '$1') || ':');
  // Punctuation alone is no evidence: `**MR:** :` stays open.
  return tokens.some((t) => !/^[:/]$/.test(t)) && tokens.every((t) => INFO_TOKEN_RE.test(t));
}

/** Points without a mark that are not done — real open points and info lines alike. */
export function unmarkedPoints(points) {
  return points.filter((p) => !p.marked && !p.done);
}

/**
 * Queue item kind for a point: a post-merge/train check is `nachsorge`,
 * other open points `lead-todo`. `null` for a point under an owner/decision
 * heading — an `entscheid` needs options and a class, so it is reported, never
 * filed as a lead todo. Peer promises (`zusage`) likewise stay the session's
 * own call under fleet-protocol Schritt 1a.
 *
 * @param {OpenPoint} point
 * @returns {'nachsorge'|'lead-todo'|null}
 */
export function kindFor(point) {
  if (OWNER_SECTION_RE.test(point.section)) return null;
  return /^nachkontrolle/i.test(point.section) ? 'nachsorge' : 'lead-todo';
}

/**
 * `--ref` for owner-queue: the first MR (`!N`) or issue (`#N`) the point names.
 * A `group/repo!N` keeps only its last path segment; a bare `!N` gets `repo`.
 * `null` when nothing is named or the result would not pass the CLI's ref
 * check — a missing ref files the item, an invalid one would refuse it.
 *
 * @param {OpenPoint} point
 * @param {string} repo
 * @returns {string|null}
 */
export function refFor(point, repo) {
  const m = /(?:^|[\s(*`])((?:[\w.-]+\/)*([\w.-]+))?([!#])(\d+)\b/.exec(point.text.replace(MARK_RE, ''));
  if (!m) return null;
  const ref = `${m[2] ?? repo}${m[3]}${m[4]}`;
  return CLI_REF_RE.test(ref) ? ref : null;
}

/**
 * Appends ` queue:#<id>` to the first line of each point in `ids`
 * (Map<line, id>), keeping a CRLF line ending. Other lines are untouched.
 *
 * @param {string} content
 * @param {Map<number, number>} ids
 * @returns {string}
 */
export function insertMarks(content, ids) {
  const lines = content.split('\n');
  for (const [line, id] of ids) {
    const cr = lines[line].endsWith('\r') ? '\r' : '';
    lines[line] = `${lines[line].replace(/\s+$/, '')} queue:#${id}${cr}`;
  }
  return lines.join('\n');
}
