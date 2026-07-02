import { Effect, Schedule } from "effect"
import { closeSync, writeSync } from "node:fs"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

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
    yield* Effect.sync(() => process.on("SIGHUP", reload))

    // Readiness: the socket being bound (above) is not enough for the
    // coordinator — session creation only works once the workspace instance
    // has booted, which normally happens lazily on the first request. Boot it
    // eagerly here so the readiness notification below means "the first real
    // session operation will succeed". A failed boot is evicted from
    // InstanceStore, so every retry is a real attempt; retries continue with
    // capped backoff and the supervisor's readiness timeout owns giving up.
    const warmupDirectory = Flag.OPENCODE_SERVER_WARMUP_DIRECTORY
    if (warmupDirectory) {
      yield* Effect.tryPromise(() => server.warmup(warmupDirectory)).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("workspace warmup failed; retrying", { directory: warmupDirectory, error }),
        ),
        Effect.retry(Schedule.exponential(250).pipe(Schedule.either(Schedule.spaced(5000)))),
        Effect.orDie,
      )
      console.log(`workspace warmup complete for ${warmupDirectory}`)
    }
    yield* Effect.sync(notifyReady)

    yield* Effect.never
  }),
})

// s6 readiness protocol: s6-supervise passes an inherited pipe on the fd
// declared in the service dir's notification-fd file; writing a newline to it
// (then closing it) flips the service to ready for s6-svwait -U / s6-rc
// dependents. Opt-in via env because in a non-supervised launch that fd could
// be an unrelated inherited descriptor that must not receive stray bytes.
function notifyReady() {
  const raw = Flag.OPENCODE_SERVER_READY_FD
  if (!raw) return
  const fd = Number(raw)
  if (!Number.isInteger(fd) || fd <= 2) {
    console.error(`ignoring invalid OPENCODE_SERVER_READY_FD: ${raw}`)
    return
  }
  try {
    writeSync(fd, "\n")
    closeSync(fd)
    console.log(`readiness signaled on fd ${fd}`)
  } catch (error) {
    console.error(`failed to signal readiness on fd ${fd}`, error)
  }
}
