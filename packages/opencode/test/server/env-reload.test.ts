import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EnvReload } from "../../src/server/env-reload"

function envdir(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "envdir-"))
  for (const [name, value] of Object.entries(files)) writeFileSync(path.join(dir, name), value)
  return dir
}

const saved = { ...process.env }
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
})

describe("EnvReload", () => {
  test("loads files as env vars, stripping the trailing newline", () => {
    const dir = envdir({ FOO_RELOAD: "bar\n" })
    process.env["OPENCODE_RELOAD_ENVDIRS"] = dir
    EnvReload.reload()
    expect(process.env["FOO_RELOAD"]).toBe("bar")
  })

  test("later envdir wins on conflict", () => {
    const a = envdir({ DUP_RELOAD: "first\n" })
    const b = envdir({ DUP_RELOAD: "second\n" })
    process.env["OPENCODE_RELOAD_ENVDIRS"] = [a, b].join(":")
    EnvReload.reload()
    expect(process.env["DUP_RELOAD"]).toBe("second")
  })

  test("empty file unsets the variable", () => {
    process.env["GONE_RELOAD"] = "present"
    const dir = envdir({ GONE_RELOAD: "" })
    process.env["OPENCODE_RELOAD_ENVDIRS"] = dir
    EnvReload.reload()
    expect("GONE_RELOAD" in process.env).toBe(false)
  })

  test("converts NULs to newlines then strips trailing newline (s6 order)", () => {
    const dir = envdir({ NUL_RELOAD: "a\0b\0" })
    process.env["OPENCODE_RELOAD_ENVDIRS"] = dir
    EnvReload.reload()
    expect(process.env["NUL_RELOAD"]).toBe("a\nb")
  })

  test("skips dotfiles and names containing '=', tolerates missing dirs", () => {
    const dir = envdir({ ".hidden": "x\n", "BAD=NAME": "y\n", OK_RELOAD: "z\n" })
    process.env["OPENCODE_RELOAD_ENVDIRS"] = [dir, "/does/not/exist"].join(":")
    const result = EnvReload.reload()
    expect(process.env["OK_RELOAD"]).toBe("z")
    expect(process.env[".hidden"]).toBeUndefined()
    expect(result.applied).toBe(1)
  })
})
