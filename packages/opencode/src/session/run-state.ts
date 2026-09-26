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
  cancelledMessageIds: Set<MessageID>
}

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly registerPrompt: (input: { sessionId: SessionID; messageId: MessageID }) => Effect.Effect<Prompt>
  readonly finishPrompt: (sessionID: SessionID, ownership: Prompt) => Effect.Effect<void>
  readonly filterMessages: (
    sessionID: SessionID,
    messages: SessionV1.WithParts[],
  ) => Effect.Effect<SessionV1.WithParts[]>
  readonly startStep: (input: {
    sessionId: SessionID
    messageId: MessageID
    messageIds: MessageID[]
  }) => Effect.Effect<boolean>
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
        // Preparing input must not hide prompts already admitted to the runner.
        const queuedPrompts = new Map<SessionID, Map<MessageID, Prompt>>()
        const activePrompts = new Map<
          SessionID,
          {
            messageId?: MessageID
            cancelled: Set<MessageID>
            consumed: Set<MessageID>
            resume: (prompt: Prompt) => Effect.Effect<SessionV1.WithParts>
          }
        >()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
            prompts.clear()
            queuedPrompts.clear()
            activePrompts.clear()
          }),
        )
        return { runners, prompts, queuedPrompts, activePrompts, scope }
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
          if (data.runners.get(sessionID) !== next || next.busy) return
          const active = data.activePrompts.get(sessionID)
          const queued = data.queuedPrompts.get(sessionID)
          for (const id of active?.consumed ?? []) queued?.delete(id)
          if (active?.messageId) queued?.delete(active.messageId)
          const pending = [...(queued?.values() ?? [])].at(-1)
          data.runners.delete(sessionID)
          data.activePrompts.delete(sessionID)
          if (!pending) data.queuedPrompts.delete(sessionID)
          const latest = data.prompts.get(sessionID)
          if (latest?.queued && queued?.get(latest.messageId) !== latest) data.prompts.delete(sessionID)
          // Admission can happen after the final history snapshot but before the runner settles.
          if (active && pending) {
            yield* active.resume(pending).pipe(Effect.forkIn(data.scope))
            yield* status.clearIf(sessionID, () => !data.runners.get(sessionID)?.busy)
            return
          }
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
      for (const queued of data.queuedPrompts.get(sessionID)?.values() ?? []) queued.cancelled = true
      data.queuedPrompts.delete(sessionID)
      data.prompts.delete(sessionID)
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
      const previous = data.prompts.get(input.sessionId)
      if (previous && !previous.queued && previous.messageId !== input.messageId) {
        previous.cancelled = true
        previous.cancelledMessageIds.add(previous.messageId)
      }
      const prompt = {
        messageId: input.messageId,
        cancelled: false,
        queued: false,
        cancelledMessageIds:
          data.activePrompts.get(input.sessionId)?.cancelled ??
          [...(data.queuedPrompts.get(input.sessionId)?.values() ?? [])].at(-1)?.cancelledMessageIds ??
          previous?.cancelledMessageIds ??
          new Set<MessageID>(),
      }
      data.prompts.set(input.sessionId, prompt)
      return prompt
    })

    const finishPrompt = Effect.fn("SessionRunState.finishPrompt")(function* (sessionID: SessionID, ownership: Prompt) {
      const data = yield* InstanceState.get(state)
      if (!ownership.queued && data.prompts.get(sessionID) === ownership) data.prompts.delete(sessionID)
    })

    const filterMessages = Effect.fn("SessionRunState.filterMessages")(function* (
      sessionID: SessionID,
      messages: SessionV1.WithParts[],
    ) {
      const data = yield* InstanceState.get(state)
      const cancelled = data.activePrompts.get(sessionID)?.cancelled
      if (!cancelled?.size) return messages
      // Queued prompts are already persisted; cancellation excludes them only from the current drain.
      return messages.filter(
        (message) => !cancelled.has(message.info.role === "user" ? message.info.id : message.info.parentID),
      )
    })

    const startStep = Effect.fn("SessionRunState.startStep")(function* (input: {
      sessionId: SessionID
      messageId: MessageID
      messageIds: MessageID[]
    }) {
      const data = yield* InstanceState.get(state)
      const active = data.activePrompts.get(input.sessionId)
      if (!active) return true
      // A queued cancellation may invalidate the snapshot before this step takes ownership.
      if (input.messageIds.some((id) => active.cancelled.has(id))) return false
      const queued = data.queuedPrompts.get(input.sessionId)
      for (const id of input.messageIds) {
        if (!queued?.has(id)) continue
        active.consumed.add(id)
        if (id !== input.messageId) queued.delete(id)
      }
      if (active.messageId && active.messageId !== input.messageId) queued?.delete(active.messageId)
      if (!queued?.size) data.queuedPrompts.delete(input.sessionId)
      const latest = data.prompts.get(input.sessionId)
      if (latest?.queued && queued?.get(latest.messageId) !== latest) data.prompts.delete(input.sessionId)
      active.messageId = input.messageId
      return true
    })

    const cancelPrompt = Effect.fn("SessionRunState.cancelPrompt")(function* (input: {
      sessionId: SessionID
      messageId: MessageID
    }) {
      const data = yield* InstanceState.get(state)
      const active = data.runners.get(input.sessionId)
      const interrupted = data.activePrompts.get(input.sessionId)
      let claimed = false
      const claim = () => {
        if (data.runners.get(input.sessionId) !== active) return false
        if (data.activePrompts.get(input.sessionId) !== interrupted) return false
        const running = active?.state._tag === "Running" && interrupted?.messageId === input.messageId
        const queued = data.queuedPrompts.get(input.sessionId)
        const prompt = queued?.get(input.messageId) ?? data.prompts.get(input.sessionId)
        if (prompt?.messageId === input.messageId && !prompt.cancelled) {
          prompt.cancelled = true
          claimed = true
          if (!running) prompt.cancelledMessageIds.add(input.messageId)
          queued?.delete(input.messageId)
          if (!queued?.size) data.queuedPrompts.delete(input.sessionId)
          if (data.prompts.get(input.sessionId) === prompt) data.prompts.delete(input.sessionId)
        }
        return running && claimed
      }
      // Preparation and queued prompts can be cancelled without interrupting another prompt or a shell.
      const stopped = active ? yield* active.cancelIf(claim, { notifyIdle: false }) : claim()
      if (stopped) {
        const resume = [...(data.queuedPrompts.get(input.sessionId)?.values() ?? [])].at(-1)
        if (data.runners.get(input.sessionId) === active && !active?.busy) {
          data.runners.delete(input.sessionId)
          data.activePrompts.delete(input.sessionId)
          if (!resume) data.queuedPrompts.delete(input.sessionId)
        }
        if (interrupted && resume) yield* interrupted.resume(resume).pipe(Effect.forkIn(data.scope))
        yield* status.clearIf(input.sessionId, () => !data.runners.get(input.sessionId)?.busy)
      }
      return stopped || claimed
    })

    const ensureRunning: Interface["ensureRunning"] = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ownership?: Prompt,
    ) {
      const data = yield* InstanceState.get(state)
      const active = yield* runner(sessionID, onInterrupt)
      let admitted = false
      const guarded = Effect.suspend(() => {
        if (ownership?.cancelled) {
          if (!data.queuedPrompts.get(sessionID)?.size) return onInterrupt
        }
        return work
      })
      return yield* active
        .ensureRunning(guarded, () => {
          const current = ownership?.queued
            ? [...(data.queuedPrompts.get(sessionID)?.values() ?? [])].at(-1)
            : data.prompts.get(sessionID)
          if (ownership?.cancelled || (ownership && current !== ownership)) return false
          admitted = true
          if (ownership) {
            ownership.queued = true
            ownership.cancelledMessageIds =
              data.activePrompts.get(sessionID)?.cancelled ?? ownership.cancelledMessageIds
            const queued = data.queuedPrompts.get(sessionID) ?? new Map<MessageID, Prompt>()
            queued.set(ownership.messageId, ownership)
            data.queuedPrompts.set(sessionID, queued)
          }
          if (!active.busy || active.state._tag === "Shell") {
            data.activePrompts.set(sessionID, {
              messageId: ownership?.messageId,
              cancelled: ownership?.cancelledMessageIds ?? new Set(),
              consumed: new Set(),
              resume: (next) => ensureRunning(sessionID, onInterrupt, work, next),
            })
          }
          return true
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (admitted || data.runners.get(sessionID) !== active || active.busy) return
              data.runners.delete(sessionID)
              data.activePrompts.delete(sessionID)
            }),
          ),
        )
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

    return Service.of({
      assertNotBusy,
      cancel,
      registerPrompt,
      finishPrompt,
      filterMessages,
      startStep,
      cancelPrompt,
      ensureRunning,
      startShell,
    })
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
