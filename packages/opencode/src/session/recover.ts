import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { NamedError } from "@opencode-ai/core/util/error"
import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { MessageV2 } from "./message-v2"
import type { MessageID, SessionID } from "./schema"
import { Session } from "./session"

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRecovery") {}

// Only one opencode process serves a sandbox and a turn's run loop lives in that process, so at
// instance boot every assistant message without a completion time is provably dead. Finish it the
// way an abort would. No session.error is published here: a client that keys "no reply yet" off
// the first assistant message can race it, and the coordinator already derives the terminal event
// from a completed errored message when it replays the session after a restart.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* Session.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRecovery.state")(function* (ctx) {
        const rows = yield* database.db
          .select({ id: MessageTable.id, sessionID: MessageTable.session_id })
          .from(MessageTable)
          .innerJoin(SessionTable, eq(SessionTable.id, MessageTable.session_id))
          .where(
            and(
              eq(SessionTable.project_id, ctx.project.id),
              sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
              sql`json_extract(${MessageTable.data}, '$.time.completed') IS NULL`,
            ),
          )
          .all()
          .pipe(Effect.orDie)

        for (const row of rows) {
          // One unreadable row must not strand every other orphan (REPL-29772 saw session-DB corruption).
          yield* recover(row).pipe(
            Effect.catchCause((cause) => Effect.logWarning("recovery failed", { messageID: row.id, cause })),
          )
        }
      }),
    )

    const recover = Effect.fn("SessionRecovery.recover")(function* (row: { id: MessageID; sessionID: SessionID }) {
      const { info, parts } = yield* MessageV2.get({ sessionID: row.sessionID, messageID: row.id }).pipe(
        Effect.provideService(Database.Service, database),
      )
      if (info.role !== "assistant") return
      const end = Date.now()
      for (const part of parts) {
        if (part.type !== "tool" || part.state.status === "completed" || part.state.status === "error") continue
        const metadata = "metadata" in part.state && part.state.metadata ? part.state.metadata : {}
        yield* sessions.updatePart({
          ...part,
          state: {
            ...part.state,
            status: "error",
            error: "Tool execution interrupted by a restart",
            metadata: { ...metadata, interrupted: true },
            time: { start: "time" in part.state ? part.state.time.start : end, end },
          },
        })
      }
      info.error = new NamedError.Unknown({
        message: "The agent restarted before it could finish this turn. Send your message again.",
      }).toObject()
      info.time.completed = end
      yield* sessions.updateMessage(info)
      yield* Effect.logInfo("recovered interrupted turn", { sessionID: info.sessionID, messageID: info.id })
    })

    return Service.of({
      init: () => InstanceState.get(state).pipe(Effect.asVoid),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Session.node, MessageV2.node],
})

export * as SessionRecovery from "./recover"
