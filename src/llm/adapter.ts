export interface LlmToolCall {
  id: string
  name: string
  arguments: unknown
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: LlmToolCall[] }
  | {
      role: "tool"
      content: string
      toolCallId: string
      name: string
      isError: boolean
    }

export interface LlmTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface LlmOptions {
  maxTokens: number
  timeoutMs: number
}

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
}

export type LlmErrorCode =
  | "timeout"
  | "rate_limit"
  | "authentication"
  | "invalid_response"
  | "provider_error"

export interface LlmProviderError {
  code: LlmErrorCode
  message: string
  retryable: boolean
}

export type LlmResponse =
  | {
      type: "message"
      content: string
      toolCalls: LlmToolCall[]
      usage: LlmUsage
      stopReason: "complete" | "tool_calls" | "max_tokens"
    }
  | { type: "error"; error: LlmProviderError }

export interface LlmAdapter {
  readonly provider: string
  readonly model: string

  /**
   * Send a message sequence with available tools to the model.
   * Never throws — provider failures are returned as structured errors without
   * credentials or raw provider response bodies.
   */
  send(
    messages: LlmMessage[],
    tools: LlmTool[],
    options: LlmOptions,
  ): Promise<LlmResponse>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
