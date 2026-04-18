# Feature: Windows Native Support (v3.0.0)

**Date:** 2026-04-18
**Author:** Bernhard Götzendorfer + Claude (AI-assisted planning)
**Status:** Draft — Awaiting Approval
**Appetite:** Full Migration (no time estimate per user direction)
**Parent Project:** session-orchestrator (v2.0.0 → v3.0.0)

---

## 1. Problem & Motivation

### What

Der `session-orchestrator` Plugin läuft heute auf macOS und Linux zuverlässig, auf **nativem Windows (ohne WSL/Git-Bash-Hack) aber gar nicht**. Alle 5 Hooks sind fest auf `bash` verdrahtet (`bash "$CLAUDE_PLUGIN_ROOT/hooks/*.sh"`), ~50 Scripts verwenden POSIX-only Idioms (`/tmp`, Prefix-Stripping mit `/`, GNU `sed`/`date`/`jq`), und 47 `.sh`-Testscripts blockieren Windows-Contributors komplett.

**Ziel:** Windows läuft **identisch wie macOS** — nativer Betrieb ohne WSL, ohne Git Bash, ohne manuelle Workarounds. Plugin-User unter Windows installieren einmal, Hooks funktionieren, Tests laufen, CI grün.

Der Migrations-Pfad ist klar: **Kompletter Umstieg auf Node.js (zx 8.x) für allen ausgeführten Code** (Hooks + Scripts + Test-Runner). Markdown-Skills mit Bash-Snippets bleiben unverändert — das sind Prompt-Dokumentationen für das LLM, kein tatsächlich ausgeführter Code.

### Why

1. **User-Feedback:** Konkreter Report, dass Codex/Claude-Code-User auf Windows mit session-orchestrator "die ärgsten Probleme" haben.
2. **Anthropic hat den Boden bereitet:** Claude Code v2.1.84 (März 2026) brachte den Opt-in-PowerShell-Tool; April-2026-Release fixte Drive-Letter-Case und SessionStart-Hooks auf Windows. Jetzt ist der realistische Zeitpunkt für Native-Support.
3. **Marktplatz-Adoption:** Plugin ist im `kanevry`-Marketplace pending Anthropic-Review. Ein "Windows broken"-Label schadet der Erstwahrnehmung. ~30% der Developer-Userbase arbeitet auf Windows (Stack Overflow Survey 2025).
4. **Wartungslast:** Bash-Scripts sind fragil (POSIX vs GNU sed, macOS `date` vs Linux `date`, `/tmp` vs `%TEMP%`). Node.js eliminiert diese Klasse von Bugs komplett (`os.tmpdir()`, `path.join()`, native JSON).
5. **Known Upstream Bugs:** GitHub-Issues #22700 (bash-PATH), #23556 (WSL+Git-Bash-Konflikt), #34457 (subprocess-deadlocks), #18527 (Path-Separator) → alle durch Node.js-Hooks umgangen, weil `command: "node ..."` die bash-Resolution-Probleme bypasst.

### Who

1. **Primary: Native-Windows-Developer ohne WSL** — Corporate-IT-Umgebungen mit WSL-Verbot, Windows-First-Developer, Einsteiger die WSL-Setup als Hürde empfinden. Das ist der aktuell komplett blockierte Cohort.
2. **Secondary: WSL2-User** — funktioniert heute halbwegs, wird durch Migration aber robuster (keine CRLF-Probleme mehr, keine jq-Abhängigkeit).
3. **Tertiary: Unix-User (macOS/Linux)** — profitieren durch robustere Scripts, klarere Fehlermeldungen (Node-Stacktraces > Bash `set -e` abort), einheitliche Test-Story.
4. **Plugin-Contributors unter Windows** — können zum ersten Mal nativ Tests laufen lassen (Vitest statt bats), lokal debuggen, beitragen.

---

## 2. Solution & Scope

### In-Scope

