import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Exit, Schema } from "effect"
import { isRecord } from "@/util/record"
import type { Err } from "./retry"

// The coordinator ships this per sandbox; it is the same shape the removed
// model-fallback plugin consumed, so nothing upstream has to change.
export const ENV_VAR = "REPLO_OPENCODE_FALLBACK_CONFIG"

const NonNegativeInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const ConfigSchema = Schema.Struct({
  fallbackModelsByModel: Schema.Record(Schema.String, Schema.String),
  fallbackOnErrors: Schema.Array(NonNegativeInt),
  maxFallbackAttempts: NonNegativeInt,
  maxUpstreamRetryAttempts: NonNegativeInt,
  cooldownSeconds: NonNegativeInt,
})
export type Config = Schema.Schema.Type<typeof ConfigSchema>
const decode = Schema.decodeUnknownExit(Schema.fromJsonString(ConfigSchema))

export type ModelRef = { providerID: string; modelID: string }

const NETWORK_ERROR_PATTERN =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|terminated/i

let loaded = false
let current: Config | null = null
const degradedUntil = new Map<string, number>()

export function config(): Config | null {
  if (loaded) return current
  loaded = true
  const raw = process.env[ENV_VAR]
  if (!raw) return null
  const exit = decode(raw)
  if (Exit.isSuccess(exit)) current = exit.value
  else console.error("[model-fallback] ignoring invalid config", String(exit.cause))
  return current
}

// Tests inject a config instead of setting the env var.
export function configure(next: Config | null) {
  loaded = true
  current = next
  degradedUntil.clear()
}

export function reset() {
  loaded = false
  current = null
  degradedUntil.clear()
}

export function key(model: ModelRef) {
  return `${model.providerID}/${model.modelID}`
}

// Map values are "provider/model"; a value without a provider is ignored
// rather than routed to a model that does not exist.
export function fallbackFor(model: ModelRef): ModelRef | undefined {
  const target = config()?.fallbackModelsByModel[key(model)]
  const index = target?.indexOf("/") ?? -1
  if (!target || index < 1 || index === target.length - 1) return undefined
  return { providerID: target.slice(0, index), modelID: target.slice(index + 1) }
}

// Cooldown is per model route: the coordinator chains several models on the
// same provider, and a failing Claude route must not take GPT down with it.
export function markDegraded(model: ModelRef, now = Date.now()) {
  const cfg = config()
  if (!cfg) return
  degradedUntil.set(key(model), now + cfg.cooldownSeconds * 1000)
}

export function isDegraded(model: ModelRef, now = Date.now()) {
  const until = degradedUntil.get(key(model))
  if (until === undefined) return false
  if (until > now) return true
  degradedUntil.delete(key(model))
  return false
}

// Follows the fallback chain past every route that is cooling down, so the
// steps after a failure start on the route that just worked.
export function healthy(model: ModelRef, now = Date.now()): ModelRef {
  const seen = new Set<string>([key(model)])
  let candidate = model
  while (isDegraded(candidate, now)) {
    const next = fallbackFor(candidate)
    if (!next || seen.has(key(next))) return model
    seen.add(key(next))
    candidate = next
  }
  return candidate
}

// Transport-level failures the fallback config lists, plus retryable errors
// with no status (connection resets, stream drops, overloaded upstreams
// reported inside a 200). Non-retryable statusless errors such as an invalid
// prompt or exhausted quota stay on the requested model. Context overflow and
// aborts are the caller's problem and never switch models.
export function qualifies(error: Err): boolean {
  const cfg = config()
  if (!cfg) return false
  if (SessionV1.ContextOverflowError.isInstance(error)) return false
  if (SessionV1.AbortedError.isInstance(error)) return false
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    if (status === undefined) return error.data.isRetryable === true
    return cfg.fallbackOnErrors.includes(status) || status === 402
  }
  const message = isRecord(error.data) ? error.data.message : undefined
  return typeof message === "string" && NETWORK_ERROR_PATTERN.test(message)
}

// Records the failed route and returns the one to try next, if the swap
// budget allows another. The cooldown is recorded before the cap is applied so
// the last route in a chain is also skipped by the steps that follow.
export function failed(input: { model: ModelRef; error: Err; swaps: number }): ModelRef | undefined {
  const cfg = config()
  if (!cfg || !qualifies(input.error)) return undefined
  markDegraded(input.model)
  if (input.swaps >= cfg.maxFallbackAttempts) return undefined
  return fallbackFor(input.model)
}

export * as SessionFallback from "./fallback"
