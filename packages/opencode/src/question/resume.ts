import { Effect } from "effect"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { Question } from "."
import { settleOrphanedQuestion, type OrphanedResolution } from "./settle"

export const resumeOrphanedQuestion = Effect.fn("Question.resumeOrphanedQuestion")(function* (
  input: OrphanedResolution & { type: "reply" | "reject" },
) {
  const prompts = yield* SessionPrompt.Service
  const status = yield* SessionStatus.Service
  const questions = yield* Question.Service
  if (!(yield* settleOrphanedQuestion(input))) return
  if ((yield* questions.list()).some((request) => request.sessionID === input.request.sessionID)) return

  const current = yield* status.get(input.request.sessionID)
  if (current.type !== "idle") {
    yield* Effect.logInfo("skipping question resume, session busy", { sessionID: input.request.sessionID })
    return
  }
  yield* prompts.loop({ sessionID: input.request.sessionID })
})