- [ ] **`.gitattributes`** (neu): LF für `.sh`, `.md`, `.json`, `.yaml`, `.yml`, `.mjs`, `.js`; CRLF für `.ps1`; `* text=auto` als Fallback.
- [ ] **`package.json`** (neu, Plugin-Root): Node 20+ engines, `type: "module"`, `zx ^8.1.0` als dep, `vitest ^2.0.0` als devDep, Scripts `test`, `test:watch`, `lint`, `typecheck`.
- [ ] **Alle 5 Hooks migriert von `.sh` nach `.mjs`** (Node + zx): `on-session-start`, `on-stop`, `enforce-scope`, `enforce-commands`, `post-edit-validate`.
- [ ] **`hooks/hooks.json` aktualisiert** auf `"command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/<name>.mjs\""` für alle Hooks.
- [ ] **Kritische Scripts migriert** von `.sh` nach `.mjs` — alle unter `scripts/` die nicht Tests sind: `parse-config.sh`, `lib/events.sh`, `lib/worktree.sh`, `lib/config-yaml-parser.sh`, `lib/platform.sh`, `lib/hardening.sh`, `lib/common.sh`.
- [ ] **Test-Runner von `bats` auf `vitest`** migriert: alle 47 `scripts/test/test-*.sh` in `tests/*.test.mjs` übersetzt. Fokus auf Verhaltensäquivalenz, nicht 1:1-Übersetzung.
- [ ] **GitHub Actions windows-latest + macos-latest + ubuntu-latest Matrix** ab Tag 1 des Branches.
- [ ] **Platform-Detection erweitert** in `scripts/lib/platform.mjs`: OS-Detection (`process.platform`), Drive-Letter-Awareness, SO_OS-Export für Downstream-Use.
- [ ] **Path-Handling-Helfer** in `scripts/lib/path-utils.mjs`: Containment-Check (path-traversal-safe), Relative-Path-Computation, Drive-Letter-Case-Normalization.
- [ ] **`jq`-Dependency eliminiert** (~40 Stellen) durch native JS `JSON.parse()`/`JSON.stringify()`.
- [ ] **`/tmp`-Hardcodes eliminiert** durch `os.tmpdir()`.
- [ ] **POSIX-Prefix-Stripping** (`${PATH#"$ROOT"/}`) durch `path.relative()` ersetzt.
- [ ] **README.md aktualisiert**: "Platform Support"-Tabelle klarstellen (Windows nativ ✅), Installation-Docs (`npm install`-Schritt), Troubleshooting-Section für Windows-spezifische Gotchas.
- [ ] **CHANGELOG.md v3.0.0**: BREAKING-CHANGES-Section, Migration-Guide für Bestands-User.
- [ ] **Migration-Guide** in `docs/migration-v3.md`: Was ändert sich für User (Node-Install nötig), für Contributors (Vitest statt bats), für Plugin-Entwickler (`.mjs` statt `.sh`).
- [ ] **ESLint + Prettier Config** (flat config, v9): Basis-Regeln für `.mjs` files, CI-Check.

### Out-of-Scope

- **Skill-Markdown-Prompts mit Bash-Code-Blöcken bleiben unverändert** — das sind Prompts/Dokumentation für das LLM, nicht ausgeführter Code. Das LLM interpretiert sie sowieso platform-agnostisch. Eine Migration wäre reine Kosmetik mit YAGNI-Risiko und würde getestetes LLM-Verhalten brechen.
- **PowerShell-Version der Hooks** (`.ps1`) — Dual-Shipping ist wartungsfeindlich (Drift). Node.js ersetzt beides sauber. `shell: "powershell"` im Hooks.json wird nur als optionale Escape-Hatch in Docs erwähnt, nicht als Primärpfad.
- **WSL-Deprecation** — WSL-User profitieren automatisch, aber nichts wird für WSL spezifisch gebaut oder entfernt.
- **Migration bestehender Sessions-History / Metrics** — Format (JSONL) bleibt identisch, keine Schema-Änderung.
- **Neue Features** — keine zusätzliche Funktionalität. Dieser PRD ist reine Portabilitäts-Refaktorierung.
- **TypeScript-Migration** — vorerst bleibt es bei `.mjs` mit JSDoc-Typisierung wo sinnvoll. TS ist separates Projekt.
- **Shell-Script-Bundling mit `pkg`/`ncc`** — Single-Binary-Distribution wäre ein eigenes großes Projekt und nicht notwendig: `npm install` ist für Developer akzeptabel.
- **Node-Version-Downgrade unter 20** — Node 20 LTS ist seit Oktober 2023 stabil; `AbortController`, Native Test Runner, stable Fetch brauchen wir.
- **Codex-CLI-spezifische Abweichungen** — gleiche Node-basierte Hooks laufen in beiden Environments.

