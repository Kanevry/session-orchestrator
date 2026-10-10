# #1032: Backupteil der Schreibprimitive — Analyse und Entscheidungsvorlage

Status: Phase 1 abgeschlossen; ausschließlich Plan/Analyse. Keine Umsetzungswelle freigegeben.
Refs #1032. Auftrag: so-bb3, Lauf-Branch beim Lead `fix/so-bb3-1032-backup-schreibprimitive`.

## Empfehlung und Entscheidungsgrenze

**Backupteil zunächst behalten; nur Backfill/Migrate gezielt als Vertragsvergleich vorbereiten. Rotation bleibt beim Store.**
18 direkte Sync-Aufrufstellen und 9 direkte Async-Aufrufstellen nutzen die vorhandenen Primitiven; keine übergibt `backup: true`.
Das beweist geringe direkte Nutzung des Backupoptionszweigs, aber keinen fehlenden Sicherungsbedarf:
vier Sync-Aufrufer sichern selbst, Proposal-Clear archiviert selbst, Learnings hält ausdrücklich drei Sicherungen.
Die offene Entscheidung ist Nutzung/Migration versus kompatible Verkleinerung dieses Zweigs; der allgemeine atomare Schreibkern und der Async-Zwilling sind bereits vorhanden.

Keine API-Entfernung, Migration, globale Adapterverschärfung, neue Rotation, historische Rewrite-Sweeps oder Live-Datenproben in diesem Lauf.
Ein späteres `/go` darf erst nach Lead-/Vertragsentscheid und vollständiger neuer Code-/Testfläche beginnen; dieses Dokument autorisiert Phase 2 nicht.

## Belegstand und Prämissen

- Im Brief vom Lead gemessener main: `fb94819e31e04fe435b7180dde2ab49d97bd4cd8`, Messdatum `2026-10-10T07:10:27Z`.
- Hier erneut vorhandenes Commitobjekt und Code gemessen: `fb94819e31e04fe435b7180dde2ab49d97bd4cd8`, Messdatum `2026-10-10T07:19:37Z` (Uhr: `date -u +%FT%TZ`).
- Lokaler geprüfter HEAD: `c6d53e746e1de540e66f41f760546c148e346660` (Offload-Snapshot), abgelöst, kein Lauf-Branch lokal ausgecheckt. Kein Branchwechsel/Indexschreiben.
- `origin/main` fehlt; keine Netzaktualisierung erlaubt. Lokal gespeicherter `main` ist `1d0d0873c0c61ba668a9d6fe9148459d1a9bd364`, nicht als aktueller Remote-Stand verwendet.
- `git diff --name-only fb94819e31e04fe435b7180dde2ab49d97bd4cd8 HEAD`: nur `agents/code-implementer.md` und `skills/claude-md-drift-check/package-lock.json`; sämtliche untersuchten scripts, Tests und CI sind unverändert. Alle untenstehenden Zeilenkoordinaten beziehen sich auf das gemessene main-Objekt, nicht auf eine Drei-Punkte-Merge-Base.
- `git rev-list --left-right --count fb94819e31e04fe435b7180dde2ab49d97bd4cd8...HEAD` = `0 3`; das ist keine Aussage über heutiges Remote-main.
- Live-Issue, Kommentare, Labels, MR-/CI-Status und externe Consumer: **nicht messbar**, Netz/glab verboten. Issueprämissen stammen aus dem Owner-/Lead-Brief, keine neue API-Verifikation behauptet.
- `triage-belegvertrag.md` und die externe Triage-Datei sind hier nicht vorhanden; der im Brief vollständig wiedergegebene Belegvertrag wird angewandt. Keine anderen Repos gelesen.

Zensus: `git grep -n 'atomicWriteWithBackup(' fb94819e31e04fe435b7180dde2ab49d97bd4cd8 -- scripts hooks skills`: 19 Treffer einschließlich einer Definition, also 18 direkte Stellen. Async analog: 10 einschließlich Definition, also 9 direkte Stellen in 7 Dateien. Kommentare, Definitionen, Tests und dynamische/fremde Consumer sind keine Aufrufstellen dieses Zensus.
Historische „24“, „~16“ bzw. „THREE PRODUCTION CALL-SITES“ (`scripts/lib/io.mjs:953`) sind **keine aktuelle Anzahl** und kein Anlass für einen Sweep.

## Kandidaten- und Vertragsmatrix: Sync

Die Prämisse jeder Zeile ist der im Brief genannte #1032-Aufrufer: Bedarf und Fehlervertrag anhand des Codes entscheiden.
„Nicht gefordert“ bezeichnet den gelesenen Vertrag, nicht eine Empfehlung keep-0; „kein Lock“ ist auf die genannte Ebene begrenzt.
Jede Zeile enthält den vollständig gemessenen main-SHA und das lokale Messdatum.

