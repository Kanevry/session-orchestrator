# #990: Sicherheitsgrenzen für den Session-Lock-Split

Status: **Phase 1 abgeschlossen; Analysevorschlag, keine Umsetzungsfreigabe.**
Refs #990. Das Issue bleibt offen; der vorhandene Teilsplit erledigt den Rest nicht.

## Auftrag und Belegstand

Der Lead begrenzt die Planphase auf genau dieses neue Planartefakt. Keine Phase 2,
keine Welle, kein `/go`, keine Quell-, Test-, Config-, Hook- oder Runtime-Schreibvorgänge.
Der abweichende Dateiname aus dem ursprünglichen Triage-Zitat wird nicht angelegt.

Messdatum: **2026-10-10T07:48:17Z**. Alle Main-Anker beziehen sich auf
**`e9674ea2df3afedd2790f904ce9188575e3d6d2d`**, gelesen mit
`git show e9674ea2df3afedd2790f904ce9188575e3d6d2d:<datei>` mit Zeilennummerierung.
Keine Drei-Punkte-Diff-Koordinaten.

### Prämisse je Kandidat

Einziger Laufkandidat: **#990**, laut Lead offen, `area:scripts`, `follow-up`,
`priority::low`, `type:chore`. Prämisse: ein großes Lock-Modul enthält weiter
gekoppelte Zustands- und Proofmechanik. Urteil: **teilweise erledigt**, offener
Rest ist die sichere Modulaufteilung, keine aus Größe abgeleitete Sicherheitslücke.

| Reproduktion | Voller SHA | Rohzeilen `session-lock.mjs` | Urteil |
| --- | --- | ---: | --- |
| Historischer Größenstand | `d2de3ca71969e3e96aeb41b1493da82116d5d591` | 1001 | Historische Angabe reproduziert, nicht aktueller Main |
| Historischer Kommentarstand | `317015cecdbd0819a859d4d1717ade6a0d230e1d` | 1310 | Historische Angabe reproduziert, nicht aktueller Main |
| Main des Leads | `e9674ea2df3afedd2790f904ce9188575e3d6d2d` | 1435 | Teilsplit vorhanden, Kern und Proof zusammenliegend |

Reproduktion jeweils `git show <sha>:scripts/lib/session-lock.mjs | wc -l`;
Historie mit `git log <main-sha> --format=%H -- scripts/lib/session-lock.mjs`
und Zeilenzählung der erreichbaren Fassungen geprüft. Die Zählung belegt die
historischen Größen, nicht die zeitliche Zuordnung eines offline nicht gelesenen
Issue-Kommentars. Main-Anker: Barrel-Vertrag `:25–36`, Reexports `:56–80`,
`acquire :581`, `withOwnerProof :875`, `forceAcquire :894`, `reclaimIfNotLive :955`,
Proof-Familie `:1072/:1134/:1189/:1237`, `release :1296`, Heartbeat `:1363`,
Staleness `:1389`. Messdatum und Main-SHA gelten für diesen gesamten Kandidaten.

## Export-, Importer- und Abhängigkeitskarte

### Tatsächliche öffentliche Interface

`scripts/lib/session-lock.mjs` bleibt der kanonische Barrel. Die Kommentare
„22 Symbole / 17 Importer“ (`:29–30`) beschreiben einen historischen Vertrag,
keinen aktuellen Census. Statisch am Main gemessen: **31 benannte Exporte**.
Keine importbasierte Laufzeitprobe in diesem Lauf.

