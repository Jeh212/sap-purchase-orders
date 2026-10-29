import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import App from "../App"
import { ApiError, createSessionId, getSession, postChat } from "../api"
import type {
  ChatResponse,
  PendingConfirmation,
  SessionEvent,
  SessionHistory,
  ToolEvent,
} from "../types"

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api")
  return {
    ...actual,
    createSessionId: vi.fn(() => "session-new"),
    getSession: vi.fn(),
    postChat: vi.fn(),
  }
})

const mockedCreateSessionId = vi.mocked(createSessionId)
const mockedGetSession = vi.mocked(getSession)
const mockedPostChat = vi.mocked(postChat)

const now = "2026-10-28T19:20:00.000Z"

function validationEvent(): ToolEvent {
  return {
    type: "tool",
    ts: now,
    callId: "call-validation",
    name: "po_validate",
    arguments: { case_id: "req-004" },
    resultSummary: "eligible=true, blockers=0, confirmations=1",
    isError: false,
    cached: false,
    details: {
      kind: "validation",
      caseId: "req-004",
      eligible: true,
      blockers: [],
      confirmations: [{
        code: "RC5",
        message: "Quote total differs from request total by 6.00%.",
        values: { request_total: 25_000_000, quote_total: 26_500_000, difference_pct: 6 },
      }],
      derived: {},
      retroactive: false,
    },
  }
}

function creationEvent(): ToolEvent {
  return {
    type: "tool",
    ts: now,
    callId: "call-create",
    name: "po_create",
    arguments: { case_id: "req-001" },
    resultSummary: "PO 4500000001 created",
    isError: false,
    cached: false,
    details: {
      kind: "creation",
      poNumber: "4500000001",
      date: "2026-10-28",
      idempotent: false,
    },
  }
}

function history(
  events: SessionEvent[],
  pendingConfirmation: PendingConfirmation | null = null,
  id = "session-new",
): SessionHistory {
  return {
    id,
    history: events,
    tokenUsage: { input: 100, output: 40, total: 140 },
    pendingConfirmation,
    createdAt: now,
    updatedAt: now,
  }
}

function response(
  overrides: Partial<ChatResponse> = {},
): ChatResponse {
  return {
    sessionId: "session-new",
    reply: "Workflow complete.",
    toolCalls: [],
    needsConfirmation: false,
    pendingConfirmation: null,
    tokenUsage: { input: 100, output: 40, total: 140 },
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  mockedCreateSessionId.mockReturnValue("session-new")
})