| Aufrufer / Codeanker | Prämisse und Urteil | Backupformat / Auslöser / keep-N | Fehler / Restore / Lock / Adapter | Offener Rest / Entscheidung | Gemessener main-SHA / Messdatum |
|---|---|---|---|---|---|
| JSON-Delegation · `scripts/lib/io.mjs:896–907` | Backupbedarf nicht gefordert; Delegation bereits umgesetzt | Keines / nie / nicht gefordert | Serialisierung und FS als Envelope; Erfolg nur {ok:true}; kein Restore/Lock; keine DI-Weitergabe | Kein Migrationsrest | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Board · `scripts/lib/vault-status/board-writer.mjs:600–690` | Backupbedarf ausdrücklich 0; Adapterentscheidung offen | Keines / nie / 0 | skipped-write-failed; ableitbar aus Locks/Registry; Handnotizen-/Noop-Guards; partieller fs-Adapter; writeBoard selbst ohne Lock, höherer Boardpfad mit withBoardLock | Nur abgegrenzte 2b-Entscheidung, kein Backup einschalten | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Regelablauf · `scripts/lib/reconcile/rule-expiry-sweep.mjs:945–948,967–968` | Kein Backup gefordert; Fehlersemantik bewusst unterscheiden | Keines / nie / nicht gefordert | new Error(res.error), code entfällt; errors[] pro Datei; kein Restore/Lock an Schreibstelle; echtes fs | Vertrag dokumentieren, keine beiläufige Fehleränderung | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Regelwriter · `scripts/lib/reconcile/writer.mjs:320–322,819–830` | Kein Snapshotvertrag belegt | Keines / nie / nicht gefordert | envelopeToError; Batch unter rules.lock; kein Restore; echtes fs; Aufrufer-Pfadgates | Kein offener Migrationsrest, Snapshotpflicht nicht erfinden | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Bootstrap-Refresh · `scripts/lib/bootstrap-lock-refresh.mjs:94–112` | Kein Backup gefordert; Provenienz ist historisch | Keines / nie / nicht gefordert | message/code werfen; bestehende Provenienz bis auf Refresh-Felder erhalten; kein Restore/Lock; echtes fs | Historischen Wiederherstellungsbedarf vor zusätzlicher Pflicht entscheiden | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Telemetrie · `scripts/lib/autopilot/telemetry.mjs:51–64` | Kein Backup gefordert, kein vollständig herleitbarer Cache | Keines / nie / nicht gefordert | read→append→rewrite; Lesefehler als leer behandelt; message/code werfen; kein Restore/Lock; echtes fs | Snapshotbedarf ungeklärt; keine automatische Rotation | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Vault-Baseline · `scripts/lib/vault-sync-baseline.mjs:53–83` | Historische Messung, kein Snapshotvertrag | Keines / nie / nicht gefordert | message/code werfen; ungültiges Lesen null; historische errors/warnings/Schemahash/Zeit; kein Restore/Lock; echtes fs | Neue Messung ersetzt alte Baseline nicht identisch | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| UX-Ledger · `scripts/lib/ux-grill/run-record.mjs:245–297` | Kein Backup gefordert, Wiederherstellung ungeklärt | Keines / nie / nicht gefordert | message/code werfen; fehlerhafte Zeilen erhalten; kein Restore; NO lock ausdrücklich wegen Einzelkoordinator, Parallelcollect Revisit; echtes fs | Keine Ledgerprobe, kein ungefragter Lock | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Backfill-Sessions · `scripts/backfill-sessions.mjs:246–275` | Eigene Sicherung belegt; begrenzter Vergleich offen | <file>.bak-<ISO, :/.→-> / Nicht-dry-run / nicht gefordert | copy zuerst; dann Primitive ohne Backup; Recovery-Ausgabe und Exit 1; manueller Restore; kein Lock; echtes fs | Mit Migrate vergleichen; fehlendes Original muss weiterhin Fehler sein | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Migrate-Sessions · `scripts/migrate-sessions-jsonl.mjs:417–438` | Eigene Sicherung belegt; begrenzter Vergleich offen | <file>.bak-<ISO, :/.→-> / --apply / nicht gefordert | copy zuerst; message/code intern, Recovery-Ausgabe und Exit 1; kein Auto-Restore/Postverify/Lock; echtes fs | Gleiche Grundform wie Backfill, Recoverytexte getrennt erhalten | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Cross-Repo-Migrate · `scripts/run-migrate-v2-cross-repo.mjs:206–239,314–342` | Eigenes Format und Lock schließen blinden Austausch aus | <file>.bak-cross-repo-migrate-<ms> / apply / nicht gefordert | read→backup→rewrite unter Learnings-Store-Lock; catch als status:error; kein Auto-Restore; echtes fs; ausschließlich Quelltext gelesen | Kein ausführbarer Laufkandidat dieses Briefs | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Session-Repair · `scripts/lib/session-record-repair.mjs:757–837` | Eigenes Snapshot-/Restoreformat belegt | <file>.bak-<compact stamp> / apply und backup=true (Default) / nicht gefordert | Copyfehler werfen; Postverify bei Regression Restore aus Backup oder Originalbytes; I/O message/code; kein Lock im Modul/CLI; read/copy DI separat, write/rename/unlink DI an Primitive | Kein Standardbackup als austauschbar behandeln | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Proposal-Clear · `scripts/lib/memory-proposals/sink.mjs:316–324,357–389` | Kein Primitivebackup, eigener Recovery-Archivvertrag belegt | proposals-archive.jsonl Append / vor Clear nichtleerer Bytes / nicht gefordert | Archiv-I/O best-effort, unsicherer Archivpfad blockiert Clear; Clearfehler cleared:false/summariesCleared:0; no-throw; kein Restore/Lock; echtes fs | Archiv erhalten, keine echten Proposals löschen | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| SHA-Marker · `scripts/lib/quality-gate.mjs:411–416` | Herleitbar, Backupbedarf 0 | Keines / nie / 0 | Best-effort, Envelope ignoriert/umgebender catch; kein Restore/Lock; echtes fs | Kein Migrationsrest | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Reconcile-Queue · `scripts/lib/reconcile/idempotency.mjs:154–172` | Kein Backup gefordert, terminale Entscheidungen nicht komplett herleitbar | Keines / nie / nicht gefordert | Serialisierung catch; eigenes Erfolgsergebnis oder Fehler-Envelope; no-throw; kein Restore/Lock; echtes fs | Snapshotbedarf getrennt entscheiden | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Evolution-Queue · `scripts/lib/skill-evolution/idempotency.mjs:195–214` | Kein Backup gefordert, anderer fachlicher Idempotenzschlüssel | Keines / nie / nicht gefordert | Physische ID/Supersession statt learning-key; Envelope; kein Restore/Lock; echtes fs | Gleiche I/O-Form beweist keinen gleichen Snapshotbedarf | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Evolution-Engine · `scripts/lib/skill-evolution/engine.mjs:271–290` | Kein Backup gefordert; fachlicher Ergebnisvertrag | Keines / nie / nicht gefordert | Read/writefehler ok:true,applied:false,reason; no-op bei aktuellem Inhalt; kein Restore/Lock; echtes fs | Ergebnisvertrag unverändert lassen | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| Slopcache · `scripts/lib/slopcheck.mjs:159–177` | Herleitbar, Backupbedarf 0 | Keines / nie / 0 | Serialisierungs-/Schreibfehler Warnung code/message; Resultat weiter nutzbar; kein Restore/Lock; echtes fs | Kein Migrationsrest | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |

