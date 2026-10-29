export interface ValidationIssue {
  code: string
  message: string
  values?: Record<string, unknown>
}

export type ToolEventDetails =
  | { kind: "package"; requestId: string | null }
  | {
      kind: "validation"
      caseId: string | null
      eligible: boolean
      blockers: ValidationIssue[]
      confirmations: ValidationIssue[]
      derived: Record<string, unknown>
      retroactive: boolean
    }
  | { kind: "evidence"; path: string | null; sha256: string | null }
  | {
      kind: "payload"
      caseId: string | null
      requestId: string | null
      traceabilityPath: string | null
    }
  | {
      kind: "creation"
      poNumber: string
      date: string | null
      idempotent: boolean
    }
  | { kind: "error"; message: string }
  | { kind: "completed" }

export interface MessageEvent {
  type: "message"
  ts: string
  role: "user" | "assistant"
  content: string
}

export interface ToolEvent {
  type: "tool"
  ts: string
  callId: string
  name: string
  arguments: Record<string, unknown>
  resultSummary: string
  isError: boolean
  cached: boolean
  details: ToolEventDetails
}

export type SessionEvent = MessageEvent | ToolEvent

export interface PendingConfirmation {
  requestId: string
  codes: string[]
  confirmations: ValidationIssue[]
}

export interface TokenUsage {
  input: number
  output: number
  total: number
}

export interface ChatResponse {
  sessionId: string
  reply: string
  toolCalls: Omit<ToolEvent, "type" | "ts">[]
  needsConfirmation: boolean
  pendingConfirmation: PendingConfirmation | null
  tokenUsage: TokenUsage
}

export interface SessionHistory {
  id: string
  history: SessionEvent[]
  tokenUsage: TokenUsage
  pendingConfirmation: PendingConfirmation | null
  createdAt: string
  updatedAt: string
}
