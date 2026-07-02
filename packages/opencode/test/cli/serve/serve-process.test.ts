// Subprocess integration tests for `opencode serve`. Spawns the real CLI in
// headless mode and exercises it over HTTP — this is the only test tier that
// catches bugs spanning argv → server boot → routing → instance loading.
//
// `serve` is long-lived: the harness returns a handle (url/port/kill/exited)
// and kills the process when the test scope closes. The OS-assigned port is
// parsed off the "listening on http://..." line.
import { describe, expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { HttpClient } from "effect/unstable/http"
import { closeSync, openSync, readFileSync } from "node:fs"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("opencode serve (subprocess)", () => {
  // Smoke test: server starts, binds a port, and /global/health responds.
  // If this fails, all other serve tests likely will too — debug here first.
  cliIt.live(
    "starts, binds a port, and serves /global/health",
    ({ opencode }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve()
        expect(server.port).toBeGreaterThan(0)
        expect(server.url).toMatch(/^http:\/\//)

        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${server.url}/global/health`)
        expect(res.status).toBe(200)
        // GlobalHealth schema is { success: true, ... } | { success: false, error }.
        // We don't lock in further shape here — any 200 with parseable JSON is
        // enough proof the routing + auth-bypass + instance loading is alive.
        const body = yield* res.json
        expect(body).toBeDefined()
      }),
    60_000,
  )

  // s6-style readiness: with OPENCODE_SERVER_READY_FD + WARMUP_DIRECTORY set,
  // the server must boot the workspace instance eagerly and then write a
  // newline to the notification fd — the same contract s6-supervise expects
  // from a service with a notification-fd file. The fd here is a regular file
  // instead of a pipe so the test can just read it back.
  cliIt.live(
    "signals readiness on OPENCODE_SERVER_READY_FD after workspace warmup",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const readyFile = path.join(home, "ready-notification")
        const fd = openSync(readyFile, "w")
        const server = yield* opencode
          .serve({
            extraFds: [fd],
            env: {
              OPENCODE_SERVER_READY_FD: "3",
              OPENCODE_SERVER_WARMUP_DIRECTORY: home,
            },
          })
          // The child owns its copy of the fd after spawn; drop the parent's.
          .pipe(Effect.ensuring(Effect.sync(() => closeSync(fd))))

        // The notification lands after warmup, which finishes after the
        // "listening" line the serve helper waits for — so poll briefly.
        yield* Effect.try({
          try: () => {
            if (!readFileSync(readyFile, "utf8").includes("\n")) throw new Error("readiness fd not signaled yet")
          },
          catch: (cause) => new Error(`readiness notification never arrived: ${String(cause)}`),
        }).pipe(Effect.retry(Schedule.spaced(100).pipe(Schedule.both(Schedule.recurs(300)))))

        // Readiness promised the first real session operation succeeds.
        const res = yield* Effect.promise(() =>
          fetch(`${server.url}/session?directory=${encodeURIComponent(home)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        )
        expect([200, 201]).toContain(res.status)
      }),
    120_000,
  )

  // The scope-close finalizer must actually terminate the child. Without this
  // test a regression in the kill path (e.g. a future refactor that forgets
  // to wire the finalizer) would leak processes on every test run.
  cliIt.live(
    "kills the subprocess on scope close",
    ({ opencode }) =>
      Effect.gen(function* () {
        // Inner scope so we can observe `.exited` resolving after it closes.
        const exitedPromise = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* opencode.serve()
            // Capture the Promise, not the resolved value — scope closes after
            // this gen returns, at which point the finalizer kills the child.
            return server.exited
          }),
        )
        // After scope close: finalizer fired, process must have exited.
        const code = yield* Effect.promise(() => exitedPromise)
        // Bun reports the exit code; SIGTERM-killed processes return non-null
        // (typically 143 on POSIX). We just require resolution within a sane
        // window — anything else means the kill didn't take.
        expect(typeof code === "number" || code === null).toBe(true)
      }),
    60_000,
  )
})