## Async-Zwilling: ergänzender direkter Zensus

Prämisse je Zeile: schon vorhandene async Primitive nutzen, keinen weiteren Zwilling bauen.
Urteil bei allen neun Stellen: bestehende API-Nutzung, keine belegte Nutzung ihres Backupoptionszweigs.
Backupformat/Auslöser/keep-N der Primitive jeweils **nicht gefordert**; keine fs-Injektion an diesen Calls.
Aufruferseitige Archive und Rollback-Manifeste sind separat ausgewiesen; aus fehlender Option folgt kein allgemeiner Recoverybedarf 0.

| Codeanker | Fachlicher Fehler-/Recoveryvertrag und Urteil | Gemessener main-SHA / Messdatum |
|---|---|---|
| `scripts/lib/peer-cards/writer.mjs:122–124` | USER/AGENT-Karten; message/code werfen; kein Snapshot/Restore/Lock am Call; kein neuer Migrationskandidat ohne weiteren Vertrag | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| `scripts/lib/worktree/meta.mjs:64–67` | Metadaten; message/code werfen; zufälliger Tmp; kein Snapshot/Restore/Lock am Call; kein neuer Migrationskandidat ohne weiteren Vertrag | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| `scripts/lib/auto-dream.mjs:248–251` | Pending-Proposal; message/code werfen; kein Snapshot/Restore/Lock am Call; kein neuer Migrationskandidat ohne weiteren Vertrag | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| `scripts/lib/auto-dream.mjs:474–480` | MEMORY-Rewrite, danach Pending konsumieren; kein Vorherbackup/Restore belegt; historische Inhalte nicht pauschal herleitbar; kein neuer Migrationskandidat ohne weiteren Vertrag | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| `scripts/lib/auto-dialectic.mjs:316–323` | last-run-Marker; Fehler ok:false,error; kein Snapshot/Restore/Lock am Call; kein neuer Migrationskandidat ohne weiteren Vertrag | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| `scripts/lib/auto-dialectic.mjs:406–409` | Pending-Proposal; message/code werfen; separates Consume-Archiv keep-10 (:54–66,494,542–549), kein Rewritebackup; kein neuer Migrationskandidat ohne weiteren Vertrag | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| `scripts/migrate-vault-paths.mjs:524–527` | Rewrite-Wrapper; message/code werfen; am Wrapper kein Snapshot/Restore/Lockvertrag; kein neuer Migrationskandidat ohne weiteren Vertrag | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| `scripts/sweep-expired-learnings.mjs:672–678` | Snapshot-Sidecar selbst Ziel des Writes; Fehler stderr/Exit 2; keep-3 schützt späteren Store-Apply, nicht Sidecar; kein neuer Migrationskandidat ohne weiteren Vertrag | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |
| `scripts/relocate-vault-corpus.mjs:700–722` | Neuer zeitgestempelter Reverse-Manifestpfad für Rollback; message/code werfen; kein Vorversionbackup/Lock am Call; kein neuer Migrationskandidat ohne weiteren Vertrag | `fb94819e31e04fe435b7180dde2ab49d97bd4cd8` · 2026-10-10T07:19:37Z |

