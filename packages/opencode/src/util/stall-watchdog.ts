import { Duration, Effect } from "effect"
import { truncateMiddle } from "@opencode-ai/core/util/path"

export const TICK_MS = 250
export const STALL_THRESHOLD_MS = 1_000

// In-flight op register so a stall log can name its culprit; read synchronously by the watchdog tick.
const inflight = new Map<string, { op: string; detail: string; startedAt: number }>()

export function breadcrumb(id: string, op: string, detail: string) {
  inflight.set(id, { op, detail: truncateMiddle(detail, 200), startedAt: performance.now() })
  return () => void inflight.delete(id)
}

let last: { at: number; stallMs: number } | undefined

// Exposed for tests and a future health endpoint.
export function lastStall() {
  return last
}

// Effect.sleep only wakes when the loop is free (waking `lag` ms late = starved that long); monotonic clock, so NTP steps/suspend don't fabricate stalls.
export const stallWatchdog = Effect.gen(function* () {
  while (true) {
    const expected = performance.now() + TICK_MS
    yield* Effect.sleep(Duration.millis(TICK_MS))
    const now = performance.now()
    const lag = now - expected
    if (lag <= STALL_THRESHOLD_MS) continue
    last = { at: Date.now(), stallMs: lag }
    yield* Effect.logWarning("event-loop.stall", {
      stall_ms: Math.round(lag),
      inflight: [...inflight.values()].map((x) => ({ op: x.op, detail: x.detail, age_ms: Math.round(now - x.startedAt) })),
    })
  }
})
