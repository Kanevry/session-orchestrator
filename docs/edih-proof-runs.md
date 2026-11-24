# EDIH proof run protocol

The result to establish is that Session Orchestrator can complete a full Pi
session, from an agreed plan through implementation and checks to a written
handover, both with a European inference provider and with an open-weight model
on hardware we operate.

## Planned runs

| Run | Setup | What a pass establishes | Status |
| --- | --- | --- | --- |
| 0 — Compatibility | Live Pi, a fresh `HOME` (a new empty user profile for Pi), and one available model | The packaged integration loads and completes the workflow in Pi. | not run yet (2026-11-24) |
| A — European provider | Fresh Pi profile with the Mistral API as the sole provider | The workflow completes with inference through a European provider. | not run yet (2026-11-24) |
| B — Own hardware | Fresh Pi profile with one local model endpoint serving an open-weight model on hardware we operate | The workflow completes with inference on our hardware and no connection to an external inference provider during the run. | not run yet (2026-11-24) |

Use a disposable checkout of a small public sample repository with working test,
typecheck and lint commands. Start with `/session feature` and plan two tasks:
one code change with a test and one documentation change. Then use `/go` and
`/close`. Keep Pi’s sequential execution and the lack of model-facing hook
context visible when reporting the result.

## Pass criteria

All nine checks must have evidence in the recording or its accompanying log.

1. `pi install npm:session-orchestrator` returns exit code 0. Pi offers
   `/session`, `/go` and `/close`.
2. The operator agrees to a written plan before the first edit.
3. The model completes the code and documentation tasks in sequence.
4. The project’s test, typecheck and lint commands each run and exit 0. Record
   all three exit codes.
5. The destructive-command guard denies a deliberate test request and shows
   the reason. Use the disposable sample checkout for this check and stop if
   the guard lets the request through.
6. `/close` writes a handover and creates one commit.
7. Record the Pi and Session Orchestrator versions, model ID, inference
   provider or local endpoint, hosting and hardware, and the start and end
   timestamps with time zone. For B, record the model file hash and
   quantization. Include token counts when displayed.
8. Show that the fresh Pi profile has exactly one configured model provider
   or endpoint. Record the scope, method and observed destinations of network
   monitoring. For B, capture the entire session and show that model traffic
   stayed on the local endpoint and no external inference provider was
   contacted. Account for Pi’s own connections separately from model traffic.
9. Record that the Session Orchestrator update check, security pulse and
   startup probes were disabled, with telemetry left off. Use
   `SO_DISABLE_UPDATE_CHECK=1`, `SO_SECURITY_PULSE_REFRESH=off`,
   `SO_DISABLE_STARTUP_PROBES=1` and `SO_TELEMETRY_DISABLED=1`.

## Stop rules and public wording

Run 0 comes first. Stop a run when a mandatory check fails, evidence cannot be
collected, or its runtime cannot complete the task. Record the failed criterion
and the reason before a retry. Treat any run with missing mandatory evidence as
unverified.

| Outcome | Publication decision and fallback |
| --- | --- |
| Run 0 cannot pass after fixes and a retry | Stop before A and B. Remove Pi from lists of verified hosts. Use “A Pi package is documented. Live Pi compatibility remains unverified.” |
| A fails and B passes | Use “A complete Pi session was recorded with an open-weight model on our own hardware.” |
| B fails and A passes | Use “A complete Pi session was recorded using the Mistral API.” |
| A and B both fail or lack evidence | Use “A Pi package is available. An end-to-end session with a European provider or a locally hosted model has yet to be recorded.” |

Publish a terminal or screen recording and a write-up with versions,
configuration, observed network traffic and limitations. Update the Pi setup
guide and EDIH page after the relevant evidence is public. Scope the claim to
the observed inference route. A European provider’s location alone cannot
establish where requests are processed. Verify any processing-region claim
against the provider’s documentation and use the network record, including
Pi’s own traffic, to support any broader data-flow claim.