## Vergleich außerhalb des direkten Zensus: Learnings

Prämisse: vorhandene keep-3-Policy könnte zentralisiert werden. **Urteil: derzeit nicht belegt.**
Gemessener main-SHA `fb94819e31e04fe435b7180dde2ab49d97bd4cd8`, Messdatum `2026-10-10T07:19:37Z`.
Anker: `scripts/lib/learnings/io.mjs:401,422–475,563–594`.

- Format: `<file>.bak-<ISO, :/.→->`; bestehende Ziele bei Rewrite mit `backup=true` (Default); dry-run schreibt nichts.
- keep-N = **3**. Alte `.bak.` und neue `.bak-` Formen werden erkannt; Rotation sortiert bereinigte Timestamp-Suffixe.
- Read, Backup, Rotation und Rewrite unter reentrantem Store-Lock; das fachliche aufrufende read-modify-write muss denselben Lock umfassen.
- Backup-Copyfehler verhindern Rewrite; Rotationsfehler sind best-effort. Kein automatisches Restore in rewriteLearnings; separater Restore nutzt denselben Namensklassifikator.
- Validation und Erhalt malformed lines bleiben beim Store. Keine Injektions-API in diesem Writepfad.
- Primitive rotiert ausdrücklich nicht (`io.mjs:934–937`). Nur **ein** keep-3-Vertrag belegt; zwei ähnlich benannte Backfill-Backups ohne Retention sind kein zweiter keep-3-Vertrag.
- Migration würde Backup/Rotation-Reihenfolge und Lockhaltung berühren; vorerst kein Kandidat. Legacy-Namenszweig nicht aus diesem Repo allein entfernen.

## Isolierte Reproduktionen und Grenzen

Am unveränderten HEAD mit Node `v24.20.0` ausgeführt:
`perl -e 'alarm shift; exec @ARGV' 60 node /private/tmp/so-bb3-1032.JtB37O/probe.mjs`.
Log: `/private/tmp/so-bb3-1032.JtB37O/probe.log`; tatsächlicher Exit **0** und terminale Zeile
`TESTENDE cases=8 exit=0 fs=memory-only`.

1. Sync erstellt Vorher-Snapshot vor Write/Rename, mit erwartetem Namen; keine Rotation.
2. Synthetischer Copy-`EACCES` erhält Originalbytes und verhindert Write/Rename; Envelope behält code.
3. Synthetischer Rename-`EIO` erhält Original und Snapshot; Tmp-Cleanup ausschließlich im Map-Adapter; kein Auto-Restore.
4. Sync verweigert partiellen Backupadapter vor jedem FS-Aufruf.
5. Async verweigert fehlende Copy-Methode vor jedem FS-Aufruf und löst auf Fehler-Envelope auf.
6. Async verwendet gleiches Snapshotformat; keine Rotation.
7. Async Copy-`ENOENT` erlaubt Erstschreiben mit `backupPath:null`.
8. Board mit Map-write/rename und fehlendem copy liefert `written` bei deaktiviertem Backup.

Sämtliche Ziel-/Backup-/Tmpbytes nur in Maps; keine realen Board-/Ledger-/Lock-/STATE-Dateien, keine reale Rotation oder Datenlöschung.
Probeskript und Logs bleiben als eigene temporäre Belege stehen. Dies ist Vertragsanalyse, kein neuer Repo-Test.
Vorhandene einschlägige Tests wurden gelesen (`tests/lib/io.test.mjs:660–675,737–785,860–898`,
`tests/lib/vault-status/board-writer.test.mjs:212–249,344–363`); nicht ausgeführt.

Historische Sweeps nicht erneut gebaut oder als offen angenommen. Der zeitgebundene Board-Legacy-Trigger ist **geparkt**:
Probe 8 belegt den expliziten Map-Rename, nicht produktiven Real-FS-Fallback mit `renameSync:undefined`, keinen historischen Vorherzustand.
Keine Board-Fehlerprobe mit partieller DI, weil Board `unlinkSync` nicht weiterreicht und sonst Cleanup echten FS erreichen könnte.
Keine Darwin-/Linux-/Windows-Dateisystemgarantie aus Map-Proben ableiten; Ziel-OS-Wirkung **nicht messbar** in diesem Lauf.

## Entscheidungsvorlage

| Option | Nutzen und Kosten | Erforderlicher Vertrag vor Freigabe | Urteil |
|---|---|---|---|
| Behalten, gezielt migrieren | Öffentliche Sync/Async-Envelopes bleiben; mögliche Nutzung des bisher ungenutzten Backupzweigs durch zwei verwandte Aufrufer | Backfill/Migrate exakt vergleichen: fehlendes Original, Copyfehler, Renamefehler, Snapshotpfad in Summary/Recoverytext, Timestamp, Dry-run, mkdir-Reihenfolge | **Empfohlen als nächster Vergleich**, keine Migration jetzt |
| Backupzweig verkleinern | Weniger ungenutzte Policy/DI-Fläche | Externe Consumer erfassen; Deprecation und kompatiblen Weg beschließen; Optionen/backupPath/now und Tests auf API-Vertrag prüfen | Owner-/Kompatibilitätsentscheidung, aktuell kein Removal |
| Rotation zentralisieren | Nur bei gleichen Retention-/Fehler-/Namensverträgen hilfreich | Mindestens zwei reale Aufrufer mit gleichem keep-N und passenden Lock-/Recoveryverträgen | Nicht erfüllt; verwerfen |
| Globale Totaladapterpflicht | Könnte versehentliche reale FS-Fallbacks verhindern | Board-Produktionsform und Repair-DI getrennt prüfen; produktive Default-Fallbacks dürfen nicht blind abgewiesen werden | Kein globaler Kandidat |

