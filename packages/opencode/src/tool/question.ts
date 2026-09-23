import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { formatAnswerOutput } from "../question/format"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
  autoAnswered?: ReadonlyArray<boolean>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const { answers, autoAnswered } = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: formatAnswerOutput({ questions: params.questions, answers, autoAnswered }),
            metadata: autoAnswered ? { answers, autoAnswered } : { answers },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
