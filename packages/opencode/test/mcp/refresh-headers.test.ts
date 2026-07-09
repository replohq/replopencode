import path from "node:path"
import { describe, expect, mock, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

// Capture the requestInit each transport was constructed with so tests can
// observe in-place header swaps on the live object.
const transportInits: { url: string; requestInit?: RequestInit }[] = []
let clientCreateCount = 0

class MockTransport {
  constructor(url: URL, opts?: { requestInit?: RequestInit }) {
    transportInits.push({ url: url.toString(), requestInit: opts?.requestInit })
  }
  async start() {}
  async close() {}
}

void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockTransport,
}))
void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockTransport,
}))
void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    transport: unknown
    constructor() {
      clientCreateCount++
    }
    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
    }
    setRequestHandler() {}
    setNotificationHandler() {}
    getServerCapabilities() {
      return {}
    }
    async close() {}
  },
}))

beforeEach(() => {
  transportInits.length = 0
  clientCreateCount = 0
})

// Import modules after mocking
const { MCP } = await import("../../src/mcp/index")
const { Config } = await import("../../src/config/config")
const { McpAuth } = await import("../../src/mcp/auth")
const { EventV2Bridge } = await import("../../src/event-v2-bridge")
const { FSUtil } = await import("@opencode-ai/core/fs-util")
const { CrossSpawnSpawner } = await import("@opencode-ai/core/cross-spawn-spawner")

// provideMerge exposes the SAME Config instance MCP reads internally, so the
// test can invalidate it the way harness-reload does in production.
const it = testEffect(
  MCP.layer.pipe(
    Layer.provide(McpAuth.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provideMerge(Config.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
  ),
)

function mcpConfig(token: string) {
  return {
    mcp: {
      bedrock: {
        type: "remote" as const,
        url: "https://example.com/mcp",
        oauth: false as const,
        headers: { Authorization: token },
      },
    },
  }
}

describe("MCP.refreshHeaders", () => {
  it.instance(
    "swaps rotated config headers into the live transport without reconnecting",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const mcp = yield* MCP.Service
        const config = yield* Config.Service

        const clients = yield* mcp.clients()
        expect(Object.keys(clients)).toEqual(["bedrock"])
        const connectedClientCount = clientCreateCount
        expect(transportInits[0]?.requestInit?.headers).toEqual({ Authorization: "Bearer v1" })

        // Simulate credential rotation + the SIGHUP config invalidation that
        // harness-reload performs before refreshing headers.
        yield* Effect.promise(() =>
          Bun.write(
            path.join(tmp.directory, "opencode.json"),
            JSON.stringify({ $schema: "https://opencode.ai/config.json", ...mcpConfig("Bearer v2") }),
          ),
        )
        yield* config.invalidate()
        yield* config.invalidateInstance()
        yield* mcp.refreshHeaders()

        // Same client, same transport object — only the live headers changed,
        // so the next request authenticates with the rotated token.
        expect(transportInits[0]?.requestInit?.headers).toEqual({ Authorization: "Bearer v2" })
        expect((yield* mcp.clients())["bedrock"]).toBe(clients["bedrock"])
        expect(clientCreateCount).toBe(connectedClientCount)
      }),
    { config: mcpConfig("Bearer v1") },
  )

  it.instance(
    "never triggers MCP connection setup on an instance that has not used MCP",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.refreshHeaders()
        expect(transportInits.length).toBe(0)
        expect(clientCreateCount).toBe(0)
      }),
    { config: mcpConfig("Bearer v1") },
  )
})