**Konkreter Haken bei Backfill/Migrate:** Eigenes `copyFileSync` wirft bei fehlendem Original.
Sync-Primitive prüft Exists und überspringt Backup bei Erstschreiben; Async behandelt Copy-`ENOENT` als Erstschreiben.
Ein simples `backup:true` verändert deshalb den Fehlervertrag, auch bei gleichem Namen und keep-N.
Beide CLIs lesen das Original schon vorher: Der relevante Unterschied betrifft insbesondere ein zwischen Lesen und Sicherung verschwundenes Ziel (TOCTOU), nicht den normalen CLI-Einstieg mit fehlender Eingabedatei.
Zudem sichern die CLIs vor dem mkdir der Primitive, erhalten eigene exakte Recoverytexte und Summaryfelder.
Erst wenn diese Unterschiede ausdrücklich erhalten oder fachlich beschlossen sind, darf eine Migration vorgeschlagen werden.
Keine generische Pflicht zu Snapshots bei Telemetrie, Baselines oder Queues aus deren wertvollen Daten ableiten.

Die APIs sind exportiert und in `package.json` ohne `exports`-Map öffentlich deep-importierbar.
Entfernung/Umbenennung/veränderte Laufzeitsemantik muss den Migration-/Breaking-Vertrag aus
`.claude/rules/development.md:89–93` und § Package Lifecycle beachten; kein Patch-Removal auf Basis eines lokalen Zensus.

## Sessionstart: jede Phase geprüft, eingeschränkter Offload-Vertrag

Der spezielle Phase-1-Auftrag ersetzt die schreibenden/externalen Teile des regulären Sessionstarts. Kein vollständiger normaler Sessionstart behauptet.

| Phase | Befund / Behandlung |
|---|---|
| 0 Bootstrap | AGENTS/CLAUDE mit Session Config vorhanden; bootstrap.lock gültiger version/tier-Marker; offen |
| 0.5, 1.2 Peer/Besitz | Startbaum sauber; keine lokale session.lock, STATE.md oder Filescopes vorhanden; Zielplan noch nicht vorhanden. Starterbeleg übernommen; kein slot check, keine Lockidentität abgeleitet. Laufende externe Autoren **ungeklärt** |
| 1 Config | Committed Config gelesen: deep, persistence true, enforcement warn, npm, docs-orchestrator false, vault true. Keine owner.yaml außerhalb cwd gelesen; Defaults full/minimal/neutral; kein Override/Configwrite |
| 1.05, 1.1 | Telemetrieschreibfläche nicht freigegeben; kein Self-report. Dispatcherblock vorhanden, kein Migrationsbedarf |
| 1.5–1.6 | Kein STATE und keine lokalen metrics sessions/learnings; keine historische Continuity/Trendbehauptung. Keine Metricsanlage |
| 1.7, 2.7 | Vault/Portfolio nicht ausgeführt: andere Repos und Vaultschreiben verboten |
| 2 Git | HEAD, 20 jüngste Commits, sauberer Baum, lokale Branches und Vergleich zum Brief-SHA gelesen; Remote ahead/behind unbekannt; kein Fetch |
| 2.5–2.6 | Docs-Orchestrator deaktiviert; Steering product/tech/structure gelesen; Plan als einzige Produktdatei |
| 3 VCS | Ausschließlich Brieflage #1032; offene/geschlossene Issues, MR, CI live nicht messbar |
| 4 Umgebung | Node 24.20.0 und Perl vorhanden; npm-canonical/package-lock; Dependencies schon vorhanden, keine Installation. CI **nicht gemessen**, nicht als grün behauptet |
| 4.5 Ressourcen | Höchstens zwei lesende Subagents plus Koordinator; kein Heavy-Gate. ps sandboxgesperrt (Exit 127), Live-Prozess-/Waisenmessung nicht messbar |
| 5 Cross-Repo | Nicht konfiguriert/freigegeben; kein fremdes Repo gelesen |
| 6, 6.5–6.8 | Synergie Backup/Fehlerverträge; keine lokalen STATE-Fragen/Learnings; Claude-Memory auf Codex nicht verfügbar; keine Telemetrie-Consentfrage im Headless-Lauf |
| 7, 7.1, 7.5 | Main-Prämissen durch direkten Zensus und unveränderten Diff geprüft; expliziter deep-Analyseauftrag bleibt; keine Mode-/Learningswrites |
| 8–9 Alignment/Plan | Analyse-only bereits gedeckt; beantwortete Entscheidungen unten protokolliert. Mechanische Shape nur dry-run; kein STATE-/Issuewrite, keine Welle |

