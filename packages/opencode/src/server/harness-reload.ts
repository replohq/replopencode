import { Effect } from "effect"
import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Skill } from "@/skill"
import { ToolRegistry } from "@/tool/registry"
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
 * 2. For every currently-loaded instance, invalidate config/agent/command/skill/tool
 *    caches so the next access re-reads from disk (and from the fresh env).
 * 3. Emit global.reloaded so connected clients can refresh.
 *
 * Unlike InstanceStore.disposeAll(), this never runs the instance disposers, so
 * active sessions keep their already-loaded state and pick up changes on their
 * next access.
 */
export const run = Effect.gen(function* () {
  const env = yield* Effect.sync(() => EnvReload.reload())
  yield* Effect.logInfo("harness reload", { envApplied: env.applied })

  const store = yield* InstanceStore.Service
  const config = yield* Config.Service
  const agent = yield* Agent.Service
  const command = yield* Command.Service
  const skill = yield* Skill.Service
  const tools = yield* ToolRegistry.Service

  const invalidateAll = Effect.all(
    [
      config.invalidate(),
      config.invalidateInstance(),
      agent.invalidate(),
      command.invalidate(),
      skill.invalidate(),
      tools.invalidate(),
    ],
    { discard: true },
  )

  const dirs = yield* store.directories()
  yield* Effect.forEach(dirs, (dir) => store.provide({ directory: dir }, invalidateAll), {
    concurrency: "unbounded",
    discard: true,
  })

  yield* emitReloaded
}).pipe(Effect.withSpan("Server.harnessReload"), Effect.uninterruptible)

export * as HarnessReload from "./harness-reload"
