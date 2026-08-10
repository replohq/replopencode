import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListPromptsRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { MCP } from "../../src/mcp/index"
import { Config } from "../../src/config/config"

// One compiled graph so the test invalidates the same Config instance MCP reads internally.
const it = testEffect(AppNodeBuilder.build(LayerNode.group([MCP.node, Config.node])))

// Real MCP server over streamable HTTP (mirrors headers.test.ts); records each request's headers.
const serve = Effect.acquireRelease(
  Effect.promise(async () => {
    const requests: Headers[] = []
    const protocol = new Server({ name: "refresh", version: "1.0.0" }, { capabilities: { tools: {}, prompts: {} } })
    protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
    protocol.setRequestHandler(ListPromptsRequestSchema, () => Promise.resolve({ prompts: [] }))
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    })
    await protocol.connect(transport)
    const http = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(new Headers(request.headers))
        return transport.handleRequest(request)
      },
    })
    return {
      requests,
      url: http.url.toString(),
      close: async () => {
        await http.stop(true)
        await protocol.close()
      },
    }
  }),
  (server) => Effect.promise(server.close),
)

// Config-file-driven server (production shape): add()-registered servers bypass refreshHeaders' config re-read.
function opencodeJson(url: string, token: string) {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    mcp: {
      bedrock: { type: "remote" as const, url, oauth: false as const, headers: { Authorization: token } },
    },
  })
}

const lastAuthorization = (requests: Headers[]) => requests.at(-1)?.get("authorization")

describe("MCP.refreshHeaders", () => {
  it.instance("swaps rotated config headers into the live transport without reconnecting", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const tmp = yield* TestInstance
      const mcp = yield* MCP.Service
      const config = yield* Config.Service

      // Server URL is only known at runtime: write config now, invalidate so first access reads it fresh.
      yield* Effect.promise(() =>
        Bun.write(path.join(tmp.directory, "opencode.json"), opencodeJson(server.url, "Bearer v1")),
      )
      yield* config.invalidate()
      yield* config.invalidateInstance()

      const clients = yield* mcp.clients()
      expect(Object.keys(clients)).toEqual(["bedrock"])
      expect(server.requests.length).toBeGreaterThan(0)
      expect(lastAuthorization(server.requests)).toBe("Bearer v1")

      // Rotate credentials on disk, then invalidate config the way harness-reload does
      yield* Effect.promise(() =>
        Bun.write(path.join(tmp.directory, "opencode.json"), opencodeJson(server.url, "Bearer v2")),
      )
      yield* config.invalidate()
      yield* config.invalidateInstance()
      yield* mcp.refreshHeaders()

      // Next request rides the same live transport (no reconnect) with the rotated token.
      const requestsBefore = server.requests.length
      yield* mcp.prompts()
      expect(server.requests.length).toBeGreaterThan(requestsBefore)
      expect(lastAuthorization(server.requests)).toBe("Bearer v2")
      expect((yield* mcp.clients())["bedrock"]).toBe(clients["bedrock"])
    }),
  )

  it.instance("never triggers MCP connection setup on an instance that has not used MCP", () =>
    Effect.gen(function* () {
      const server = yield* serve
      const tmp = yield* TestInstance
      const mcp = yield* MCP.Service
      yield* Effect.promise(() =>
        Bun.write(path.join(tmp.directory, "opencode.json"), opencodeJson(server.url, "Bearer v1")),
      )
      yield* mcp.refreshHeaders()
      expect(server.requests.length).toBe(0)
    }),
  )
})
