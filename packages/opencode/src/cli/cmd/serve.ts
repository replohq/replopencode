import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import { SighupBootGuard } from "../sighup-boot-guard"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    // SIGHUP: reload env vars + harness in place without restarting or
    // interrupting in-flight sessions. The coordinator rotates the s6 envdirs
    // on disk, then sends SIGHUP; we re-read them and invalidate harness caches.
    // server.reload() runs against the listener's own service context, so it
    // invalidates the exact InstanceStore/Skill/Config caches requests serve from.
    let reloading = false
    let pending = false
    const reload = () => {
      if (reloading) {
        // SIGHUP during an in-flight reload: coalesce into a single trailing
        // re-run so the latest rotated envdir/config state is always applied.
        pending = true
        return
      }
      reloading = true
      server
        .reload()
        .catch((err) => console.error("harness reload failed", err))
        .finally(() => {
          reloading = false
          if (pending) {
            pending = false
            reload()
          }
        })
    }
    yield* Effect.sync(() => SighupBootGuard.handover(reload))

    yield* Effect.never
  }),
})
