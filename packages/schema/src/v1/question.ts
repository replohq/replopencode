export * as QuestionV1 from "./question"

import { Schema } from "effect"
import { define, inventory } from "../event"
import { ascending } from "../identifier"
import { statics } from "../schema"
import { SessionID } from "../session-id"
import { SessionV1 } from "./session"

export const ID = Schema.String.check(Schema.isStartsWith("que")).pipe(
  Schema.brand("QuestionID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "que_" + ascending()) })),
)

export const Option = Schema.Struct({
  label: Schema.String.annotate({ description: "Display text (1-5 words, concise)" }),
  description: Schema.String.annotate({ description: "Explanation of choice" }),
}).annotate({ identifier: "QuestionOption" })

// Bounded so one reply or saved progress cannot bloat the question row that every list reader parses;
// the caps sit far above real answers (typed text, or every option of one question).
export const Answer = Schema.Array(Schema.String.check(Schema.isMaxLength(16000)))
  .check(Schema.isMaxLength(100))
  .annotate({ identifier: "QuestionAnswer" })

const base = {
  question: Schema.String.annotate({ description: "Complete question" }),
  header: Schema.String.annotate({ description: "Very short label (max 30 chars)" }),
  options: Schema.Array(Option).annotate({ description: "Available choices" }),
  multiple: Schema.optional(Schema.Boolean).annotate({ description: "Allow selecting multiple choices" }),
}

const recommendedDescription =
  "Exact label(s) of the option(s) you would pick yourself; empty when you have no genuine preference or the choice is the user's alone"

export const Info = Schema.Struct({
  ...base,
  custom: Schema.optional(Schema.Boolean).annotate({ description: "Allow typing a custom answer (default: true)" }),
  // Optional here: some system-generated questions (e.g. plan_exit's) are built by hand rather than
  // through the tool's validated Prompt schema, and questions asked before the tool required a
  // recommendation are still stored and served. Absent does not mean "no recommendation was intended".
  recommended: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Recommended label(s) at ask time; absent when none was recorded for this question",
    }),
  ),
}).annotate({ identifier: "QuestionInfo" })
// The tool requires a recommendation, so the model always decides; an empty list means no genuine preference or "the user decides".
export const Prompt = Schema.Struct({
  ...base,
  recommended: Schema.Array(Schema.String).annotate({ description: recommendedDescription }),
})
  .check(
    Schema.makeFilter((question) => {
      const labels = question.options.map((option) => option.label)
      const unknown = question.recommended.find((label) => !labels.includes(label))
      if (unknown !== undefined) {
        return `recommended "${unknown}" is not an option label (options: ${labels.map((label) => `"${label}"`).join(", ")})`
      }
      if (!question.multiple && question.recommended.length > 1) {
        return "recommend at most one option unless multiple is true"
      }
      return undefined
    }),
  )
  .annotate({ identifier: "QuestionPrompt" })
export const Tool = Schema.Struct({ messageID: SessionV1.MessageID, callID: Schema.String }).annotate({
  identifier: "QuestionTool",
})
export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  questions: Schema.Array(Info).annotate({ description: "Questions to ask" }),
  tool: Schema.optional(Tool),
  progress: Schema.optional(
    Schema.Array(Answer).annotate({
      description:
        "Answers saved so far, in question order; may be shorter than questions. A missing or empty entry is a question not answered yet. Absent until a client saves; each save replaces the whole list.",
    }),
  ),
}).annotate({ identifier: "QuestionRequest" })
export const Reply = Schema.Struct({
  answers: Schema.Array(Answer).annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
}).annotate({ identifier: "QuestionReply" })
export const Replied = Schema.Struct({
  sessionID: SessionID,
  requestID: ID,
  answers: Schema.Array(Answer),
}).annotate({
  identifier: "QuestionReplied",
})
export const Rejected = Schema.Struct({ sessionID: SessionID, requestID: ID }).annotate({
  identifier: "QuestionRejected",
})

const Asked = define({ type: "question.asked", schema: Request.fields })
const RepliedEvent = define({ type: "question.replied", schema: Replied.fields })
const RejectedEvent = define({ type: "question.rejected", schema: Rejected.fields })
export const Event = {
  Asked,
  Replied: RepliedEvent,
  Rejected: RejectedEvent,
  Definitions: inventory(Asked, RepliedEvent, RejectedEvent),
}