| Gruppe | Exporte | Main-Anker |
| --- | --- | --- |
| Session-Konstanten | `DEFAULT_TTL_HOURS`, `LOCK_PATH`, `FUTURE_HEARTBEAT_TOLERANCE_MS`, `LOCK_LEFTOVER_MIN_AGE_MS`, `OWNER_PROOF_RELPATH` | `:86–134` |
| Lesen / Diagnose | `isLockLive`, `readLock`, `readLockDetailed`, `checkStale` | `:326/:446/:481/:1389` |
| Session-Mutationen | `acquire`, `forceAcquire`, `sweepLockLeftovers`, `release`, `updateHeartbeat` | `:581/:894/:1023/:1296/:1363` |
| Proof-Familie | `buildLockOwnerProof`, `isLockOwnedByProof`, `writeOwnerProof`, `loadOwnerProof` | `:1072/:1134/:1189/:1237` |
| Kompatibilitäts-Reexport | `isPidAliveOnHost` aus `file-lock.mjs` | `:46/:56` |
| STATE.md-Protokoll | `STATE_LOCK_PATH`, `DEFAULT_STATE_LOCK_TIMEOUT_MS`, `STATE_LOCK_POLL_MS`, `acquireStateLock`, `releaseStateLock`, `withStateMdLock` | `:64–71` |
| Staging-Fence-Protokoll | `STAGING_FENCE_LOCK_PATH`, `DEFAULT_STAGING_FENCE_LOCK_TIMEOUT_MS`, `STAGING_FENCE_LOCK_POLL_MS`, `acquireStagingFenceLock`, `releaseStagingFenceLock`, `withStagingFenceLock` | `:73–80` |

Alle Namen, Importpfade, Parameterdefaults, Synchronität und Returnformen erhalten.
Neue Dateien unter `scripts/lib/` sind durch den Package-Dateivertrag mitlieferbar
(`package.json:38`); ohne `exports`-Map werden auch tiefe Importpfade zur
Kompatibilitätsfläche. Keine beiläufig neuen Testhelper-Exporte einführen.
`locks/index.mjs:3–8/:30–38` ist ein warnender Deprecation-Shim, kein neuer
Einstiegspunkt; ESLint sperrt neue Imports davon.

### Produktion: Importer am Main

Statische und dynamische Imports über `git ls-tree -r --name-only <main-sha>
scripts hooks tests` und Lesen der `.mjs`-Blobs ermittelt; kommentierte Pfadtreffer
zusätzlich mit `rg` gegengeprüft. Das ist eine Codekarte, keine universelle
AST-/externe Consumer-Vollständigkeitsgarantie.

| Verwendung | Dateien mit Importanker |
| --- | --- |
| Lifecycle-Hooks | `hooks/_lib/lock-bootstrap.mjs:116/:376` (dynamisch); `hooks/_lib/lock-reconcile.mjs:27`; `hooks/on-session-end.mjs:41`; `hooks/on-session-start.mjs:1289` (dynamisch); `hooks/on-stop.mjs:58`; `hooks/post-tool-batch-wave-signal.mjs:393` (dynamisch) |
| Staging-Fence | `hooks/wave-scope-commit-guard.mjs:60` |
| Erwerb / Übergang / Release | `scripts/lib/dispatcher/cli.mjs:32`; `scripts/lib/autopilot/worktree-pipeline.mjs:35`; `scripts/lib/session-transition.mjs:59`; `scripts/release-session-lock.mjs:48` |
| Discovery / Registry / Reaper | `scripts/lib/dispatcher/enumerate.mjs:36`; `scripts/lib/session-discovery.mjs:69`; `scripts/lib/peer-discovery.mjs:67`; `scripts/lib/session-registry.mjs:45`; `scripts/lib/lock-reaper.mjs:69` |
| Lesen / Attribution / Backfill | `scripts/archive-closed-prds.mjs:52`; `scripts/backfill-abandoned-sessions.mjs:49`; `scripts/lib/events.mjs:56`; `scripts/lib/session-close-backfill.mjs:61`; `scripts/lib/sessions-staleness-banner.mjs:147`; `scripts/lib/skill-evidence-window.mjs:55`; `scripts/lib/wave-transcript-tail.mjs:61`; `scripts/lib/vault-status/board-writer.mjs:56`; `scripts/memory-propose.mjs:52` |
| STATE.md / Session-ID | `scripts/lib/state-md.mjs:21`; `scripts/lib/state-md/frontmatter-mutators.mjs:16`; `scripts/lib/session-id.mjs:48` |

