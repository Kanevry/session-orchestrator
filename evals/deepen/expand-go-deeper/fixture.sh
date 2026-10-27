#!/usr/bin/env bash
# Runs in the empty eval workspace (only with --scaffold). Invented onboarding event logs (JSON lines).
set -euo pipefail
mkdir -p logs
cat > logs/events-2026-10.jsonl <<'JSONL'
{"ts":"2026-10-01T09:00:00Z","user":"u1","event":"signup"}
{"ts":"2026-10-01T09:02:00Z","user":"u1","event":"onboarding_step","step":1}
{"ts":"2026-10-01T09:03:00Z","user":"u1","event":"onboarding_step","step":2}
{"ts":"2026-10-01T09:05:00Z","user":"u1","event":"onboarding_done"}
{"ts":"2026-10-01T09:30:00Z","user":"u1","event":"first_project_created"}
{"ts":"2026-10-02T10:00:00Z","user":"u2","event":"signup"}
{"ts":"2026-10-02T10:01:00Z","user":"u2","event":"onboarding_step","step":1}
{"ts":"2026-10-02T10:04:00Z","user":"u2","event":"onboarding_step","step":2}
{"ts":"2026-10-02T10:04:30Z","user":"u2","event":"error","code":"IMPORT_TIMEOUT"}
{"ts":"2026-10-03T11:00:00Z","user":"u3","event":"signup"}
{"ts":"2026-10-03T11:01:00Z","user":"u3","event":"onboarding_step","step":1}
{"ts":"2026-10-03T11:06:00Z","user":"u3","event":"onboarding_step","step":2}
{"ts":"2026-10-03T11:06:20Z","user":"u3","event":"error","code":"IMPORT_TIMEOUT"}
{"ts":"2026-10-03T11:07:00Z","user":"u3","event":"onboarding_done"}
{"ts":"2026-10-04T08:00:00Z","user":"u4","event":"signup"}
{"ts":"2026-10-04T08:02:00Z","user":"u4","event":"onboarding_step","step":1}
{"ts":"2026-10-04T08:03:00Z","user":"u4","event":"onboarding_step","step":2}
{"ts":"2026-10-04T08:04:00Z","user":"u4","event":"onboarding_done"}
JSONL
cat > logs/README.txt <<'TXT'
Ereignislog der App, eine Zeile je Ereignis. Nutzer-IDs sind pseudonymisiert.
TXT
