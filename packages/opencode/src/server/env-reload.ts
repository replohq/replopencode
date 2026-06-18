import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const DEFAULT_DIRS = ["/var/s6-env/global", "/var/s6-env/opencode", "/var/s6-env/publish"]

export function dirs(): string[] {
  const override = process.env["OPENCODE_RELOAD_ENVDIRS"]
  return override ? override.split(":").filter(Boolean) : DEFAULT_DIRS
}

/**
 * Re-read s6 envdirs into process.env. An s6 envdir is a directory whose file
 * names are env var names and whose contents are the values (trailing newlines
 * stripped, NULs -> newlines). An empty file unsets the variable. Later dirs in
 * the list override earlier ones, matching the s6-envdir order in the service
 * `run` script.
 */
export function reload(): { applied: number } {
  let applied = 0
  for (const dir of dirs()) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name.startsWith(".") || name.includes("=")) continue
      const file = path.join(dir, name)
      let contents: string
      try {
        if (!statSync(file).isFile()) continue
        contents = readFileSync(file, "utf8")
      } catch {
        continue
      }
      if (contents.length === 0) {
        delete process.env[name]
        applied++
        continue
      }
      process.env[name] = contents.replace(/\n+$/, "").replace(/\0/g, "\n")
      applied++
    }
  }
  return { applied }
}

export * as EnvReload from "./env-reload"