## Wellenplan als Vorlage nach Vertragsentscheid

Issuebündel ausschließlich #1032; Backfill/Migrate, Repair, Board und Learnings sind Vergleichsgruppen desselben Issues,
keine neuen Issues oder Sweep-Aufträge. Erledigte 1a/2a und abgegrenzte 1b/1c nicht erneut laden.
2b bleibt Vertrags-/Ownerentscheid, 3c zeitgebunden, Lock-/Guard-Themen #490 bleiben Owner-Queue laut Brief.

Shape-Aufruf:
`perl -e 'alarm shift; exec @ARGV' 30 node scripts/session-shape.mjs --repo-root "$PWD" --session-type deep --known-scope true --task-count 1 --no-event`.
Exit 0, Log `/private/tmp/so-bb3-1032.JtB37O/shape.log`: vier Rollen (Impl-Core, Impl-Polish, Quality, Finalization), Discovery entfällt bei known-scope.
**Ownerabweichung:** Hier ausschließlich abgeschlossene Analyse; kein ausführbarer Vierwellenplan und keine Welle gestartet.
Future-Scope derzeit unvollständig, daher keine automatische Übernahme von known-scope in /go.

| Mögliche spätere Welle | Agenten / Modelle / Ort | Aufgabe und Startvoraussetzung |
|---|---|---|
| Vorcheckpoint, seriell | Lead/Opus 5.5 auf M4; Sol 6.1 Medium als lesender Vertragsanalyst | Option entscheiden; aktuelle Peerflächen, Issue, main und komplette Code-/Testfläche belegen. Keine API-Entfernung ohne Ownervertrag |
| 1 Impl-Core | 1 Implementierer Opus 5.5 nativ gemäß SO-Code/Testvorgabe, M4; unabhängiger lesender Reviewer Opus 5.5 | Nur beschlossener kleiner Adapter-/Callerfall; konkrete Dateien erst nach Entscheid. Keine Sweepmigration |
| 2 Impl-Polish | 1 Sol 6.1 Medium für Doku; Implementierung mit Ermessen Opus 5.5 | Nur aus dem Review begründete Nacharbeit, sonst leer; keine Aufgaben zum Füllen der Rolle |
| 3 Quality | 1 Testrolle Opus 5.5 für SO-Code/Test; Sol 6.1 Medium für vorgegebene Gates, M5/CI; 1 Opus-Reviewer | Einzeldatei-Tests zeitgedeckelt, gegenseitiger Vertragsreview, volle passende CI; OS-Pfade gezielt prüfen |
| 4 Finalization | Lead Opus 5.5 auf M4 | Vollständiger Diff/Peer-/CI-Review; Commit/Push/MR/ggf. Merge ausschließlich Lead; keine Veröffentlichung |

Maximal vier aktive Subagents, für diese kleine Fläche regelmäßig ein Autor und ein lesender Reviewer; gemeinsam beschriebene Dateien seriell.
In Phase 1 tatsächlich eingesetzt: Codex-Koordinator mit zwei nativen, ausschließlich lesenden Subagents (`gpt-6.1-sol`, Effort Medium), Rollen Aufruferzensus und unabhängiger Vertrags-/Planreview. Keine Opus-Ausführung behauptet; die Modelle der zukünftigen Wellen sind Anforderungen an den Lead, keine bereits verfügbaren oder gestarteten Prozesse.
M5 erhält nur zugelassene Heavy-Rollen/Gates nach Reservierungs-/Lastprüfung, nie parallele Vollsuiten.
Auf main soll in Phase 1 allenfalls dieser geprüfte Plan landen; spätere Codeänderung erst nach dem Vorcheckpoint.

