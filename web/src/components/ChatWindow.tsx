import type { PendingConfirmation, SessionEvent } from "../types"
import { ConfirmationBanner } from "./ConfirmationBanner"
import { MessageBubble } from "./MessageBubble"
import { ToolCallCard } from "./ToolCallCard"

interface ChatWindowProps {
  events: SessionEvent[]
  pending: PendingConfirmation | null
  loading: boolean
  onConfirm(): void
}

export function ChatWindow({ events, pending, loading, onConfirm }: ChatWindowProps) {
  return (
    <div className="conversation" aria-live="polite">
      {events.length === 0 && (
        <section className="empty-state">
          <span className="eyebrow">Ready for a request</span>
          <h2>Turn a purchase request into a controlled SAP PO.</h2>
          <p>
            Ask the agent to process any official case. You will see each backend tool, validation,
            exception, and final purchase order result here.
          </p>
        </section>
      )}

      {events.map((event, index) => event.type === "message"
        ? <MessageBubble event={event} key={`${event.ts}-${event.role}-${index}`} />
        : <ToolCallCard event={event} key={`${event.callId}-${index}`} />)}

      {loading && (
        <div className="thinking-state" role="status">
          <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
          <span>The agent is processing with validated backend tools…</span>
        </div>
      )}

      {pending !== null && (
        <ConfirmationBanner pending={pending} disabled={loading} onConfirm={onConfirm} />
      )}
    </div>
  )
}
