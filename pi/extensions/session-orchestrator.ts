import path from "node:path";
import { fileURLToPath } from "node:url";

import { deliverPiWarnings, runPiHookEvent } from "../../scripts/lib/pi-hook-bridge.mjs";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(EXTENSION_DIR, "../..");

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
  on: (event: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) => void;
}) {
  pi.on("session_start", async (event, ctx) => dispatch("session_start", event, ctx));
  pi.on("session_shutdown", async (event, ctx) => dispatch("session_shutdown", event, ctx));
  pi.on("tool_call", async (event, ctx) => dispatch("tool_call", event, ctx));
  pi.on("tool_result", async (event, ctx) => dispatch("tool_result", event, ctx));
  pi.on("agent_end", async (event, ctx) => dispatch("agent_end", event, ctx));
}
