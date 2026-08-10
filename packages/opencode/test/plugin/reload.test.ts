import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

// Config.node is in the group so tests resolve the same (memoized, shared) config
// instance Plugin reads, and can invalidate it after rewriting opencode.json.
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, Config.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)
const systemHook = "experimental.chat.system.transform"

// Writes loaded-<tag>.txt when instantiated and disposed-<tag>.txt when disposed, so tests can observe both lifecycle edges.
function pluginSource(tag: string, dir: string) {
  return [
    "export default async () => {",
    `  await Bun.write(${JSON.stringify(path.join(dir, `loaded-${tag}.txt`))}, "1")`,
    "  return {",
    `    ${JSON.stringify(systemHook)}: (_input, output) => { output.system.unshift(${JSON.stringify(tag)}) },`,
    `    dispose: async () => { await Bun.write(${JSON.stringify(path.join(dir, `disposed-${tag}.txt`))}, "1") },`,
    "  }",
    "}",
    "",
  ].join("\n")
}

const markerExists = (dir: string, name: string) => Effect.promise(() => Bun.file(path.join(dir, name)).exists())

const triggerSystemTransform = Effect.fn("PluginReloadTest.triggerSystemTransform")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    {
      model: {
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("claude-sonnet-4-6"),
      },
    },
    out,
  )
  return out.system
})

// Mirrors the Replo harness layout: plugin files behind a versioned-dir symlink (`plugins` -> `plugins-<sha>`), flipped in place by upgrades.
function withVersionedPlugin<A, E, R>(self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const v1 = path.join(test.directory, "plugins-v1")
    yield* Effect.promise(() => fs.mkdir(v1, { recursive: true }))
    yield* Effect.promise(() => Bun.write(path.join(v1, "hook.ts"), pluginSource("v1", test.directory)))
    yield* Effect.promise(() => fs.symlink("plugins-v1", path.join(test.directory, "plugins")))
    yield* Effect.promise(() =>
      Bun.write(
        path.join(test.directory, "opencode.json"),
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(path.join(test.directory, "plugins", "hook.ts")).href],
          },
          null,
          2,
        ),
      ),
    )
    return yield* self
  })
}

describe("plugin.reload", () => {
  it.instance("re-imports a flipped versioned plugins dir and disposes the old hooks", () =>
    withVersionedPlugin(
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect(yield* triggerSystemTransform()).toEqual(["v1"])

        const v2 = path.join(test.directory, "plugins-v2")
        yield* Effect.promise(() => fs.mkdir(v2, { recursive: true }))
        yield* Effect.promise(() => Bun.write(path.join(v2, "hook.ts"), pluginSource("v2", test.directory)))
        // unlink+symlink is deliberately harsher than production's staged-symlink rename(2) flip.
        yield* Effect.promise(() => fs.unlink(path.join(test.directory, "plugins")))
        yield* Effect.promise(() => fs.symlink("plugins-v2", path.join(test.directory, "plugins")))
        yield* Effect.promise(() => fs.rm(path.join(test.directory, "plugins-v1"), { recursive: true, force: true }))

        const plugin = yield* Plugin.Service
        yield* plugin.reload()
        expect(yield* triggerSystemTransform()).toEqual(["v2"])
        expect(yield* markerExists(test.directory, "disposed-v1.txt")).toBe(true)
      }),
    ),
  )

  it.instance("keeps loaded plugins across a reload when nothing changed", () =>
    withVersionedPlugin(
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const before = yield* plugin.list()
        yield* plugin.reload()
        const after = yield* plugin.list()
        expect(after).toBe(before)
      }),
    ),
  )

  it.instance("leaves never-loaded plugins unloaded", () =>
    withVersionedPlugin(
      Effect.gen(function* () {
        const test = yield* TestInstance
        const plugin = yield* Plugin.Service
        yield* plugin.reload()
        expect(yield* markerExists(test.directory, "loaded-v1.txt")).toBe(false)
      }),
    ),
  )

  it.instance("reloads when plugin order changes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      for (const tag of ["a", "b"])
        yield* Effect.promise(() => Bun.write(path.join(test.directory, `${tag}.ts`), pluginSource(tag, test.directory)))
      const specs = ["a", "b"].map((tag) => pathToFileURL(path.join(test.directory, `${tag}.ts`)).href)
      yield* writePluginConfig(test.directory, specs)
      // Hooks unshift their tag, so trigger order [a, b] yields ["b", "a"].
      expect(yield* triggerSystemTransform()).toEqual(["b", "a"])

      yield* writePluginConfig(test.directory, [specs[1]!, specs[0]!])
      yield* invalidateConfig()
      const plugin = yield* Plugin.Service
      yield* plugin.reload()
      expect(yield* triggerSystemTransform()).toEqual(["a", "b"])
    }),
  )

  it.instance("reloads when plugin options change", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "hook.ts"), pluginSource("v1", test.directory)))
      const spec = pathToFileURL(path.join(test.directory, "hook.ts")).href
      yield* writePluginConfig(test.directory, [[spec, { flag: "one" }]])
      const plugin = yield* Plugin.Service
      const before = yield* plugin.list()

      yield* writePluginConfig(test.directory, [[spec, { flag: "two" }]])
      yield* invalidateConfig()
      yield* plugin.reload()
      expect(yield* plugin.list()).not.toBe(before)
      expect(yield* markerExists(test.directory, "disposed-v1.txt")).toBe(true)
    }),
  )
})

function writePluginConfig(dir: string, plugin: unknown[]) {
  return Effect.promise(() =>
    Bun.write(
      path.join(dir, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin }, null, 2),
    ),
  )
}

const invalidateConfig = () =>
  Config.Service.use((svc) => svc.invalidate().pipe(Effect.andThen(svc.invalidateInstance())))
