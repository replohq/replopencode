import { Schema } from "effect"
import { Event as SchemaEvent } from "@opencode-ai/schema/event"
import { ServerEvent } from "@opencode-ai/schema/server-event"

// Fork-only SIGHUP-reload event; non-durable, so it stays out of the durable-event manifests.
export const Event = {
  ...ServerEvent,
  Reloaded: SchemaEvent.define({ type: "global.reloaded", schema: {} }),
}

export const InstanceDisposed = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("server.instance.disposed"),
  properties: Schema.Struct({ directory: Schema.String }),
}).annotate({ identifier: "Event.server.instance.disposed" })
