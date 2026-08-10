import { Schema } from "effect"
import { ServerEvent } from "@opencode-ai/schema/server-event"

<<<<<<< dev
export const Event = {
  Connected: EventV2.define({ type: "server.connected", schema: {} }),
  Disposed: EventV2.define({ type: "global.disposed", schema: {} }),
  Reloaded: EventV2.define({ type: "global.reloaded", schema: {} }),
}
=======
export const Event = ServerEvent
>>>>>>> v1.17.14

export const InstanceDisposed = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("server.instance.disposed"),
  properties: Schema.Struct({ directory: Schema.String }),
}).annotate({ identifier: "Event.server.instance.disposed" })