Test-Consumers umfassen `tests/lib/session-lock.test.mjs:21`,
`tests/lib/session-lock-staging-fence.test.mjs:27`,
`tests/unit/state-md-lock.test.mjs:44`, `tests/lib/lock-ttl-parity.test.mjs:22`,
`tests/lib/session-lock-shape.test.mjs:22`, `tests/lib/session-transition.test.mjs:49`,
`tests/lib/vault-status/board-writer.test.mjs:37`, `tests/hooks/lock-bootstrap.test.mjs:20`,
`tests/scripts/release-session-lock.test.mjs:23`,
`tests/integration/parallel-detection-e2e.test.mjs:42`,
`tests/integration/session-identity-boundaries.test.mjs:21` und
`tests/integration/state-md-lock-concurrent.test.mjs:30`.
Die beiden Cross-Process-Suiten für Session-/STATE.md-Locks konstruieren außerdem
absolute Worker-Importpfade (`session-lock-cross-process.test.mjs:95`,
`state-md-lock-cross-process.test.mjs:100`); reine Importzeilen-Suche reicht nicht.
`tests/lib/session-id.test.mjs:27` mockt den kanonischen Pfad.
Direkte Leaf-Tests liegen unter `tests/lib/locks/`.

### Gerichtete Abhängigkeiten heute

```text
Consumer → session-lock.mjs
session-lock → exclusivity-matrix, session-lock-shape, file-lock, io, host-identity
session-lock → locks/state-md-lock, locks/staging-fence-lock (Reexports)
state-md-lock → config/state-md-lock, file-lock, host-identity, locks/lock-body
staging-fence-lock → file-lock, host-identity, locks/lock-body
file-lock → io, host-identity
session-lock-shape → keine Imports
locks/lock-body → keine Imports
```

Node-Stdlib zusätzlich: im Session-Kern `fs`, `os`, `path`, `crypto` (`:40–43`).
Leaf-Imports: `state-md-lock.mjs:37–45`, `staging-fence-lock.mjs:25–31`,
`file-lock.mjs:49–55`. `host-identity` erreicht hostlokale Config-/Owner-Helfer;
„Leaf“ bedeutet hier Einweg-Abhängigkeit, nicht überall pure Implementation.
`session-lock-shape.mjs` muss dagegen importfrei bleiben: sein anderer Consumer
`session-identity/own-session.mjs` liegt im Edit/Write-Hook-Hotpath.
Kein Rückimport zum Barrel, zu Lifecycle-Hooks oder zu `events.mjs`:
`events.mjs:56` importiert den Barrel bereits; `release-session-lock.mjs:23–24`
dokumentiert diesen Zyklusgrund. Events bleiben bei den Aufrufern.

## Vorschlag und Alternativen

**Empfehlung zur späteren Prüfung: zuerst den gesamten Session-Lock-Kern als
eine Implementation hinter dem bestehenden Barrel bündeln.** Hypothetischer
<!-- path-check: planned #990 -->
neuer Pfad: `scripts/lib/locks/session-core.mjs`; er wird hier nicht angelegt.
Die zwei schon getrennten Kurzzeitprotokolle und ihre Leafs bleiben bestehen.

Der Core enthält gemeinsam Erwerb, Reclaim, Cleanup, Read/Diagnose, Heartbeat,
Release und die komplette Proof-Familie einschließlich `withOwnerProof`.
Die Interface bleibt die existierende Barrel-Oberfläche. Einweg-Graph:
Consumer → Barrel → Core → vorhandene Leafs; Core → keine Barrel-/Hook-/Event-Imports.
Der Barrel reexportiert Core-Symbole explizit und behält den PID-Reexport sowie
die STATE.md-/Staging-Fence-Reexports. Alle internen Helfer bleiben privat.

