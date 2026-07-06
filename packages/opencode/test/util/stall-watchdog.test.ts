import { describe, test, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { breadcrumb, lastStall, stallWatchdog, STALL_THRESHOLD_MS } from "@/util/stall-watchdog"

describe("stall-watchdog", () => {
  test("breadcrumb registers and disposes", () => {
    const drop = breadcrumb("t1", "read", "/tmp/x")
    drop()
    drop() // idempotent
  })

  test("detects a blocked event loop", async () => {
    const fiber = Effect.runFork(stallWatchdog)
    await Bun.sleep(300)
    const end = Date.now() + STALL_THRESHOLD_MS + 400
    while (Date.now() < end) {} // starve the loop synchronously
    await Bun.sleep(300)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(lastStall()?.stallMs).toBeGreaterThan(STALL_THRESHOLD_MS)
  })
})
