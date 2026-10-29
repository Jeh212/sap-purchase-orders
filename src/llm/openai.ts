import OpenAI from "openai"
import type { LlmAdapter, LlmMessage, LlmOptions, LlmResponse, LlmTool, LlmToolCall } from "./adapter.js"

type OpenAiClient = Pick<OpenAI, "chat">

export interface OpenAiAdapterOptions {
  apiKey: string
  model: string
  client?: OpenAiClient
}

function toOpenAiMessages(messages: LlmMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((message): OpenAI.ChatCompletionMessageParam => {
    if (message.role === "system" || message.role === "user") {
      return { role: message.role, content: message.content }
    }
    if (message.role === "tool") {
      return { role: "tool", content: message.content, tool_call_id: message.toolCallId }
    }
    return {
      role: "assistant",
      content: message.content.length > 0 ? message.content : null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
      })),
    }
  })
}

function toOpenAiTools(tools: LlmTool[]): OpenAI.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: true,
    },
  }))
}

function providerFailure(error: unknown): LlmResponse {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return { type: "error", error: { code: "timeout", message: "The OpenAI request timed out. Please try again.", retryable: true } }
  }
  if (error instanceof OpenAI.RateLimitError) {
    return { type: "error", error: { code: "rate_limit", message: "OpenAI rate limit reached after retries. Please try again shortly.", retryable: true } }
  }
  if (error instanceof OpenAI.AuthenticationError) {
    return { type: "error", error: { code: "authentication", message: "OpenAI authentication failed. Check the server configuration.", retryable: false } }
  }
  return { type: "error", error: { code: "provider_error", message: "OpenAI could not complete the request.", retryable: true } }
}

export class OpenAiAdapter implements LlmAdapter {
  readonly provider = "openai"
  readonly model: string
  private readonly client: OpenAiClient

  constructor(options: OpenAiAdapterOptions) {
    this.model = options.model
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey, maxRetries: 2 })
  }

  async send(messages: LlmMessage[], tools: LlmTool[], options: LlmOptions): Promise<LlmResponse> {
    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: toOpenAiMessages(messages),
          tools: toOpenAiTools(tools),
          tool_choice: "auto",
          max_tokens: options.maxTokens,
        },
        { timeout: options.timeoutMs },
      )
      const choice = response.choices[0]
      if (choice === undefined) {
        return { type: "error", error: { code: "invalid_response", message: "OpenAI returned no response choice.", retryable: true } }
      }

      const toolCalls: LlmToolCall[] = (choice.message.tool_calls ?? []).flatMap((toolCall) => {
        if (toolCall.type !== "function") return []
        let parsedArguments: unknown
        try {
          parsedArguments = JSON.parse(toolCall.function.arguments) as unknown
        } catch {
          parsedArguments = { invalid_json: toolCall.function.arguments }
        }
        return { id: toolCall.id, name: toolCall.function.name, arguments: parsedArguments }
      })

      return {
        type: "message",
        content: choice.message.content ?? "",
        toolCalls,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
        stopReason: choice.finish_reason === "length"
          ? "max_tokens"
          : toolCalls.length > 0 ? "tool_calls" : "complete",
      }
    } catch (error) {
      return providerFailure(error)
    }
  }
}
