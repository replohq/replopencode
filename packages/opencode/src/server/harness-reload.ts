import { Effect } from "effect"
import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Skill } from "@/skill"
import { ToolRegistry } from "@/tool/registry"
import { Env } from "@/env"
import { Provider } from "@/provider/provider"
import { MCP } from "@/mcp"
import { EnvReload } from "./env-reload"
import { Event } from "./event"

const emitReloaded = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: { type: Event.Reloaded.type, properties: {} },
  }),
)

/**
 * Reload env + harness in place without disposing instances (sessions survive).
 * 1. Re-read s6 envdirs into process.env.
 * 2. For every currently-loaded instance, invalidate the env/config/provider/
 *    agent/command/skill/tool caches so the next access re-reads from disk and
 *    from the fresh env (incl. provider credentials from OPENCODE_CONFIG_CONTENT).
 * 3. Emit global.reloaded so connected clients can refresh.
 *
 * Unlike InstanceStore.disposeAll(), this never runs the instance disposers, so
 * active sessions keep their already-loaded state and pick up changes on their
 * next access.
 *
 * MCP connections are intentionally NOT torn down here: closing them would
 * break in-flight tool calls, violating the sessions-survive guarantee.
 * Instead, MCP.refreshHeaders swaps freshly-resolved config headers into the
 * live remote transports in place, so the next tool call authenticates with
 * rotated credentials. Structural MCP config changes (URLs, added/removed
 * servers, stdio env) still require a restart.
 */
export const run = Effect.gen(function* () {
  const reloaded = yield* Effect.sync(() => EnvReload.reload())
  yield* Effect.logInfo("harness reload", { envApplied: reloaded.applied })

  const store = yield* InstanceStore.Service
  const env = yield* Env.Service
  const config = yield* Config.Service
  const provider = yield* Provider.Service
  const agent = yield* Agent.Service
  const command = yield* Command.Service
  const skill = yield* Skill.Service
  const tools = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service

  // Invalidate dependencies before their dependents: env (the process.env
  // snapshot) feeds config; config feeds provider/skill/etc; skill feeds
  // agent/command/tools. Sequential order (no concurrency option) makes this
  // ordering meaningful, so a concurrent request re-caching a dependent reads
  // already-fresh upstream state.
  const invalidateAll = Effect.all(
    [
      env.invalidate(),
      config.invalidate(),
      config.invalidateInstance(),
      skill.invalidate(),
      provider.invalidate(),
      agent.invalidate(),
      command.invalidate(),
      tools.invalidate(),
    ],
    { discard: true },
  )

  // Header refresh runs after the invalidations so it re-reads the already
  // fresh config (incl. rotated MCP credentials from OPENCODE_CONFIG_CONTENT).
  const reloadInstance = invalidateAll.pipe(Effect.andThen(mcp.refreshHeaders()))

  const dirs = yield* store.directories()
  yield* Effect.forEach(
    dirs,
    // Isolate each instance: a single failing/mid-disposal instance must not
    // abort the batch or suppress the reloaded event below.
    (dir) =>
      store
        .provide({ directory: dir }, reloadInstance)
        .pipe(Effect.catchCause((cause) => Effect.logWarning("instance harness reload failed", { dir, cause }))),
    { concurrency: "unbounded", discard: true },
  )

  yield* emitReloaded
}).pipe(Effect.withSpan("Server.harnessReload"), Effect.uninterruptible)

export * as HarnessReload from "./harness-reload"
