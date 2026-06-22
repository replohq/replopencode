import { expect, test, afterEach } from "bun:test"
import { Flag } from "../src/flag/flag"

const saved = process.env["OPENCODE_CONFIG_CONTENT"]
afterEach(() => {
  if (saved === undefined) delete process.env["OPENCODE_CONFIG_CONTENT"]
  else process.env["OPENCODE_CONFIG_CONTENT"] = saved
})

test("OPENCODE_CONFIG_CONTENT reflects runtime process.env changes", () => {
  process.env["OPENCODE_CONFIG_CONTENT"] = '{"a":1}'
  expect(Flag.OPENCODE_CONFIG_CONTENT).toBe('{"a":1}')
  process.env["OPENCODE_CONFIG_CONTENT"] = '{"a":2}'
  expect(Flag.OPENCODE_CONFIG_CONTENT).toBe('{"a":2}')
})
