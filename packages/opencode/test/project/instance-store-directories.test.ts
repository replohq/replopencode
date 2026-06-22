import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceStore } from "../../src/project/instance-store"
import { testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, testInstanceStoreLayer))

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
