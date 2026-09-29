import { Effect } from "effect"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { Question } from "."
import { settleOrphanedQuestion, type OrphanedResolution } from "./settle"

export const resumeOrphanedQuestion = Effect.fn("Question.resumeOrphanedQuestion")(function* (
  input: OrphanedResolution,
) {
  const prompts = yield* SessionPrompt.Service
  const status = yield* SessionStatus.Service
  const questions = yield* Question.Service
  const result = yield* settleOrphanedQuestion(input)
  if (!result.settled || input.type === "cancel") return
  if ((yield* questions.list()).some((request) => request.sessionID === input.request.sessionID)) return

  const current = yield* status.get(input.request.sessionID)
  if (current.type !== "idle") {
    yield* Effect.logInfo("skipping question resume, session busy", { sessionID: input.request.sessionID })
    return
  }
  yield* prompts.loop({ sessionID: input.request.sessionID })
})