---

## 3. Acceptance Criteria

### Bereich 1: Hooks laufen auf Windows nativ

```gherkin
Given ein Windows-11-System ohne WSL und ohne Git-for-Windows
And Node.js 20+ ist installiert
And der User hat `session-orchestrator` geklont und `npm install` im Plugin-Root ausgeführt
When Claude Code startet und eine Session geöffnet wird
Then der SessionStart-Hook läuft ohne Fehler durch
And `.claude/STATE.md` wird korrekt gelesen/geschrieben
And es erscheinen keine "bash: command not found" oder Path-Separator-Fehler im Transcript
```

### Bereich 2: Scope-Enforcement schützt korrekt cross-platform

```gherkin
Given eine Session mit aktivem wave-scope.json (`enforcement: strict`, `allowedPaths: ["src/**/*.ts"]`)
When Claude versucht, `C:\Users\dev\project\src\index.ts` (Windows) zu editieren
Then `enforce-scope.mjs` liest stdin, resolved Path via `path.resolve()`, matched gegen Pattern mit `path.relative()`
And gibt `{"permissionDecision": "allow"}` zurück mit Exit-Code 0
When Claude versucht, `C:\Users\dev\project\node_modules\foo.js` zu editieren
Then Hook liefert `{"permissionDecision": "deny", "reason": "Scope violation: ..."}` mit Exit-Code 2
```

### Bereich 3: Path-Traversal-Schutz ist sicher

```gherkin
Given project-root `C:\Users\dev\project`
When Claude versucht, `../../Windows/System32/hosts` zu editieren
Then `enforce-scope.mjs` resolved zu `C:\Windows\System32\hosts`
And `path.relative(projectRoot, fullPath)` startet mit `..` oder ist absolut
And Hook liefert `deny` mit Reason "File outside project root"
And auf macOS: gleicher Test mit `/etc/passwd` liefert ebenfalls `deny`
```

### Bereich 4: `jq`-Unabhängigkeit

```gherkin
Given ein Windows-System ohne `jq` im PATH
When irgendein Hook oder Script ausgeführt wird, das früher `jq` verwendete (z.B. on-stop.mjs, enforce-commands.mjs)
Then das Script parst JSON nativ mit `JSON.parse()` und `JSON.stringify()`
And keine externe Binary wird aufgerufen
And die funktionale Ausgabe ist identisch zu macOS
```

### Bereich 5: Tests laufen auf allen drei OS

```gherkin
Given der Developer hat das Repo gecloned und `npm install` ausgeführt
When `npm test` auf macOS/Linux/Windows ausgeführt wird
Then Vitest erkennt alle `tests/**/*.test.mjs`
And jeder Test läuft mit identischem Ergebnis
And die Test-Suite endet mit Exit-Code 0 und allen grünen Tests
And Watch-Mode (`npm run test:watch`) funktioniert interaktiv
```

### Bereich 6: GitHub Actions CI-Matrix

```gherkin
Given ein PR gegen den `main`-Branch
When GH-Actions der Test-Workflow läuft
Then 3 Jobs laufen parallel: `windows-latest`, `macos-latest`, `ubuntu-latest`
And jeder Job: Checkout mit `autocrlf: false`, Setup-Node 20, `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`
And alle drei müssen grün sein, damit Merge möglich ist (Branch-Protection)
And bei Windows-Fehlern wird der fehlgeschlagene stderr im GH-Log sichtbar
```

