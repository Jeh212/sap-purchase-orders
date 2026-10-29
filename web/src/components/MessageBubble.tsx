import type { MessageEvent } from "../types"

interface MessageBubbleProps {
  event: MessageEvent
}

export function MessageBubble({ event }: MessageBubbleProps) {
  const assistant = event.role === "assistant"
  return (
    <article className={`message-row message-row--${event.role}`}>
      <div className="message-avatar" aria-hidden="true">
        {assistant ? "PO" : "You"}
      </div>
      <div className="message-content">
        <div className="message-meta">
          <span>{assistant ? "Purchase order agent" : "Administrative analyst"}</span>
          <time dateTime={event.ts}>
            {new Date(event.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        </div>
        <p>{event.content}</p>
      </div>
    </article>
  )
}
