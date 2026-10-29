import type { LlmMessage } from "./llm/adapter.js"
import { InMemoryConfirmationStore } from "./domain/confirmation.js"

export interface TokenUsage {
  input: number
  output: number
  total: number
}

export interface ValidationIssueView {
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
      blockers: ValidationIssueView[]
      confirmations: ValidationIssueView[]
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

export interface MessageEvent {
  type: "message"
  ts: string
  role: "user" | "assistant"
  content: string
}

export type SessionEvent = ToolEvent | MessageEvent

export interface CachedToolResult {
  name: string
  content: string
  isError: boolean
  summary: string
  details: ToolEventDetails
}

export interface Session {
  id: string
  messages: LlmMessage[]
  events: SessionEvent[]
  tokenUsage: TokenUsage
  confirmationStore: InMemoryConfirmationStore
  toolResults: Map<string, CachedToolResult>
  createdAt: string
  updatedAt: string
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly systemPrompt: string

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  getOrCreate(id: string): Session {
    const existing = this.sessions.get(id)
    if (existing !== undefined) return existing
    const now = new Date().toISOString()
    const session: Session = {
      id,
      messages: [{ role: "system", content: this.systemPrompt }],
      events: [],
      tokenUsage: { input: 0, output: 0, total: 0 },
      confirmationStore: new InMemoryConfirmationStore(),
      toolResults: new Map(),
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.set(id, session)
    return session
  }

  async runExclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.locks.set(id, tail)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this.locks.get(id) === tail) this.locks.delete(id)
    }
  }
}
