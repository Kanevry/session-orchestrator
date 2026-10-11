# so-hud 0.1.0

Native, lesende SO-Anzeige für Claude Code 2.1.296 (Paket A, #1508).
SO-Zustand kommt ausschließlich aus `scripts/so-hud.mjs`; STATE.md, Locks,
Dispatch und Events werden nicht verändert. Der Mod schreibt nur seine eigene
Beacon-Datei und seinen Installationspfad-Cache.

Installation: dieses Verzeichnis als Mod laden. `soRoot` kann auf eine lokale
SO-Installation zeigen. Alternativ dort `node scripts/so-hud.mjs --register-root`
ausführen; letzter Rückfall ist `claude plugin list --json`. Der Sammler selbst
wird mit `--json --repo-root <cwd>` aufgerufen (15 Sekunden, Timeout 3 Sekunden).
Keine dieser Installationsaktionen wird durch die Entwicklungstests ausgeführt.

`$.so.version()` ist 1, `snapshot()` und `beacons()` sind asynchrone Engine-Nomen
(`await`); `profile()` liefert `locker`, `ausgewogen` oder `streng`. Ein kalter
Snapshot ist `null`, ein alter behält seine Messzeit und trägt `age_ms`. Bei einem
fehlgeschlagenen Refresh bleibt er mit `degraded` erhalten. Die deutsche Tabelle
ist aktiv; die englische Texttabelle ist vorbereitet. Owner-Spracherkennung ist
noch nicht verdrahtet, da JSON v1 dafür kein Feld definiert.

Die API `$.fs` dieses Builds bietet weder Umbenennen noch chmod/unlink.
`hooks/beacon-io.mjs` wird deshalb per `$.process.run` mit argv und JSON auf stdin
aufgerufen: temporäre Datei plus rename, 0600, Beacon-Verzeichnis 0700, maximal
4 KB. Der Parent-PID des Helpers bezeichnet den startenden Engine-Prozess;
diese Zuordnung muss im echten Engine-Host noch bestätigt werden. Fremde
Beacons werden validiert; bei Alter >120 Sekunden und nicht nachweisbar lebendem
PID wird ihr Zustand unbekannt. `tool.check: ask` bezeichnet die Weitergabe an
den Entscheider (auch Auto-Modus), nicht den Beweis eines sichtbaren Dialogs.
Es wird niemals eine Tool-Entscheidung verändert.

Grenzen: Status ohne Session-/Wave-Bindung wird nicht einer aktuellen Welle
zugeschlagen. Dispatch enthält nicht immer Agent-Typ oder Modell; diese Felder
bleiben dann null. Peer-Scope ist unbekannt, wenn eine der beiden Scope-Quellen
fehlt oder Scope-Signale lückenhaft sind. Events betrachten nur die letzten
512 KB; dies wird als `events:tail-only` gemeldet. Keine vollständige Historie.

Prüfung: `npx vitest --run tests/so-hud` im SO-Repo (CI-Job `test`); CI-Job
`mods:plugin` prüft je Mod `claude plugin validate --strict --json` und
`claude plugin test`. Engine-Integration separat
mit `claude plugin test mods/so-hud`; unter Claude Code 2.1.296 bestehen die
Kit-Tests. `tsconfig.json` folgt dem Header der Typdatei;
die Engine erzeugt `.claude-plugin/types` beim Laden. Kein Rollout, keine Gates,
keine Commands aus späteren Paketen und keine zweite SO-Zustandsführung.