**Depth / Leverage / Locality:** Dieser Schnitt trennt Protokoll-Implementation
von Kompatibilitäts-Interface und konzentriert sicherheitsrelevante Reihenfolge
an einem Ort. Er verspricht noch keine einfachere interne Zustandsmaschine und
keine Sicherheitsreparatur. Der Barrel ist bewusst ein Kompatibilitätsadapter;
beim Deletion test tauchen seine Pfad-/Exportverträge bei allen Consumern wieder
auf. Ein austauschbarer Filesystem-Adapter mit nur einer Implementation wäre
eine hypothetische Seam; dafür gibt es hier keine belegte Notwendigkeit.

| Alternative | Nutzen | Sicherheits-/Wartungskosten | Bewertung |
| --- | --- | --- | --- |
| Kern zunächst unverändert behalten | Kein Import-/Packaging-Diff | Interne Navigation bleibt aufwendig | Zulässiger Default bis zur Freigabe; Größe erzwingt keine Änderung |
| Ein kohäsiver Core hinter bestehendem Barrel | Bestehenden Teilsplit fortführen; Transaktionen und Proof bleiben lokal | Mehr Importkante, Hook-Importset und Packaging prüfen; LOC im Core bleiben hoch | Bevorzugter minimaler Strukturschnitt, vorbehaltlich nativem Review |
| Proof-Familie separat auslagern | Vier Proof-Funktionen thematisch gebündelt | Neue Kopplung über `withOwnerProof`, gemeinsamen `repoRoot`, Zeitstempel und Release; Transaktionsvertrag verteilt | Erst später erwägen, nur gesamte Familie und expliziter Write/Proof-Vertrag; jetzt nicht empfohlen |
| Acquisition / Reclaim / Release / Heartbeat je Datei | Kleine Dateien | Reclaim ruft Acquire zurück, gemeinsame Writer und Proof-Reihenfolge verteilen sich; große interne Interface | Verwerfen als ersten Schnitt |
| Session-Protokoll auf `withFileLock` vereinheitlichen | Weniger vermeintliche Duplikation | Kurzzeitlease, PID-Semantik, Async-Mutex und Session-Heartbeat sind verschiedene Verträge | Außerhalb #990-Teilschnitt; keine Protokollmigration |

## Invarianten und Race-/Fehlerverträge

