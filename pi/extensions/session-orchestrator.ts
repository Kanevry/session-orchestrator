import path from "node:path";
import { fileURLToPath } from "node:url";

import { runPiHookEvent } from "../../scripts/lib/pi-hook-bridge.mjs";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(EXTENSION_DIR, "../..");

async function dispatch(piEventName: string, event: Record<string, unknown>, ctx: Record<string, unknown>) {
  const result = await runPiHookEvent(piEventName, event, ctx, { pluginRoot: PLUGIN_ROOT });
  if (result.block) {
    return { block: true, reason: result.reason ?? "Blocked by Session Orchestrator" };
  }
  return undefined;
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
