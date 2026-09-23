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

export const Answer = Schema.Array(Schema.String).annotate({ identifier: "QuestionAnswer" })

const base = {
  question: Schema.String.annotate({ description: "Complete question" }),
  header: Schema.String.annotate({ description: "Very short label (max 30 chars)" }),
  options: Schema.Array(Option).annotate({ description: "Available choices" }),
  multiple: Schema.optional(Schema.Boolean).annotate({ description: "Allow selecting multiple choices" }),
  recommended: Schema.optional(Answer).annotate({
    description: "Exact label(s) of the option(s) you recommend; used for the user if they do not answer in time",
  }),
}

export const Info = Schema.Struct({
  ...base,
  custom: Schema.optional(Schema.Boolean).annotate({ description: "Allow typing a custom answer (default: true)" }),
}).annotate({ identifier: "QuestionInfo" })
export const Prompt = Schema.Struct(base).annotate({ identifier: "QuestionPrompt" })
export const Tool = Schema.Struct({ messageID: SessionV1.MessageID, callID: Schema.String }).annotate({
  identifier: "QuestionTool",
})
export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  questions: Schema.Array(Info).annotate({ description: "Questions to ask" }),
  tool: Schema.optional(Tool),
  progress: Schema.optional(Schema.Array(Answer)).annotate({
    description: "Answers saved before the reply, in question order (empty for a question not answered yet)",
  }),
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
  autoAnswered: Schema.optional(Schema.Array(Schema.Boolean)).annotate({
    description: "Per question, true when nobody answered in time and the recommended answer was used",
  }),
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