| Vertrag / Main-Anker | Beim späteren Split erhalten; erforderliche Probe |
| --- | --- |
| No-throw (`session-lock.mjs:9–23`) | Gültige bestehende Aufrufformen und FS-Fehler bleiben strukturierte Ergebnisse; keine Async-Umstellung. Keine pauschale Garantie für jede denkbare ungültige Eingabe ableiten |
| Lesen (`:446/:481–500`) | `readLock`: absent/unreadable/corrupt → `null`; `readLockDetailed`: vier getrennte Zustände. `acquire` darf unlesbar nie als frei interpretieren. EACCES/EISDIR und Corrupt-Fixtures getrennt prüfen |
| Erwerb (`:581–817`, Writer `:387–417`) | Session-ID-Guard vor Writes; Klassifikation und `quiet` erhalten. Tmp+Hardlink ist create-or-fail; EEXIST-Verlierer liest neu, verschwundener Sieger führt konservativ zu `active` mit Null-Feldern |
| Liveness (`:326–334/:1389`) | Heartbeat allein entscheidet Live, kein PID-/started_at-Fallback. Zukunftstoleranz 300000 ms; exakt TTL ist stale, exakt Toleranz bleibt innerhalb der Zeitregel. Fehlende/ungültige/far-future Heartbeats testen; TTL-Diagnose bleibt separat |
| Reclaim (`:894–906/:955–1010`) | `onlyIfNotLive` verschiebt, beurteilt das verschobene Objekt, verlinkt Live-Lock zurück; create-or-fail und frisches Acquire auf Verlustpfaden. Unlesbares Tombstone-Objekt bewahren. Plain force bleibt autorisierter last-writer-wins-Pfad |
| Proof-Write (`:840–877`) | Erfolgreiche Writes aus Acquire, Force und Reclaim rufen unmittelbar `withOwnerProof` mit demselben `repoRoot` auf. Proof-Fehler lässt `ok:true` bestehen, aber setzt `ownerProof:{ok:false,reason}`. Fehlgeschlagener Erwerb schreibt keinen Proof |
| Proof-Familie (`:1072/:1134/:1173–1181/:1237`) | Nur Triple pid + roher host + startedAt vergleicht Ownership; Envelope-IDs/repo_root/written_at sind forensisch. Fehlende/mistypisierte Faktoren → null/false. Keine neue Host-Normalisierung in der Proof-Prüfung |
| Release (`:1296–1346`) | Erst raw session_id, dann vorhandener Proof, dann Unlink. Fehlender/undefined/null Proof aktiviert ausdrücklich den historischen ID-only-Pfad; fail-closed-on-unprovable muss der Aufrufer vorab entscheiden. Proof-Mismatch löscht nicht |
| Release-Retry (`:1325–1346`) | Nachprüfung und begrenzter Retry nur anhand gleicher session_id; fremde andere ID bleibt bestehen. `verified` bedeutet „eigene ID nicht mehr da“, keine universelle Ownership-Garantie |
| Heartbeat (`:1363–1372`) | Guard über gleiche ID, nur last_heartbeat ändern, Boolean-Return beibehalten; tmp+rename ist atomare Sichtbarkeit, keine Compare-and-swap-Garantie |
| Leftovers (`:105–126/:1023–1052`) | Nur exakt eigene alte reguläre Dateien, lstat ohne Symlinkfolge; Alter max(mtime,ctime), Live-/unlesbare Tombstones behalten. Nicht mit Reaper oder globalem Cleanup zusammenlegen |
| Einweg-Imports (`:25–34`) | Vorhandene Leaf-Verträge, alle 31 Exporte und tiefe Importpfade bewahren; keine Events im Core, kein `locks/index`-Import |

Dokumentierte Grenzen sind **keine neu reproduzierten Defekte**:
Reclaim kann einen Live-Lock kurz unsichtbar machen und im dokumentierten
Heartbeat-/Dritt-Erwerber-Interleaving verlieren (`:938–947`). Plain-Force-Lock-
und Proof-Writes können sich überkreuzen (`:855–868`); Zwillinge mit gleicher
raw session_id sind nicht auseinanderzuhalten. Release und Heartbeat haben
Read/Write-Fenster; der Release-Retry prüft keinen zweiten Proof. Ein reiner
Split muss diese Semantik erhalten, darf weder eine Race-Reparatur verstecken
noch „racefrei“ versprechen. Zuerst vorhandene isolierte Fixtures reproduzieren,
dann gegebenenfalls getrennte Entscheidung über eine Verhaltensänderung.

## Spätere Proben und vorhandene Gates

**Hier keine Lock-Tests ausgeführt.** Für einen später freigegebenen nativen Lauf
einzeln, mit Zeitdeckel, frischem Fixture-Root und den vorhandenen Vitest-Setup-
Guards aus `vitest.config.mjs:19–61` planen. Insbesondere host-alias-/Vault-/Event-
Isolation muss auch in erzeugten Worker-Kindern wirksam sein; deren Env-Vererbung
prüfen, nicht aus dem Parent-Setup voraussetzen.

