import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Schema } from "effect"
import { SessionFallback } from "../../src/session/fallback"

const cfg: SessionFallback.Config = {
  fallbackModelsByModel: {
    "openrouter/anthropic/claude-sonnet-5": "anthropic/claude-sonnet-5",
    "anthropic/claude-sonnet-5": "openrouter/anthropic/claude-sonnet-5",
  },
  fallbackOnErrors: [429, 503],
  maxFallbackAttempts: 1,
  maxUpstreamRetryAttempts: 1,
  cooldownSeconds: 60,
}
const openrouter = { providerID: "openrouter", modelID: "anthropic/claude-sonnet-5" }
const anthropic = { providerID: "anthropic", modelID: "claude-sonnet-5" }

function apiError(statusCode?: number, isRetryable = true) {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({ message: "boom", isRetryable, statusCode }).toObject(),
  )
}

function clean() {
  delete process.env[SessionFallback.ENV_VAR]
  SessionFallback.reset()
}
beforeEach(clean)
afterEach(clean)

describe("session.fallback config", () => {
  test("reads the coordinator env var once", () => {
    process.env[SessionFallback.ENV_VAR] = JSON.stringify(cfg)
    expect(SessionFallback.config()).toEqual(cfg)
    delete process.env[SessionFallback.ENV_VAR]
    expect(SessionFallback.config()).toEqual(cfg)
  })

  test("ignores a malformed env var", () => {
    process.env[SessionFallback.ENV_VAR] = '{"fallbackOnErrors": "nope"}'
    expect(SessionFallback.config()).toBeNull()
    process.env[SessionFallback.ENV_VAR] = "not json"
    SessionFallback.reset()
    expect(SessionFallback.config()).toBeNull()
  })

  test("rejects negative or fractional limits", () => {
    process.env[SessionFallback.ENV_VAR] = JSON.stringify({ ...cfg, cooldownSeconds: -1 })
    expect(SessionFallback.config()).toBeNull()
    SessionFallback.reset()
    process.env[SessionFallback.ENV_VAR] = JSON.stringify({ ...cfg, maxFallbackAttempts: 1.5 })
    expect(SessionFallback.config()).toBeNull()
  })

  test("does nothing without config", () => {
    expect(SessionFallback.failed({ model: openrouter, error: apiError(503), swaps: 0 })).toBeUndefined()
    expect(SessionFallback.healthy(openrouter)).toEqual(openrouter)
  })
})

describe("session.fallback failed", () => {
  test("switches on listed statuses and on retryable transport errors", () => {
    SessionFallback.configure(cfg)
    expect(SessionFallback.failed({ model: openrouter, error: apiError(503), swaps: 0 })).toEqual(anthropic)
    expect(SessionFallback.failed({ model: openrouter, error: apiError(402), swaps: 0 })).toEqual(anthropic)
    expect(SessionFallback.failed({ model: openrouter, error: apiError(), swaps: 0 })).toEqual(anthropic)
    expect(SessionFallback.failed({ model: anthropic, error: apiError(429), swaps: 0 })).toEqual(openrouter)
  })

  test("stays put on client errors, non-retryable statusless errors, context overflow, and unmapped models", () => {
    SessionFallback.configure(cfg)
    expect(SessionFallback.failed({ model: openrouter, error: apiError(400), swaps: 0 })).toBeUndefined()
    expect(SessionFallback.failed({ model: openrouter, error: apiError(undefined, false), swaps: 0 })).toBeUndefined()
    const overflow = new SessionV1.ContextOverflowError({ message: "too long" }).toObject()
    expect(SessionFallback.failed({ model: openrouter, error: overflow, swaps: 0 })).toBeUndefined()
    const unmapped = { providerID: "openrouter", modelID: "openai/gpt-5.6" }
    expect(SessionFallback.failed({ model: unmapped, error: apiError(503), swaps: 0 })).toBeUndefined()
    expect(SessionFallback.isDegraded(openrouter)).toBe(false)
  })

  test("caps swaps per step but still records the failed route", () => {
    SessionFallback.configure(cfg)
    expect(SessionFallback.failed({ model: anthropic, error: apiError(503), swaps: 1 })).toBeUndefined()
    expect(SessionFallback.isDegraded(anthropic)).toBe(true)
  })
})

describe("session.fallback healthy", () => {
  test("routes later steps around a degraded provider until the cooldown ends", () => {
    SessionFallback.configure(cfg)
    const now = 1_000_000
    SessionFallback.markDegraded(openrouter, now)
    expect(SessionFallback.healthy(openrouter, now)).toEqual(anthropic)
    expect(SessionFallback.healthy(openrouter, now + 61_000)).toEqual(openrouter)
  })

  test("keeps the requested model when every route in the cycle is degraded", () => {
    SessionFallback.configure(cfg)
    SessionFallback.markDegraded(openrouter)
    SessionFallback.markDegraded(anthropic)
    expect(SessionFallback.healthy(openrouter)).toEqual(openrouter)
  })

  test("walks a chain of models on one provider", () => {
    const claude = { providerID: "openrouter", modelID: "anthropic/claude-sonnet-5" }
    const gpt = { providerID: "openrouter", modelID: "openai/gpt-5.4" }
    const gemini = { providerID: "openrouter", modelID: "google/gemini-3.1-pro-preview" }
    SessionFallback.configure({
      ...cfg,
      fallbackModelsByModel: {
        [SessionFallback.key(claude)]: SessionFallback.key(gpt),
        [SessionFallback.key(gpt)]: SessionFallback.key(gemini),
      },
    })
    SessionFallback.markDegraded(claude)
    expect(SessionFallback.healthy(claude)).toEqual(gpt)
    SessionFallback.markDegraded(gpt)
    expect(SessionFallback.healthy(claude)).toEqual(gemini)
  })
})
