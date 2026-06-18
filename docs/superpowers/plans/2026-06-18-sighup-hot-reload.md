# SIGHUP Hot-Reload (harness + env) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the headless `opencode serve` process catch `SIGHUP` and, without restarting or interrupting in-flight sessions, reload (1) environment variables from the s6 envdirs and (2) the harness (config, skills, agents, commands, tools).

**Architecture:** The Effect codebase already caches every harness module's state via `InstanceState.make(...)` (per-directory `ScopedCache`) and already exposes `InstanceState.invalidate(state)` — a *non-destructive* cache-bust where the next access re-reads from disk (unlike `InstanceStore.disposeAll()`, which runs the destructive disposers that tear down sessions). We add a per-service `invalidate()` to Config/Agent/Command/Skill/ToolRegistry, an orchestrator that re-reads the envdirs into `process.env` and then invalidates those caches for every currently-loaded instance, and a `SIGHUP` handler in `serve.ts` that runs the orchestrator against the listener's own service context via `Listener.reload()` (see Task 6 implementation note — the original `AppRuntime` approach was a no-op against the live server). Because an in-flight turn already snapshotted its config/tools, invalidation only affects the *next* access — active sessions are never interrupted. A `global.reloaded` bus event is emitted so clients can refresh.

**Tech Stack:** TypeScript, Effect (v4 `effect/unstable`), Bun test runner, Node `process` signals, s6 envdir format.

## Global Constraints

- Runtime/test commands use **bun**: `bun test <path>`, `bun run typecheck`.
- All new source files end with a namespace re-export matching the existing convention, e.g. `export * as EnvReload from "./env-reload"`.
- Path alias `@/` → `packages/opencode/src`. Core package alias `@opencode-ai/core/*` → `packages/core/src/*`.
- Reload MUST be non-destructive: never call `InstanceStore.disposeAll()`, `reload()`, or `disposeDirectory()` from the SIGHUP path — those run `runDisposers` and kill sessions. Only `InstanceState.invalidate` is permitted.
- Effect services expose methods returning `Effect.Effect<...>`; follow the existing `Effect.fn("<Name>.<method>")(function* () { ... })` style for every new method.
- Default envdir set (s6) is `/var/s6-env/global`, `/var/s6-env/opencode`, `/var/s6-env/publish` in that precedence order (later dir wins), overridable via `OPENCODE_RELOAD_ENVDIRS` (`:`-separated absolute paths). Operational contract: the coordinator rotates all three envdirs on disk *before* sending `SIGHUP`; opencode only re-reads them (option (a) from design discussion).

---

## File Structure

- Create `packages/opencode/src/server/env-reload.ts` — pure Node reader that loads s6 envdirs into `process.env`.
- Create `packages/opencode/src/server/harness-reload.ts` — the Effect orchestrator (`HarnessReload.run`).
- Modify `packages/core/src/flag/flag.ts` — make `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` lazy getters.
- Modify `packages/opencode/src/config/config.ts` — add `invalidateInstance()`.
- Modify `packages/opencode/src/agent/agent.ts` — add `invalidate()`.
- Modify `packages/opencode/src/command/index.ts` — add `invalidate()`.
- Modify `packages/opencode/src/skill/index.ts` — add `invalidate()` (busts both `discovered` and `state`).
- Modify `packages/opencode/src/tool/registry.ts` — add `invalidate()`.
- Modify `packages/opencode/src/project/instance-store.ts` — add `directories()`.
- Modify `packages/opencode/src/server/event.ts` — add `Event.Reloaded`.
- Modify `packages/opencode/src/cli/cmd/serve.ts` — install the `SIGHUP` handler.
- Create tests under `packages/opencode/test/server/` and `packages/opencode/test/skill/`.

### Key Risk / Assumption — RESOLVED during implementation

Original assumption: `AppRuntime` and the server share `InstanceStore` via the process-wide `memoMap`, so `AppRuntime.runPromise(HarnessReload.run)` would reload the live server.