### Bereich 7: CRLF-Resilienz

```gherkin
Given der User clont das Repo auf Windows mit Git `core.autocrlf=true` (Default)
When Hooks versuchen, `CLAUDE.md` oder `wave-scope.json` zu parsen
Then `.gitattributes` hat LF für alle Script-, Config- und JSON-Dateien erzwungen → Git behält LF bei Checkout
And selbst wenn CRLF vorkommt: Node parst UTF-8 mit LF oder CRLF transparent (JSON.parse, fs.readFile mit string encoding)
And keine `grep -q "^## Session Config"`-ähnlichen Anchor-Failures mehr
```

### Bereich 8: Upgrade-Pfad für bestehende User

```gherkin
Given ein User auf v2.0.0 aktualisiert auf v3.0.0
When er die neue Version installiert
Then README und CHANGELOG erklären den Breaking Change klar
And ein explicit `npm install` im Plugin-Root ist die einzige zusätzliche Aktion
And STATE.md, Session-History, Metrics-Files (JSONL) bleiben ohne Migration lesbar
And Hooks-Verhalten ist funktional äquivalent zur alten Bash-Version
```

### Bereich 9: Fehlerpfade & Robustheit

```gherkin
Given `npm install` wurde noch nicht ausgeführt und `zx` fehlt in node_modules
When ein Hook ausgelöst wird
Then der Hook erkennt fehlende Dependencies, gibt eine verständliche Fehlermeldung auf stderr aus ("Run `npm install` in plugin root")
And terminiert mit Exit-Code 0 statt 2 (non-blocking warn statt deny, damit die Session nicht komplett bricht)

Given Node.js-Version < 20 ist installiert
When ein Hook ausgeführt wird
Then die erste `engines`-Check-Zeile gibt "Node 20+ required, found vX.Y.Z" aus und bricht sauber mit Exit-Code 1
```

### Bereich 10: Dokumentation ist aktuell und korrekt

```gherkin
Given ein neuer User liest README.md
Then die Platform-Support-Tabelle listet Windows explizit als unterstützt (✅) mit Link zur Installation-Section
And die Installation-Section beschreibt: (1) Node 20+ installieren, (2) Plugin klonen/installieren, (3) `npm install` im Plugin-Root, (4) Claude Code restart
And CHANGELOG.md hat einen v3.0.0-Eintrag mit BREAKING-CHANGES-Section
And `docs/migration-v3.md` existiert und beschreibt den Umstieg für Bestands-User
```

---

## 4. Technical Notes

### Affected Files

**Neu (zu erstellen):**

| Datei | Zweck |
|---|---|
| `package.json` | Plugin-Root: Node-deps, Scripts |
| `.gitattributes` | LF für `.sh`/`.md`/JSON/YAML/`.mjs`, CRLF für `.ps1` |
| `.github/workflows/test.yml` | CI-Matrix (win/mac/linux) |
| `eslint.config.js` | ESLint v9 flat config |
| `.prettierrc` | Prettier defaults |
| `vitest.config.js` | Vitest config (environment `node`, pattern `tests/**/*.test.mjs`) |
| `hooks/on-session-start.mjs` | ersetzt `.sh` |
| `hooks/on-stop.mjs` | ersetzt `.sh` |
| `hooks/enforce-scope.mjs` | ersetzt `.sh`, PoC aus Research liegt vor |
| `hooks/enforce-commands.mjs` | ersetzt `.sh` |
| `hooks/post-edit-validate.mjs` | ersetzt `.sh` |
| `scripts/lib/platform.mjs` | ersetzt `platform.sh`, erweitert um OS-Detection |
| `scripts/lib/path-utils.mjs` | Containment-Check, Relative-Resolve, Drive-Letter-Case |
| `scripts/lib/config.mjs` | ersetzt `parse-config.sh` + `config-yaml-parser.sh` |
| `scripts/lib/events.mjs` | ersetzt `events.sh` |
| `scripts/lib/worktree.mjs` | ersetzt `worktree.sh` |
| `scripts/lib/hardening.mjs` | ersetzt `hardening.sh` |
| `scripts/lib/common.mjs` | ersetzt `common.sh` |
| `tests/**/*.test.mjs` | Vitest-Suite (ersetzt `scripts/test/test-*.sh`) |
| `docs/migration-v3.md` | Migration-Guide |

