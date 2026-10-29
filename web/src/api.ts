import type { ChatResponse, SessionHistory } from "./types"

const REQUEST_TIMEOUT_MS = 45_000

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

function errorMessage(value: unknown, fallback: string): string {
  if (value !== null && typeof value === "object" && "error" in value) {
    const error = value.error
    if (typeof error === "string" && error.length > 0) return error
  }
  return fallback
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const body = await response.json().catch((): unknown => null)
    if (!response.ok) {
      throw new ApiError(
        errorMessage(body, `Request failed with status ${response.status}.`),
        response.status,
      )
    }
    return body as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError("The request timed out. The session is still available; you can retry safely.")
    }
    throw new ApiError("Unable to reach the agent service. Check the connection and try again.")
  } finally {
    window.clearTimeout(timeout)
  }
}

export function createSessionId(): string {
  return `session-${crypto.randomUUID()}`
}

export function postChat(
  sessionId: string | null,
  message: string,
  confirm = false,
): Promise<ChatResponse> {
  return requestJson<ChatResponse>("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: sessionId ?? createSessionId(),
      message,
      confirm,
    }),
  })
}

export function getSession(id: string): Promise<SessionHistory> {
  return requestJson<SessionHistory>(`/api/sessions/${encodeURIComponent(id)}`)
}
