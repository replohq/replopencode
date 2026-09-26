import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import { Session } from "./session"
import { MessageID, SessionID } from "./schema"
import { SessionStatus } from "./status"

interface Prompt {
  messageId: MessageID
  cancelled: boolean
  queued: boolean
}

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly registerPrompt: (input: { sessionId: SessionID; messageId: MessageID }) => Effect.Effect<Prompt>
  readonly startStep: (input: { sessionId: SessionID; messageId: MessageID }) => Effect.Effect<void>
  readonly cancelPrompt: (input: { sessionId: SessionID; messageId: MessageID }) => Effect.Effect<boolean>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ownership?: Prompt,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()
        const prompts = new Map<SessionID, Prompt>()
        const activePrompts = new Map<
          SessionID,
          { messageId: MessageID; resume: (prompt: Prompt) => Effect.Effect<SessionV1.WithParts> }
        >()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, prompts, activePrompts, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<SessionV1.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          data.activePrompts.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const prompt = data.prompts.get(sessionID)
      if (prompt) prompt.cancelled = true
      yield* cancelBackgroundJobs(background, sessionID)
      const existing = data.runners.get(sessionID)
      if (!existing) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.cancel
    })

    const registerPrompt = Effect.fn("SessionRunState.registerPrompt")(function* (input: {
      sessionId: SessionID
      messageId: MessageID
    }) {
      const data = yield* InstanceState.get(state)
      const prompt = { messageId: input.messageId, cancelled: false, queued: false }
      data.prompts.set(input.sessionId, prompt)
      return prompt
    })

    const startStep = Effect.fn("SessionRunState.startStep")(function* (input: {
      sessionId: SessionID
      messageId: MessageID
    }) {
      const data = yield* InstanceState.get(state)
      const active = data.activePrompts.get(input.sessionId)
      if (active) active.messageId = input.messageId
    })

    const cancelPrompt = Effect.fn("SessionRunState.cancelPrompt")(function* (input: {
      sessionId: SessionID
      messageId: MessageID
    }) {
      const data = yield* InstanceState.get(state)
      const active = data.runners.get(input.sessionId)
      const interrupted = data.activePrompts.get(input.sessionId)
      const claim = () => {
        if (data.runners.get(input.sessionId) !== active) return false
        if (data.activePrompts.get(input.sessionId) !== interrupted) return false
        const prompt = data.prompts.get(input.sessionId)
        if (prompt?.messageId === input.messageId && !prompt.cancelled) {
          prompt.cancelled = true
          return true
        }
        return active?.busy === true && interrupted?.messageId === input.messageId
      }
      // The runner checks ownership while detaching the exact fiber it will interrupt.
      const cancelled = active ? yield* active.cancelIf(claim, { notifyIdle: false }) : claim()
      if (cancelled) {
        const next = data.prompts.get(input.sessionId)
        if (interrupted && next && next.messageId !== input.messageId && next.queued && !next.cancelled) {
          // A newer prompt can be queued inside the interrupted loop and needs a fresh drain.
          yield* interrupted.resume(next).pipe(Effect.forkIn(data.scope))
        }
        yield* status.clearIf(input.sessionId, () => {
          const current = data.prompts.get(input.sessionId)
          return current?.messageId === input.messageId && current.cancelled && !data.runners.get(input.sessionId)?.busy
        })
      }
      return cancelled
    })

    const ensureRunning: Interface["ensureRunning"] = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ownership?: Prompt,
    ) {
      const data = yield* InstanceState.get(state)
      const active = yield* runner(sessionID, onInterrupt)
      return yield* active.ensureRunning(work, () => {
        const prompt = ownership ?? data.prompts.get(sessionID)
        if (prompt?.cancelled || (ownership && data.prompts.get(sessionID) !== ownership)) return false
        if (prompt) prompt.queued = true
        if ((!active.busy || active.state._tag === "Shell") && prompt) {
          data.activePrompts.set(sessionID, {
            messageId: prompt.messageId,
            resume: (next) => ensureRunning(sessionID, onInterrupt, work, next),
          })
        }
        return true
      })
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt))
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    return Service.of({ assertNotBusy, cancel, registerPrompt, startStep, cancelPrompt, ensureRunning, startShell })
  }),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [BackgroundJob.node, SessionStatus.node] })

export * as SessionRunState from "./run-state"