**Zeitdeckel auf m5 (#245), wörtlich:** Fehlt `timeout`, jeden lokalen Test- und Gate-Aufruf ohne Installation mit `perl -e 'alarm shift; exec @ARGV' <sek> <befehl>` begrenzen. Fehlendes `timeout` allein rechtfertigt kein Parken der Testbaseline. Fehlt auch Perl oder das eigentliche Prüfwerkzeug, bleibt der Befund „nicht messbar“. Keine coreutils installieren. Der Starter-Zeitdeckel beträgt 5400 s; Einzelprüfungen müssen in das verbleibende Budget passen. Der Perl-Alarm ersetzt keinen garantierten Prozessgruppen-Abbau mit Kill-Nachfrist. Vor Abschluss eigene Gate-Kinder per `ps` prüfen, auch auf Waisen mit PPID=1, und keine laufenden Prüfungen zurücklassen.

## Vollständige Schreibfläche und Kollisionsmatrix

Phase-1-Produktfläche vollständig: **nur neu `docs/plans/triage-2026-10-10-atomic-backup.md`**.
Zusätzlicher ausdrücklich vorgeschriebener Offload-Parkplatz: **neu `.fleet-m5/parkplatz.txt`** (Startertransport, keine Codefläche).
Eigene Arbeitsbelege ausschließlich `/private/tmp/so-bb3-1032.JtB37O/`; keine sonstigen Repo-Arbeitsdateien.
Künftige Adapter-/Testfläche **unvollständig**; genannte Vergleichsmodule sind Leseflächen, keine künftige Schreibfreigabe.

| Gegenbündel / Autor | Belegte Gegenfläche | Verhältnis / Behandlung |
|---|---|---|
| S1157 | Lokaler jüngster Merge betrifft agents/code-implementer.md; vollständiger anderer Planscope hier nicht geliefert | Gegen diese belegte Datei disjunkt; laut Lead-Triage parallel planbar; vollständige aktuelle Kollision ungeklärt |
| S856 | Keine vollständige lokale Dateifläche im Brief/Checkout | Laut Lead disjunkt/parallel planbar; unabhängig aktuell ungeklärt |
| S1026 | Keine vollständige lokale Dateifläche im Brief/Checkout | Laut Lead disjunkt/parallel planbar; unabhängig aktuell ungeklärt |
| S1021 | Keine vollständige lokale Dateifläche im Brief/Checkout | Laut Lead disjunkt/parallel planbar; unabhängig aktuell ungeklärt |
| S990 | Keine vollständige lokale Dateifläche im Brief/Checkout | Laut Lead disjunkt/parallel planbar; unabhängig aktuell ungeklärt |
| Laufende externe Autoren | Lokale Locks/Scopes fehlen; ps gesperrt, andere Repos unzulässig | Ungeklärt bis Lead aktuelle Gegenflächen vorlegt |
| Analyseagent contracts / review_basis | Keine Schreibfläche, nur cwd-lesend | Disjunkt zu Planautor; beide abgeschlossen vor Ende |
| Spätere io-/Board-/Callerautoren | Künftige Schreibfläche unvollständig | Gemeinsame Datei seriell; keine parallele Umsetzung ableiten |

Nur vollständig belegte disjunkte Flächen erlauben „parallel planbar“ als eigene Schlussfolgerung.
Keine belegte Kollision ist kein Disjunktheitsbeleg. Der Planpfad war bei Beginn unbelegt/untracked; nur Koordinator schreibt ihn.

## Fragen, Parkplatz und Risiken

Beantwortet und gedeckt:
1. Analyseumfang? Nur #1032 und neue Plandatei, keine Welle; Ownerbrief.
2. Fehlende origin/main-Ref? Vorhandenes Brief-Commitobjekt verwenden, Snapshotabweichungen offen nennen, kein Fetch.
3. Historische Aufrufzahlen/Async neu bauen? Verwerfen; aktueller Zensus und vorhandener Zwilling.
4. Rotation zentralisieren? Nein, keine zwei gleichen keep-N-Verträge.
5. Baseline-Vollsuite? Keine lokale Vollsuite für Plan-Diff; sichere Map-Proben und bestehende Dokuprüfung, CI beim Lead bleibt offen.

Geparkt und ungedeckt:
- API-Verkleinerung/Removal, Migration und Retentionpflicht bis Vertrags-/Ownerentscheid; externe Consumer unbekannt.
- Board-2b-/Legacy-Real-FS-Nachweis, echte Ledger/Lock/STATE-Proben, Löschungen und reale Backuprotation.
- Aktuelle externe Autorflächen, Remote-/Issue-/CI-Zustand und Projektkonfiguration durch Lead messen.
- Ziel-OS-Dateisystemwirkung sowie ps-Waisenbeleg; Sandbox verweigert ps, keine OS-Abnahme behaupten.
- Commit/Push/MR/Merge/Release/Publish und jede Außenwirkung; hier nicht durchgeführt.

Risiken für einen unbeaufsichtigten Folge-Lauf: historische Zahlen als offene Migration missverstehen; keep-0 aus fehlenden Backups ableiten;
fehlendes Original plötzlich als Erstschreiben erlauben; Recoverytexte/backup_path/Lock-Reihenfolge verlieren;
Board-Fallback durch Totaladapterpflicht blockieren; Telemetrie/Queues als Cache behandeln; externe Deep-Imports brechen;
aus Map-Proben FS- oder OS-Garantien ableiten; unbekannte Peerflächen als disjunkt behandeln.
Alle eigenen Prüfaufrufe haben abgeschlossene Toolresultate; beide Analyseagenten einschließlich Planreview haben finale Berichte geliefert. Unabhängige Prozess-/Waisenmessung per ps bleibt nicht messbar.

## Gate-Tabelle und Lead-Übergabe

Alle lokalen Prüfungen am vollständigen HEAD `c6d53e746e1de540e66f41f760546c148e346660`,
uncommittete Fläche ausschließlich Plan/Parkplatz. Ausführungsort: dieser m5-Offload-Arbeitsordner.
Kein grüner Einzelbeleg ersetzt Repo-CI.

| Befehl / Prüfung | SHA / tatsächliches Ergebnis | Log / Ort |
|---|---|---|
| git cat-file -t fb94819e31e04fe435b7180dde2ab49d97bd4cd8; git diff --name-only Brief-SHA HEAD | main-Objekt vorhanden; unveränderte Fachmodule; Exit 0 | Toolprotokoll und Belegstand oben |
| git grep der zwei Funktionsnamen am Brief-SHA | main-SHA oben; Exit 0; 18 sync / 9 async ohne Definition | Vollständige Aufrufermatrix |
| Perl 60s node probe.mjs (Befehl oben) | HEAD oben; Exit 0; TESTENDE, 8 Memoryfälle | /private/tmp/so-bb3-1032.JtB37O/probe.log |
| Perl 30s node scripts/session-shape.mjs … --no-event | HEAD oben; Exit 0; 4 Rollen als dry-run | /private/tmp/so-bb3-1032.JtB37O/shape.log |
| Perl 60s node node_modules/prettier/bin/prettier.cjs --check docs/plans/triage-2026-10-10-atomic-backup.md | HEAD oben; Exit 0, All matched files use Prettier code style | /private/tmp/so-bb3-1032.JtB37O/prettier.log |
| git diff --check; beide geforderten status-Varianten | HEAD oben; Exit 0; nur Plan untracked, eigener Parkplatz und bekannte Dependencyreste ignoriert | /private/tmp/so-bb3-1032.JtB37O/status.log |
| Lokale Parkplatz-Formatprüfung (9 Zeilen, UTC-Stempel, Felder) | HEAD oben; Exit 0; 9/9 korrekt; navigator ledger verify hier nicht verfügbar | /private/tmp/so-bb3-1032.JtB37O/status.log |
| ps -o pid=,ppid=,command= -p $$ | Exit 127, operation not permitted; **nicht messbar** | Sandbox-Toolprotokoll |
| Vollständige MR-Pipeline am zukünftigen Head | Nicht ausgeführt, kein Netz; offen beim Lead | Noch keine Pipeline-/Job-ID |

CI hat keine docs-Pfadausnahme: `.gitlab-ci.yml:74–78` aktiviert die gemeinsamen MR-/Branch-Gates.
Erforderlich: gitleaks-scan, npm-audit, npm-audit-signatures, semgrep, lint, commitlint, typecheck,
owner-leakage, fixture-shape, plugin-schema-validate, hook-import-set-check, package-manager-guard,
drei Testshards, pack-lifecycle, schema-drift-check und pipeline-gate.
test-value-bans ist zusätzlich warnend. Bestehende lokale Befehle je Bedarf:
`node scripts/validate-plugin.mjs`, `npm run lint`, `npm run typecheck`, `npm test`;
Security/Schema/Pack-Fan-in nicht durch diese Befehle als bestanden behaupten.
Für Doku hier nur gezielte Prettierprüfung/Scopecheck; volle MR-Pipeline mit tatsächlichen Jobs durch Lead.

Versionierte GitLab-main-Regeln lösen Default-Branch-Prüfpipeline plus Coverage (`:758–761`) aus;
Stages `:37–44` und Jobinventar enthalten keinen Deploy-/Release-/Publishjob. vault-watcher nur benannter Schedule (`:1032–1033`).
**Versionierter Gegenbeleg:** `.claude/rules/security.md:100` dokumentiert, dass direkter Push auf GitHub-`main` den Vercel-Produktivdeploy von session-orchestrator.com auslöst; `/close` und Release spiegeln laut diesem Vertrag dorthin.
Die vorhandene `.github/workflows/test.yml:4–5` reagiert ebenfalls auf main-Push; eine dort fehlende Deployjob-Definition widerlegt den externen Vercel-Trigger nicht.
**Externe Projektkonfiguration nicht live messbar**; der Lead muss vor Merge den tatsächlichen Veröffentlichungsweg prüfen und GitHub-Mirror/Prod-Deploy parken. Kein autonomer `/close`-Mirror; bei einem main-Merge, der veröffentlicht, gilt die Owner-Sperre.
Kein pauschales „main veröffentlicht nichts“ über die versionierte GitLab-Datei hinaus.

Finaler Scopebeleg: `git status --porcelain --untracked-files=all` zeigt ausschließlich den neuen Plan.
`git status --porcelain --ignored=traditional` zeigt `?? docs/plans/` und den eigenen neuen Parkplatz als `!! .fleet-m5/`; der Starter muss `.fleet-m5/parkplatz.txt` ausdrücklich mittransportieren, reguläres git staging erfasst ihn nicht.
Zusätzlich ignoriert sind die bereits vor Beginn vorhandenen
`marketing/remotion/node_modules/`, `node_modules/`, `skills/claude-md-drift-check/node_modules/`, `skills/vault-sync/node_modules/` und `skills/vault-sync/package-lock.json`.
Diese Reste gehören zum Starter-/Dependency-Snapshot, wurden hier nicht erzeugt oder verändert und bleiben unangetastet.
Eigene Tempbelege: `/private/tmp/so-bb3-1032.JtB37O/probe.mjs`, `probe.log`, `shape.log`, `prettier-write.log`, `prettier.log`, `status.log`; stehen lassen, keine Löschung.

Commitvorschlag für die einzige Produktänderung:
`docs(io): Begründe Backupverträge und Entscheidungsgrenzen für #1032`.
Parkplatz als Starterprotokoll separat behandeln, kein Commit hier.
