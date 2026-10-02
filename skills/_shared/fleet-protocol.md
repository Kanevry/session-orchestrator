# Fleet Protocol v1 — Dateien statt Nachrichten (#1462)

Generic contract note for every session-orchestrator session (Claude Code, Codex, headless) that
may run beside a fleet coordinator ("navigator"). It is a reference, **not a rule**: nothing under
`.claude/rules/**` loads it; session-start Phase 7.6 and the operations-contract peer preflight
point here. The mechanics live in code — `scripts/lib/fleet-protocol.mjs` is the only place that
knows paths, fields, deadlines and lease validity; `scripts/fleet-checkin.mjs` writes the check-in.
This file describes them and never redefines them. The coordinator itself is not part of this
package: it is operated outside the plugin, which owns its operational detail (how it measures,
which conditions it issues, how it acquires and hands over the lease).

**Grundsatz (CSM-003).** Zustand liegt in Dateien; Nachrichten sind nur Hinweise auf eine Datei.
Der Navigator erteilt keine Freigaben — maßgeblich ist der Owner-Auftrag der Session. Eine Datei,
die fehlt, heißt „nicht nachweisbar", nie „nicht vorhanden": eine fehlende Lease ist kein freies
Feld, sondern ein Zustand ohne Beleg.

## Verzeichnis und Dateiform

- Wurzel `~/.config/navigator/`, Override `NAVIGATOR_CONFIG_DIR` (getrimmt; leer oder nur
  Whitespace zählt als nicht gesetzt). Code: `navigatorDir()`. Ein Override zeigt nur auf ein
  eigenes Verzeichnis mit Modus 0700, nie auf einen geteilten Ort: wer dort schreiben kann, kann
  eine „aktive" Lease vortäuschen.
- Verzeichnisse Modus `0700`, Dateien Modus `0600`. Schreiben immer atomar (tmp-Datei im
  Zielverzeichnis, dann `rename`).
- Jede Datei trägt `zeit` aus `date -u +%FT%TZ` (Sekunden, `YYYY-MM-DDTHH:MM:SSZ`); nie geschätzt,
  nie aus einer anderen Uhr. Code: `utcSecondsTimestamp()`.
- Dateinamen aus einer `session_id` sind pfadsicher: nur `[A-Za-z0-9._-]`, 1–128 Zeichen, nicht
  `.` oder `..`, kein `/`. Code: `isSafeSessionId()`; `checkinPath()` und `auflagenPath()` werfen
  sonst.
- Tests berühren das echte Verzeichnis nie: `tests/setup/navigator-dir-guard.mjs` setzt
  `NAVIGATOR_CONFIG_DIR` je vitest-Worker auf ein tmp-Verzeichnis.

## `leases/navigator.json` — genau ein aktiver Navigator

| Feld | Inhalt |
|---|---|
| `session_id` | Registry-ID des Navigators (Pflicht; pfadsicher wie oben) |
| `plattform` | `claude` \| `codex` \| `kopflos` (Pflicht) |
| `adresse` | `ListAgents`-Name, wenn Claude (`[A-Za-z0-9._:@-]`, 1–128 Zeichen); sonst `null` |
| `seit` | Zeit des Erwerbs, UTC mit `Z`, Sekunden oder Millisekunden (Pflicht) |
| `laeuft_ab` | UTC mit `Z`, gleiche Form; nach diesem Zeitpunkt ist die Lease abgelaufen (Pflicht) |
| `uebergabe_an` | `null` oder Session-ID des Nachfolgers |

**„Aktiv" heißt ausschließlich: gültige Lease.** `readNavigatorLease()` liefert genau eines von
`active` (Datei lesbar, Pflichtfelder da, `laeuft_ab` in der Zukunft), `none` (Datei fehlt oder
`laeuft_ab` überschritten) oder `unreadable` (kaputtes JSON, fehlende Pflichtfelder, Lesefehler,
oder ein Feld außerhalb der Tabellenform: unbekannte `plattform`, Steuerzeichen in
`session_id`/`adresse`, eine Zeit ohne `Z` oder mit Offset — sie würde in lokaler Zeit gelesen und
könnte die Lease verlängern). Unlesbar oder abgelaufen ist **nie** aktiv (fail-closed).
Registry-Heartbeat (`role: navigator`, `scripts/lib/session-registry.mjs`) und `ListAgents` sind
Zusatzsignale, keine Lebendbeweise. Dieses Paket liest die Lease nur (SessionStart-Banner,
`fleet-checkin.mjs`); Erwerb, Erneuerung und Übergabe liegen beim Navigator.

## `checkin/<session_id>.json` — Session an Navigator

**Schreibend** heißt: Änderung an Repo-Inhalt oder VCS-Zustand (Datei im Arbeitsbaum außerhalb
`.orchestrator/` und `.claude/`, Commit, Branch, Push, MR, Issue, Kommentar). SO-eigener
Sitzungszustand zählt nicht: Phase 1.1 (CLAUDE.md-Migration, einmalig), 1.2 `session.lock`, 1.5
`STATE.md`, 1.6 Metriken, 1.7 Live-Status-Board. Phase 1.1 ist eine Repo-Datei und wird deshalb
als Ausnahme im Check-in genannt (`vorab_geschrieben`). (`CLAUDE.md` heißt auf Codex CLI `AGENTS.md`, siehe
`skills/_shared/instruction-file-resolution.md`.)

