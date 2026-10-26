# Fleet Protocol v1 — Dateien statt Nachrichten (#1462)

Generic contract note for every session-orchestrator session (Claude Code, Codex, headless) that
may run beside a fleet coordinator ("navigator"). It is a reference, **not a rule**: nothing under
`.claude/rules/**` loads it; session-start Phase 7.6 and the operations-contract peer preflight
point here. The mechanics live in code — `scripts/lib/fleet-protocol.mjs` is the only place that
knows paths, fields, deadlines and lease validity; `scripts/fleet-checkin.mjs` writes the check-in.
This file describes them and never redefines them. The coordinator itself is not part of this
package: it is operated outside the plugin, which owns its operational detail (how it measures,
which conditions it issues, how it acquires and hands over the lease).
A public coordinator that implements this contract is lead-session-orchestrator
(https://session-orchestrator.com/lead); any other tool that writes the same files works too.

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
- Zeiten in Check-in und Lease stehen in UTC mit `Z`; eine Zeit ohne `Z` oder mit Offset ist dort
  ungültig. Die Form hängt an der Datei: Nur der Check-in trägt `zeit`, in Sekunden wie `date -u +%FT%TZ`
  (`YYYY-MM-DDTHH:MM:SSZ`), gesetzt von der CLI, nie geschätzt, nie aus einer anderen Uhr (Code:
  `utcSecondsTimestamp()`). Die Lease trägt `seit` und `laeuft_ab` in Sekunden oder Millisekunden
  (Tabelle unten, Code: `LEASE_TS_RE`). Inhalt und Form der Auflagen gehören dem Navigator.
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
`{ ok, path, navigator_state, navigator_adresse, fallback_due_at, event }`; `navigator_adresse` ist
die vom Lease-Validator akzeptierte `adresse` einer aktiven Lease, sonst `null` (keine aktive
Lease, kein Eintrag oder ein abgelehnter Wert — nie ein ungeprüfter String). `fallback_due_at` ist
der Zeitpunkt, ab dem die Standard-Auflagen (unten) gelten, in der Form von `zeit` (Code:
`fallbackDueAt()`); er steht nur auf stdout, die Check-in-Datei behält ihr Schema. Exit 0
geschrieben, 2 ungültige Eingabe (Fehlerliste auf stderr, keine Datei) oder semantische Session-ID
von einem anderen Repo belegt (eine Zeile auf stderr mit JSON-escaped Repo-Namen, fremde Datei unverändert,
tmp entfernt, kein Event), 1 Schreibfehler.
Vor dem `rename` lehnt der Schreiber ein vorhandenes String-`repo` ungleich dem eigenen ab;
gleiches `repo`, unlesbare Dateien und ungültiges JSON dürfen überschrieben werden.
Die Prüfung folgt keinen Symlinks, öffnet nichtblockierend und liest nur reguläre Dateien
bis 64 KiB. Symlinks, andere Dateitypen, größere Dateien oder fehlende sichere Open-Flags
gelten für diese Prüfung als unlesbar (fail-open zum `rename`).

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

## Rücklauf an den Navigator (Pflicht)

In jedem Warte-Zug, den eine Eingabe ausgelöst hat (Anstoß der Owner-Inbox, Nachricht vom Lead,
Nachricht vom Owner, auch ein Befehl wie `/go` oder `/close`) — keine Arbeit gefunden, Blocker länger
als 15 min, `/go` oder `/close` ohne Plan, fertig, nur noch Zug/Pipeline offen — genau eine Meldung
an den Koordinator, im Zug der Warte-Antwort selbst: Session (`<name>`, unten), Wartefall
(`keine-arbeit`, `blocker-<issue>`, `go-ohne-plan`, `close-ohne-plan`, `fertig`, `zug-<name>`), seit
wann (Uhr aus `date`, die lokale Systemzeit des Hosts), was gebraucht wird. Auch wenn derselbe Fall
in einem früheren Zug schon gemeldet wurde (Resume, Verdichtung, erneuter Anstoß): Die Owner-Inbox
lässt eine Session nur ruhen, wenn sie im Zug ihrer letzten Antwort gemeldet hat (SendMessage oder
`owner-queue add`) UND diese Antwort als Warte-Antwort erkennt; eine unterdrückte Wiederholung hält
sie wach und führt zu stündlichen Anstößen (#1611). Ausgenommen sind Züge, die keine Eingabe
ausgelöst hat: Weckungen durch `/loop`, ein Monitor-Ereignis, ein eigener Hintergrund-Agent oder eine
eigene Hintergrund-Shell, ScheduleWakeup. Sie melden nicht erneut: solange ein Monitor oder
Hintergrund-Lauf offen ist, stößt die Inbox ohnehin nicht an; nach einer Weckung durch `/loop` oder
ScheduleWakeup holt der nächste Anstoß die Meldung nach. Flotte und Lease lesend messen, ohne Check-in zu schreiben
(derselbe Helfer `readNavigatorLease()`, aus dem die Check-in-CLI `navigator_adresse` gewinnt):

```bash
node --input-type=module -e "const { pathToFileURL } = await import('node:url'); const m = await import(pathToFileURL(process.argv[1]).href); const r = await m.readNavigatorLease(); console.log(JSON.stringify({flotte: m.fleetIntegrationEnabled(), state: r.state, adresse: r.lease?.adresse ?? null}))" "${CLAUDE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-$PLUGIN_ROOT}}/scripts/lib/fleet-protocol.mjs"
```

`flotte: false` (§ Verhalten ohne Flotte): keine Meldung, keine Datei; hier endet der Abschnitt.
Sonst die Meldung über eine Rückfallkette; die nächste Stufe greift, sobald die vorige nicht greift
oder scheitert:

1. `state: active`, `adresse` nicht `null` und per `ListAgents` erreichbar: eine `SendMessage` an
   genau diese Adresse. Werkzeugfehler oder unbekannte Adresse: weiter mit Stufe 2.
2. Sonst (Lease `none` oder `unreadable`, keine oder keine erreichbare Adresse, Stufe 1
   gescheitert): ein Lead-Todo in der owner-queue des Koordinators, `<repo>` wie das Check-in-Feld
   `repo`, Titel mit `<name>` (unten) und dem, worauf die Session wartet. Exit 4 heißt „ähnlicher
   offener Eintrag liegt schon in der Queue“. Der Befehl selbst muss Exit 0 und 4 auf Exit 0
   normalisieren: Claude Code markiert jeden Exit ungleich 0 als Werkzeugfehler (`is_error`), und
   einen gescheiterten Aufruf zählt die Owner-Inbox nicht als Meldung. Pflichtform:

   ```bash
   navigator owner-queue add --repo <repo> --kind lead-todo --waits-on lead --title '<name>: <worauf die Session wartet>'; rc=$?; [ "$rc" -eq 0 ] || [ "$rc" -eq 4 ] || { echo "Meldung gescheitert: owner-queue add exit $rc" >&2; exit "$rc"; }
   ```

   `navigator` ist die CLI des Koordinators (lead-session-orchestrator: Binary `navigator`); nennt
   die Steuerungsregel des Koordinators im Systemprompt der Session einen Aufrufpfad, gilt dieser.
   Einen eigenen Pfad zum Koordinator-Repo nicht raten.
3. Scheitert auch Stufe 2 (Exit weder 0 noch 4, z. B. 127, weil `navigator` nicht im `PATH` liegt):
   der letzte Absatz der Antwort nennt sichtbar `Meldung gescheitert: <Grund>` (Stufe, Exit-Code
   oder Fehlertext), vor dem Wartesatz. Still warten ist nie zulässig.

**Wartesatz.** Jede Warte-Antwort endet mit einem Satz, den der Koordinator als Warte-Antwort
erkennt (letzte 600 Zeichen ohne Code-Blöcke, kein `?` am Ende des letzten Absatzes, Muster wie
unter Übergabe Punkt 3): `Bereit zum Schließen.`, wenn die Übergabe unten gilt, sonst
`Ich warte auf den nächsten Auftrag.` Eine Meldung oder Statuszeile allein (etwa
`/go: kein Plan vorhanden – nichts ausgeführt`) erkennt er nicht.

**Flotten-Ordner und Session-Name.** Beide stehen im eigenen Eintrag der Claude-Session-Registry
`~/.claude/sessions/<pid>.json`, dem mit `sessionId` gleich `$CLAUDE_CODE_SESSION_ID`:

```bash
jq -c --arg id "$CLAUDE_CODE_SESSION_ID" 'select(.sessionId == $id) | {name, cwd, startedAt}' ~/.claude/sessions/*.json
```

`<name>` ist das Feld `name` (der Peer-Name, z. B. `session-orchestrator-cf`; fehlt es, die ersten
acht Zeichen von `sessionId`), nicht `session_id` und nicht `semantic_session_id`. Der Flotten-Ordner
ist `<cwd>/.orchestrator/runtime/fleet/` mit dem `cwd`, der im Moment des Schreibens in diesem
Eintrag steht: den Befehl unmittelbar davor ausführen, nie einen früher gemessenen Wert nehmen. Nach
`EnterWorktree` zeigt `cwd` auf den Worktree, und dort sucht der Koordinator. `/close` kann einen
auto-promoteten Worktree samt der Datei darin entfernen (session-end Phase 4a); die Datei entsteht
deshalb erst mit der Meldung, und der Koordinator liest sie vor dem Abschluss.

**Übergabe und Zug-Manifest.** Nur mit Flottenintegration (`flotte: true` in derselben Messung),
auch ohne aktive Lease: der Koordinator schließt eine von ihm geführte Session, sobald ihre Übergabe
vorliegt, ohne die Lease zu prüfen. Und nur in der Warte- oder Fertig-Antwort außerhalb von
session-end (Phase start oder go: das Abschluss-Ergebnis des wave-executor, das Ende des Express Path,
`/go` ohne Plan, keine Arbeit). Ist die Session fertig oder wartet sie nur noch auf einen Release-Zug oder eine Pipeline
und hat keine andere Arbeit:

1. Im selben Zug wie diese Antwort schreibt sie selbst mit dem Datei-Werkzeug des Harness (Claude
   Code: Write), nicht per Shell, in den Flotten-Ordner: fertig die Übergabe
   `uebergabe-<name>-an-<Nachfolger>.md` (ohne Nachfolger `uebergabe-<name>.md`), bei Zug oder
   Pipeline das Zug-Manifest `<name>-zug-<zugname>.md` — enthaltene MRs, Köpfe, Migrationen,
   manuelle Jobs, Nachkontrolle, Rückweg, offene Themen. Der Koordinator erkennt nur genau diese
   Namen (`uebergabe-<name>.md`, `uebergabe-<name>-….md`, `<name>-zug-….md`) und nur eine Datei, die
   die Session im Zug ihrer letzten Antwort nachweislich selbst geschrieben hat. Vorher
   `git -C <cwd> check-ignore --no-index -q .orchestrator/runtime/fleet/<datei>` prüfen: Exit 1
   (nicht ignoriert) hält das Schreiben nicht auf — der Koordinator braucht die Datei genau
   dort —, aber Meldung und Antwort nennen „ungetrackte Datei in <repo>:
   .orchestrator/runtime/fleet/<datei>“. Kein Ausweichen in einen anderen Ordner.
1a. **Jeder offene Punkt trägt eine Vorgangsmarke (#1639).** Jeder Listenpunkt unter einer
   Überschrift, die mit „Offen“, „Nachkontrolle“, „Folge“ oder „Danach“ beginnt (ohne „erledigt“ im
   Titel), endet mit `queue:#<id>`. Hat der Punkt schon ein GitLab-Issue und braucht keinen
   Zeitpunkt, endet er stattdessen mit `issue:#<iid>`. Erledigte Punkte stehen als `[x]` da.
   Belege und Infozeilen (MR, Kopf-SHA, Pipeline, Gate-Ergebnis, Messungen) stehen unter „Vollzogen“
   oder als Fließtext, nie als Listenpunkt unter Offen, Nachkontrolle, Folge oder Danach (#1794).
   Ein Nachkontrolle-Block mit einem einzigen Vorgang trägt sein `queue:#<id>` in der Überschrift
   (`## Nachkontrolle (queue:#<id>)`); die Marke deckt dann die Listenpunkte direkt unter dieser
   Überschrift bis zur nächsten Überschrift gleich welcher Ebene, eine Unterüberschrift braucht
   ihre eigene Marke. Fehlt die
   Marke, legt die Session den Vorgang vor dem Schreiben an
   (`navigator owner-queue add --repo <repo> … --title '<name>: <punkt>'`, `<repo>` wie oben):
   Prüfung nach Merge oder Zug `--kind nachsorge --waits-on lead --ref <repo>!<iid>`; Folgearbeit,
   Termin oder Nachfolge-Session `--kind lead-todo --waits-on lead` (mit `--not-before`/`--due`
   bei Termin oder Frist); Versprechen an einen Peer `--kind zusage --waits-on peer:<session>`;
   Owner-Frage wie bisher als Entscheid mit `--options`, `--recommendation`, `--class`. Exit 0 und 4
   gelten als Erfolg; bei 4 die ID des vorhandenen Vorgangs übernehmen (`--json` liefert sie als
   `ids`). Danach prüft sie die geschriebene Datei mechanisch:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-$PLUGIN_ROOT}}/scripts/handover-queue-check.mjs" --file <cwd>/.orchestrator/runtime/fleet/<datei> --name <name> --since <startedAt> --apply --repo <repo> --navigator-cli <koordinator-cli>
   ```

   `<koordinator-cli>` ist der Aufrufpfad der Koordinator-CLI aus der Steuerungsregel (eine `.js`-Datei
   läuft unter node), sonst entfällt die Option und `navigator` aus dem `PATH` gilt. `--apply` legt
   für jeden Punkt ohne Marke den Vorgang an (Nachkontrolle als `nachsorge`, sonst `lead-todo`, Ref
   aus dem ersten `!N`/`#N` im Punkt, nur wenn die CLI ihn annimmt) und schreibt `queue:#<id>` in die
   Datei. Punkte unter einer Überschrift mit „Owner“ oder „Entscheid“ legt es nie an, es meldet sie:
   Owner-Fragen brauchen einen Entscheid mit Optionen und Klasse. Eine eindeutige Infozeile
   (`**MR:**`, `**Kopf:**`, `**Pipeline:**`, `**Belege:**`, `**Gate:**` am Anfang, oder nur
   `Pipeline <id> grün`) legt es ebenfalls nie an, es meldet sie als Hinweis „Infozeile unter
   Offen-Überschrift, nach Vollzogen verschieben“ mit Exit 3; alles andere zählt als offener Punkt.
   `--apply` verlangt `--name`
   (sonst Exit 2) und schreibt nur in die eigene Datei (`uebergabe-<name>.md`,
   `uebergabe-<name>-*.md`, `<name>-zug-*.md`); eine fremde Datei, einen Symlink oder eine Datei
   älter als `--since` (Vorgänger gleichen Namens) lehnt es unverändert ab (Exit 4), nie in einer
   Schleife über den Flotten-Ordner aufrufen. Hat es Vorgänge
   angelegt, die Datei danach lesen und mit dem Datei-Werkzeug unverändert neu schreiben: der
   Koordinator erkennt nur eine selbst geschriebene Datei. Exit 3 heißt, Punkte bleiben ohne Marke
   (die Liste steht in der Ausgabe): dann nennen Meldung und Antwort „Übergabe ohne Queue-IDs: <n>
   Punkte“, und die Antwort endet mit `Ich warte auf den nächsten Auftrag.`, nicht mit dem Satz aus
   Schritt 3. Ohne Flottenintegration prüft das Skript nichts (Exit 0).
2. Mit jeder weiteren Warte-Antwort schreibt sie die Datei neu, auch wenn sie aus einem früheren Zug
   schon dasteht, so wie sie in jedem Warte-Zug neu meldet.
3. Sie meldet „bereit zum Schließen“ (in der Meldung dieses Zugs) und beendet
   die Antwort mit genau diesem Satz: `Bereit zum Schließen.` Der Koordinator erkennt eine Warte-
   oder Fertig-Antwort nur in ihren letzten 600 Zeichen (Code-Blöcke zählen nicht mit); ein langer
   Bericht mit dem Satz weiter oben schließt nicht. Der letzte Absatz endet nicht auf `?`, und die
   letzten 400 Zeichen enthalten weder `soll ich` noch `weiter mit`, `welche option` oder
   `freigabe für`: sonst gilt die Antwort als Frage an den Owner, und es schließt ebenfalls nicht.
   Auch eine Verneinung („noch nicht bereit zum Schließen“) zählt dort als Fertig-Antwort: nie ans
   Ende stellen. Sie beginnt nichts Neues und beendet Monitore, Hintergrund-Shells und
   Hintergrund-Agenten (Claude Code: TaskStop); solange einer läuft, gilt sie als nicht fertig.
4. Sie schließt nicht selbst: `/close` ist nicht modell-aufrufbar (`disable-model-invocation`), und
   den Abschluss löst der Koordinator aus. session-end (Phase 4.5) meldet im Zug von `/close` genau
   einmal den Fall `zug-<name>` (eigener Warte-Zug, gewollt) und schreibt keine Datei.
   Das gilt auch für den Express Path (session-start Phase 8.5, `skills/go/SKILL.md`): mit
   Flottenintegration ruft `/go` session-end nicht selbst auf, sondern endet nach Deviation-Eintrag
   mit Meldung, Übergabe und Wartesatz wie oben (#1620). Ohne Flottenintegration bleibt der
   Express Path beim eigenen Abschluss.

Ohne Flottenintegration keine Meldung, keine Übergabe-Datei und kein Manifest. Nie auf Antwort
warten, nie eine Entscheidung an einer Antwort festmachen (CSM-004); eine Meldung ist keine Freigabe
(ADR-002). Schließen nur über session-end, nie durch handgeschriebene Metriken.

## `auflagen/<session_id>.json` — Navigator an Session

Bedingungen, die der Navigator einer Session schreibt (z. B. Agent-Caps, volle Pipelines je Repo,
Offload-Regel, Merge- und Zeitregeln, Besitzkonflikte); Inhalt und Form gehören dem Navigator. Die
Session **liest** die Datei; sie wartet auf keine Nachricht. Keine Auflage ist eine Freigabe.

**Pflichtfeld `repo`** (#1520, navigator#190): absoluter Pfad auf Toplevel oder git-common-dir des
Ziel-Repos. Der Dateiname ist die semantische Session-ID, und die kollidiert über Repos hinweg.
Gelesen wird über `node scripts/fleet-auflagen.mjs <session_id>` (Code: `readAuflagen()`); die
Datei gilt nur, wenn `repo` und das eigene Repo auf dasselbe `git rev-parse --path-format=absolute
--git-common-dir` auflösen, ein Worktree passt also zu seinem Haupt-Checkout. Fehlt das Feld, passt
es nicht oder ist die Datei unlesbar: fail-closed, WARN auf stderr, die Datei zählt als nicht
vorhanden, die Standard-Auflagen gelten.

**Standard-Auflagen (konservative Stufe).** Sie gelten ab `fallback_due_at` (stdout der
Check-in-CLI), wenn bis dahin keine Auflagen-Datei liegt. Die Frist rechnet `fallbackDueAt()`:
`CHECKIN_FALLBACK_MIN` = 10 Minuten nach `checkin.zeit`, solange ein Navigator aktiv ist; ohne
aktiven Navigator ist `fallback_due_at` gleich `zeit`, die Auflagen gelten also sofort:

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

## Verhalten ohne Flotte

Flottenintegration liegt vor, wenn `NAVIGATOR_CONFIG_DIR` gesetzt und nicht leer ist (ausdrückliches
Opt-in, auch vor dem ersten Anlegen) oder `~/.config/navigator/` als Verzeichnis existiert (Code:
`fleetIntegrationEnabled()`, #1559). Ein Flottenhost hat das Verzeichnis, weil der Koordinator dort
die Lease schreibt. Ohne Flottenintegration validiert `fleet-checkin.mjs` die Eingabe wie immer
(ungültig → Exit 2), schreibt dann aber nichts, legt kein Verzeichnis an, emittiert kein Event und
meldet `{"ok":true,"skipped":"no-fleet",…}`. Es gelten keine Auflagen, auch keine Standard-Auflagen:
ohne Flotte gibt es nichts zu koordinieren. Die Navigator-Zeile im Sessionstart-Banner entfällt
ebenso. Das gilt auch für `plattform: kopflos`: der Datensatz beweist keinen Koordinator, und ein
Schreiben legte das Verzeichnis an, das danach jede Solo-Session zur Flotte macht. Ein kopfloser
Lauf ohne Flottenintegration wendet stattdessen die Standard-Auflagen sofort an — er kann niemanden
fragen. Ein Flotten-Starter, der auf einem frischen Remote-Host startet, setzt deshalb
`NAVIGATOR_CONFIG_DIR` oder legt das Verzeichnis vorher an.

## Verhalten ohne Navigator

Flottenintegration vorhanden, Lease `none` oder `unreadable`: die Check-in-Datei wird **trotzdem** geschrieben (sie ist der
zählbare Beleg), die Standard-Auflagen gelten sofort, es geht keine Nachricht ab. Kopflose Läufe
sind per Nachricht nicht erreichbar und nutzen dieselben Dateien: vor jeder Welle `auflagen/` lesen.

## See Also

`skills/session-start/SKILL.md` Phase 7.6 · `skills/session-start/references/operations-contract.md`
(Peer-Preflight) · Rücklauf-Verweise: `skills/go/SKILL.md` § No plan to execute, `skills/close/SKILL.md`, `skills/wave-executor/SKILL.md` § Completion,
`skills/session-end/SKILL.md` Phase 4.5 · `skills/_shared/state-ownership.md` § Session Identity and Lock Ownership (`role`) ·
`docs/events-schema.md` (`orchestrator.fleet.checkin`) · `.claude/rules/cross-session-messaging.md`
(CSM-003/004) · `scripts/lib/fleet-protocol.mjs` · `scripts/fleet-checkin.mjs`
