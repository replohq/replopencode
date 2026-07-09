import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Skill } from "../../src/skill"
import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { ToolRegistry } from "../../src/tool/registry"
import { MCP } from "../../src/mcp"
import { Env } from "../../src/env"
import { HarnessReload } from "../../src/server/harness-reload"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { ProviderTest } from "../fake/provider"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Stub the harness services HarnessReload only invalidates (never reads) so the
// test stays light. Skill + Config are real so the skill re-read is meaningful.
const agentStub = Layer.succeed(
  Agent.Service,
  Agent.Service.of({
    get: () => Effect.die("stub"),
    list: () => Effect.succeed([]),
    defaultInfo: () => Effect.die("stub"),
    defaultAgent: () => Effect.succeed("build"),
    generate: () => Effect.die("stub"),
    invalidate: () => Effect.void,
  }),
)
const commandStub = Layer.succeed(
  Command.Service,
  Command.Service.of({
    get: () => Effect.succeed(undefined),
    list: () => Effect.succeed([]),
    invalidate: () => Effect.void,
  }),
)
const toolRegistryStub = Layer.succeed(
  ToolRegistry.Service,
  ToolRegistry.Service.of({
    ids: () => Effect.succeed([]),
    all: () => Effect.succeed([]),
    named: () => Effect.die("stub"),
    tools: () => Effect.succeed([]),
    invalidate: () => Effect.void,
  }),
)
let mcpRefreshCount = 0
const mcpStub = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.die("stub"),
    clients: () => Effect.die("stub"),
    tools: () => Effect.die("stub"),
    prompts: () => Effect.die("stub"),
    resources: () => Effect.die("stub"),
    add: () => Effect.die("stub"),
    connect: () => Effect.die("stub"),
    disconnect: () => Effect.die("stub"),
    refreshHeaders: () =>
      Effect.sync(() => {
        mcpRefreshCount++
      }),
    getPrompt: () => Effect.die("stub"),
    readResource: () => Effect.die("stub"),
    startAuth: () => Effect.die("stub"),
    authenticate: () => Effect.die("stub"),
    finishAuth: () => Effect.die("stub"),
    removeAuth: () => Effect.die("stub"),
    supportsOAuth: () => Effect.die("stub"),
    hasStoredTokens: () => Effect.die("stub"),
    getAuthStatus: () => Effect.die("stub"),
  }),
)

const it = testEffect(
  Layer.mergeAll(
    Skill.defaultLayer,
    Config.defaultLayer,
    Env.defaultLayer,
    ProviderTest.fake().layer,
    agentStub,
    commandStub,
    toolRegistryStub,
    mcpStub,
    testInstanceStoreLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

function skillMd(name: string, description: string) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}

describe("HarnessReload.run", () => {
  it.live("invalidates loaded instances and emits global.reloaded", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // Point env reload at a harmless empty override so it never touches /var/s6-env.
        process.env["OPENCODE_RELOAD_ENVDIRS"] = path.join(dir, "no-such-envdir")

        const skill = yield* Skill.Service
        const file = path.join(dir, ".opencode", "skill", "hot", "SKILL.md")
        yield* Effect.promise(() => Bun.write(file, skillMd("hot", "before")))
        expect((yield* skill.get("hot"))?.description).toBe("before")

        const events: GlobalEvent[] = []
        const handler = (e: GlobalEvent) => events.push(e)
        GlobalBus.on("event", handler)

        yield* Effect.promise(() => Bun.write(file, skillMd("hot", "after")))
        mcpRefreshCount = 0
        yield* HarnessReload.run
        GlobalBus.off("event", handler)

        expect((yield* skill.get("hot"))?.description).toBe("after")
        // Live MCP headers are refreshed (post config invalidation) per instance.
        expect(mcpRefreshCount).toBe(1)
        expect(events.some((e) => e.payload?.type === "global.reloaded")).toBe(true)
      }),
    ),
  )
})
