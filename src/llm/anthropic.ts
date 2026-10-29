import Anthropic from "@anthropic-ai/sdk"
import type {
  LlmAdapter,
  LlmMessage,
  LlmOptions,
  LlmResponse,
  LlmTool,
  LlmToolCall,
} from "./adapter.js"

type AnthropicClient = Pick<Anthropic, "messages">

export interface AnthropicAdapterOptions {
  apiKey: string
  model: string
  client?: AnthropicClient
}

function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  const converted: Anthropic.MessageParam[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === undefined || message.role === "system") continue

    if (message.role === "assistant") {
      const content: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = []
      if (message.content.length > 0) content.push({ type: "text", text: message.content })
      for (const toolCall of message.toolCalls) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments,
        })
      }
      converted.push({ role: "assistant", content })
      continue
    }

    if (message.role === "tool") {
      const results: Anthropic.ToolResultBlockParam[] = []
      let cursor = index
      while (cursor < messages.length) {
        const candidate = messages[cursor]
        if (candidate === undefined || candidate.role !== "tool") break
        results.push({
          type: "tool_result",
          tool_use_id: candidate.toolCallId,
          content: candidate.content,
          is_error: candidate.isError,
        })
        cursor += 1
      }
      converted.push({ role: "user", content: results })
      index = cursor - 1
      continue
    }

    converted.push({ role: "user", content: message.content })
  }
  return converted
}

function toAnthropicTools(tools: LlmTool[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: { type: "object", ...tool.inputSchema },
  }))
}

function providerFailure(error: unknown): LlmResponse {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return {
      type: "error",
      error: { code: "timeout", message: "The Anthropic request timed out. Please try again.", retryable: true },
    }
  }
  if (error instanceof Anthropic.RateLimitError) {
    return {
      type: "error",
      error: { code: "rate_limit", message: "Anthropic rate limit reached after retries. Please try again shortly.", retryable: true },
    }
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return {
      type: "error",
      error: { code: "authentication", message: "Anthropic authentication failed. Check the server configuration.", retryable: false },
    }
  }
  return {
    type: "error",
    error: { code: "provider_error", message: "Anthropic could not complete the request.", retryable: true },
  }
}

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic"
  readonly model: string
  private readonly client: AnthropicClient

  constructor(options: AnthropicAdapterOptions) {
    this.model = options.model
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 2 })
  }

  async send(messages: LlmMessage[], tools: LlmTool[], options: LlmOptions): Promise<LlmResponse> {
    try {
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n")
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: options.maxTokens,
          system,
          messages: toAnthropicMessages(messages),
          tools: toAnthropicTools(tools),
        },
        { timeout: options.timeoutMs },
      )

      const toolCalls: LlmToolCall[] = []
      const text: string[] = []
      for (const block of response.content) {
        if (block.type === "text") text.push(block.text)
        if (block.type === "tool_use") {
          toolCalls.push({ id: block.id, name: block.name, arguments: block.input })
        }
      }
      return {
        type: "message",
        content: text.join("\n"),
        toolCalls,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        stopReason: response.stop_reason === "max_tokens"
          ? "max_tokens"
          : toolCalls.length > 0 ? "tool_calls" : "complete",
      }
    } catch (error) {
      return providerFailure(error)
    }
  }
}