**This proved FALSE for the headless `serve` path.** `startListener` (`server/server.ts`) builds the listener's services with a **fresh per-listener `memoMap`** (`Layer.makeMemoMapUnsafe()`), isolated from `AppRuntime`'s `memoMap`. Live testing showed the `AppRuntime` reload ran against an empty, unrelated `InstanceStore` (no-op). Fix (see Task 6): build the shared `appLayer` against the **listener's own `memoMap`+scope** and run `HarnessReload.run` against that context via a `Listener.reload()` method. Verified live end-to-end in Task 7 (skill + env changes apply on SIGHUP, no restart, no instance disposal).

---

## Task 1: Env reloader (`EnvReload`)

**Files:**
- Create: `packages/opencode/src/server/env-reload.ts`
- Test: `packages/opencode/test/server/env-reload.test.ts`

**Interfaces:**
- Produces: `EnvReload.reload(): { applied: number }` (mutates `process.env`), `EnvReload.dirs(): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/opencode/test/server/env-reload.test.ts
import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EnvReload } from "../../src/server/env-reload"

function envdir(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "envdir-"))
  for (const [name, value] of Object.entries(files)) writeFileSync(path.join(dir, name), value)
  return dir
}

const saved = { ...process.env }
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
})

describe("EnvReload", () => {
  test("loads files as env vars, stripping the trailing newline", () => {
    const dir = envdir({ FOO_RELOAD: "bar\n" })
    process.env["OPENCODE_RELOAD_ENVDIRS"] = dir
    EnvReload.reload()
    expect(process.env["FOO_RELOAD"]).toBe("bar")
  })

  test("later envdir wins on conflict", () => {
    const a = envdir({ DUP_RELOAD: "first\n" })
    const b = envdir({ DUP_RELOAD: "second\n" })
    process.env["OPENCODE_RELOAD_ENVDIRS"] = [a, b].join(":")
    EnvReload.reload()
    expect(process.env["DUP_RELOAD"]).toBe("second")
  })

  test("empty file unsets the variable", () => {
    process.env["GONE_RELOAD"] = "present"
    const dir = envdir({ GONE_RELOAD: "" })
    process.env["OPENCODE_RELOAD_ENVDIRS"] = dir
    EnvReload.reload()
    expect("GONE_RELOAD" in process.env).toBe(false)
  })

  test("skips dotfiles and names containing '=', tolerates missing dirs", () => {
    const dir = envdir({ ".hidden": "x\n", "BAD=NAME": "y\n", OK_RELOAD: "z\n" })
    process.env["OPENCODE_RELOAD_ENVDIRS"] = [dir, "/does/not/exist"].join(":")
    const result = EnvReload.reload()
    expect(process.env["OK_RELOAD"]).toBe("z")
    expect(process.env[".hidden"]).toBeUndefined()
    expect(result.applied).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/opencode/test/server/env-reload.test.ts`
Expected: FAIL — `Cannot find module ".../src/server/env-reload"`.

- [ ] **Step 3: Implement `EnvReload`**

```ts
// packages/opencode/src/server/env-reload.ts
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const DEFAULT_DIRS = ["/var/s6-env/global", "/var/s6-env/opencode", "/var/s6-env/publish"]

export function dirs(): string[] {
  const override = process.env["OPENCODE_RELOAD_ENVDIRS"]
  return override ? override.split(":").filter(Boolean) : DEFAULT_DIRS
}

/**
 * Re-read s6 envdirs into process.env. An s6 envdir is a directory whose file
 * names are env var names and whose contents are the values (trailing newlines
 * stripped, NULs -> newlines). An empty file unsets the variable. Later dirs in
 * the list override earlier ones, matching the s6-envdir order in the service
 * `run` script.
 */
export function reload(): { applied: number } {
  let applied = 0
  for (const dir of dirs()) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name.startsWith(".") || name.includes("=")) continue
      const file = path.join(dir, name)
      let contents: string
      try {
        if (!statSync(file).isFile()) continue
        contents = readFileSync(file, "utf8")
      } catch {
        continue
      }
      if (contents.length === 0) {
        delete process.env[name]
        applied++
        continue
      }
      process.env[name] = contents.replace(/\n+$/, "").replace(/\0/g, "\n")
      applied++
    }
  }
  return { applied }
}

export * as EnvReload from "./env-reload"
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/opencode/test/server/env-reload.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/server/env-reload.ts packages/opencode/test/server/env-reload.test.ts
git commit -m "feat(server): add s6 envdir reloader"
```

