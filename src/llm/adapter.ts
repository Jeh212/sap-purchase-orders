// Provider-neutral LLM adapter. Switching providers must not touch the agent loop.

export type LlmMessageRole = "system" | "user" | "assistant"

export type LlmMessagePart =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }

export interface LlmMessage {
  role: LlmMessageRole
  content: string | LlmMessagePart[]
}

export interface LlmTool {
  name: string
  description: string
  /** JSON Schema object for the tool's input parameters. */
  inputSchema: Record<string, unknown>
}

export interface LlmToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface LlmOptions {
  maxTokens: number
  timeout: number
}

export interface LlmResponse {
  type: "text" | "tool_calls"
  content?: string
  toolCalls?: LlmToolCall[]
  /** Approximate token usage for session budget tracking. */
  usage?: { input: number; output: number }
}

export interface LlmAdapter {
  readonly provider: string
  readonly model: string

  /**
   * Send a message sequence with available tools to the model.
   * Never throws — errors are returned as LlmResponse with type 'text' and
   * an error message in content.
   */
  send(
    messages: LlmMessage[],
    tools: LlmTool[],
    options: LlmOptions,
  ): Promise<LlmResponse>
}
