// SIGHUP kills `serve` until the reload handler installs post-listen (REPL-29403); ignore it while booting.
const ignore = () => {
  console.error("[sighup-guard] ignoring SIGHUP: serve is still booting, reload handler not yet installed")
}

// Arms at import time — index.ts's first import — so the whole module graph is covered; argv[2] is the subcommand for both `bun entry.ts serve` and the compiled binary.
if (process.argv[2] === "serve") {
  process.on("SIGHUP", ignore)
  console.error("[sighup-guard] armed: SIGHUP is ignored until the server is listening")
}

// Swaps in the real handler with no unguarded window: on-before-off, one synchronous step.
export function handover(handler: () => void) {
  process.on("SIGHUP", handler)
  process.off("SIGHUP", ignore)
  console.error("[sighup-guard] released: SIGHUP now reloads env + harness in place")
}

export * as SighupBootGuard from "./sighup-boot-guard"
