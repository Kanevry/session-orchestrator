<!-- source: session-orchestrator plugin (canonical: templates/_shared/journey-manifest.md) -->
<!--
  Retired with /journey-audit in 4.0.0 — kept as a template for a per-repo
  product-truth manifest; no command consumes it.

  Copy to `.orchestrator/journey-manifest.md` in the target repo and fill in every
  section. While `/journey-audit` existed, it refused to run without this file;
  with the command removed, filling this in is optional documentation only.

  The `## SAFETY` block described what gated R5 (the real end-to-end run against
  production with a real account) when the skill still ran. Kept below for
  reference in case a future consumer re-adopts the same manifest shape.

  Credentials: env-var NAMES only, never values. A value pasted here is a secret
  in a tracked file.
-->

# Journey Manifest — <REPO NAME>

> Per-repo product-truth manifest, not code structure.
> Retired with `/journey-audit` in 4.0.0 — no command consumes this file today.
> Last verified: <YYYY-MM-DD> by <operator>

## Personas & Einstiegspunkte

| Persona | Ziel | Einstiegspunkt (URL/Route) | Erfolg heißt |
|---------|------|---------------------------|--------------|
| <anonymer Besucher> | <was er will> | `<https://…/>` | <messbarer Endzustand> |
| <zahlender Kunde> | | | |
| <Owner/Admin> | | | |

List every entry point a real user can reach — including the ones marketing links
to but the app never surfaces. A feature with no entry point is exactly the defect
class this audit exists to find.

## Wahrheits-SSOTs

Where the truth about the product lives in code. R3 compares every claim against
THESE files, not against other prose.

| Gegenstand | SSOT-Datei/Konstante |
|-----------|----------------------|
| Preise / Pläne / Limits | `<src/config/plans.ts>` |
| Feature-Flags | `<…>` |
| Währung / Steuer / Region | `<…>` |
| Quota / Kontingente | `<…>` |
| i18n-Namespaces (Marketing, FAQ, Mail) | `<…>` |
| Chat-/Bot-Faktenquelle | `<…>` |

## Outbound-Touchpoints (Input für R1/R2)

- Template-Verzeichnis: `<…>`
- Send-Pfad / Provider-Adapter: `<…>`
- Cron-/Scheduler-Quellen: `<…>`
- Render-Idiom + Beispiel-Props für R2: `<z. B. react-email, props aus …>`

## Chat-Interview (Frage → Soll-Antwort)

R4 asks these verbatim and scores the answer against the expected one. The expected
answer must be derivable from a Wahrheits-SSOT above — otherwise it is a second
claim, not a truth key.

| # | Frage (wörtlich) | Soll-Antwort (Kern-Fakt) | SSOT |
|---|------------------|--------------------------|------|
| 1 | <"Was kostet …?"> | <"…"> | `<datei>` |
| 2 | | | |
| 3 | | | |

## SAFETY

**MANDATORY for R5. Without this block filled in, R5 is not dispatched.**

- **Erlaubte Konten:** `<test-account@…>` — and no other. Never a real customer account.
- **Erlaubte Events/Objekte:** `<z. B. nur Events mit Präfix AUDIT-…>`
- **No-Go-Aktionen:** <Löschen fremder Daten · Mailversand an echte Empfänger · Plan-Downgrade · Refunds · Webhook-Replays gegen Prod>
- **Checkout-Grenze:** `<max. EUR X, Testkarte …, Live-Zahlungen verboten>`
- **Cleanup-Regel:** <was nach dem Durchstich wieder entfernt wird, von wem, woran man erkennt dass es weg ist>
- **Abbruchbedingung:** <woran R5 sofort stoppt und meldet statt weiterzumachen>

## Credential-Quellen (env-Namen, NIE Werte)

| Zweck | Env-Variable | Bezugsquelle |
|-------|--------------|--------------|
| Prod-Login R5 | `<AUDIT_TEST_ACCOUNT_EMAIL>` | `<1Password-Item / .env.local>` |
| DB read-only R6 | `<AUDIT_DB_READONLY_URL>` | `<…>` |
| Mail-Provider-API R6 | `<…>` | `<…>` |
| Plattform-CLI R7 | `<…>` | `<…>` |

## Realdaten-Queries (R6, read-only)

Only `SELECT`. A query that writes does not belong in this file.

```sql
-- Funnel: Registrierung → Aktivierung → Zahlung
SELECT …;
```

- Identitäts-Regeln: <wie ein Nutzer über Tabellen hinweg identifiziert wird>
- Nicht messbar (bewusst benennen): <was die Daten NICHT hergeben>

## Plattform-Erwartung (R7)

- CLI-Logins: `<vercel · supabase · cloudflare · …>`
- Erwarteter Plan/Tier je Dienst: `<…>`
- Offene Perf-/Kosten-Issues: `<#…>`

## Bekannte Ausnahmen

Findings that are known and deliberately accepted — with the reason and a revisit
trigger. R1–R7 report them as `known-exception`, never as new findings.

| Befund | Warum akzeptiert | Revisit-Trigger |
|--------|------------------|-----------------|
| <…> | <…> | <…> |
