import { Effect, Option } from "effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { formatAnswerOutput } from "./format"
import type { Answer, Request } from "."

/**
 * Continues a session after a reply arrived for a question whose in-process
 * waiter died with a restart. The persisted request lets us complete the
 * interrupted tool call with the real answers and re-enter the assistant loop
 * as if the answer had resolved normally.
 */
export const resumeOrphanedReply = Effect.fn("Question.resumeOrphanedReply")(function* (input: {
  request: Request
  answers: ReadonlyArray<Answer>
}) {
  const sessions = yield* Session.Service
  const prompts = yield* SessionPrompt.Service
  const status = yield* SessionStatus.Service

  const tool = input.request.tool
  if (tool) {
    const message = yield* sessions.findMessage(input.request.sessionID, (msg) => msg.info.id === tool.messageID)
    const part = Option.isSome(message)
      ? message.value.parts.find((candidate) => candidate.type === "tool" && candidate.callID === tool.callID)
      : undefined
    if (part && part.type === "tool" && part.state.status !== "completed") {
      const started = "time" in part.state && part.state.time ? part.state.time.start : Date.now()
      yield* sessions.updatePart({
        ...part,
        state: {
          status: "completed",
          input: part.state.input,
          output: formatAnswerOutput({ questions: input.request.questions, answers: input.answers }),
          title: `Asked ${input.request.questions.length} question${input.request.questions.length > 1 ? "s" : ""}`,
          metadata: { answers: input.answers.map((answer) => [...answer]) },
          time: { start: started, end: Date.now() },
        },
      })
    }
  }

  const current = yield* status.get(input.request.sessionID)
  if (current.type !== "idle") {
    yield* Effect.logInfo("skipping question resume, session busy", { sessionID: input.request.sessionID })
    return
  }
  yield* prompts.loop({ sessionID: input.request.sessionID })
})
