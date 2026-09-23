import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Duration, Effect, Layer, Schema, Context } from "effect"
import { and, asc, eq, inArray } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { QuestionRequestTable, SessionTable } from "@opencode-ai/core/session/sql"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { QuestionID } from "./schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"

export const Option = QuestionV1.Option
export type Option = typeof Option.Type
export const Info = QuestionV1.Info
export type Info = typeof Info.Type
export const Prompt = QuestionV1.Prompt
export type Prompt = typeof Prompt.Type
export const Tool = QuestionV1.Tool
export type Tool = typeof Tool.Type
export const Request = QuestionV1.Request
export type Request = typeof Request.Type
export const Answer = QuestionV1.Answer
export type Answer = typeof Answer.Type
export const Reply = QuestionV1.Reply
export type Reply = typeof Reply.Type
export const Replied = QuestionV1.Replied
export const Rejected = QuestionV1.Rejected
export const Event = QuestionV1.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Question.NotFoundError", {
  requestID: QuestionID,
}) {}

// Session metadata key. The client sets it per session (PATCH /session/:id) to the milliseconds a question may
// wait before its recommended answer is used; unset means questions wait for a person.
export const AUTO_ANSWER_DELAY_KEY = "questionAutoAnswerDelayMs"

export interface Answered {
  readonly answers: ReadonlyArray<Answer>
  /** Per question, true when nobody answered in time and the recommended answer was used. Absent on a person's reply. */
  readonly autoAnswered?: ReadonlyArray<boolean>
}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<Answered, RejectedError>
}

interface State {
  pending: Map<QuestionID, PendingEntry>
}

export type ReplyOutcome =
  | { readonly outcome: "resolved" }
  | { readonly outcome: "orphaned"; readonly request: Request }

type QuestionRequestRow = typeof QuestionRequestTable.$inferSelect

function rowToRequest(row: QuestionRequestRow): Request {
  return { ...row.data, id: row.id, sessionID: row.session_id }
}

