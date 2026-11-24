import path from "node:path";
import { fileURLToPath } from "node:url";

import { deliverPiWarnings, runPiHookEvent } from "../../scripts/lib/pi-hook-bridge.mjs";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(EXTENSION_DIR, "../..");
const PACKAGE_PATH_GUIDANCE = `Session Orchestrator package root: ${PLUGIN_ROOT}\n`
  + "Resolve commands/, skills/, and scripts/ paths in Session Orchestrator prompts and skills against this root. "
  + "Replace ${CLAUDE_PLUGIN_ROOT} in their paths with this absolute directory.";

type PiEvent = Record<string, unknown> & {
  systemPromptOptions?: { sections?: Record<string, string>; promptGuidelines?: string[] };
};

async function dispatch(piEventName: string, event: Record<string, unknown>, ctx: Record<string, unknown>) {
  const result = await runPiHookEvent(piEventName, event, ctx, { pluginRoot: PLUGIN_ROOT });
  // The decision is fixed before any warning is shown: delivery must never cost a block.
  const decision = result.block
    ? { block: true, reason: result.reason ?? "Blocked by Session Orchestrator" }
    : undefined;
  // Non-blocking hook warnings (emitWarn, `relaxed` profile) would otherwise be lost on Pi.
  // deliverPiWarnings never throws; the catch only guards against a regression there.
  try {
    deliverPiWarnings(result.warnings, ctx);
  } catch {
    /* a warning that cannot be shown must not change the decision */
  }
  return decision;
}

export default function sessionOrchestratorPiExtension(pi: {
  on: (event: string, handler: (event: PiEvent, ctx: Record<string, unknown>) => unknown) => void;
}) {
  // Skills and commands call scripts as `node "${CLAUDE_PLUGIN_ROOT}/scripts/…"`. Claude Code
  // substitutes that text; Pi does not, and a model copies it into its bash tool verbatim
  // (EDIH proof probe 24.11.2026, #2277). Pi's bash tool runs with this process's environment,
  // so setting the variables here lets the shell resolve the path itself. An existing
  // non-blank value is kept. detectPlatform() (scripts/lib/platform.mjs) reads
  // CLAUDE_PLUGIN_ROOT as "this is Claude Code" unless SO_PLATFORM says otherwise, so
  // SO_PLATFORM=pi is set too; without it the scripts the model starts would use .claude/
  // instead of .pi/ and /close would find no state (review note_369583, !552). The hook
  // bridge sets the same three values for hooks (pi-hook-bridge.mjs). BV-004 ceiling: every
  // child of this Pi process inherits them, so a different harness started from Pi's bash
  // tool detects itself as Pi unless it sets its own SO_PLATFORM; a tool that spawns with a
  // scrubbed environment sees none of them. Revisit-Trigger: a Pi run where
  // `${CLAUDE_PLUGIN_ROOT}` expands empty, or a harness launched from Pi misdetecting itself.
  for (const name of ["CLAUDE_PLUGIN_ROOT", "PI_PLUGIN_ROOT"]) {
    if (!(process.env[name] ?? "").trim()) process.env[name] = PLUGIN_ROOT;
  }
  if (!(process.env.SO_PLATFORM ?? "").trim()) process.env.SO_PLATFORM = "pi";
  pi.on("before_agent_start", (event) => {
    try {
      const options = event.systemPromptOptions;
      if (options?.sections) {
        options.sections["session-orchestrator"] = PACKAGE_PATH_GUIDANCE;
      } else if (options?.promptGuidelines && !options.promptGuidelines.includes(PACKAGE_PATH_GUIDANCE)) {
        options.promptGuidelines.push(PACKAGE_PATH_GUIDANCE);
      }
    } catch {
      /* Pi can start the run even when its prompt options cannot be updated. */
    }
  });
  pi.on("session_start", async (event, ctx) => dispatch("session_start", event, ctx));
  pi.on("session_shutdown", async (event, ctx) => dispatch("session_shutdown", event, ctx));
  pi.on("tool_call", async (event, ctx) => dispatch("tool_call", event, ctx));
  pi.on("tool_result", async (event, ctx) => dispatch("tool_result", event, ctx));
  pi.on("agent_end", async (event, ctx) => dispatch("agent_end", event, ctx));
}
