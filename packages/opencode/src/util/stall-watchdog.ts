import { Duration, Effect } from "effect"
import { truncateMiddle } from "@opencode-ai/core/util/path"

export const TICK_MS = 250
export const STALL_THRESHOLD_MS = 1_000

// In-flight op register so a stall log can name its culprit; read synchronously by the watchdog tick.
const inflight = new Map<string, { op: string; detail: string; startedAt: number }>()

export function breadcrumb(id: string, op: string, detail: string) {
  inflight.set(id, { op, detail: truncateMiddle(detail, 200), startedAt: Date.now() })
  return () => void inflight.delete(id)
}

let last: { at: number; stallMs: number } | undefined

// Exposed for tests and a future health endpoint.
export function lastStall() {
  return last
}

// Effect.sleep can only wake when the event loop is free, so waking `lag` ms late means the loop was starved that long.
export const stallWatchdog = Effect.gen(function* () {
  while (true) {
    const expected = Date.now() + TICK_MS
    yield* Effect.sleep(Duration.millis(TICK_MS))
    const now = Date.now()
    const lag = now - expected
    if (lag <= STALL_THRESHOLD_MS) continue
    last = { at: now, stallMs: lag }
    yield* Effect.logWarning("event-loop.stall", {
      stall_ms: lag,
      inflight: [...inflight.values()].map((x) => ({ op: x.op, detail: x.detail, age_ms: now - x.startedAt })),
    })
  }
})