**Zu modifizieren:**

| Datei | Änderung |
|---|---|
| `hooks/hooks.json` | Alle `"command"`-Strings: `bash "$X.sh"` → `node "$X.mjs"` |
| `README.md` | Platform-Support-Tabelle, Installation-Section, Troubleshooting |
| `CHANGELOG.md` | v3.0.0 Entry mit BREAKING-CHANGES |
| `CLAUDE.md` (plugin-repo) | Session Config + Developer-Setup-Notes |

**Zu löschen (nach erfolgreichem Cutover):**

| Datei | Grund |
|---|---|
| `hooks/*.sh` (5 Dateien) | Ersetzt durch `.mjs` |
| `scripts/lib/*.sh` (7 Dateien) | Ersetzt durch `.mjs` |
| `scripts/parse-config.sh` | Ersetzt durch `scripts/lib/config.mjs` |
| `scripts/test/test-*.sh` (47 Dateien) | Ersetzt durch `tests/**/*.test.mjs` |
| `scripts/test/run-all.sh` | Ersetzt durch `npm test` |

### Architecture

**Layering (nach Migration):**

```
┌─────────────────────────────────────────────────────────────┐
│ Claude Code Runtime (native: Mac/Win/Linux)                 │
└────────────────────────┬────────────────────────────────────┘
                         │ spawns via hooks.json
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ hooks/*.mjs (5 files, Node entry points)                    │
│ — read stdin JSON, write stdout JSON, exit 0/2              │
└────────────────────────┬────────────────────────────────────┘
                         │ import
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ scripts/lib/*.mjs (shared libs)                             │
│ — platform.mjs: OS + IDE detection                          │
│ — path-utils.mjs: cross-platform path handling              │
│ — config.mjs: CLAUDE.md / Session Config parser             │
│ — events.mjs: JSONL event emission                          │
│ — worktree.mjs: git worktree helpers                        │
│ — hardening.mjs: env/runtime sanity checks                  │
│ — common.mjs: shared utilities                              │
└────────────────────────┬────────────────────────────────────┘
                         │ uses
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Node 20+ stdlib (path, fs/promises, os, url, child_process) │
│ + zx ^8.1.0 (for template-literal shell ops where needed)   │
└─────────────────────────────────────────────────────────────┘
```

**Key Patterns:**

1. **Hook entry point pattern** (alle 5 Hooks):
   ```javascript
   #!/usr/bin/env node
   import { readStdin, emitAllow, emitDeny, emitWarn } from './_lib/io.mjs';
   
   const input = await readStdin();  // JSON from Claude Code
   // ... business logic ...
   emitAllow();  // stdout JSON + exit 0
   ```

2. **Path-traversal-safe containment** (zentral in `path-utils.mjs`):
   ```javascript
   import path from 'path';
   
   export function isPathInside(child, parent) {
     const relativePath = path.relative(path.resolve(parent), path.resolve(child));
     return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
   }
   ```

