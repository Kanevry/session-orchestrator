# OpenAI-Plugin-Verzeichnis: Paket nur mit Skills

Stand: 2026-11-06, gemessen auf `0a357b2a` mit den Änderungen aus #1966 (vor dem Commit). Issues: #1931, #1966, #1968.

## Warum nur Skills

Das Plugin-Verzeichnis von OpenAI, das ChatGPT und Codex gemeinsam nutzen, nimmt session-orchestrator nur als reines Skill-Paket an. Die Regeln wurden am 2026-11-03 auf developers.openai.com/plugins gelesen:

- Plugins mit Lifecycle-Hooks sind nicht zulässig. Also darf es keinen `hooks`-Eintrag und keine Hook-Dateien geben.
- Ein ZIP, das nur Skills enthält, darf keine MCP-Konfiguration enthalten (`mcp_configuration_excluded`). Also gibt es keine `.mcp.json` und keine `mcpServers`.
- Es braucht mindestens einen Skill unter `skills/<name>/SKILL.md`. Dessen Frontmatter hat `name` und `description` (höchstens 1.024 Zeichen), und der Inhalt darunter ist nicht leer. `plugin-name:skill-name` hat höchstens 64 Zeichen.
- Skills sollen nicht von einem Anbieter abhängen („the model“). Sie sollen in einer sauberen Umgebung laufen, ohne Pakete, Dateien oder Zugangsdaten, die das Paket nicht angibt.
- Das ZIP hat genau ein Plugin-Wurzelverzeichnis. Bevorzugt wird darin eine `plugin.json` nach Agent Plugins 1.0.0 (`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`). Eine Kopie des Schemas vom 2026-11-06 liegt in `scripts/lib/openai-skills/plugin.schema.json`.

Das volle Codex-Plugin (`.codex-plugin/plugin.json`) enthält `hooks` und `mcpServers` und kann deshalb nicht so eingereicht werden. Der Großteil von session-orchestrator lebt von Hooks, Subagenten, `AskUserQuestion` und `scripts/`. In ein Paket ohne all das gehört nur, was ohne diese Teile ehrlich funktioniert.

## Zählung (PSA-006)

Erstmals gemessen am 2026-11-06T10:35:08Z auf `1a42e326` im Worktree `so-e7`. Neu gemessen am 2026-11-06T16:39:12Z auf `0a357b2a` plus den noch nicht committeten Änderungen aus #1966 im Worktree `so-66`; die Tabelle unten zeigt diesen Stand. Seit `1a42e326` haben sich nur session-end, test-runner und wave-executor verschoben, durch fremde Commits (etwa `9954b83a`, `db82140f`). Es gibt 53 Verzeichnisse unter `skills/` und 52 `SKILL.md`, denn `_shared` ist kein Skill. Jede Spalte zählt die Treffer von `rg -c -i -e '<muster>' skills/<skill>/`, summiert über alle Dateien des Skill-Verzeichnisses:

| Spalte | Muster |
|---|---|
| hook | `\bhooks?/\|\bhook\b\|PreToolUse\|PostToolUse\|SessionStart\|SubagentStop` |
| auq | `AskUserQuestion` |
| agent | `Agent\(\|subagent` |
| instr | `CLAUDE\.md\|AGENTS\.md` |
| outside | `scripts/\|skills/_shared\|\.claude/rules\|\.\./` |
| node | `\bnode \|\bnpm \|\bnpx ` |
| glab | `\bglab\b\|gitlab` |
| cred | `token\|api[_-]?key\|credential\|secret` |

Die Muster sind grob: `hook` trifft auch das Wort im Fließtext, und `cred` trifft auch „token“ im Sinn von Kontext-Tokens. Die Zahlen sortieren nur vor. Das Urteil über die Kandidaten mit wenigen Treffern kommt aus dem Lesen der Trefferzeilen mit `rg -n` (siehe unten).

Skills mit mindestens einem Treffer je Spalte (Nenner 52, Stand 16:39:12Z): hook 27, auq 28, agent 25, instr 21, outside 48, node 36, glab 24, cred 32. Auf `1a42e326` vor der Umschreibung von grill waren es outside 49 und cred 31. Gegenprobe zur Zahl aus dem Issue: `rg -l -e 'AskUserQuestion|Agent\(|CLAUDE\.md' skills/*/SKILL.md | wc -l` ergibt 37 von 52, wie am 2026-11-03 und wieder um 16:39:12Z.

