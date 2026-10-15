import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(SessionRunState.node))

it.instance("a cancelled preparation stays excluded from its overlapping successor", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const sessionId = SessionID.make("ses_cancelled_preparation")
    const first = message(sessionId)
    const second = message(sessionId)
    const messages = [first, second]
    const preparing = yield* state.registerPrompt({ sessionId, messageId: first.info.id })

    expect(yield* state.cancelPrompt({ sessionId, messageId: first.info.id })).toBe(true)
    expect(yield* state.cancelPrompt({ sessionId, messageId: first.info.id })).toBe(false)

    const successor = yield* state.registerPrompt({ sessionId, messageId: second.info.id })
    yield* state.finishPrompt(sessionId, preparing)
    yield* state.ensureRunning(
      sessionId,
      Effect.succeed(second),
      Effect.gen(function* () {
        const history = yield* state.filterMessages(sessionId, messages)
        expect(history.map((message) => message.info.id)).toEqual([second.info.id])
        return second
      }),
      successor,
    )
  }),
)

function message(sessionID: SessionID): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    },
    parts: [],
  }
}
