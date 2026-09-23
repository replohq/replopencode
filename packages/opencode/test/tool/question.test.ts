import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Fiber, Queue } from "effect"
import { QuestionTool } from "../../src/tool/question"
import { Question } from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { seedSession } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("msg_test-message"),
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, Truncate.node, Agent.node, Database.node])),
)

const pending = Effect.fn("QuestionToolTest.pending")(function* (question: Question.Interface) {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const items = yield* question.list()
    const item = items[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

describe("tool.question", () => {
  it.instance("should successfully execute with valid question parameters", () =>
    Effect.gen(function* () {
      yield* seedSession(ctx.sessionID)
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "What is your favorite color?",
          header: "Color",
          options: [
            { label: "Red", description: "The color of passion" },
            { label: "Blue", description: "The color of sky" },
          ],
          multiple: false,
        },
      ]

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Red"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.title).toBe("Asked 1 question")
    }),
  )

  it.instance("should now pass with a header longer than 12 but less than 30 chars", () =>
    Effect.gen(function* () {
      yield* seedSession(ctx.sessionID)
      const question = yield* Question.Service
      const toolInfo = yield* QuestionTool
      const tool = yield* toolInfo.init()
      const questions = [
        {
          question: "What is your favorite animal?",
          header: "This Header is Over 12",
          options: [{ label: "Dog", description: "Man's best friend" }],
        },
      ]

      const fiber = yield* tool.execute({ questions }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["Dog"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
    }),
  )

  it.instance("tells the model which answers were chosen for the user", () =>
    Effect.gen(function* () {
      yield* seedSession(ctx.sessionID)
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ metadata: { [Question.AUTO_ANSWER_DELAY_KEY]: 20 } })
        .where(eq(SessionTable.id, ctx.sessionID))
        .run()
      const tool = yield* (yield* QuestionTool).init()

      const result = yield* tool.execute(
        {
          questions: [
            {
              question: "What is your favorite color?",
              header: "Color",
              options: [
                { label: "Red", description: "The color of passion" },
                { label: "Blue", description: "The color of sky" },
              ],
              recommended: ["Blue"],
            },
          ],
        },
        ctx,
      )

      expect(result.metadata).toMatchObject({ answers: [["Blue"]], autoAnswered: [true] })
      expect(result.output).toContain(
        `"What is your favorite color?"="Blue" (your recommendation, used because the user did not answer in time)`,
      )
      expect(result.output).toContain("do not ask again")
    }),
  )

  // intentionally removed the zod validation due to tool call errors, hoping prompting is gonna be good enough
  //   test("should throw an Error for header exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "What is your favorite animal?",
  //         header: "This Header is Definitely More Than Thirty Characters Long",
  //         options: [{ label: "Dog", description: "Man's best friend" }],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })

  //   test("should throw an Error for label exceeding 30 characters", async () => {
  //     const tool = await QuestionTool.init()
  //     const questions = [
  //       {
  //         question: "A question with a very long label",
  //         header: "Long Label",
  //         options: [
  //           { label: "This is a very, very, very long label that will exceed the limit", description: "A description" },
  //         ],
  //       },
  //     ]
  //     try {
  //       await tool.execute({ questions }, ctx)
  //       // If it reaches here, the test should fail
  //       expect(true).toBe(false)
  //     } catch (e: any) {
  //       expect(e).toBeInstanceOf(Error)
  //       expect(e.cause).toBeInstanceOf(z.ZodError)
  //     }
  //   })
})
