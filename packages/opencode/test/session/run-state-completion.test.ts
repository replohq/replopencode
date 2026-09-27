import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, SessionID } from "../../src/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(SessionRunState.node))

for (const [cancelFirst, duplicate, failFirst] of [
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [true, true, false],
  [false, false, true],
  [false, true, true],
]) {
  it.instance(
    `synchronous ${duplicate ? "duplicate" : "queued"} callers wait through ${failFirst ? "defect" : cancelFirst ? "targeted abort" : "completion"} handoff`,
    () =>
      Effect.gen(function* () {
        const state = yield* SessionRunState.Service
        const sessionId = SessionID.make("ses_completion_handoff")
        const firstMessage = message(sessionId)
        const secondMessage = message(sessionId)
        const lastMessage = duplicate ? secondMessage : message(sessionId)
        const messages = [firstMessage, secondMessage, lastMessage]
        const started = yield* Deferred.make<void>()
        const finishFirst = yield* Deferred.make<void>()
        const resumed = yield* Deferred.make<void>()
        const finishNext = yield* Deferred.make<void>()
        let calls = 0
        const work = Effect.gen(function* () {
          calls++
          if (calls === 1) {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(finishFirst)
            if (failFirst) return yield* Effect.die("first run failed")
            return firstMessage
          }
          yield* state.startStep({
            sessionId,
            messageId: lastMessage.info.id,
            messageIds: messages.map((message) => message.info.id),
          })
          yield* Deferred.succeed(resumed, undefined)
          yield* Deferred.await(finishNext)
          return lastMessage
        })
        const ownership = yield* state.registerPrompt({ sessionId, messageId: firstMessage.info.id })
        const first = yield* state
          .ensureRunning(sessionId, Effect.succeed(firstMessage), work, ownership)
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const queued = yield* Effect.forEach(messages.slice(1), (message) =>
          Effect.gen(function* () {
            const token = yield* state.registerPrompt({ sessionId, messageId: message.info.id })
            const fiber = yield* state
              .ensureRunning(sessionId, Effect.succeed(firstMessage), work, token)
              .pipe(Effect.forkChild)
            yield* pollWithTimeout(
              Effect.sync(() => (token.queued ? true : undefined)),
              "prompt admitted",
            )
            return fiber
          }),
        )
        if (cancelFirst) expect(yield* state.cancelPrompt({ sessionId, messageId: firstMessage.info.id })).toBe(true)
        else yield* Deferred.succeed(finishFirst, undefined)
        const firstResult = yield* Fiber.await(first)
        expect(Exit.isFailure(firstResult)).toBe(failFirst)
        yield* Deferred.await(resumed)
        yield* Effect.yieldNow
        for (const fiber of queued) expect(fiber.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(finishNext, undefined)
        for (const fiber of queued) expect((yield* Fiber.join(fiber)).info.id).toBe(lastMessage.info.id)
        expect(calls).toBe(2)
      }),
  )
}

it.instance("stopping a shell settles prompts whose model work has not started", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const sessionId = SessionID.make("ses_shell_completion")
    const result = message(sessionId)
    const started = yield* Deferred.make<void>()
    const shell = yield* state
      .startShell(
        sessionId,
        Effect.succeed(result),
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(started)
    const token = yield* state.registerPrompt({ sessionId, messageId: MessageID.ascending() })
    const prompt = yield* state
      .ensureRunning(sessionId, Effect.succeed(result), Effect.die("model work must not start"), token)
      .pipe(Effect.forkChild)
    yield* pollWithTimeout(
      Effect.sync(() => (token.queued ? true : undefined)),
      "prompt queued behind shell",
    )
    yield* state.cancel(sessionId)
    expect((yield* Fiber.join(prompt)).info.id).toBe(result.info.id)
    yield* Fiber.join(shell)
    expect(yield* Deferred.isDone(token.done)).toBe(true)
  }),
)

it.instance("a model-work defect settles prompt completion with its failure", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const sessionId = SessionID.make("ses_failure_completion")
    const result = message(sessionId)
    const token = yield* state.registerPrompt({ sessionId, messageId: result.info.id })
    const exit = yield* state
      .ensureRunning(sessionId, Effect.succeed(result), Effect.die("model work failed"), token)
      .pipe(Effect.exit)
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    const completion = yield* Deferred.await(token.done).pipe(Effect.exit)
    expect(Exit.isFailure(completion) && Cause.hasDies(completion.cause)).toBe(true)
  }),
)

it.instance("interrupting a synchronous caller does not wait for model completion", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const sessionId = SessionID.make("ses_interrupted_caller")
    const result = message(sessionId)
    const token = yield* state.registerPrompt({ sessionId, messageId: result.info.id })
    const started = yield* Deferred.make<void>()
    const caller = yield* state
      .ensureRunning(
        sessionId,
        Effect.succeed(result),
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        token,
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(caller)
    const exit = yield* Fiber.await(caller)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(yield* Deferred.isDone(token.done)).toBe(false)
    yield* state.cancel(sessionId)
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
