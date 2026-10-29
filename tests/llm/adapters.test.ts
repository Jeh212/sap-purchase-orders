import { describe, expect, it, vi } from "vitest"
import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { AnthropicAdapter } from "../../src/llm/anthropic.js"
import { OpenAiAdapter } from "../../src/llm/openai.js"
import type { LlmMessage, LlmTool } from "../../src/llm/adapter.js"

const messages: LlmMessage[] = [
  { role: "system", content: "Use tools." },
  { role: "user", content: "Run the probe." },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-123", name: "probe", arguments: { value: "ok" } }],
  },
  {
    role: "tool",
    content: '{"ok":true}',
    toolCallId: "call-123",
    name: "probe",
    isError: false,
  },
]

const tools: LlmTool[] = [
  {
    name: "probe",
    description: "Returns the supplied value.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
]

describe("official SDK provider adapters", () => {
  it("Anthropic maps assistant tool_use and correlated user tool_result blocks", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 12, output_tokens: 3 },
      stop_reason: "end_turn",
    })
    const client = { messages: { create } } as unknown as Pick<Anthropic, "messages">
    const adapter = new AnthropicAdapter({ apiKey: "test-only", model: "test-model", client })
    const result = await adapter.send(messages, tools, { maxTokens: 200, timeoutMs: 1_000 })
    expect(result.type).toBe("message")
    const body = create.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(body.messages[1]).toMatchObject({
      role: "assistant",
      content: [expect.objectContaining({ type: "tool_use", id: "call-123" })],
    })
    expect(body.messages[2]).toMatchObject({
      role: "user",
      content: [expect.objectContaining({ type: "tool_result", tool_use_id: "call-123" })],
    })
  })

  it("OpenAI maps assistant tool_calls and correlated tool messages", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "done", tool_calls: [] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    })
    const client = {
      chat: { completions: { create } },
    } as unknown as Pick<OpenAI, "chat">
    const adapter = new OpenAiAdapter({ apiKey: "test-only", model: "test-model", client })
    const result = await adapter.send(messages, tools, { maxTokens: 200, timeoutMs: 1_000 })
    expect(result.type).toBe("message")
    const body = create.mock.calls[0]?.[0] as {
      messages: Array<Record<string, unknown>>
    }
    expect(body.messages[2]).toMatchObject({
      role: "assistant",
      tool_calls: [expect.objectContaining({ id: "call-123" })],
    })
    expect(body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "call-123" })
  })
})