3. **Cross-platform tmpdir** (`common.mjs`):
   ```javascript
   import os from 'os';
   import path from 'path';
   
   export function makeTmpPath(prefix) {
     const rand = Math.random().toString(36).slice(2, 8);
     return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${rand}`);
   }
   ```

4. **Graceful dep-check** (frontloaded in jedem Hook):
   ```javascript
   try {
     await import('zx');
   } catch {
     console.error('session-orchestrator: Run `npm install` in plugin root first.');
     process.exit(0);  // non-blocking
   }
   ```

5. **zx-Nutzung** nur wo wir tatsächlich externe Commands shellen (git, glab, gh). Reine File-I/O + JSON-Parsing bleibt in Node-stdlib ohne zx.

### Data Model Changes

Keine. `.orchestrator/metrics/sessions.jsonl`, `wave-scope.json`, `STATE.md`, Session-Memory-Files bleiben im Format identisch. Nur das *wer-schreibt-sie* wechselt von Bash zu Node.

### API Changes

Keine externen APIs. `hooks/hooks.json` ist das einzige "öffentliche" Interface zu Claude Code — das ändert sich im *command*-Feld (`bash ...` → `node ...`) aber behält Struktur + Matcher + Event-Types bei.

### Dependency Strategy

- **Runtime:** `zx ^8.1.0` (Google, aktiv gewartet, battle-tested). Mit `^` pinned minor, damit Security-Patches automatisch.
- **Dev:** `vitest ^2.0.0`, `eslint ^9.0.0` (flat config), `@eslint/js ^9.0.0`, `prettier ^3.0.0`.
- **User-Install:** `npm install` im Plugin-Root. Keine globalen Abhängigkeiten. `node_modules/` in `.gitignore`.
- **First-Run-Trigger:** Bootstrap-Gate (oder ein neuer SessionStart-Pre-Hook) checkt ob `node_modules/zx` existiert; wenn nicht, log-warnt und exit-0 (nicht blockierend).

### Plattform-Detection-Erweiterung

`scripts/lib/platform.mjs` exportiert zusätzlich zu den vorhandenen IDE-Feldern:

```javascript
export const SO_OS = process.platform;  // 'darwin' | 'linux' | 'win32'
export const SO_IS_WINDOWS = SO_OS === 'win32';
export const SO_IS_WSL = process.env.WSL_DISTRO_NAME !== undefined;
export const SO_PATH_SEP = path.sep;
```

Downstream-Code kann verzweigen wo nötig (z.B. Drive-Letter-Normalization nur auf Windows).

---

## 5. Risks & Dependencies

| Risk | Impact | Mitigation |
|---|---|---|
| **Claude-Code-Bug #32930**: Hook-Router ignoriert `shell`-Field, routet alles durch `/usr/bin/bash` auf Windows | Hoch: würde Node-Hooks blockieren, wenn es den `node`-Command auch betrifft | **Wir bypassen das**, weil unsere hooks.json `"command": "node ..."` nutzt (nicht `"shell": "powershell"`). Der Bug betrifft nur PowerShell-Shell-Hint, nicht direkten Node-Spawn. Verifizieren mit Windows-CI in Phase 1. |
| **Breaking Change** für bestehende User | Mittel: v2→v3-User müssen `npm install` laufen lassen, sonst Hooks failen | Ausführlicher Migration-Guide, klare CHANGELOG-BREAKING-Section, README-Upgrade-Section. v3.0.0 als Major-Bump signalisiert Break offen. |
| **`npm install`-Hürde** für Casual-User | Mittel: eine Aktion mehr als v2 | Im README als Einzeiler dokumentieren, SessionStart-Hook checkt und gibt freundliche Meldung wenn deps fehlen. |
| **Windows-Contributors fehlen** für lokale Validierung während Entwicklung | Mittel: wir könnten Win-spezifische Bugs im Dev erst in CI sehen | `windows-latest`-CI ab Tag 1, nicht erst am Ende. Jeder PR muss Win-grün sein. |
| **zx 8.x Breaking-Changes in zukünftigen Minor-Versions** | Gering: zx ist stabil seit v7 | `^8.1.0`-Pin, `package-lock.json` comitten, Monitoring der zx-Release-Notes. |
| **GH-Actions-Cost: windows-latest ist 2× teurer** | Gering: PR-triggered only, keine Schedule-Runs | Pro-PR-Trigger reicht, keine Pushes auf Feature-Branches, `concurrency`-Gruppe um parallele Runs zu vermeiden. |
| **Path-Traversal-Bug in enforce-scope.mjs** (Security!) | Hoch wenn, Breach für private Files | `path.relative`-basierter Containment-Check (nicht `startsWith`), Test-Case für `..`/`../..`-Szenarien mandatorisch, Code-Review durch security-reviewer-Agent im PR. |
| **CRLF bei User-Checkouts vor `.gitattributes`-Commit** | Gering: nur beim allerersten Pull nach Commit | Docs-Hinweis: `git config core.autocrlf false` für neue Clones dieses Repos. |
| **Startup-Cost Node-Hook vs Bash** (~180ms auf Windows) | Gering bei unserer Hook-Frequenz | Akzeptabel, weil Hooks ohnehin seltene Events sind (Session-Start, Tool-Use). Kein Hot-Path. |
| **Skill-Prompts enthalten Bash-Beispiele, die ein LLM im User-Repo generieren könnte** | Gering: das LLM passt Code an Zielprojekt an | Out-of-Scope dieser Migration (siehe §2). Wenn sich LLM-Verhalten als Problem zeigt, separates Ticket. |
| **Node 20 nicht installiert auf User-System** | Gering: Node 20 ist LTS seit Oct 2023, Claude-Code-Desktop bringt eigenes Node mit | `engines`-Check in package.json + Hook-intro-Check mit klarer Fehlermeldung. |
| **Test-Framework-Migration bats → Vitest verliert Coverage** | Mittel: Behavioral-Tests müssen korrekt übersetzt werden | Jeder bats-Test wird 1:1 in Vitest übersetzt, nicht neu designed. Parallel-Testing (bats grün + Vitest grün) während Cutover. |

### Dependencies

| Dependency | Status | Relationship |
|---|---|---|
| **Claude Code v2.1.84+** | Released März 2026, aktuell | Required Baseline. Hook-JSON-Format stabil. |
| **Node.js ≥ 20.0.0** | LTS seit Oct 2023 | Required Runtime. |
| **Open Issue #86** (lifecycle-sim v6) | Offen, niedrige Priorität | Unabhängig; kann parallel gemerged werden. |
| **GL#10 / Marketplace Anthropic-Review** | Closed, pending review | Nicht-blockierend. v3.0.0 würde nach Marketplace-Approval released. |
| **obra/superpowers Skills** | Extern, stabil | Nutzen wir als Deps der Skills; Migration berührt sie nicht. |
| **bootstrap.lock Schema** | v1 stabil | Unverändert. |
| **`.orchestrator/metrics/sessions.jsonl` Format** | v2-stabil | Unverändert. |

### Dokumentations-Anforderungen

Vom User explizit gefordert: "dokumentiere alles sauber bitte und recherchiere unbedingt damit 100% das vorgehen klar ist".

Ergebnis:
- Dieser PRD (detailliert)
- `docs/migration-v3.md` (User-Facing Migration-Guide)
- `docs/plugin-architecture-v3.md` (Contributor-Facing: neue Layering, patterns, extension-points)
- README-Update (Platform-Support + Installation)
- CHANGELOG v3.0.0 mit BREAKING-CHANGES + Motivation + Migration-Summary
- Pro Hook/Script-Migrations-Issue: Vor/Nach-Snippet in Issue-Body

### Rollout-Strategie

1. **Feature-Branch** `feat/windows-native-v3` (sauber separat).
2. **CI ab Commit 1** auf allen drei OS; kein Merge ohne drei grüne Matrix-Jobs.
3. **Hook-by-Hook-Migration** (pro Hook ein Commit/Issue, kleine diff-Surface, leicht review-bar).
4. **Parallel-Period im Branch:** `.sh` bleibt bis alle `.mjs` grün sind; dann .sh in einem finalen Cleanup-Commit löschen.
5. **Pre-Release** `v3.0.0-rc.1` → `v3.0.0-rc.2` nach Feedback → `v3.0.0` stable.
6. **Marketplace-Update** nach Stable-Tag + README-Update.

---

<!-- Fin PRD -->
