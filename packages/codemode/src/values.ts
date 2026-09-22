import type { Effect, Fiber } from "effect"

export class SandboxPromise {
  interrupted = false
  constructor(
    readonly fiber: Fiber.Fiber<unknown, unknown> | undefined,
    readonly immediate?: Effect.Effect<unknown, unknown>,
  ) {}
}

export class SandboxDate {
  constructor(readonly time: number) {}
}

export class SandboxRegExp {
  readonly regex: RegExp
  constructor(pattern: string, flags: string) {
    this.regex = new RegExp(pattern, flags)
  }
}

export class SandboxMap {
  readonly map = new Map<unknown, unknown>()
}

export class SandboxSet {
  readonly set = new Set<unknown>()
}

export class SandboxURLSearchParams {
  constructor(readonly params: URLSearchParams) {}
}

export class SandboxURL {
  readonly searchParams: SandboxURLSearchParams
  constructor(readonly url: URL) {
    this.searchParams = new SandboxURLSearchParams(url.searchParams)
  }
}

export const isSandboxValue = (
  value: unknown,
): value is SandboxDate | SandboxRegExp | SandboxMap | SandboxSet | SandboxURL | SandboxURLSearchParams =>
  value instanceof SandboxDate ||
  value instanceof SandboxRegExp ||
  value instanceof SandboxMap ||
  value instanceof SandboxSet ||
  value instanceof SandboxURL ||
  value instanceof SandboxURLSearchParams

const ErrorBrand: unique symbol = Symbol("codemode.error")

export const createErrorValue = (name: string, message: string): Record<string, unknown> => {
  const value = Object.assign(Object.create(null) as Record<string, unknown>, { name, message })
  Object.defineProperty(value, ErrorBrand, { value: name })
  return value
}

export const errorBrandName = (value: unknown): string | undefined =>
  value !== null && typeof value === "object"
    ? ((value as Record<PropertyKey, unknown>)[ErrorBrand] as string | undefined)
    : undefined
