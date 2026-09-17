import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Tool, toolError } from "../src/index.js"

const text = (description: string, value: string) =>
  Tool.make({
    description,
    input: Schema.Struct({ query: Schema.optionalKey(Schema.String) }),
    output: Schema.String,
    run: () => Effect.succeed(value),
  })

const tools = {
  bedrock: {
    registry_find_items: text("Find registry items", "found"),
    generate_image: text("Generate an image", "job"),
    list_sites: text("List sites", "sites"),
    reject: Tool.make({
      description: "Reject a record",
      input: Schema.Struct({}),
      output: Schema.String,
      run: () => Effect.fail(toolError("Field contact_phone must be a valid phone number")),
    }),
  },
}

const execute = (code: string, options: Omit<CodeMode.Options<typeof tools>, "tools"> = {}) =>
  Effect.runPromise(CodeMode.make({ tools, ...options }).execute(code))

// Each of these is a mistake models make daily. The reply has to carry the fix, because every
// extra round trip to discover it costs a full model turn.
describe("CodeMode recoverable mistakes", () => {
  test("an unknown tool names the closest real tool with its signature", async () => {
    const result = await execute(`return await tools.bedrock.find_registry_items({ query: "cro" })`)

    expect(result.ok ? undefined : result.error.kind).toBe("UnknownTool")
    expect(result.ok ? undefined : result.error.suggestions?.[0]).toStartWith(
      "Did you mean: tools.bedrock.registry_find_items(",
    )
  })

  test("a namespace repeated in the name still finds the tool", async () => {
    const result = await execute(`return await tools.bedrock.bedrock_generate_image({ query: "hero" })`)

    expect(result.ok ? undefined : result.error.suggestions?.[0]).toStartWith(
      "Did you mean: tools.bedrock.generate_image(",
    )
  })

  test("a name nothing resembles still points at search", async () => {
    const result = await execute(`return await tools.bedrock.zzz({})`)

    expect(result.ok ? undefined : result.error.suggestions).toStrictEqual([
      "Use tools.$codemode.search({ query }) to find available described tools.",
    ])
  })

  test("the host can claim an unknown name as one of its own tools", async () => {
    const hint = "'set-project-context' is one of your regular tools. Call it directly."
    const result = await execute(`return await tools.bedrock.set_project_context({})`, {
      unknownToolHint: (path) => (path.at(-1) === "set_project_context" ? hint : undefined),
    })

    expect(result.ok ? undefined : result.error.suggestions).toStrictEqual([hint])
  })

  test("a call with no arguments sends an empty input object", async () => {
    const result = await execute(`return await tools.bedrock.list_sites()`)

    expect(result.ok ? result.value : result.error).toBe("sites")
  })

  test("a second argument is still rejected", async () => {
    const result = await execute(`return await tools.bedrock.list_sites({}, {})`)

    expect(result.ok ? undefined : result.error.kind).toBe("InvalidToolInput")
  })

  test("a parse error says where it is", async () => {
    const result = await execute(`const sites = 1\nreturn await tools.bedrock.list_sites({)`)

    expect(result.ok ? undefined : result.error.kind).toBe("ParseError")
    expect(result.ok ? undefined : result.error.message).toMatch(/\(line 2, col \d+\) near: .*list_sites/)
  })

  test("a caught tool failure stringifies to its message", async () => {
    const result = await execute(
      `try { await tools.bedrock.reject({}) } catch (e) { return [String(e), \`failed: \${e}\`, "" + e] }`,
    )

    expect(result.ok ? result.value : result.error).toStrictEqual([
      "Error: Field contact_phone must be a valid phone number",
      "failed: Error: Field contact_phone must be a valid phone number",
      "Error: Field contact_phone must be a valid phone number",
    ])
  })
})
