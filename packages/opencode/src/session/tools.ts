import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const result = yield* item.execute(args, ctx)
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  for (const [key, item] of Object.entries(yield* mcp.tools())) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                attachments.push({
                  type: "file",
                  mime: resource.mimeType ?? "application/octet-stream",
                  url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  // Lazy-loaded MCP servers: their tools are not injected upfront. Expose a
  // single discovery tool so the model can load a server's tools on demand.
  // Loaded tools become available on the next step (tools are re-resolved each
  // step in the prompt loop).
  const deferred = yield* mcp.deferred()
  const deferredServers = Object.keys(deferred)
  if (deferredServers.length > 0) {
    const toolId = (server: string, name: string) => McpCatalog.sanitize(server) + "_" + McpCatalog.sanitize(name)
    const serverLines = deferredServers.map((server) => {
      const names = deferred[server].tools.map((t) => toolId(server, t.name))
      return `- ${server}: ${names.length ? names.join(", ") : "(tools not yet indexed — load to discover)"}`
    })
    const description = [
      "Load tools from MCP servers that are configured but deferred (their tools are not loaded upfront, to keep startup fast and the context small).",
      "",
      "Deferred servers and the tools they provide:",
      ...serverLines,
      "",
      "Pass `server` to connect that server and load its tools — they become callable on your next step. Call with no arguments to see full descriptions for every deferred tool.",
    ].join("\n")

    tools["mcp"] = tool({
      description,
      inputSchema: jsonSchema<{ server?: string }>({
        type: "object",
        properties: {
          server: {
            type: "string",
            description: "Name of the deferred MCP server to connect and load. Omit to list all deferred tools.",
          },
        },
        additionalProperties: false,
      }),
      execute(args) {
        return run.promise(
          Effect.gen(function* () {
            const server = (args as { server?: string }).server
            const current = yield* mcp.deferred()

            if (!server) {
              const sections = Object.entries(current).map(([name, info]) => {
                const lines = info.tools.length
                  ? info.tools.map((t) => `  - ${toolId(name, t.name)}: ${t.description ?? ""}`.trimEnd()).join("\n")
                  : "  (tools not yet indexed — load this server to discover them)"
                return `${name}:\n${lines}`
              })
              return {
                title: "mcp",
                metadata: { servers: Object.keys(current) },
                output: sections.length ? sections.join("\n\n") : "No deferred MCP servers.",
              }
            }

            if (!(server in current)) {
              return {
                title: "mcp",
                metadata: { server },
                output: `No deferred MCP server named "${server}". It may already be loaded, disabled, or misspelled. Deferred servers: ${
                  Object.keys(current).join(", ") || "(none)"
                }.`,
              }
            }

            const status = yield* mcp.activate(server).pipe(Effect.orElseSucceed(() => undefined))
            if (!status || status.status !== "connected") {
              const reason = status?.status === "failed" ? `: ${status.error}` : status ? ` (${status.status})` : ""
              return {
                title: "mcp",
                metadata: { server, status: status?.status ?? "error" },
                output: `Failed to load MCP server "${server}"${reason}.`,
              }
            }

            const loaded = Object.keys(yield* mcp.tools()).filter((key) =>
              key.startsWith(McpCatalog.sanitize(server) + "_"),
            )
            return {
              title: "mcp",
              metadata: { server, loaded },
              output: [
                `Loaded MCP server "${server}". The following tools are now available on your next step:`,
                ...loaded.map((key) => `- ${key}`),
              ].join("\n"),
            }
          }),
        )
      },
    })
  }

  return tools
})

export * as SessionTools from "./tools"