describe("SAP PO frontend workflow", () => {
  it("submits chat, hydrates authoritative tool history, and displays the final PO", async () => {
    const user = userEvent.setup()
    mockedPostChat.mockResolvedValue(response())
    mockedGetSession.mockResolvedValue(history([
      { type: "message", ts: now, role: "user", content: "Process req-001" },
      creationEvent(),
      { type: "message", ts: now, role: "assistant", content: "Purchase order created successfully." },
    ]))

    render(<App />)
    await user.type(screen.getByLabelText("Message the purchase order agent"), "Process req-001")
    await user.click(screen.getByRole("button", { name: "Send request" }))

    await waitFor(() => expect(mockedPostChat).toHaveBeenCalledWith("session-new", "Process req-001", false))
    expect(await screen.findByText("4500000001")).toBeInTheDocument()
    expect(screen.getByText("Create purchase order")).toBeInTheDocument()
    expect(screen.getByText("Purchase order created successfully.")).toBeInTheDocument()
    expect(window.localStorage.getItem("sap-po-agent-session")).toBe("session-new")
  })

  it("shows a genuine loading state and a recoverable API error", async () => {
    const user = userEvent.setup()
    const pendingRequest = deferred<ChatResponse>()
    mockedPostChat.mockReturnValue(pendingRequest.promise)

    render(<App />)
    await user.type(screen.getByLabelText("Message the purchase order agent"), "Process req-002")
    await user.click(screen.getByRole("button", { name: "Send request" }))

    expect(screen.getByRole("status")).toHaveTextContent("processing with validated backend tools")
    expect(screen.getByLabelText("Message the purchase order agent")).toBeDisabled()
    pendingRequest.reject(new ApiError("Provider timeout. Please retry."))
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider timeout")
    expect(screen.getByLabelText("Message the purchase order agent")).toBeEnabled()
  })

  it("restores exact confirmation values after reload and prevents double submission", async () => {
    const user = userEvent.setup()
    const validation = validationEvent()
    const pendingConfirmation: PendingConfirmation = {
      requestId: "REQ-2026-004",
      codes: ["RC5"],
      confirmations: validation.details.kind === "validation"
        ? validation.details.confirmations
        : [],
    }
    window.localStorage.setItem("sap-po-agent-session", "session-existing")
    const confirmRequest = deferred<ChatResponse>()
    mockedGetSession
      .mockResolvedValueOnce(history([validationEvent()], pendingConfirmation, "session-existing"))
      .mockResolvedValueOnce(history([
        validationEvent(),
        { type: "message", ts: now, role: "user", content: "I explicitly confirm the pending exceptions for REQ-2026-004." },
        creationEvent(),
      ], null, "session-existing"))
    mockedPostChat.mockReturnValue(confirmRequest.promise)

    render(<App />)
    expect(await screen.findByText("Review exceptions before creating the PO")).toBeInTheDocument()
    expect(screen.getByText("REQ-2026-004")).toBeInTheDocument()
    expect(screen.getAllByText("25,000,000").length).toBeGreaterThan(0)
    expect(screen.getAllByText("26,500,000").length).toBeGreaterThan(0)

    const confirmButton = screen.getByRole("button", { name: "Confirm RC5 and continue" })
    await user.dblClick(confirmButton)
    expect(mockedPostChat).toHaveBeenCalledTimes(1)
    expect(mockedPostChat).toHaveBeenCalledWith("session-existing", "", true)
    expect(confirmButton).toBeDisabled()

    confirmRequest.resolve(response({ sessionId: "session-existing" }))
    expect(await screen.findByText("4500000001")).toBeInTheDocument()
    expect(screen.queryByText("Review exceptions before creating the PO")).not.toBeInTheDocument()
  })

  it("restores conversation continuity from browser storage", async () => {
    window.localStorage.setItem("sap-po-agent-session", "session-history")
    mockedGetSession.mockResolvedValue(history([
      { type: "message", ts: now, role: "user", content: "Process req-005" },
      { type: "message", ts: now, role: "assistant", content: "The request is retroactive and needs confirmation." },
    ], null, "session-history"))

    render(<App />)
    expect(await screen.findByText("Process req-005")).toBeInTheDocument()
    expect(screen.getByText("The request is retroactive and needs confirmation.")).toBeInTheDocument()
    expect(mockedGetSession).toHaveBeenCalledWith("session-history")
  })

  it("clears a stale missing session and explains that the next message starts fresh", async () => {
    window.localStorage.setItem("sap-po-agent-session", "session-stale")
    mockedGetSession.mockRejectedValue(new ApiError("session not found", 404))

    render(<App />)
    expect(await screen.findByRole("alert")).toHaveTextContent("previous session is no longer available")
    expect(window.localStorage.getItem("sap-po-agent-session")).toBeNull()
    expect(screen.getByText("Ready for a request")).toBeInTheDocument()
  })

  it("renders backend tool failures without inventing a result", async () => {
    window.localStorage.setItem("sap-po-agent-session", "session-failure")
    mockedGetSession.mockResolvedValue(history([{
      type: "tool",
      ts: now,
      callId: "call-failure",
      name: "po_create",
      arguments: { case_id: "req-004" },
      resultSummary: "Error: SAP persistence unavailable",
      isError: true,
      cached: false,
      details: { kind: "error", message: "SAP persistence unavailable" },
    }], null, "session-failure"))

    render(<App />)
    expect(await screen.findByText("SAP persistence unavailable")).toBeInTheDocument()
    expect(screen.getByText("Failed")).toBeInTheDocument()
    expect(screen.queryByLabelText("Purchase order result")).not.toBeInTheDocument()
  })
})