| Probe | Vorhandener Ausgangspunkt / Orakel |
| --- | --- |
| Fresh-acquire Race | `tests/integration/session-lock-cross-process.test.mjs:137/:190`: fünf Barrier-Worker, exakt ein Sieger, gültiger Lock, keine Create-Tmp-Reste; Child-Watchdog und Cleanup vorhanden |
| Stale-Reclaim-Verlierer | `tests/lib/session-lock.test.mjs:1262–1318`: deterministisch B im Tombstone-Fenster sowie B nach A-Create; Sieger-Lock, loser reason und Reste prüfen. Diese Suite belegt kein echtes Multi-Prozess-Reclaim |
| Read-/Write-Faults | Dieselbe Suite `:1814–2063`: EACCES/ENOSPC/EEXIST/vanished/corrupt; nach Split dieselben Branches, kein „frei“ bei unlesbar |
| Proof und Write-Kopplung | Dieselbe Suite Proof-Abschnitte einschließlich `:847–899`: erfolgreicher Neuerwerb erneuert Proof; Verlierer bewahrt Sieger-Proof; Triple-/Envelope-Mismatch und fehlende Faktoren; Proof-Write-Failure gezielt vor/nach Split vergleichen |
| Release / Heartbeat / Zeit | Dieselbe Suite Release-Abschnitt, `:1545–1778` und TTL-Paritätssuite: null vs malformed Proof, fremder Reacquire beim Retry, eigene stale Revival, foreign-ID-Abweisung, TTL-/Zukunftskanten |
| Lifecycle-Verbrauch | `tests/hooks/lock-bootstrap.test.mjs`, `tests/scripts/release-session-lock.test.mjs`, `tests/lib/session-transition.test.mjs`, `tests/integration/session-identity-boundaries.test.mjs`: Genesis/Enrichment, Proof-Verbrauch und Event-Ort erhalten |
| Unveränderter Teilsplit | `tests/lib/session-lock-staging-fence.test.mjs`, `tests/lib/locks/state-md-lock.test.mjs`, `tests/lib/locks/staging-fence-lock.test.mjs`, `tests/integration/state-md-lock-cross-process.test.mjs` |

Startbefehle für die drei vom Lead verlangten Einzeldateien auf nativem m5,
**erst nach neuer Freigabe**, seriell; kein Aufruf in diesem Lauf:

```sh
perl -e 'alarm shift; exec @ARGV' 120 npm test -- tests/lib/session-lock.test.mjs
perl -e 'alarm shift; exec @ARGV' 120 npm test -- tests/integration/session-lock-cross-process.test.mjs
perl -e 'alarm shift; exec @ARGV' 120 npm test -- tests/lib/session-lock-staging-fence.test.mjs
```

Der Perl-Alarm begrenzt den gestarteten npm-Prozess, garantiert aber keinen
Prozessgruppen-Abbau mit Kill-Nachfrist. Spätere native Prüfer müssen eigene
Kinder, PPID-1-Waisen und Fixture-Reste ausdrücklich kontrollieren und auf das
tatsächliche Ende samt Exit warten. Keine fremden Prozesse beenden.

Darwin/APFS-Probe und Linux-CI-Probe getrennt belegen: tatsächlich ausgeführte
Hardlink/Rename-/Prozesspfade, Runner-OS/FS und Skip-Gründe erfassen. PID-/Prozess-
Identitätsfälle in einer Sandbox sind bei verweigerter Messung **übersprungen,
nicht messbar**, kein Zielsystem-Grün. Heute wurden weder native Racefälle noch
Linux-Pfade geprüft. Bei späterem Umsetzungsdiff erst Import-/Export-/Packaging-
Parity und Hook-Importset mit vorhandenen Prüfern, danach volle Repo-Gates nativ/CI.
Neue Racefälle nur bei belegter Prüflücke, nach Testwert-Prüfung; keine Tests nur
für Dateianzahl oder kopierte Implementation schreiben.

### Doku-Diff und CI-Pflicht

Einziger hier erlaubter lokaler Gate-Befehl:

```sh
perl -e 'alarm shift; exec @ARGV' 120 npx --no-install prettier --check docs/plans/triage-2026-10-10-lock-split.md
```

Kein Install nötig, kein lokaler Vollsuite-/Lint-/Typecheck-Aufruf.
MR-Pipeline bleibt vollständig erforderlich: `.gitlab-ci.yml:61–78` hat keine
Doku-Pfadausnahme. Hard-Needs von `pipeline-gate:919–932`:
`gitleaks-scan`, `npm-audit`, `npm-audit-signatures`, `semgrep`, `lint`,
`typecheck`, `owner-leakage`, `fixture-shape`, `plugin-schema-validate`,
`hook-import-set-check`, `package-manager-guard`, drei `test`-Shards,
`pack-lifecycle`, `commitlint`. Außerdem `schema-drift-check:809–880` mit
Markerprüfung im Gate; `test-value-bans` ist ausdrücklich advisory.