---

## Task 2: Make config flags lazy

`config.ts:467` already reads `process.env.OPENCODE_CONFIG_CONTENT` directly, but the guard at `config.ts:250` uses the module-load constants `Flag.OPENCODE_CONFIG` / `Flag.OPENCODE_CONFIG_CONTENT`. After an env reload those constants are stale, so make them lazy getters (transparent to all existing readers).

**Files:**
- Modify: `packages/core/src/flag/flag.ts:21-22`
- Test: `packages/core/test/flag.test.ts`

**Interfaces:**
- Produces: `Flag.OPENCODE_CONFIG` and `Flag.OPENCODE_CONFIG_CONTENT` now re-read `process.env` on every access.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/flag.test.ts
import { expect, test, afterEach } from "bun:test"
import { Flag } from "../src/flag/flag"

const saved = process.env["OPENCODE_CONFIG_CONTENT"]
afterEach(() => {
  if (saved === undefined) delete process.env["OPENCODE_CONFIG_CONTENT"]
  else process.env["OPENCODE_CONFIG_CONTENT"] = saved
})

test("OPENCODE_CONFIG_CONTENT reflects runtime process.env changes", () => {
  process.env["OPENCODE_CONFIG_CONTENT"] = '{"a":1}'
  expect(Flag.OPENCODE_CONFIG_CONTENT).toBe('{"a":1}')
  process.env["OPENCODE_CONFIG_CONTENT"] = '{"a":2}'
  expect(Flag.OPENCODE_CONFIG_CONTENT).toBe('{"a":2}')
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/core/test/flag.test.ts`
Expected: FAIL — second assertion gets `'{"a":1}'` (stale module constant).

- [ ] **Step 3: Convert the two constants to getters**

In `packages/core/src/flag/flag.ts`, replace:

```ts
  OPENCODE_CONFIG: process.env["OPENCODE_CONFIG"],
  OPENCODE_CONFIG_CONTENT: process.env["OPENCODE_CONFIG_CONTENT"],
```

with:

```ts
  get OPENCODE_CONFIG() {
    return process.env["OPENCODE_CONFIG"]
  },
  get OPENCODE_CONFIG_CONTENT() {
    return process.env["OPENCODE_CONFIG_CONTENT"]
  },
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/core/test/flag.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/flag/flag.ts packages/core/test/flag.test.ts
git commit -m "fix(flag): read OPENCODE_CONFIG/CONTENT lazily so env reload takes effect"
```

---

## Task 3: Per-service `invalidate()` methods

Add a non-destructive invalidate to each harness service. Each just calls `InstanceState.invalidate(state)` for the current instance directory. Skill busts **both** its `discovered` (file-scan) and `state` (loaded content) caches so additions/deletions are picked up, not just edits.

**Files:**
- Modify: `packages/opencode/src/config/config.ts` (Interface ~line 117 region + return ~661)
- Modify: `packages/opencode/src/agent/agent.ts` (Interface ~line 60 region + `Service.of` ~353)
- Modify: `packages/opencode/src/command/index.ts` (Interface 59-62 + return 172)
- Modify: `packages/opencode/src/skill/index.ts` (Interface 97-103 + return ~315)
- Modify: `packages/opencode/src/tool/registry.ts` (Interface region + `Service.of` 314)
- Test: `packages/opencode/test/skill/skill-reload.test.ts`

**Interfaces:**
- Produces: `Config.Service.invalidateInstance(): Effect<void>`, `Agent.Service.invalidate(): Effect<void>`, `Command.Service.invalidate(): Effect<void>`, `Skill.Service.invalidate(): Effect<void>`, `ToolRegistry.Service.invalidate(): Effect<void>`.
- Consumes: `InstanceState.invalidate` from `@/effect/instance-state` (already imported in each module).

- [ ] **Step 1: Write the failing integration test (Skill add + edit)**

```ts
// packages/opencode/test/skill/skill-reload.test.ts
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
        yield* Effect.promise(() => Bun.write(path.join(dir, ".opencode", "skill", "fresh", "SKILL.md"), skillMd("fresh", "new")))

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
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/opencode/test/skill/skill-reload.test.ts`
Expected: FAIL — `skill.invalidate is not a function` (and typecheck error on `.invalidate()`).

- [ ] **Step 3: Add `invalidate()` to Skill**

In `packages/opencode/src/skill/index.ts`, add to the `Interface` (after `available`):

```ts
  readonly invalidate: () => Effect.Effect<void>
```

In the `layer`, after the `available` accessor and before the return, add:

```ts
    const invalidate = Effect.fn("Skill.invalidate")(function* () {
      yield* InstanceState.invalidate(discovered)
      yield* InstanceState.invalidate(state)
    })
```

Then add `invalidate` to the service return (e.g. `return Service.of({ get, require, all, dirs, available, invalidate })`).

- [ ] **Step 4: Run the Skill test, verify it passes**

Run: `bun test packages/opencode/test/skill/skill-reload.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `invalidate()` to Agent**

In `packages/opencode/src/agent/agent.ts`, add to `Interface`:

```ts
  readonly invalidate: () => Effect.Effect<void>
```

In the `Service.of({ ... })` return (~353), add:

```ts
      invalidate: Effect.fn("Agent.invalidate")(function* () {
        yield* InstanceState.invalidate(state)
      }),
```

- [ ] **Step 6: Add `invalidate()` to Command**

In `packages/opencode/src/command/index.ts`, add to `Interface` (after `list`):

```ts
  readonly invalidate: () => Effect.Effect<void>
```

After the `list` accessor (before `return Service.of(...)`), add:

```ts
    const invalidate = Effect.fn("Command.invalidate")(function* () {
      yield* InstanceState.invalidate(state)
    })
```

Change the return to `return Service.of({ get, list, invalidate })`.

- [ ] **Step 7: Add `invalidate()` to ToolRegistry**

In `packages/opencode/src/tool/registry.ts`, add to `Interface`:

```ts
  readonly invalidate: () => Effect.Effect<void>
```

Before `return Service.of({ ids, all, named, tools })` (~314), add:

```ts
    const invalidate: Interface["invalidate"] = Effect.fn("ToolRegistry.invalidate")(function* () {
      yield* InstanceState.invalidate(state)
    })
```

Change the return to `return Service.of({ ids, all, named, tools, invalidate })`.

- [ ] **Step 8: Add `invalidateInstance()` to Config**

In `packages/opencode/src/config/config.ts`, add to `Interface` (near `invalidate`):

```ts
  readonly invalidateInstance: () => Effect.Effect<void>
```

After the existing `invalidate` definition (~632), add:

```ts
    const invalidateInstance = Effect.fn("Config.invalidateInstance")(function* () {
      yield* InstanceState.invalidate(state)
    })
```

Add `invalidateInstance` to the `Service.of({ ... })` return (~661).

- [ ] **Step 9: Typecheck the whole package**

Run: `bun run typecheck`
Expected: PASS (no errors about the new methods or service shapes).

- [ ] **Step 10: Commit**

```bash
git add packages/opencode/src/skill/index.ts packages/opencode/src/agent/agent.ts \
        packages/opencode/src/command/index.ts packages/opencode/src/tool/registry.ts \
        packages/opencode/src/config/config.ts packages/opencode/test/skill/skill-reload.test.ts
git commit -m "feat(harness): add non-destructive invalidate() to config/agent/command/skill/tools"
```

---

## Task 4: Enumerate loaded instances (`InstanceStore.directories`)

The orchestrator must invalidate only **already-loaded** instances (never boot new ones). Expose the store's loaded directory keys.

**Files:**
- Modify: `packages/opencode/src/project/instance-store.ts` (Interface ~22-27, `Service.of` ~194)
- Test: `packages/opencode/test/project/instance-store-directories.test.ts`

**Interfaces:**
- Produces: `InstanceStore.Service.directories(): Effect<string[]>` — resolved keys of currently-cached instances.

- [ ] **Step 1: Write the failing test**

```ts
// packages/opencode/test/project/instance-store-directories.test.ts
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceStore } from "../../src/project/instance-store"
import { provideInstanceEffect, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, testInstanceStoreLayer))

it.live("directories() lists loaded instance directories", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    const store = yield* InstanceStore.Service

    // touch both directories so they load
    yield* store.load({ directory: one })
    yield* store.load({ directory: two })

    const dirs = yield* store.directories()
    expect(dirs.sort()).toEqual([one, two].sort())
  }),
)
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/opencode/test/project/instance-store-directories.test.ts`
Expected: FAIL — `store.directories is not a function`.

- [ ] **Step 3: Implement `directories()`**

In `packages/opencode/src/project/instance-store.ts`, add to the `Interface`:

```ts
  readonly directories: () => Effect.Effect<string[]>
```

Inside the `layer` (the `cache` Map is already in scope), add before the `Service.of(...)` return (~194):

```ts
    const directories = Effect.fn("InstanceStore.directories")(function* () {
      return [...cache.keys()]
    })
```

Add `directories` to the `Service.of({ ... })` return object.

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test packages/opencode/test/project/instance-store-directories.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/project/instance-store.ts packages/opencode/test/project/instance-store-directories.test.ts
git commit -m "feat(instance-store): expose loaded directories()"
```

---

## Task 5: Reload orchestrator + `global.reloaded` event

Wire env reload + per-instance harness invalidation + a bus event into one Effect.

**Files:**
- Modify: `packages/opencode/src/server/event.ts:4-7`
- Create: `packages/opencode/src/server/harness-reload.ts`
- Test: `packages/opencode/test/server/harness-reload.test.ts`

**Interfaces:**
- Consumes: `EnvReload.reload` (Task 1); `Config.invalidateInstance`, `Agent/Command/Skill/ToolRegistry.invalidate` (Task 3); `InstanceStore.directories`, `InstanceStore.provide` (Task 4 + existing); `GlobalBus` (`@/bus/global`); `Event.Reloaded` (this task).
- Produces: `HarnessReload.run: Effect.Effect<void, never, Config.Service | Agent.Service | Command.Service | Skill.Service | ToolRegistry.Service | InstanceStore.Service>`.

- [ ] **Step 1: Add the `Reloaded` event**

In `packages/opencode/src/server/event.ts`, change the `Event` object to:

```ts
export const Event = {
  Connected: EventV2.define({ type: "server.connected", schema: {} }),
  Disposed: EventV2.define({ type: "global.disposed", schema: {} }),
  Reloaded: EventV2.define({ type: "global.reloaded", schema: {} }),
}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/opencode/test/server/harness-reload.test.ts
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Skill } from "../../src/skill"
import { HarnessReload } from "../../src/server/harness-reload"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(HarnessReload.layer, Skill.defaultLayer, CrossSpawnSpawner.defaultLayer, testInstanceStoreLayer))

