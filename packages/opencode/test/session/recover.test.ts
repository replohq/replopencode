import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionRecovery } from "@/session/recover"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      MessageV2.node,
      SessionProjector.node,
      SessionStatus.node,
      EventV2Bridge.node,
      SessionRecovery.node,
    ]),
  ),
)

const seedTurn = Effect.fn("Test.seedTurn")(function* (sessionID: SessionID, opts?: { completed?: number }) {
  const sessions = yield* Session.Service
  const userID = MessageID.ascending()
  yield* sessions.updateMessage({
    id: userID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as SessionV1.Info)
  const assistantID = MessageID.ascending()
  yield* sessions.updateMessage({
    id: assistantID,
    sessionID,
    role: "assistant",
    time: { created: Date.now(), completed: opts?.completed },
    parentID: userID,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Info)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: assistantID,
    type: "tool",
    callID: "call-1",
    tool: "bash",
    state: { status: "running", input: { command: "sleep 120" }, time: { start: 1 } },
  } as unknown as SessionV1.Part)
  return assistantID
})

it.instance("finishes a restart-orphaned assistant message with an interrupted error", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    const recovery = yield* SessionRecovery.Service
    const chat = yield* sessions.create({})
    const assistantID = yield* seedTurn(chat.id)
    const seen: string[] = []
    const off = yield* events.listen((event) => {
      seen.push(event.type)
      return Effect.void
    })

    yield* recovery.init()
    yield* off

    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: assistantID })
    expect(stored.info.role).toBe("assistant")
    if (stored.info.role === "assistant") {
      expect(stored.info.error?.name).toBe("UnknownError")
      expect(stored.info.time.completed).toBeNumber()
    }
    const tool = stored.parts.find((part) => part.type === "tool")
    expect(tool?.type === "tool" && tool.state.status === "error" ? tool.state.metadata?.interrupted : undefined).toBe(
      true,
    )
    expect(seen).toContain(MessageV2.Event.Updated.type)
    expect(seen).toContain(Session.Event.Error.type)
    expect(seen.indexOf(MessageV2.Event.Updated.type)).toBeLessThan(seen.indexOf(Session.Event.Error.type))
    expect(seen).toContain(SessionStatus.Event.Idle.type)
  }),
)

it.instance("leaves a completed assistant message alone", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const recovery = yield* SessionRecovery.Service
    const chat = yield* sessions.create({})
    const assistantID = yield* seedTurn(chat.id, { completed: Date.now() })

    yield* recovery.init()

    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: assistantID })
    expect(stored.info.role === "assistant" ? stored.info.error : "wrong role").toBeUndefined()
    const tool = stored.parts.find((part) => part.type === "tool")
    expect(tool?.type === "tool" ? tool.state.status : "missing").toBe("running")
  }),
)
