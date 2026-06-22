import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Skill } from "../../src/skill"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, CrossSpawnSpawner.defaultLayer, testInstanceStoreLayer))

function skillMd(name: string, description: string) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}

describe("Skill.invalidate", () => {
  it.live("re-reads edited and newly-added SKILL.md after invalidate", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const skill = yield* Skill.Service
        const hot = path.join(dir, ".opencode", "skill", "hot", "SKILL.md")
        yield* Effect.promise(() => Bun.write(hot, skillMd("hot", "before")))

        // first access populates the cache
        expect((yield* skill.get("hot"))?.description).toBe("before")

        // edit on disk + add a brand new skill
        yield* Effect.promise(() => Bun.write(hot, skillMd("hot", "after")))
        yield* Effect.promise(() =>
          Bun.write(path.join(dir, ".opencode", "skill", "fresh", "SKILL.md"), skillMd("fresh", "new")),
        )

        // still cached -> stale
        expect((yield* skill.get("hot"))?.description).toBe("before")
        expect(yield* skill.get("fresh")).toBeUndefined()

        // invalidate -> next access re-scans + re-reads
        yield* skill.invalidate()
        expect((yield* skill.get("hot"))?.description).toBe("after")
        expect((yield* skill.get("fresh"))?.description).toBe("new")
      }),
    ),
  )
})