function skillMd(name: string, description: string) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}

describe("HarnessReload.run", () => {
  it.live("invalidates loaded instances and emits global.reloaded", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        // point env reload at a harmless empty override so it never reads /var/s6-env
        process.env["OPENCODE_RELOAD_ENVDIRS"] = path.join(dir, "no-such-envdir")

        const skill = yield* Skill.Service
        const file = path.join(dir, ".opencode", "skill", "hot", "SKILL.md")
        yield* Effect.promise(() => Bun.write(file, skillMd("hot", "before")))
        expect((yield* skill.get("hot"))?.description).toBe("before")

        const events: GlobalEvent[] = []
        const handler = (e: GlobalEvent) => events.push(e)
        GlobalBus.on("event", handler)

        yield* Effect.promise(() => Bun.write(file, skillMd("hot", "after")))
        yield* HarnessReload.run
        GlobalBus.off("event", handler)

        expect((yield* skill.get("hot"))?.description).toBe("after")
        expect(events.some((e) => e.payload?.type === "global.reloaded")).toBe(true)
      }),
    ),
  )
})
```

Note: `HarnessReload` is exposed both as the bare `run` Effect (used by `serve.ts`) and as a no-op `layer` re-export of the harness service layers for tests; if the project prefers, drop `HarnessReload.layer` from the merge and instead merge the individual `*.defaultLayer`s. Keep whichever compiles — `run`'s requirements are the five harness services + `InstanceStore`.

- [ ] **Step 3: Run the test, verify it fails**

Run: `bun test packages/opencode/test/server/harness-reload.test.ts`
Expected: FAIL — `Cannot find module ".../src/server/harness-reload"`.

- [ ] **Step 4: Implement the orchestrator**

```ts
// packages/opencode/src/server/harness-reload.ts
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
```

If the test's `HarnessReload.layer` reference does not compile, remove it from the test's `Layer.mergeAll` and instead merge `Config.defaultLayer`, `Agent.defaultLayer`, `Command.defaultLayer`, `ToolRegistry.defaultLayer` alongside `Skill.defaultLayer` (each is exported by its module). Do not add a `layer` export to the source file if it isn't needed.

- [ ] **Step 5: Run the test, verify it passes**

Run: `bun test packages/opencode/test/server/harness-reload.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/server/harness-reload.ts packages/opencode/src/server/event.ts \
        packages/opencode/test/server/harness-reload.test.ts