// Service

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<Answered, RejectedError>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<ReplyOutcome, NotFoundError>
  readonly saveProgress: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: QuestionID) => Effect.Effect<void, NotFoundError>
  readonly rejectAllForSession: (sessionID: SessionID) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* () {
        const state = {
          pending: new Map<QuestionID, PendingEntry>(),
        }

        // Rows intentionally survive shutdown so a restarted process can still resolve replies.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Question.ask")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const id = QuestionID.ascending()
      yield* Effect.logInfo("asking", { id, questions: input.questions.length })

      const deferred = yield* Deferred.make<Answered, RejectedError>()
      // Leaving a question without a recommendation is how the model says only the user can decide it.
      const delay = input.questions.every((question) => question.recommended?.length)
        ? yield* autoAnswerDelay(input.sessionID)
        : undefined
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }
      yield* db
        .insert(QuestionRequestTable)
        .values({
          id,
          session_id: input.sessionID,
          data: { questions: input.questions, tool: input.tool },
        })
        .run()
        .pipe(Effect.orDie)
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)

      if (delay !== undefined) {
        // A child of this ask, so however the question settles, the timer ends with it.
        yield* Effect.sleep(Duration.millis(delay)).pipe(
          Effect.andThen(autoAnswer(id)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning("auto-answer failed", { id, cause }),
          ),
          Effect.forkChild,
        )
      }

      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    // Deleting the row is the claim: whichever concurrent reply/reject wins the delete owns the request.
    // Scoped to this instance's project (like list) so co-located instances sharing the global DB
    // cannot consume each other's live requests.
    const inProject = Effect.fn("Question.inProject")(function* (requestID: QuestionID) {
      const ctx = yield* InstanceState.context
      return and(
        eq(QuestionRequestTable.id, requestID),
        inArray(
          QuestionRequestTable.session_id,
          db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.project_id, ctx.project.id)),
        ),
      )
    })

    const claim = Effect.fn("Question.claim")(function* (requestID: QuestionID) {
      return yield* db
        .delete(QuestionRequestTable)
        .where(yield* inProject(requestID))
        .returning()
        .get()
        .pipe(Effect.orDie)
    })

    // Publishes the reply and hands it to the waiting ask when that ask is still alive in this process.
    const settle = Effect.fn("Question.settle")(function* (request: Request, answered: Answered) {
      yield* events.publish(Event.Replied, {
        sessionID: request.sessionID,
        requestID: request.id,
        answers: answered.answers.map((a) => [...a]),
        ...(answered.autoAnswered ? { autoAnswered: [...answered.autoAnswered] } : {}),
      })
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(request.id)
      if (!existing) return "orphaned" as const
      pending.delete(request.id)
      // False when instance disposal already failed this waiter.
      return (yield* Deferred.succeed(existing.deferred, answered)) ? ("resolved" as const) : ("disposed" as const)
    })

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const row = yield* claim(input.requestID)
      if (!row) {
        yield* Effect.logWarning("reply for unknown request", { requestID: input.requestID })
        return yield* new NotFoundError({ requestID: input.requestID })
      }
      const request = rowToRequest(row)
      yield* Effect.logInfo("replied", { requestID: input.requestID, answers: input.answers })
      const settled = yield* settle(request, { answers: input.answers })
      if (settled === "resolved") return { outcome: "resolved" } as const
      // Without a live waiter the answers still need the orphaned heal path.
      yield* Effect.logInfo(
        settled === "orphaned" ? "reply for orphaned request" : "reply raced instance disposal, treating as orphaned",
        { requestID: input.requestID },
      )
      return { outcome: "orphaned", request } as const
    })

    const autoAnswerDelay = Effect.fn("Question.autoAnswerDelay")(function* (sessionID: SessionID) {
      const row = yield* db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const delay = row?.metadata?.[AUTO_ANSWER_DELAY_KEY]
      return typeof delay === "number" && Number.isFinite(delay) && delay >= 0 ? delay : undefined
    })

    // Only a question whose ask is live in this process is answered: after a restart there is no turn to hand the
    // answer to, so the question waits for a person and their reply resumes the turn.
    const autoAnswer = Effect.fn("Question.autoAnswer")(function* (requestID: QuestionID) {
      const entry = (yield* InstanceState.get(state)).pending.get(requestID)
      // Re-read at fire time so clearing the setting also stops questions already waiting.
      if (!entry || (yield* autoAnswerDelay(entry.info.sessionID)) === undefined) return
      const row = yield* claim(requestID)
      if (!row) return
      const request = rowToRequest(row)
      const answers = request.questions.map((question, index) => {
        const saved = request.progress?.[index]
        return saved?.length ? saved : (question.recommended ?? [])
      })
      const autoAnswered = request.questions.map((_, index) => !request.progress?.[index]?.length)
      yield* Effect.logInfo("auto-answered", { requestID, answers, autoAnswered })
      const settled = yield* settle(request, { answers, autoAnswered })
      // Only instance disposal between the check above and the claim lands here; boot recovery then closes the turn.
      if (settled !== "resolved") yield* Effect.logWarning("auto-answer lost its waiter", { requestID, settled })
    })

    const saveProgress = Effect.fn("Question.saveProgress")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const where = yield* inProject(input.requestID)
      const row = yield* db.select().from(QuestionRequestTable).where(where).get().pipe(Effect.orDie)
      // A reply can claim the row between the read and the write; the write then matches nothing.
      const saved =
        row &&
        (yield* db
          .update(QuestionRequestTable)
          .set({ data: { ...row.data, progress: input.answers.map((a) => [...a]) } })
          .where(where)
          .returning({ id: QuestionRequestTable.id })
          .get()
          .pipe(Effect.orDie))
      if (!saved) return yield* new NotFoundError({ requestID: input.requestID })
    })

    const rejectClaimed = Effect.fn("Question.rejectClaimed")(function* (row: QuestionRequestRow) {
      yield* Effect.logInfo("rejected", { requestID: row.id })
      yield* events.publish(Event.Rejected, {
        sessionID: row.session_id,
        requestID: row.id,
      })
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(row.id)
      if (!existing) return
      pending.delete(row.id)
      yield* Deferred.fail(existing.deferred, new RejectedError())
    })

    const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
      const row = yield* claim(requestID)
      if (!row) {
        yield* Effect.logWarning("reject for unknown request", { requestID })
        return yield* new NotFoundError({ requestID })
      }
      yield* rejectClaimed(row)
    })

    const rejectAllForSession = Effect.fn("Question.rejectAllForSession")(function* (sessionID: SessionID) {
      const rows = yield* db
        .delete(QuestionRequestTable)
        .where(eq(QuestionRequestTable.session_id, sessionID))
        .returning()
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(rows, rejectClaimed, { discard: true })
    })

    const list = Effect.fn("Question.list")(function* () {
      const ctx = yield* InstanceState.context
      const rows = yield* db
        .select({ request: QuestionRequestTable })
        .from(QuestionRequestTable)
        .innerJoin(SessionTable, eq(QuestionRequestTable.session_id, SessionTable.id))
        .where(eq(SessionTable.project_id, ctx.project.id))
        .orderBy(asc(QuestionRequestTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map((x) => rowToRequest(x.request))
    })

    return Service.of({ ask, reply, saveProgress, reject, rejectAllForSession, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Database.node] })

export * as Question from "."
