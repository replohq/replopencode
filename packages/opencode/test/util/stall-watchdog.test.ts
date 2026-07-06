import { describe, expect } from "bun:test"
import { Duration, Effect } from "effect"
import { it } from "../lib/effect"
import { breadcrumb, lastStall, stallWatchdog, STALL_THRESHOLD_MS } from "@/util/stall-watchdog"

describe("stall-watchdog", () => {
  it.live(
    "breadcrumb registers and disposes",
    Effect.sync(() => {
      const drop = breadcrumb("t1", "read", "/tmp/x")
      drop()
      drop() // idempotent
    }),
  )

  it.live(
    "detects a blocked event loop",
    Effect.gen(function* () {
      yield* stallWatchdog.pipe(Effect.forkScoped)
      yield* Effect.sleep(Duration.millis(300))
      const end = performance.now() + STALL_THRESHOLD_MS + 400
      while (performance.now() < end) {} // starve the loop synchronously
      yield* Effect.sleep(Duration.millis(300))
      expect(lastStall()?.stallMs).toBeGreaterThan(STALL_THRESHOLD_MS)
    }),
    15000,
  )
})