Konkrete vorhandene Befehle: `npm run lint` (`:351`), `npm run typecheck` (`:485`),
`npm test -- --shard=$CI_NODE_INDEX/$CI_NODE_TOTAL ...` (`:648`),
`npm run test:pack` (`:676`), `node scripts/validate-plugin-manifests.mjs` (`:517`),
`node scripts/generate-hook-import-set.mjs --plugin-root <repo> --check` (`:541`),
`node scripts/check-package-manager.mjs` (`:565`),
`node scripts/lib/validate/check-owner-leakage.mjs <repo>` (`:495`),
`node scripts/lib/validate/check-test-fixture-shapes.mjs <repo>` (`:508`).
Security-/commitlint-/schema-drift-Befehle vollständig aus der dann gültigen
CI-Konfiguration ableiten; keine Tokens ausgeben oder lokale Netzprobe ausführen.
Auf main zusätzlich `npm run test:coverage` (`:710/:759–761`), vom Fan-in-Gate
über Marker verlangt (`:949–957`). Pipeline-ID, voller Head-SHA, tatsächliche
Job-Endzustände und Logs muss der Lead nachweisen; jetzt nicht messbar.

## Dateifläche und Kollisionsmatrix

**Vollständige Schreibfläche dieses Bündels:** ausschließlich neu
`docs/plans/triage-2026-10-10-lock-split.md`. Keine zusätzliche Runtime-Schreibfläche; die engere Ein-Datei-Vorgabe gilt.

| Gegenbündel / Fläche | Kollision / Urteil |
| --- | --- |
| S1157, S856, S1026, S1021, S1032 aus Triage a | Lead erklärt verschiedene Planartefakte bzw. Agentdokument; gegenüber diesem eigenen Planpfad **laut Brief parallel planbar**, Gegenflächen hier nicht vollständig neu gemessen |
| Aktuell laufende Autoren | Vollständige Besitz-/Dateiliste fehlt: **ungeklärt**, keine globale Parallelfreigabe |
| Autor desselben Planpfads | Gemeinsame Datei: **seriell**; kein Überschreiben fremder Änderungen |
| Späterer Split | Quell-/Test-/Prose-/Manifestfläche **unvollständig**, noch nicht freigegeben; überschneidet sich voraussichtlich mit anderen Lock-/Hook-Aufträgen |

Hypothetische spätere Fläche beginnt bei Barrel und neuem Core, genannten
Lock-/Lifecycle-/Importtests und eventuell generiertem Hook-Importset sowie
Code-/Prose-Zitaten. Vor jeder Umsetzung vollständige Fläche gegen aktuelle
Autoren materialisieren; diese Kandidatenliste erteilt keinen Schreibscope.

## Ablauf, Rollen und Entscheidungen

**Ausführbare Wellen in der Planphase: null.** Phase-1-Reihenfolge: Prämisse/Main-
Belege → Code-/Consumerkarte → Alternativen/Verträge → unabhängiger lesender
Plancheck → Formatcheck → anhalten. Kein zweites Issue, keine Discovery-Welle.

| Spätere Phase, nur Vorschlag | Rolle | Voraussetzung |
| --- | --- | --- |
| Native Sicherheits-/Architekturprüfung | Sicherheits-/Architekturreview | Nach Lead-Auftrag; prüft Reclaim-, Proof-, Release-Verträge und Abbruchkriterien |
| Vollständige Scope- und Probeplanung | Routine-Leser/Doku und Sicherheitsreview | Freigegebenes Repo; noch keine Umsetzung |
| Eventuelle Implementation und Review | Implementierer und unabhängiger Reviewer | Erst ausdrückliche Owner-/Lead-Freigabe und disjunkte Dateifläche; keine automatische Fortsetzung durch `/go` dieses Plans |
| Gates | Routine-Gates nach klarer Vorgabe | Zulässiger Offload/CI; seriell je Datei, danach vollständige Gates auf genau dem resultierenden SHA |
| Commit / Push / MR / Merge | Lead | Nur Plan soll zunächst integriert werden, kein Split |