Der Check-in liegt **vor der ersten schreibenden Aktion** (Phase 7.6, oder der Peer-Preflight der
Operations-Route). Schreiber: `node scripts/fleet-checkin.mjs` liest das JSON von stdin, setzt
`zeit` (überschreibt immer), validiert (`validateCheckin()`), schreibt atomar mit Modus 0600 und
emittiert `orchestrator.fleet.checkin` (Payload `session`, `repo`, `modus`, `kandidaten`,
`navigator_state` — keine Pfade, keine Quota, kein `auftrag_ref`). stdout: eine JSON-Zeile
`{ ok, path, navigator_state, navigator_adresse, event }`; `navigator_adresse` ist die vom
Lease-Validator akzeptierte `adresse` einer aktiven Lease, sonst `null` (keine aktive Lease, kein
Eintrag oder ein abgelehnter Wert — nie ein ungeprüfter String). Exit 0 geschrieben, 2 ungültige
Eingabe (Fehlerliste auf stderr, keine Datei), 1 Schreibfehler.

| Feld | Inhalt |
|---|---|
| `session` | Registry-ID aus `.orchestrator/current-session.json`, pfadsicher (Pflicht) |
| `plattform` | `claude` / `codex` / `kopflos` (Pflicht) |
| `repo` | Repo-Name `name` oder `gruppe/name`, nie ein Pfad (Pflicht) |
| `repo_id`, `worktree` | String oder `null`; Worktree `true`/`false` |
| `modus` | `housekeeping` / `feature` / `deep` / `operations` (Pflicht) |
| `auftrag_ref` | Pfad der Auftragsdatei oder „Owner-Chat <zeit>" mit Wortlaut in einem Satz (Pflicht) |
| `konto_slot`, `quota` | Zahl, String oder `null`; Quota als String, sonst `nicht messbar` |
| `stand` | Objekt: main-, origin/main-, Prod-SHA (sonst `nicht messbar`), offene MRs |
| `kandidaten` | höchstens 64 Issue-Nummern (`42` oder `"#42"`) (Pflicht) |
| `schreibbereich` | Liste von Verzeichnissen/Dateien als Strings (Pflicht) |
| `bedarf` | Objekt: geplante volle Pipelines, Remote-Offload-Jobs, prozessstartende Agents |
| `vorab_geschrieben` | Liste der Ausnahmen nach der Definition oben |
| `rueckfall` | Verhalten ohne Auflagen (unten), nicht leer (Pflicht) |
| `zeit` | von der CLI gesetzt |

Eine `SendMessage` an den Navigator ist optional und nur ein Hinweis auf die Datei: höchstens eine,
nur wenn die Lease aktiv ist und `navigator_adresse` (stdout der Check-in-CLI) nicht `null` und per
`ListAgents` erreichbar ist, und nur an genau diesen Namen; nie eine Antwort
erwarten, nie darauf warten (CSM-004).

## `auflagen/<session_id>.json` — Navigator an Session

Bedingungen, die der Navigator einer Session schreibt (z. B. Agent-Caps, volle Pipelines je Repo,
Offload-Regel, Merge- und Zeitregeln, Besitzkonflikte); Inhalt und Form gehören dem Navigator. Die
Session **liest** die Datei; sie wartet auf keine Nachricht. Keine Auflage ist eine Freigabe.

**Standard-Auflagen (konservative Stufe).** Sie gelten, wenn `CHECKIN_FALLBACK_MIN` = 10 Minuten
nach `checkin.zeit` keine Auflagen-Datei liegt — und sofort, wenn kein Navigator aktiv ist:

- Caps: 2 prozessstartende + 2 lesende Agents, solange der lokale Host ≥ 50 % Speicher frei hat.
- Pipelines: ≤ 2 volle je Repo; Nachzug-Pushes vorher im Check-in (`bedarf`) benennen.
- Offload: Heavy-Rollen (test, build, lint, audit) nur auf einen deklarierten Remote-Host, der
  unmittelbar davor als bereit belegt ist (`skills/remote-offload/SKILL.md`); ohne Beleg kein neues
  Offload. Lokal nur `vitest` bzw. `eslint` je Datei mit `timeout`.
- Zeiten nur aus `date`.
- Kein Merge ohne ausdrücklichen Owner-Auftrag, der Merge für genau dieses Repo nennt
  (`auftrag_ref`).

Lesende Arbeit und Schreiben im eigenen Worktree laufen währenddessen weiter; der Rückfall ist ein
Dateistand mit Frist, kein Warten auf eine Antwort.

## Verhalten ohne Navigator

Lease `none` oder `unreadable`: die Check-in-Datei wird **trotzdem** geschrieben (sie ist der
zählbare Beleg), die Standard-Auflagen gelten sofort, es geht keine Nachricht ab. Kopflose Läufe
sind per Nachricht nicht erreichbar und nutzen dieselben Dateien: vor jeder Welle `auflagen/` lesen.

## See Also

`skills/session-start/SKILL.md` Phase 7.6 · `skills/session-start/references/operations-contract.md`
(Peer-Preflight) · `skills/_shared/state-ownership.md` § Session Identity and Lock Ownership (`role`) ·
`docs/events-schema.md` (`orchestrator.fleet.checkin`) · `.claude/rules/cross-session-messaging.md`
(CSM-003/004) · `scripts/lib/fleet-protocol.mjs` · `scripts/fleet-checkin.mjs`
