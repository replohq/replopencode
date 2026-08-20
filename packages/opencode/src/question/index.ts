import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Layer, Schema, Context } from "effect"
import { asc, eq } from "drizzle-orm"
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

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
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
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<ReplyOutcome, NotFoundError>
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

        // Rows in question_request intentionally survive this finalizer so a
        // restarted process can still resolve replies to questions it no
        // longer has waiters for.
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

      const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
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

      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const row = yield* db
        .select()
        .from(QuestionRequestTable)
        .where(eq(QuestionRequestTable.id, input.requestID))
        .get()
        .pipe(Effect.orDie)
      if (!row) {
        yield* Effect.logWarning("reply for unknown request", { requestID: input.requestID })
        return yield* new NotFoundError({ requestID: input.requestID })
      }
      yield* db.delete(QuestionRequestTable).where(eq(QuestionRequestTable.id, row.id)).run().pipe(Effect.orDie)
      const request = rowToRequest(row)
      yield* Effect.logInfo("replied", { requestID: input.requestID, answers: input.answers })
      yield* events.publish(Event.Replied, {
        sessionID: request.sessionID,
        requestID: request.id,
        answers: input.answers.map((a) => [...a]),
      })
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.requestID)
      if (!existing) {
        yield* Effect.logInfo("reply for orphaned request", { requestID: input.requestID })
        return { outcome: "orphaned", request } as const
      }
      pending.delete(input.requestID)
      yield* Deferred.succeed(existing.deferred, input.answers)
      return { outcome: "resolved" } as const
    })

    const rejectRow = Effect.fn("Question.rejectRow")(function* (row: QuestionRequestRow) {
      yield* db.delete(QuestionRequestTable).where(eq(QuestionRequestTable.id, row.id)).run().pipe(Effect.orDie)
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
      const row = yield* db
        .select()
        .from(QuestionRequestTable)
        .where(eq(QuestionRequestTable.id, requestID))
        .get()
        .pipe(Effect.orDie)
      if (!row) {
        yield* Effect.logWarning("reject for unknown request", { requestID })
        return yield* new NotFoundError({ requestID })
      }
      yield* rejectRow(row)
    })

    const rejectAllForSession = Effect.fn("Question.rejectAllForSession")(function* (sessionID: SessionID) {
      const rows = yield* db
        .select()
        .from(QuestionRequestTable)
        .where(eq(QuestionRequestTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(rows, rejectRow, { discard: true })
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

    return Service.of({ ask, reply, reject, rejectAllForSession, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Database.node] })

export * as Question from "."