Ein GitLab-Merge auf SO-main löst die GitLab-Branch-Pipeline samt Coverage aus,
aber keine GitHub-Spiegelung: `remote_mirrors` ist leer. GitHub-Spiegeltests
(`.github/workflows/test.yml:3–6`) und Vercel-Prod laufen nur über den GitHub-
Mirror-Push durch `/close` bzw. `scripts/release.mjs` (`.claude/rules/security.md:100`).
GitLab definiert keine Deploy-/Release-/Publish-Jobs; npm-Publish ist gesondert
(`.claude/rules/development.md:89–93`). `vercel.json:3–5` konfiguriert die Website.
Die Bedingung „Merge geparkt, bis Veröffentlichung belegbar ausgeschlossen“ ist
für den GitLab-Merge erfüllt; Mirror-Push und Veröffentlichung bleiben geparkt.

Beantwortet: nur #990 aufnehmen; historischen Teilsplit anerkennen; gesamten
Kern als ersten möglichen Strukturschnitt empfehlen; Proof-Familie zusammenhalten;
kein Issue schließen, keine Welle starten, fehlende Remote-/Besitz-/CI-Messung
offen ausweisen. Diese Arbeitsentscheidungen sind durch Brief und Code gedeckt.

Geparkt: tatsächlicher Split/Prioritätsanhebung, Sicherheitsabnahme, neue vollständige
Besitz-/Scope-Messung, native Race-/OS-Prüfungen, vollständige CI-Abnahme,
Commit/Push/MR durch Lead, Mirror-Push bei ungeklärter Veröffentlichung. Ebenfalls
echte Locks, Heartbeats, Reaper, Kill-/Recoveryaktionen, Release, Prod, Server,
Publish und Versand/Nachrichten. Labels und Identität geben keine Betriebsfreigabe.

Unbeaufsichtigte Risiken: veraltete lokale Main-Refs als aktuell ausgeben;
Null-Proof versehentlich fail-closed umdeuten; Lock-/Proof-Write-Reihenfolge
auseinanderziehen; Importzyklen oder neue Import-Nebenwirkungen; vorhandene
Racegrenzen als neue Defekte oder den Split als deren Reparatur deklarieren;
Sandbox-Skips als native Grünfälle zählen; incomplete Scope als Parallelfreigabe
verwenden; eine generische Skill-Fortsetzung trotz Ein-Datei-Auftrag starten.

## Abnahmekriterien

Plan akzeptabel, wenn der unabhängige Leser Exporte/Consumerkarte, Einweg-Graph,
Proof-Kopplung, null-Proof-Vertrag, dokumentierte Racegrenzen, Probe-/CI-Pflichten
und Ein-Datei-Scope bestätigt. Keine Sicherheitsabnahme einer Implementation.

Commit-Vorschlag für den Lead:
`docs(lock): Plane sichere Grenzen für den Session-Lock-Split`.
Refs #990 im Commit-Body; kein automatisches Schließwort.

## Abnahme und Übergabe

Main-SHA: `e9674ea2df3afedd2790f904ce9188575e3d6d2d`.
Messdatum: `2026-10-10T07:48:17Z`.
Methode: `git show <sha>:scripts/lib/session-lock.mjs | wc -l`, `git log <main-sha> --format=%H -- scripts/lib/session-lock.mjs` und Importer-Zensus wie oben.
Ergebnis: historische Größen reproduziert; Teilsplit und gekoppelte Kern-/Proofmechanik bestätigt, sichere Modulaufteilung offen.
