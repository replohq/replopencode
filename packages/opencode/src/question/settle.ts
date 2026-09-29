import { Effect, Option } from "effect"
import { MessageV2 } from "@/session/message-v2"
import { RESTART_ERROR_MESSAGE } from "@/session/recover"
import { Session } from "@/session/session"
import { Question } from "."
import { formatAnswerOutput } from "./format"

export type OrphanedResolution =
  | { request: Question.Request; type: "reply"; answers: ReadonlyArray<Question.Answer> }
  | { request: Question.Request; type: "reject" | "cancel" }

// Shared with Stop without importing the prompt loop back into itself.
export const settleOrphanedQuestion = Effect.fn("Question.settleOrphanedQuestion")(function* (
  input: OrphanedResolution,
) {
  const sessions = yield* Session.Service
  const tool = input.request.tool
  if (!tool) return { settled: false }
  const message = yield* sessions.findMessage(input.request.sessionID, (msg) => msg.info.id === tool.messageID)
  if (Option.isNone(message) || message.value.info.role !== "assistant") return { settled: false }
  const part = message.value.parts.find((candidate) => candidate.type === "tool" && candidate.callID === tool.callID)
  if (!part || part.type !== "tool" || part.tool !== "question" || part.state.status === "completed") {
    return { settled: false }
  }
  if (part.state.status === "error" && part.state.error !== "Tool execution interrupted by a restart") {
    return { settled: false }
  }
  const time = { start: "time" in part.state ? part.state.time.start : Date.now(), end: Date.now() }
  yield* sessions.updatePart({
    ...part,
    state:
      input.type === "reply"
        ? {
            status: "completed",
            input: part.state.input,
            output: formatAnswerOutput({ questions: input.request.questions, answers: input.answers }),
            title: `Asked ${input.request.questions.length} question${input.request.questions.length > 1 ? "s" : ""}`,
            metadata: { answers: input.answers.map((answer) => [...answer]) },
            time,
          }
        : {
            status: "error",
            input: part.state.input,
            error: input.type === "cancel" ? "Tool execution aborted" : new Question.RejectedError().message,
            metadata: input.type === "cancel" ? { interrupted: true } : {},
            time,
          },
  })

  // Read after writing: concurrent replies must see siblings settled by the other request.
  const updated = yield* sessions.findMessage(input.request.sessionID, (msg) => msg.info.id === tool.messageID)
  if (Option.isNone(updated) || updated.value.info.role !== "assistant") return { settled: false }
  if (
    updated.value.parts.some(
      (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
    )
  ) {
    return { settled: false }
  }
  const info = updated.value.info
  const error =
    info.error?.name === "UnknownError" && info.error.data.message === RESTART_ERROR_MESSAGE ? undefined : info.error
  yield* sessions.updateMessage({
    ...info,
    error:
      input.type === "cancel"
        ? (error ??
          MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
            providerID: info.providerID,
            aborted: true,
          }))
        : error,
    finish: "tool-calls",
    time: { ...info.time, completed: info.time.completed ?? Date.now() },
  })
  return { settled: !error }
})