git commit -m "feat(server): add SIGHUP harness reload orchestrator + global.reloaded event"
```

---

## Task 6: Install the `SIGHUP` handler in `serve`

> **Implementation note (deviation from original plan):** The `AppRuntime.runPromise(HarnessReload.run)` approach was implemented first and verified to be a **no-op** against the live headless server (separate per-listener `memoMap`). The shipped implementation instead:
> 1. `server/routes/instance/httpapi/server.ts`: export a single shared `appLayer = LayerNode.buildLayer(app)` and use it inside `createRoutes` (same Layer reference is essential for memoMap reuse).
> 2. `server/server.ts` `startListener`: keep the per-listener `memoMap` in a var; after building the listener, build `appLayer` against that **same** `memoMap`+`scope` to capture the listener's real service singletons (`InstanceStore`, `Skill`, `Config`, …). Expose `Listener.reload = () => Effect.runPromise(HarnessReload.run.pipe(Effect.provide(appContext)))`.
> 3. `cli/cmd/serve.ts`: `process.on("SIGHUP", () => server.reload())` with an in-flight `reloading` guard. No `AppRuntime` import.

**Files:**
- Modify: `packages/opencode/src/cli/cmd/serve.ts`, `packages/opencode/src/server/server.ts`, `packages/opencode/src/server/routes/instance/httpapi/server.ts`

**Interfaces:**
- Consumes: `Listener.reload` (server.ts), `HarnessReload.run` (Task 5), `HttpApiApp.appLayer`.

- [ ] **Step 1: Add imports**

At the top of `packages/opencode/src/cli/cmd/serve.ts`, add:

```ts
import { AppRuntime } from "@/effect/app-runtime"
import { HarnessReload } from "@/server/harness-reload"
```

- [ ] **Step 2: Register the handler before `Effect.never`**

In the handler, replace:

```ts
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
```

with:

```ts
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    // SIGHUP: reload env vars + harness in place without restarting or
    // interrupting in-flight sessions. The coordinator rotates the s6 envdirs
    // on disk, then sends SIGHUP; we re-read them and invalidate harness caches.
    let reloading = false
    const reload = () => {
      if (reloading) return
      reloading = true
      AppRuntime.runPromise(HarnessReload.run)
        .catch((err) => console.error("harness reload failed", err))
        .finally(() => {
          reloading = false
        })
    }
    yield* Effect.sync(() => process.on("SIGHUP", reload))

    yield* Effect.never
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Smoke-build the CLI command path**

