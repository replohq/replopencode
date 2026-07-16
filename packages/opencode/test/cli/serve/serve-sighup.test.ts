// SIGHUP lifecycle of `opencode serve` (REPL-29403): ignored while booting, reloads in place once listening.
// Raw Bun.spawn (not cli-process's serve()) because the storm must land BEFORE the ready line; the guard's stderr lines are the sync points.
import { describe, test, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "../../lib/cli-process"

const opencodeRoot = path.resolve(import.meta.dir, "../../../")
const cliEntry = path.join(opencodeRoot, "src/index.ts")

async function spawnServe(extraArgs: string[] = []) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "oc-sighup-"))
  return Bun.spawn(["bun", "run", "--conditions=browser", cliEntry, "serve", "--port", "0", ...extraArgs], {
    cwd: home,
    env: { ...process.env, ...isolatedEnv(home, "{}") },
    stdout: "pipe",
    stderr: "pipe",
  })
}

// Drains a stream into a mutable buffer that waitFor() can poll.
function collect(stream: ReadableStream<Uint8Array>): { text: string } {
  const buf = { text: "" }
  void (async () => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf.text += decoder.decode(value, { stream: true })
      }
    } catch {
      // Child closing the pipe at kill time is normal.
    }
  })()
  return buf
}

async function waitFor(buf: { text: string }, re: RegExp, timeoutMs: number, label: string): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const m = buf.text.match(re)
    if (m) return m
    await Bun.sleep(25)
  }
  throw new Error(
    `timed out (${timeoutMs}ms) waiting for ${label} (${re})\n--- buffer tail ---\n${buf.text.slice(-2000)}`,
  )
}

const LISTENING_RE = /listening on (http:\/\/[^\s]+)/

describe("opencode serve SIGHUP lifecycle (subprocess)", () => {
  // The prod failure mode: a SIGHUP burst mid-boot killed the process (no handler yet → default disposition).
  test("survives a SIGHUP storm that lands mid-boot", async () => {
    const proc = await spawnServe()
    const stdout = collect(proc.stdout)
    const stderr = collect(proc.stderr)

    let storm: ReturnType<typeof setInterval> | undefined
    try {
      // Signals sent before the entry module evaluates hit the default disposition even with the guard.
      await waitFor(stderr, /\[sighup-guard\] armed/, 30_000, "guard armed line")
      storm = setInterval(() => proc.kill("SIGHUP"), 50)

      const m = await waitFor(stdout, LISTENING_RE, 30_000, "listening line")
      clearInterval(storm)
      storm = undefined

      // At least one HUP must have been swallowed pre-listen, or this run proved nothing.
      await waitFor(stderr, /\[sighup-guard\] ignoring SIGHUP/, 5_000, "ignored-SIGHUP line")
      const res = await fetch(`${m[1]}/global/health`)
      expect(res.status).toBe(200)
    } finally {
      if (storm) clearInterval(storm)
      proc.kill()
      await proc.exited
    }
  }, 60_000)

  // Guards the handover: post-listen SIGHUP must still trigger the in-place env + harness reload.
  test("SIGHUP after listening still reloads env + harness in place", async () => {
    const proc = await spawnServe()
    const stdout = collect(proc.stdout)
    const stderr = collect(proc.stderr)

    try {
      const m = await waitFor(stdout, LISTENING_RE, 30_000, "listening line")
      // "released" prints after the real handler is on, removing the listen→handover race.
      await waitFor(stderr, /\[sighup-guard\] released/, 10_000, "guard released line")

      proc.kill("SIGHUP")
      // HarnessReload logs through the default Effect logger, which writes to stdout.
      await waitFor(stdout, /harness reload/, 15_000, "harness reload log")
      const res = await fetch(`${m[1]}/global/health`)
      expect(res.status).toBe(200)
    } finally {
      proc.kill()
      await proc.exited
    }
  }, 60_000)
})