| Skill | Dateien | hook | auq | agent | instr | outside | node | glab | cred | Urteil |
|---|---|---|---|---|---|---|---|---|---|---|
| architecture | 7 | 0 | 0 | 2 | 0 | 1 | 0 | 0 | 0 | abgelehnt: Subagent |
| autopilot | 1 | 1 | 0 | 1 | 0 | 37 | 0 | 0 | 11 | abgelehnt: Skripte |
| bootstrap | 16 | 5 | 14 | 0 | 62 | 114 | 34 | 44 | 11 | abgelehnt: Skripte, Hooks |
| brainstorm | 2 | 0 | 5 | 0 | 0 | 4 | 0 | 0 | 0 | Änderungsbedarf |
| claude-md-drift-check | 4 | 17 | 0 | 0 | 63 | 51 | 6 | 18 | 23 | abgelehnt: Skripte |
| close | 1 | 3 | 1 | 0 | 0 | 3 | 1 | 0 | 2 | abgelehnt: Session-Lebenszyklus |
| convergence-monitoring | 3 | 4 | 0 | 0 | 0 | 11 | 1 | 0 | 2 | abgelehnt: Skripte |
| debug | 2 | 0 | 0 | 0 | 0 | 3 | 3 | 1 | 0 | **ausgewählt** (#1966, siehe unten) |
| deepen | 1 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 1 | **ausgewählt** (#1966, mit mitgenommener Datei) |
| discovery | 23 | 11 | 14 | 2 | 27 | 72 | 29 | 37 | 28 | abgelehnt: Skripte, VCS |
| dispatcher | 1 | 0 | 7 | 3 | 0 | 14 | 2 | 7 | 0 | abgelehnt: Skripte |
| docs-orchestrator | 2 | 8 | 1 | 1 | 7 | 6 | 0 | 0 | 0 | abgelehnt: Hooks, Subagent |
| ecosystem-health | 2 | 0 | 0 | 0 | 4 | 5 | 3 | 6 | 0 | abgelehnt: Skripte, VCS |
| eli5 | 1 | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | **ausgewählt** (nachgemessen, siehe unten) |
| eval | 4 | 2 | 2 | 4 | 0 | 49 | 4 | 0 | 9 | abgelehnt: Skripte |
| evolve | 3 | 3 | 19 | 8 | 3 | 51 | 13 | 0 | 15 | abgelehnt: Skripte |
| frontmatter-guard | 1 | 3 | 0 | 0 | 1 | 8 | 0 | 0 | 0 | abgelehnt: Hooks, Skripte |
| gitlab-ops | 1 | 16 | 0 | 1 | 0 | 7 | 3 | 52 | 2 | abgelehnt: VCS-Zugang |
| gitlab-portfolio | 1 | 3 | 0 | 0 | 1 | 8 | 1 | 30 | 0 | abgelehnt: VCS-Zugang |
| go | 1 | 0 | 0 | 1 | 0 | 9 | 3 | 0 | 0 | abgelehnt: Session-Lebenszyklus |
| grill | 2 | 0 | 4 | 1 | 0 | 0 | 0 | 0 | 1 | **ausgewählt** (nachgemessen, siehe unten) |
| harness-audit | 1 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | abgelehnt: `node scripts/harness-audit.mjs` |
| hook-development | 1 | 59 | 0 | 5 | 0 | 4 | 0 | 1 | 0 | abgelehnt: Hooks |
| mcp-builder | 1 | 3 | 0 | 0 | 0 | 0 | 2 | 4 | 3 | abgelehnt: MCP |
| memory-cleanup | 1 | 1 | 2 | 0 | 0 | 22 | 2 | 0 | 0 | abgelehnt: Claude-Memory-Pfade |
| mode-selector | 1 | 0 | 0 | 0 | 0 | 10 | 0 | 2 | 0 | abgelehnt: Skripte |
| npm-publish | 1 | 0 | 0 | 0 | 0 | 12 | 34 | 2 | 33 | abgelehnt: Zugangsdaten |
| peekaboo-driver | 2 | 0 | 2 | 0 | 0 | 1 | 3 | 0 | 5 | abgelehnt: lokales Werkzeug |
| persona-panel | 5 | 1 | 0 | 4 | 0 | 23 | 0 | 0 | 3 | abgelehnt: Subagenten |
| plan | 10 | 0 | 27 | 28 | 9 | 31 | 9 | 33 | 2 | abgelehnt: Subagenten, VCS |
| playwright-driver | 2 | 0 | 0 | 0 | 0 | 7 | 6 | 0 | 6 | abgelehnt: Pakete |
| portfolio | 1 | 0 | 0 | 0 | 0 | 5 | 1 | 10 | 0 | abgelehnt: VCS-Zugang |
| quality-gates | 1 | 2 | 0 | 0 | 1 | 13 | 10 | 0 | 0 | abgelehnt: Skripte |
| reconcile | 1 | 0 | 2 | 1 | 0 | 28 | 0 | 0 | 0 | abgelehnt: Skripte |
| release | 1 | 1 | 0 | 0 | 0 | 16 | 25 | 3 | 3 | abgelehnt: Skripte, Zugangsdaten |
| remote-offload | 1 | 2 | 0 | 1 | 0 | 6 | 2 | 0 | 5 | abgelehnt: SSH-Hosts |
| repo-audit | 1 | 0 | 0 | 0 | 4 | 3 | 6 | 5 | 4 | abgelehnt: Skripte, VCS |
| session-end | 19 | 16 | 22 | 21 | 29 | 210 | 58 | 14 | 16 | abgelehnt: Session-Lebenszyklus |
| session-plan | 3 | 3 | 3 | 9 | 2 | 38 | 5 | 1 | 1 | abgelehnt: Session-Lebenszyklus |
| session-start | 18 | 25 | 36 | 9 | 19 | 185 | 31 | 22 | 8 | abgelehnt: Session-Lebenszyklus |
| spinout | 1 | 0 | 3 | 0 | 2 | 6 | 0 | 0 | 2 | abgelehnt: Repo-Gerüst |
| sunset-review | 1 | 0 | 2 | 1 | 0 | 7 | 2 | 0 | 0 | abgelehnt: Skripte |
| test | 1 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 3 | abgelehnt: braucht Skill test-runner |
| test-audit | 3 | 1 | 2 | 1 | 0 | 7 | 0 | 0 | 2 | abgelehnt: Regeldateien, vitest, Merge-Request |
| test-runner | 4 | 0 | 2 | 2 | 1 | 27 | 1 | 8 | 5 | abgelehnt: Skripte, Browser |
| tmux-layout | 1 | 0 | 1 | 1 | 1 | 9 | 2 | 5 | 0 | abgelehnt: tmux, Skripte |
| using-orchestrator | 1 | 0 | 3 | 0 | 2 | 3 | 0 | 0 | 0 | abgelehnt: erklärt das Plugin mit Hooks |
| ux-grill | 3 | 0 | 7 | 1 | 0 | 10 | 2 | 2 | 6 | abgelehnt: Browser, Subagent |
| vault-mirror | 1 | 2 | 0 | 0 | 2 | 22 | 11 | 0 | 1 | abgelehnt: Skripte, Vault |
| vault-sync | 32 | 3 | 0 | 0 | 13 | 24 | 16 | 5 | 1 | abgelehnt: Pakete, Vault |
| wave-executor | 8 | 53 | 16 | 69 | 6 | 166 | 28 | 2 | 8 | abgelehnt: Subagenten, Hooks |
| write-executable-plan | 2 | 1 | 3 | 0 | 0 | 5 | 1 | 0 | 0 | Änderungsbedarf |

Nachmessung nach der Umschreibung von grill und eli5: 2026-11-06T10:50:50Z, auf `1a42e326` plus den ungecommitteten Änderungen im Worktree `so-e7`, dieselben Muster. Der Stand vorher wurde mit `git show HEAD:<datei> | rg -c -i -e '<muster>'` aus `1a42e326` gezählt und stimmt mit der Tabelle oben überein.

| Skill | Stand | hook | auq | agent | instr | outside | node | glab | cred |
|---|---|---|---|---|---|---|---|---|---|
| grill | vorher | 0 | 4 | 1 | 0 | 3 | 0 | 0 | 0 |
| grill | nachher | 0 | 4 | 1 | 0 | 0 | 0 | 0 | 1 |
| eli5 | vorher | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 1 |
| eli5 | nachher | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 1 |

Die verbliebenen Treffer, gelesen mit `rg -n`: grill `auq` 4 sind die beiden `AskUserQuestion`-Beispiele und zwei Sätze, die den Weg mit Werkzeug als ersten nennen; daneben steht jetzt der Weg ohne Werkzeug (nummerierte Liste). grill `agent` 1 ist der Satz, dass ein Subagent nicht grillen darf. grill `cred` 1 ist „token“ im Sinn von Wort (`soul.md:92`). eli5 `auq` 1 und `outside` 1 sind bedingte Hinweise („Claude Code: …“, „session-orchestrator: `.claude/rules/…`“); die Regel steht jeweils im Skill selbst. eli5 `cred` 1 ist „token“ im Sinn von Wort.

Die zehn Skills mit den wenigsten Treffern wurden Zeile für Zeile gelesen: eli5, grill, deepen, debug, brainstorm, architecture, test-audit, write-executable-plan, harness-audit und test. Befehl dafür: `rg -n -i -e 'AskUserQuestion|Agent\(|subagent|CLAUDE\.md|AGENTS\.md|scripts/|skills/_shared|\.claude/rules|\.\./|\bnode |\bnpm |\bnpx |\bglab\b|gitlab|token|api[_-]?key|credential|secret|\bhooks?\b|\.orchestrator' skills/<skill>`.

## Auswahl

Vier Skills funktionieren ohne Hooks und ohne fremde Dateien. eli5 tat das schon vorher; grill erst nach der Umschreibung in #1931; deepen und debug seit #1966. Die Auswahl steht als Daten in `scripts/lib/openai-skills/allowlist.json`. Auf Claude Code ändert sich nichts: `AskUserQuestion` bleibt in eli5, grill und deepen der erste Weg, und debug prüft das Bootstrap-Gate weiter, sobald es als Teil des Plugins läuft.

| Skill | Warum er ohne Hooks ehrlich funktioniert |
|---|---|
| eli5 | Er besteht aus einer Datei. Seine beiden Regeln und die Liste „Never traded for brevity“ stehen in der Datei selbst. `owner.yaml` ist nur noch bedingt genannt, mit festgelegtem Ersatz (Englisch, dann die Sprache des Nutzers). Die Vorschau zeigt er im `preview`-Feld, wo es ein Fragewerkzeug gibt, sonst als Codeblock unter der Option. |
| grill | Zwei Dateien (`SKILL.md`, `soul.md`). Jede Frage hat zwei Wege: `AskUserQuestion`, wo es das Werkzeug gibt, sonst dieselbe einzelne Frage als nummerierte Liste, Empfehlung zuerst mit `(Recommended)`, Antwort per Nummer, dann warten. Antwortet niemand (Lead-geführt oder kopflos, #1976), läuft der Selbst-Grill aus § „Lead-guided runs: Selbst-Grill“: Die Session beantwortet ihre Fragen selbst mit Beleg aus dem Code, Unbelegtes wird offene Frage. Der Abschnitt steht im Skill selbst; die gemeinsame Fassung `skills/_shared/lead-guided-mode.md` liegt außerhalb des Pakets und wird deshalb nicht verlinkt. Der Kern der Register-Regel und die Skepsis-Haltung stehen im Skill selbst. `owner.yaml` ist bedingt genannt, mit Ersatz. `/brainstorm`, `/plan feature` und `/write-executable-plan` sind nur noch Empfehlungen, wenn sie installiert sind. |
| deepen | Eine Datei, dazu eine mitgenommene Datei (siehe unten). Der Export schneidet die Abschnitte „Judge order“ und „Brief B — Deepen“ aus `skills/plan/prd-premortem-panel.md` und legt sie im Paket unter `references/prd-premortem-panel.md` im Ordner von deepen ab. In der exportierten `SKILL.md` zeigt der Verweis dorthin; die Quelle im Repo bleibt unverändert. Für `AskUserQuestion` gibt es zwei Ersatzwege: Antwortet ein Mensch, gibt deepen den Block mit nummerierten Optionen aus und wartet; antwortet niemand (Lead-geführt oder kopflos, #1976), führt deepen die Umschreibung aus und nennt das Original als verworfen (§ „Lead-guided runs“, im Skill selbst ausgeschrieben). |
| debug | Zwei Dateien (`SKILL.md`, `soul.md`). Phase 0 sucht zuerst die Gate-Datei des Plugins unter `../_shared/bootstrap-gate.md`, aufgelöst vom Ordner der `SKILL.md` aus, nie vom Arbeitsverzeichnis des Projekts. Ist sie da, gilt das Gate wie bisher, ohne Ausnahme. Fehlt sie, läuft der Skill allein, und es gibt nichts zu bootstrappen. Testbefehl und Session-ID haben einen Ersatz (Testbefehl des Projekts, heutiges Datum). „Integration with wave-executor“ und „See Also“ sind als „Session Orchestrator only“ markiert. Die `description` ist jetzt `>-` statt `>` (gleicher Text, ohne Zeilenumbruch am Ende). |

Die verbliebenen Treffer von deepen und debug, gelesen mit `rg -n` in der exportierten Kopie: deepen `auq` 2 sind Zeile 54 und der Ersatz in Zeile 55; `agent` 2 sind zwei Sätze, die Subagenten ausschließen oder an eine Zustimmung binden; `cred` 1 ist „tokens“ als Kostenart. debug `outside` 3 sind die beiden Nennungen der Gate-Datei in Phase 0 (bedingt) und `.claude/rules/…` unter „See Also (Session Orchestrator only)“; `node` 3 sind „Node version“ zweimal und `npm test --watch` im freiwilligen `/tmux-layout`-Hinweis; `glab` 1 ist „GitLab #562“ im selben Hinweis.

### Mitgenommene Dateien (`include`)

Ein Skill darf in `allowlist.json` eine Datei von außerhalb seines Verzeichnisses angeben: `from` (Pfad im Repo), `to` (Pfad im Skill-Ordner), optional `sections` (Titel der `## `-Abschnitte). Der Export

- liest `from`, schneidet bei `sections` genau diese Abschnitte heraus (bis zur nächsten `#`- oder `##`-Überschrift außerhalb von Codeblöcken) und legt sie unter `to` ab;
- ersetzt in den `.md`-Dateien des Skills jede Nennung von `from` durch `to`, nur in der exportierten Kopie;
- bricht ab, wenn ein Abschnitt nicht genau einmal vorkommt, der Skill `from` nie nennt, `to` eine vorhandene Datei überschreiben würde (ohne Rücksicht auf Groß- und Kleinschreibung), die Quelle ein Symlink ist oder ein Pfad `..`, absolut oder keine `.md`-Datei ist.

`--check` meldet `include-missing`, wenn die angegebene Datei im Paket fehlt, und `include-unrewritten`, wenn eine `.md`-Datei des Skills noch auf `from` zeigt.

Warum Abschnitte und nicht die ganze Datei: `prd-premortem-panel.md` hat 59 Zeilen, deepen braucht davon zwei Abschnitte (Zeilen 18–27 und 41–52; die Datei im Paket hat mit eigener Überschrift 25 Zeilen). Der Rest (Brief A, Shared rules, Coordinator merge) verweist auf `skills/_shared/research-evidence.md`, `/grill` und `SKILL.md` Phase 4.5 von `/plan`, die das Paket nicht hat. Die ganze Datei hätte also neue tote Verweise mitgebracht. Das Schneiden an `## `-Überschriften ist einfach und deterministisch.

## Kandidaten mit Änderungsbedarf

grill und eli5 wurden in #1931 umgeschrieben, deepen und debug in #1966; alle vier stehen oben unter „Auswahl“. Die übrigen Skills sind unverändert. Jede genannte Stelle ist entweder eine harte Abhängigkeit von einer Datei außerhalb des Skill-Verzeichnisses oder ein Werkzeug, das nur Claude hat. Sobald eine Änderung auf `main` ist, kommt der Skill in `allowlist.json`, und `--check` prüft ihn mit.

- **brainstorm** und **write-executable-plan**: dasselbe Bootstrap-Gate (`brainstorm/SKILL.md:49`, `write-executable-plan/SKILL.md:30` und `:33`), dazu `AskUserQuestion` ohne Ersatz und eine Übergabe an `/plan feature`, das nicht mitgeliefert wird.

## Abgelehnt, nach Grund

- **Skripte aus `scripts/` oder `node`**: autopilot, bootstrap, claude-md-drift-check, convergence-monitoring, dispatcher, eval, evolve, harness-audit, mode-selector, quality-gates, reconcile, release, sunset-review, vault-mirror. Sie rufen Dateien auf, die das Paket nicht enthalten darf.
- **Hooks oder Hook-Verhalten**: frontmatter-guard, hook-development, docs-orchestrator, wave-executor.
- **Session-Lebenszyklus** (STATE.md, Wellen, Hooks): session-start, session-plan, session-end, close, go.
- **Subagenten-Dispatch**: architecture (Explore-Subagent und `scripts/lib/…`-Mapper), persona-panel, plan, ux-grill.
- **VCS-Zugang oder Zugangsdaten**: gitlab-ops, gitlab-portfolio, portfolio, discovery, ecosystem-health, repo-audit, npm-publish.
- **Lokale Werkzeuge, Hosts oder Pakete**: peekaboo-driver, playwright-driver, remote-offload, tmux-layout, test-runner, vault-sync, memory-cleanup (Claude-Memory-Pfade).
- **Hängt an einem anderen Skill oder am Plugin**: test (braucht test-runner), using-orchestrator (erklärt das Plugin mit Hooks), spinout (Repo-Gerüst).
- **test-audit**: `mutate.sh` liegt im Skill und würde mitgehen. Der Skill setzt aber `.claude/rules/` oder `rules/always-on/` des Plugins voraus (`SKILL.md:16–18`), dazu vitest, git und einen Entwurfs-Merge-Request (`:148`).

## Bauen und prüfen

```bash
node scripts/export-openai-skills.mjs              # baut .orchestrator/tmp/openai-skills/session-orchestrator/
node scripts/export-openai-skills.mjs --zip        # zusätzlich .orchestrator/tmp/openai-skills/session-orchestrator.zip
node scripts/export-openai-skills.mjs --check      # prüft den letzten Build
node scripts/export-openai-skills.mjs --check <dir|zip> --json
```

- Das Standardziel `.orchestrator/tmp/openai-skills/` ist gitignored; geprüft mit `git check-ignore --no-index`.
- Zur Wurzel gehört eine `plugin.json` nach Agent Plugins 1.0.0. Version, Homepage, Lizenz und Repository kommen aus `package.json`, der Autor aus `.claude-plugin/plugin.json`, denn `package.json` hat kein `author`. Dazu kommen `skills/<name>/…` aus der Allowlist samt ihren angegebenen `include`-Dateien, sonst nichts.
- Das ZIP ist deterministisch: Einträge sortiert, feste Zeitstempel (1980-01-01), DEFLATE über `node:zlib`, keine neue Abhängigkeit. Zwei Builds desselben Stands sind Byte für Byte gleich.
- `--check` meldet jeden Verstoß einzeln: Hooks (Verzeichnis, Datei oder Eintrag im Manifest), MCP-Konfiguration, ungültiges Manifest nach Schema (ajv), fehlende oder zu lange Frontmatter, `session-orchestrator:<skill>` über 64 Zeichen, leerer Inhalt, Pfad außerhalb der Wurzel (`..`, absolut, Symlink), mehr als ein Wurzelverzeichnis, Dateien, die zu keinem Skill der Allowlist gehören.
- Seit dem Review vom 2026-11-06 meldet `--check` zusätzlich: Hooks und MCP-Dateien in jeder Groß- und Kleinschreibung, `hooks`/`mcpServers` auch tief im Manifest (`extensions`) und im Skill-Frontmatter, Nicht-`.md`-Dateien in Skill-Ordnern, mehrzeilige `description`, Frontmatter, die kein gültiges YAML ist oder doppelte Schlüssel, Anker oder Aliase enthält (`frontmatter-invalid`; die Frontmatter wird mit `yaml` geparst, nicht zeilenweise gelesen), Steuerzeichen und doppelte Namen im ZIP, abweichende Namen zwischen lokalem Header und Zentralverzeichnis, falsche CRC. Ein kaputtes ZIP ist ein Verstoß (Exit 1), kein Systemfehler.
- Seit #1968 müssen die lokalen Einträge den Bereich vor dem Zentralverzeichnis lückenlos und ohne Überlappung füllen. Sonst könnte dort ein lokaler Eintrag liegen, den das Zentralverzeichnis nicht nennt (etwa `session-orchestrator/hooks/hooks.json`): `--check` sähe ihn nicht, ein Entpacker, der lokale Header der Reihe nach liest, würde ihn auspacken. Einträge mit Datendeskriptor (Bit 3, etwa aus `ditto` oder dem macOS-Archivprogramm) werden mitgezählt. Das Zentralverzeichnis muss direkt vor dem Endsatz enden; Bytes dazwischen sind ein Verstoß. ZIP64 wird ausdrücklich abgelehnt („ZIP64 is not supported“).
- `--out` gilt relativ zum aktuellen Verzeichnis. Ein vorhandenes `<out>/session-orchestrator` oder `<out>/session-orchestrator.zip` wird nur ersetzt, wenn es ein früherer Export ist; sonst bricht der Build mit Exit 1 ab. Ein `--out`, das das Repo oder das Home-Verzeichnis selbst ist oder enthält, wird abgelehnt. Ein erkannter früherer Export gehört ganz dem Exporter: alles darin, auch eigene Dateien unter `skills/`, wird beim nächsten Build ersetzt. Scheitert das Einsetzen des neuen Exports, nachdem der alte schon beiseitegelegt wurde, stellt der Exporter den alten zurück (#1968).
- Exit-Codes: 0 in Ordnung, 1 Verstöße, Ablehnung oder falsche Argumente, 2 Systemfehler.

## Lauf in einer sauberen Codex-Umgebung (2026-11-06)

Gemessen mit codex-cli 0.160.1 am 2026-11-06 gegen ~12:00 Wiener Zeit, Paket aus `node scripts/export-openai-skills.mjs --zip` (eli5 und grill).

- Eigener `CODEX_HOME` (nur `auth.json` kopiert, Modus 0600) und eigenes `HOME`; das Projektverzeichnis lag in `/private/tmp`, außerhalb jedes Git-Repos.
- Installation über einen lokalen Marketplace: `codex plugin marketplace add <dir>` mit `.agents/plugins/marketplace.json` (`source: local`), dann `codex plugin add session-orchestrator@<name>`. `codex plugin list` meldet `installed, enabled`. Codex nimmt das Root-`plugin.json` an; ein `.codex-plugin/plugin.json` braucht das Paket nicht.
- **grill** (`codex exec -s read-only`): liest `SKILL.md` und `soul.md` aus dem Plugin-Cache, fragt genau eine Frage als nummerierte Liste, Option 1 mit `(Recommended)`, zuletzt `Other / describe below`, „Antworte mit einer Nummer“, dann Ende des Zugs.
- **eli5**: liest `SKILL.md` aus dem Plugin-Cache. Ohne lesbare Owner-Datei antwortet es auf Englisch, die erste Zeile sagt, was zu tun ist, alle Zahlen bleiben erhalten, und es nennt die Herkunft der Zahlen als nicht selbst gemessen.
- Ein erster Lauf mit dem Projektverzeichnis **im** Worktree zählt nicht: Codex fand beim Hochsuchen `.agents/skills/grill/SKILL.md` des Repos und las die Repo-Fassung statt des Pakets. Ein E2E-Lauf muss deshalb außerhalb jedes Repos stattfinden.

## Offen

- Unbekannt ist, ob das Verzeichnis zusätzliche Frontmatter-Schlüssel annimmt (`user-invocable`, `model`, `tools`, `argument-hint` in eli5 und grill, dazu `color` in grill) oder ob der Export sie entfernen muss. Codex 0.160.1 nimmt sie an (Lauf oben).
- Nicht ganz anbieterneutral: `$ARGUMENTS` und die Aufrufform `/grill` sind Claude-Schreibweise, und die Zusammenfassung in Phase 4 von grill braucht `date` und `mkdir`. In ChatGPT ohne Shell entfällt diese eine Option; das Fragen selbst funktioniert.
- `skills/grill/soul.md` trägt einen Kern von drei Punkten aus `skills/session-start/soul.md` § Register. Die Gleichheit sichert bisher nur ein Satz in beiden Dateien, kein Test.
- debug: Ob der Skill unter Claude Code die Gate-Datei findet, hängt davon ab, dass das Modell `../_shared/bootstrap-gate.md` vom Skill-Verzeichnis aus auflöst. Ein Test sichert, dass Phase 0 diesen Pfad nennt und die Datei im Repo dort liegt. Ein Lauf unter Claude Code, der das Gate im Plugin auslöst, wurde nicht gemacht.
- deepen und debug sind in einer sauberen Codex-Umgebung noch nicht gelaufen (der Lauf oben galt eli5 und grill).
- Der Owner entscheidet, ob und wann eingereicht wird.
