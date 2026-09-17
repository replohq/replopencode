import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Exit, Schema } from "effect"
import { isRecord } from "@/util/record"
import { parseJSON, type Err } from "./retry"
import type { Provider } from "@/provider/provider"

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

export function ref(model: Provider.Model): ModelRef {
  return { providerID: model.providerID, modelID: model.id }
}

const NETWORK_ERROR_PATTERN =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|terminated/i

let lastRaw: string | undefined
let current: Config | null = null
const degradedUntil = new Map<string, number>()

// A swap budget of zero turns the feature off entirely, same-route retry cap
// included, so a project can opt out by shipping a config instead of deleting one.
function active(cfg: Config): Config | null {
  return cfg.maxFallbackAttempts === 0 ? null : cfg
}

// Re-read whenever the env string changes: a harness reload rewrites
// process.env in place, and the coordinator's opt-out arrives that way.
export function config(): Config | null {
  const raw = process.env[ENV_VAR]
  if (raw === lastRaw) return current
  lastRaw = raw
  current = null
  // Cooldowns were recorded under the previous config and may name routes it no longer has.
  degradedUntil.clear()
  if (!raw) return current
  const exit = decode(raw)
  if (Exit.isSuccess(exit)) current = active(exit.value)
  else console.error("[model-fallback] ignoring invalid config", String(exit.cause))
  return current
}

export function reset() {
  lastRaw = undefined
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

// The route a step should start on: follows the fallback chain past every
// route that is cooling down, so the steps after a failure start on the route
// that just worked. Returns the same object when nothing changes, otherwise a
// config route the caller still has to resolve against the provider registry.
export function route(model: ModelRef, now = Date.now()): ModelRef {
  if (!config()) return model
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

// Failures the fallback config lists by status, whether the status arrived as
// an HTTP response or as the `{ code, message }` chunk OpenRouter relays inside
// a 200 stream, plus retryable errors with no status at all (connection
// resets, stream drops). Non-retryable statusless errors such as an invalid
// prompt or exhausted quota stay on the requested model. Context overflow and
// aborts are the caller's problem and never switch models.
function qualifies(error: Err): boolean {
  const cfg = config()
  if (!cfg) return false
  if (SessionV1.ContextOverflowError.isInstance(error)) return false
  if (SessionV1.AbortedError.isInstance(error)) return false
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    if (status === undefined) return error.data.isRetryable === true
    return cfg.fallbackOnErrors.includes(status)
  }
  const message = isRecord(error.data) ? error.data.message : undefined
  if (typeof message !== "string") return false
  const json = parseJSON(message)
  const code = json?.code ?? json?.error?.code
  if (typeof code === "number") return cfg.fallbackOnErrors.includes(code)
  return NETWORK_ERROR_PATTERN.test(message)
}

// Puts the failed route on cooldown and returns the one to try next, if the
// swap budget allows another. The cooldown is recorded before the cap and the
// map are consulted, so an undefined result can still mean the route was
// marked; the last route in a chain is then skipped by the steps that follow.
export function recordFailure(input: { model: ModelRef; error: Err; swaps: number }): ModelRef | undefined {
  const cfg = config()
  if (!cfg || !qualifies(input.error)) return undefined
  markDegraded(input.model)
  if (input.swaps >= cfg.maxFallbackAttempts) return undefined
  return fallbackFor(input.model)
}

export * as SessionFallback from "./fallback"