Run: `bun test packages/opencode/test/server/harness-reload.test.ts packages/opencode/test/server/env-reload.test.ts`
Expected: PASS (regression guard that imports still resolve).

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/cli/cmd/serve.ts
git commit -m "feat(serve): reload env + harness on SIGHUP"
```

---

## Task 7: End-to-end manual verification

Signals can't be unit-tested meaningfully; verify against a live server. This also confirms the `AppRuntime`/server `memoMap`-singleton assumption (Key Risk).

**Files:** none (verification only).

- [ ] **Step 1: Start a server against a scratch project**

```bash
mkdir -p /tmp/hot/.opencode/skill/demo
printf -- '---\nname: demo\ndescription: before\n---\n# demo\n' > /tmp/hot/.opencode/skill/demo/SKILL.md
cd /tmp/hot
bun run packages/opencode/src/index.ts serve --hostname 127.0.0.1 --port 4097 --print-logs &
SERVER_PID=$!
```

- [ ] **Step 2: Load the instance + confirm the skill is visible**

```bash
curl -s -H 'x-opencode-directory: /tmp/hot' http://127.0.0.1:4097/app/agents >/dev/null
curl -s -H 'x-opencode-directory: /tmp/hot' 'http://127.0.0.1:4097/skill' | grep -o '"description":"before"'
```
Expected: prints `"description":"before"` (adjust the skill route to whatever the server exposes; the point is the `before` value is served).

- [ ] **Step 3: Edit the skill on disk and send SIGHUP**

```bash
printf -- '---\nname: demo\ndescription: after\n---\n# demo\n' > /tmp/hot/.opencode/skill/demo/SKILL.md
kill -HUP "$SERVER_PID"
sleep 1
```
Expected in server logs: a `harness reload` line with `envApplied`.

- [ ] **Step 4: Confirm the new value is served WITHOUT restart**

```bash
curl -s -H 'x-opencode-directory: /tmp/hot' 'http://127.0.0.1:4097/skill' | grep -o '"description":"after"'
```
Expected: prints `"description":"after"`. Same PID (`echo $SERVER_PID`), no restart.

- [ ] **Step 5: Confirm env reload picks up OPENCODE_CONFIG_CONTENT**

```bash
mkdir -p /tmp/hot-env
printf '{"$schema":"https://opencode.ai/config.json","model":"anthropic/claude-opus-4-8"}' > /tmp/hot-env/OPENCODE_CONFIG_CONTENT
# restart server with the override so the reload path reads from here:
kill "$SERVER_PID" 2>/dev/null
OPENCODE_RELOAD_ENVDIRS=/tmp/hot-env bun run packages/opencode/src/index.ts serve --hostname 127.0.0.1 --port 4097 --print-logs &
SERVER_PID=$!
sleep 1
# rotate the value, then HUP
printf '{"$schema":"https://opencode.ai/config.json","model":"anthropic/claude-sonnet-4-6"}' > /tmp/hot-env/OPENCODE_CONFIG_CONTENT
kill -HUP "$SERVER_PID"
sleep 1
curl -s -H 'x-opencode-directory: /tmp/hot' 'http://127.0.0.1:4097/config' | grep -o 'claude-sonnet-4-6'
```
Expected: prints `claude-sonnet-4-6` (config reflects the rotated env). Clean up: `kill "$SERVER_PID"`.

- [ ] **Step 6: Confirm in-flight sessions are not interrupted**

Start a long-running prompt against `/tmp/hot`, send `kill -HUP` mid-turn, and confirm the active turn completes normally (no session teardown / no `global.disposed` event; only `global.reloaded`). Document the observed behavior in the PR description.

---

## Operational handoff (coordinator side — separate repo)

Not implemented here, but required for production (document in the PR):
- After rotating `/var/s6-env/{global,opencode,publish}` (including regenerating the derived `opencode`/`publish` envdirs via `build-opencode-env.mjs`), the coordinator sends `SIGHUP` to the `opencode serve` pid (e.g. `s6-svc -h` on the service, or `kill -HUP <pid>`).
- Optional client UX: handle the `global.reloaded` SSE event to show a "skills/config updated — reload" affordance (the "notification + button" path for collaborators sharing skills via FUSE mounts).

---

## Self-Review

- **Spec coverage:** SIGHUP trigger (T6) ✓; harness reload of config/skills/agents/commands/tools (T3 + T5) ✓; env var reload (T1 + T2 + T5) ✓; non-destructive / sessions survive (T3 uses `InstanceState.invalidate`, never `disposeAll`; verified T7 Step 6) ✓; option (a) coordinator-rotates-then-signals (Global Constraints + Operational handoff) ✓; client refresh signal (`global.reloaded`, T5) ✓.
- **Placeholder scan:** all code steps contain full code; no TBD/TODO.
- **Type consistency:** `invalidate()` used uniformly on Agent/Command/Skill/ToolRegistry; Config uses `invalidate()` (existing, global) + `invalidateInstance()` (new); `directories()` returns `Effect<string[]>`; `HarnessReload.run` is an Effect value (matches `AppRuntime.runPromise(effect)` and the test's `yield* HarnessReload.run`).
