import crypto from "node:crypto"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer, Context, Option, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"

/**
 * Persistent on-disk cache of each MCP server's tool catalog. This lets lazy
 * servers advertise their tools without paying the cost of connecting at
 * startup: the catalog is read from disk and the server is only spawned/contacted
 * once a tool is actually used.
 *
 * Entries are keyed by server name and tagged with a signature derived from the
 * server's connection config, so a config change invalidates the stale catalog.
 */

const Entry = Schema.Struct({
  signature: Schema.String,
  tools: Schema.mutable(Schema.Array(Schema.Unknown)),
})
type Entry = Schema.Schema.Type<typeof Entry>

const decodeData = Schema.decodeUnknownOption(Schema.Record(Schema.String, Entry))
type CacheData = Record<string, Entry>

const filepath = path.join(Global.Path.data, "mcp-catalog.json")
const lockKey = `mcp-catalog:${filepath}`

/**
 * Derive a stable signature from the fields that affect which tools a server
 * exposes. Timeout/enabled/lazy are intentionally excluded — they don't change
 * the tool list.
 */
export function signature(mcp: ConfigMCPV1.Info): string {
  const relevant =
    mcp.type === "local"
      ? { type: mcp.type, command: mcp.command, cwd: mcp.cwd, environment: mcp.environment }
      : { type: mcp.type, url: mcp.url, headers: mcp.headers }
  return crypto.createHash("sha256").update(JSON.stringify(relevant)).digest("hex")
}

export interface Interface {
  readonly get: (name: string, signature: string) => Effect.Effect<MCPToolDef[] | undefined>
  readonly set: (name: string, signature: string, tools: MCPToolDef[]) => Effect.Effect<void>
  readonly remove: (name: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/McpCache") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service

    const read = Effect.fn("McpCache.read")(function* () {
      return yield* fs.readJson(filepath).pipe(
        Effect.map((data): CacheData => Option.getOrElse(decodeData(data), () => ({}) as CacheData) as CacheData),
        Effect.catch(() => Effect.succeed({} as CacheData)),
      )
    })

    const get = Effect.fn("McpCache.get")(function* (name: string, sig: string) {
      const data = yield* read().pipe(
        flock.withLock(lockKey),
        Effect.orElseSucceed(() => ({}) as CacheData),
      )
      const entry = data[name]
      if (!entry || entry.signature !== sig) return undefined
      return entry.tools as MCPToolDef[]
    })

    const set = Effect.fn("McpCache.set")(function* (name: string, sig: string, tools: MCPToolDef[]) {
      yield* Effect.gen(function* () {
        const data = yield* read()
        data[name] = { signature: sig, tools: tools as unknown[] }
        yield* fs.writeJson(filepath, data, 0o600).pipe(Effect.orDie)
      }).pipe(flock.withLock(lockKey), Effect.ignore)
    })

    const remove = Effect.fn("McpCache.remove")(function* (name: string) {
      yield* Effect.gen(function* () {
        const data = yield* read()
        if (!(name in data)) return
        delete data[name]
        yield* fs.writeJson(filepath, data, 0o600).pipe(Effect.orDie)
      }).pipe(flock.withLock(lockKey), Effect.ignore)
    })

    return Service.of({ get, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EffectFlock.defaultLayer), Layer.provide(FSUtil.defaultLayer))

export const node = LayerNode.make(layer, [FSUtil.node, EffectFlock.node])

export * as McpCache from "./cache"
