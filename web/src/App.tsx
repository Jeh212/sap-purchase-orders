import { FormEvent, useEffect, useRef, useState } from "react"
import { ApiError, createSessionId, getSession, postChat } from "./api"
import { ChatWindow } from "./components/ChatWindow"
import type {
  ChatResponse,
  PendingConfirmation,
  SessionEvent,
  SessionHistory,
} from "./types"

const SESSION_KEY = "sap-po-agent-session"
const EXAMPLES = ["req-001", "req-002", "req-004", "req-005", "req-006"]

function storedSessionId(): string | null {
  try {
    return window.localStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

function saveSessionId(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(SESSION_KEY)
    else window.localStorage.setItem(SESSION_KEY, id)
  } catch {
    // The app remains usable when browser storage is unavailable.
  }
}

function fallbackEvents(response: ChatResponse): SessionEvent[] {
  const now = new Date().toISOString()
  return [
    ...response.toolCalls.map((call): SessionEvent => ({ type: "tool", ts: now, ...call })),
    { type: "message", ts: now, role: "assistant", content: response.reply },
  ]
}

function friendlyError(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return "An unexpected interface error occurred. Your backend session was not changed."
}

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(storedSessionId)
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [pending, setPending] = useState<PendingConfirmation | null>(null)
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState(sessionId !== null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const initialSessionId = useRef(sessionId)
  const conversationEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = initialSessionId.current
    if (id === null) {
      setRestoring(false)
      return
    }
    let active = true
    getSession(id)
      .then((session) => {
        if (!active) return
        setEvents(session.history)
        setPending(session.pendingConfirmation)
      })
      .catch((sessionError: unknown) => {
        if (!active) return
        if (sessionError instanceof ApiError && sessionError.status === 404) {
          saveSessionId(null)
          setSessionId(null)
          setEvents([])
          setPending(null)
          setError("The previous session is no longer available. A fresh session will start with your next message.")
          return
        }
        setError(friendlyError(sessionError))
      })
      .finally(() => {
        if (active) setRestoring(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [events, pending, loading])

  async function hydrate(id: string): Promise<SessionHistory | null> {
    try {
      return await getSession(id)
    } catch {
      return null
    }
  }

  async function send(content: string, confirm: boolean): Promise<void> {
    if (inFlight.current) return
    const trimmed = content.trim()
    if (!confirm && trimmed.length === 0) return

    inFlight.current = true
    setLoading(true)
    setError(null)
    const activeSessionId = sessionId ?? createSessionId()
    if (sessionId === null) {
      setSessionId(activeSessionId)
      saveSessionId(activeSessionId)
    }

    if (!confirm) {
      setEvents((current) => [...current, {
        type: "message",
        ts: new Date().toISOString(),
        role: "user",
        content: trimmed,
      }])
      setMessage("")
    }

    try {
      const response = await postChat(activeSessionId, trimmed, confirm)
      if (response.sessionId !== activeSessionId) {
        saveSessionId(response.sessionId)
        setSessionId(response.sessionId)
      }
      setPending(response.pendingConfirmation)
      const session = await hydrate(response.sessionId)
      if (session !== null) {
        setEvents(session.history)
        setPending(session.pendingConfirmation)
      } else {
        setEvents((current) => [...current, ...fallbackEvents(response)])
      }
    } catch (sendError) {
      setError(friendlyError(sendError))
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void send(message, false)
  }

  function confirm(): void {
    void send("", true)
  }

  function newSession(): void {
    if (inFlight.current) return
    saveSessionId(null)
    setSessionId(null)
    setEvents([])
    setPending(null)
    setError(null)
    setMessage("")
  }

  const busy = loading || restoring

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">P</span>
          <div>
            <strong>Periferia Purchase Desk</strong>
            <span>SAP purchase order agent</span>
          </div>
        </div>
        <div className="session-controls">
          <span className="system-status"><i aria-hidden="true" /> Controls active</span>
          <button type="button" onClick={newSession} disabled={busy}>New session</button>
        </div>
      </header>

      <main className="workspace">
        <aside className="context-panel">
          <span className="eyebrow">Controlled workflow</span>
          <h1>Purchase orders, with every decision visible.</h1>
          <p>
            Business controls and SAP creation run on the backend. The interface reports what happened;
            it never validates or authorizes an order itself.
          </p>
          <div className="workflow-list" aria-label="Agent workflow">
            {["Read package", "Validate RC1–RC10", "Build evidence and payload", "Create in simulated SAP"].map((step, index) => (
              <div key={step}><span>{index + 1}</span>{step}</div>
            ))}
          </div>
          {sessionId !== null && (
            <div className="session-id">
              <span>Current session</span>
              <code>{sessionId.slice(0, 24)}…</code>
            </div>
          )}
        </aside>

        <section className="chat-panel" aria-label="Purchase order conversation">
          <div className="chat-heading">
            <div>
              <span className="eyebrow">Live agent workspace</span>
              <h2>Conversation</h2>
            </div>
            <span className="history-label">History saved in this browser session</span>
          </div>

          {error !== null && (
            <div className="error-banner" role="alert">
              <strong>Something needs attention</strong>
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button>
            </div>
          )}

          {restoring ? (
            <div className="restore-state" role="status">Restoring the conversation and confirmation state…</div>
          ) : (
            <ChatWindow events={events} pending={pending} loading={loading} onConfirm={confirm} />
          )}
          <div ref={conversationEnd} />

          <div className="composer-area">
            <div className="example-row" aria-label="Example requests">
              <span>Try:</span>
              {EXAMPLES.map((caseId) => (
                <button
                  type="button"
                  key={caseId}
                  disabled={busy}
                  onClick={() => setMessage(`Process ${caseId}`)}
                >
                  {caseId}
                </button>
              ))}
            </div>
            <form className="composer" onSubmit={submit}>
              <textarea
                aria-label="Message the purchase order agent"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
                maxLength={2000}
                rows={2}
                placeholder="Example: Process req-004 and show every validation"
                disabled={busy}
              />
              <button type="submit" disabled={busy || message.trim().length === 0}>
                {loading ? "Working…" : "Send request"}
              </button>
            </form>
            <div className="composer-note">
              <span>Enter to send · Shift + Enter for a new line</span>
              <span>{message.length}/2000</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
