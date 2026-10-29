import { describe, expect, it } from "vitest"
import { createLlmAdapterFromEnv } from "../../src/llm/factory.js"
import type { LlmMessage, LlmTool } from "../../src/llm/adapter.js"

const liveEnabled = process.env["RUN_LIVE_LLM_TESTS"] === "true"

describe.skipIf(!liveEnabled)("live provider smoke test", () => {
  it("performs and correlates a real provider tool call", async () => {
    const adapter = createLlmAdapterFromEnv(process.env)
    const tool: LlmTool = {
      name: "probe",
      description: "Return a supplied string for a connectivity smoke test.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string", enum: ["live-ok"] } },
        required: ["value"],
        additionalProperties: false,
      },
    }
    const initial: LlmMessage[] = [
      { role: "system", content: "You are a tool-calling smoke test. Always call the requested tool." },
      { role: "user", content: "Call probe exactly once with value live-ok." },
    ]
    const started = Date.now()
    const first = await adapter.send(initial, [tool], { maxTokens: 256, timeoutMs: 30_000 })
    expect(first.type).toBe("message")
    if (first.type !== "message") return
    expect(first.toolCalls).toHaveLength(1)
    expect(first.toolCalls[0]?.name).toBe("probe")

    const call = first.toolCalls[0]
    if (call === undefined) throw new Error("provider did not return a tool call")
    const followup: LlmMessage[] = [
      ...initial,
      { role: "assistant", content: first.content, toolCalls: first.toolCalls },
      { role: "tool", content: '{"ok":true,"data":{"value":"live-ok"}}', toolCallId: call.id, name: call.name, isError: false },
    ]
    const second = await adapter.send(followup, [tool], { maxTokens: 256, timeoutMs: 30_000 })
    expect(second.type).toBe("message")
    if (second.type !== "message") return
    expect(second.content.length).toBeGreaterThan(0)
    const elapsedMs = Date.now() - started
    process.stdout.write(
      `[live-llm] provider=${adapter.provider} model=${adapter.model} input_tokens=${first.usage.inputTokens + second.usage.inputTokens} output_tokens=${first.usage.outputTokens + second.usage.outputTokens} latency_ms=${elapsedMs}\n`,
    )
  }, 70_000)
})
