import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "../../src/project/instance-store"
import { testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer))

it.live("directories() lists loaded instance directories", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    const store = yield* InstanceStore.Service

    yield* store.load({ directory: one })
    yield* store.load({ directory: two })

    const dirs = yield* store.directories()
    expect(dirs.sort()).toEqual([one, two].sort())
  }),
)
