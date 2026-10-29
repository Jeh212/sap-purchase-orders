import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { FastifyInstance } from "fastify"
import type {
  LlmAdapter,
  LlmErrorCode,
  LlmMessage,
  LlmOptions,
  LlmResponse,
  LlmTool,
  LlmToolCall,
} from "../../src/llm/adapter.js"
import { buildServer } from "../../src/server.js"
import { llmTools } from "../../src/tools/registry.js"

const ROOT = process.cwd()

function modelMessage(
  content: string,
  toolCalls: LlmToolCall[] = [],
  usage = { inputTokens: 10, outputTokens: 5 },
): LlmResponse {
  return {
    type: "message",
    content,
    toolCalls,
    usage,
    stopReason: toolCalls.length > 0 ? "tool_calls" : "complete",
  }
}

function lastToolData(messages: LlmMessage[], name: string): Record<string, unknown> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "tool" || message.name !== name) continue
    const parsed = JSON.parse(message.content) as { ok: boolean; data?: Record<string, unknown> }
    if (parsed.ok && parsed.data !== undefined) return parsed.data
  }
  throw new Error(`missing successful result for ${name}`)
}

class WorkflowAdapter implements LlmAdapter {
  readonly provider = "mock"
  readonly model = "workflow-v1"
  readonly snapshots: LlmMessage[][] = []
  private readonly actions: string[]
  private readonly caseId: string
  private index = 0

  constructor(caseId: string) {
    this.caseId = caseId
    const blocked = caseId === "req-002" || caseId === "req-003"
    const confirmation = ["req-004", "req-005", "req-006"].includes(caseId)
    this.actions = blocked
      ? ["read", "validate", "done"]
      : ["read", "validate", "evidence", "build", ...(confirmation ? ["pause"] : []), "create", "done"]
  }

  send(messages: LlmMessage[], _tools: LlmTool[], _options: LlmOptions): Promise<LlmResponse> {
    this.snapshots.push(structuredClone(messages))
    const action = this.actions[this.index] ?? "done"
    const id = `${this.caseId}-${this.index}`
    this.index += 1
    if (action === "read") return Promise.resolve(modelMessage("", [{ id, name: "po_read_package", arguments: { case_id: this.caseId } }]))
    if (action === "validate") return Promise.resolve(modelMessage("", [{ id, name: "po_validate", arguments: { case_id: this.caseId, package: {} } }]))
    if (action === "evidence") return Promise.resolve(modelMessage("", [{ id, name: "po_generate_evidence", arguments: { case_id: this.caseId } }]))
    if (action === "build") return Promise.resolve(modelMessage("", [{ id, name: "po_build_payload", arguments: { case_id: this.caseId, package: {}, derived: {} } }]))
    if (action === "pause") return Promise.resolve(modelMessage(`Please explicitly confirm the pending exceptions for ${this.caseId}.`))
    if (action === "create") {
      const payload = lastToolData(messages, "po_build_payload")["payload"]
      return Promise.resolve(modelMessage("", [{ id, name: "po_create", arguments: { case_id: this.caseId, payload, confirmed: true } }]))
    }
    return Promise.resolve(modelMessage(`Workflow complete for ${this.caseId}.`))
  }
}

interface Harness {
  app: FastifyInstance
  outDir: string
  cleanup(): Promise<void>
}

const active: Harness[] = []

async function harness(adapter: LlmAdapter, options: { maxIterations?: number; maxTokensPerSession?: number } = {}): Promise<Harness> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "po-agent-test-"))
  const app = await buildServer({ adapter, rootDir: ROOT, outDir, ...options })
  const item: Harness = {
    app,
    outDir,
    async cleanup() {
      await app.close()
      await fs.rm(outDir, { recursive: true, force: true })
    },
  }
  active.push(item)
  return item
}

afterEach(async () => {
  while (active.length > 0) await active.pop()?.cleanup()
})

async function post(app: FastifyInstance, body: Record<string, unknown>) {
  const response = await app.inject({ method: "POST", url: "/api/chat", payload: body })
  expect(response.statusCode).toBe(200)
  return response.json() as {
    reply: string
    toolCalls: Array<{ callId: string; name: string; isError: boolean; cached: boolean; resultSummary: string }>
    needsConfirmation: boolean
    pendingConfirmation: {
      requestId: string
      codes: string[]
      confirmations: Array<{ code: string; message: string; values?: Record<string, unknown> }>
    } | null
    tokenUsage: { total: number }
  }
}

describe("Phase 4 official workflows through the real agent loop", () => {
  it("req-001 creates a PO without confirmation", async () => {
    const h = await harness(new WorkflowAdapter("req-001"))
    const result = await post(h.app, { sessionId: "s001", message: "Process req-001" })
    expect(result.needsConfirmation).toBe(false)
    expect(result.toolCalls.map((call) => call.name)).toEqual([
      "po_read_package", "po_validate", "po_generate_evidence", "po_build_payload", "po_create",
    ])
    expect(result.toolCalls.at(-1)?.resultSummary).toMatch(/^PO 4500000001 created$/)
  })

  it("req-002 is blocked by RC1 and never calls create", async () => {
    const h = await harness(new WorkflowAdapter("req-002"))
    const result = await post(h.app, { sessionId: "s002", message: "Process req-002" })
    expect(result.toolCalls.map((call) => call.name)).toEqual(["po_read_package", "po_validate"])
    expect(result.toolCalls[1]?.resultSummary).toContain("eligible=false")
    const control = await fs.readFile(path.join(h.outDir, "control.csv"), "utf-8")
    expect(control).toContain("RC1")
    await expect(fs.access(path.join(h.outDir, "sap", "orders.jsonl"))).rejects.toThrow()
  })

  it("req-003 is blocked by RC2 and never calls create", async () => {
    const h = await harness(new WorkflowAdapter("req-003"))
    const result = await post(h.app, { sessionId: "s003", message: "Process req-003" })
    expect(result.toolCalls.map((call) => call.name)).not.toContain("po_create")
    const control = await fs.readFile(path.join(h.outDir, "control.csv"), "utf-8")
    expect(control).toContain("RC2")
  })

  it("req-004 pauses for RC5 and creates only after explicit confirmation", async () => {
    const h = await harness(new WorkflowAdapter("req-004"))
    const first = await post(h.app, { sessionId: "s004", message: "Process req-004" })
    expect(first.needsConfirmation).toBe(true)
    expect(first.pendingConfirmation?.codes).toEqual(["RC5"])
    expect(first.pendingConfirmation?.confirmations).toEqual([
      expect.objectContaining({
        code: "RC5",
        values: {
          request_total: 25_000_000,
          quote_total: 26_500_000,
          difference_pct: 6,
        },
      }),
    ])
    expect(first.toolCalls.map((call) => call.name)).not.toContain("po_create")
    const second = await post(h.app, { sessionId: "s004", message: "I approve the 6% variance", confirm: true })
    expect(second.needsConfirmation).toBe(false)
    expect(second.toolCalls.map((call) => call.name)).toContain("po_create")
    expect(second.toolCalls.at(-1)?.resultSummary).toContain("4500000001")
  })

  it("req-005 records retroactive RC8 confirmation then creates", async () => {
    const h = await harness(new WorkflowAdapter("req-005"))
    const first = await post(h.app, { sessionId: "s005", message: "Process req-005" })
    expect(first.pendingConfirmation?.codes).toEqual(["RC8"])
    await post(h.app, { sessionId: "s005", confirm: true })
    const control = await fs.readFile(path.join(h.outDir, "control.csv"), "utf-8")
    expect(control).toMatch(/REQ-2026-005,PENDING,,true,,RC8/)
    expect(control).toMatch(/REQ-2026-005,CREATED,4500000001,true,,RC8/)
  })

  it("req-006 derives tax code/payment terms and requires RC6 confirmation", async () => {
    const h = await harness(new WorkflowAdapter("req-006"))
    const first = await post(h.app, { sessionId: "s006", message: "Process req-006" })
    expect(first.pendingConfirmation?.codes).toEqual(["RC6"])
    await post(h.app, { sessionId: "s006", confirm: true })
    const order = JSON.parse((await fs.readFile(path.join(h.outDir, "sap", "orders.jsonl"), "utf-8")).trim()) as {
      payload: { payment_terms: string; items: Array<{ tax_code: string }> }
    }
    expect(order.payload.payment_terms).toBe("Z030")
    expect(order.payload.items[0]?.tax_code).toBe("C1")
  })
})

describe("agent-loop correlation, validation, limits and recovery", () => {
  it("registers all five exact tool contracts as strict Zod-derived JSON schemas", () => {
    expect(llmTools.map((tool) => tool.name)).toEqual([
      "po_read_package", "po_validate", "po_generate_evidence", "po_build_payload", "po_create",
    ])
    for (const tool of llmTools) {
      expect(tool.inputSchema["type"]).toBe("object")
      expect(tool.inputSchema["additionalProperties"]).toBe(false)
    }
  })

  it("returns invalid LLM arguments as a correlated tool error and continues", async () => {
    class InvalidArgsAdapter implements LlmAdapter {
      readonly provider = "mock"
      readonly model = "invalid-args"
      calls = 0
      correlation = false
      send(messages: LlmMessage[]): Promise<LlmResponse> {
        this.calls += 1
        if (this.calls === 1) {
          return Promise.resolve(modelMessage("", [{ id: "bad-1", name: "po_read_package", arguments: { case_id: 42 } }]))
        }
        const assistant = messages.find((message) => message.role === "assistant" && message.toolCalls.some((call) => call.id === "bad-1"))
        const tool = messages.find((message) => message.role === "tool" && message.toolCallId === "bad-1")
        this.correlation = assistant !== undefined && tool?.role === "tool" && tool.isError
        return Promise.resolve(modelMessage("The tool arguments were invalid; no operation was performed."))
      }
    }
    const adapter = new InvalidArgsAdapter()
    const h = await harness(adapter)
    const result = await post(h.app, { sessionId: "invalid", message: "Process it" })
    expect(adapter.correlation).toBe(true)
    expect(result.toolCalls[0]?.isError).toBe(true)
    expect(result.reply).toContain("invalid")
  })

  it.each(["timeout", "rate_limit"] as const)("surfaces %s errors and preserves the session for the next turn", async (code) => {
    class RecoveringAdapter implements LlmAdapter {
      readonly provider = "mock"
      readonly model = "recovery"
      calls = 0
      send(): Promise<LlmResponse> {
        this.calls += 1
        if (this.calls === 1) {
          return Promise.resolve({ type: "error", error: { code: code as LlmErrorCode, message: `Provider ${code}`, retryable: true } })
        }
        return Promise.resolve(modelMessage("Recovered on the next turn."))
      }
    }
    const h = await harness(new RecoveringAdapter())
    const first = await post(h.app, { sessionId: `recover-${code}`, message: "First" })
    expect(first.reply).toContain(code)
    const second = await post(h.app, { sessionId: `recover-${code}`, message: "Retry" })
    expect(second.reply).toContain("Recovered")
    const history = await h.app.inject({ method: "GET", url: `/api/sessions/recover-${code}` })
    expect(history.statusCode).toBe(200)
    const body = history.json() as { history: Array<{ role?: string; content?: string }> }
    expect(body.history.filter((event) => event.role === "user")).toHaveLength(2)
  })

  it("stops at the configured iteration limit", async () => {
    class EndlessAdapter implements LlmAdapter {
      readonly provider = "mock"
      readonly model = "endless"
      calls = 0
      send(): Promise<LlmResponse> {
        this.calls += 1
        return Promise.resolve(modelMessage("", [{ id: `loop-${this.calls}`, name: "missing_tool", arguments: {} }]))
      }
    }
    const adapter = new EndlessAdapter()
    const h = await harness(adapter, { maxIterations: 3 })
    const result = await post(h.app, { sessionId: "limit", message: "Loop" })
    expect(adapter.calls).toBe(3)
    expect(result.toolCalls).toHaveLength(3)
    expect(result.reply).toContain("iteration limit")
  })

  it("stops before another model call when reported usage reaches the session token budget", async () => {
    class BudgetAdapter implements LlmAdapter {
      readonly provider = "mock"
      readonly model = "budget"
      calls = 0
      send(): Promise<LlmResponse> {
        this.calls += 1
        return Promise.resolve(modelMessage("", [{ id: "budget-1", name: "po_read_package", arguments: { case_id: "req-001" } }], { inputTokens: 4_000, outputTokens: 2_000 }))
      }
    }
    const adapter = new BudgetAdapter()
    const h = await harness(adapter, { maxTokensPerSession: 5_000 })
    const result = await post(h.app, { sessionId: "budget", message: "Process req-001" })
    expect(adapter.calls).toBe(1)
    expect(result.tokenUsage.total).toBe(6_000)
    expect(result.reply).toContain("token budget")
  })

  it("caches a repeated tool_call_id so an operation is not executed twice", async () => {
    class DuplicateAdapter implements LlmAdapter {
      readonly provider = "mock"
      readonly model = "duplicates"
      calls = 0
      send(): Promise<LlmResponse> {
        this.calls += 1
        if (this.calls === 1) {
          const call = { id: "same-id", name: "po_read_package", arguments: { case_id: "req-001" } }
          return Promise.resolve(modelMessage("", [call, call]))
        }
        return Promise.resolve(modelMessage("Done"))
      }
    }
    const h = await harness(new DuplicateAdapter())
    const result = await post(h.app, { sessionId: "dupe", message: "Read" })
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0]?.cached).toBe(false)
    expect(result.toolCalls[1]?.cached).toBe(true)
  })

  it("keeps confirmation isolated by session and prevents replay from creating a duplicate", async () => {
    const h = await harness(new WorkflowAdapter("req-004"))
    await post(h.app, { sessionId: "owner", message: "Process req-004" })
    const other = await post(h.app, { sessionId: "other", confirm: true })
    expect(other.reply).toContain("no pending")
    await post(h.app, { sessionId: "owner", confirm: true })
    const replay = await post(h.app, { sessionId: "owner", confirm: true })
    expect(replay.reply).toContain("no pending")
    const lines = (await fs.readFile(path.join(h.outDir, "sap", "orders.jsonl"), "utf-8"))
      .trim().split("\n")
    expect(lines).toHaveLength(1)
  })

  it("health and session APIs expose provider/model/history without credentials", async () => {
    const h = await harness(new WorkflowAdapter("req-002"))
    const health = await h.app.inject({ method: "GET", url: "/api/health" })
    expect(health.json()).toEqual({ ok: true, provider: "mock", model: "workflow-v1", llmConfigured: true })
    expect(health.body).not.toMatch(/api.?key|secret/i)
    await post(h.app, { sessionId: "history", message: "Process req-002" })
    const session = await h.app.inject({ method: "GET", url: "/api/sessions/history" })
    expect(session.statusCode).toBe(200)
    const body = session.json() as {
      history: Array<{ type: string; name?: string; details?: { kind: string; blockers?: Array<{ code: string }> } }>
    }
    expect(body.history.some((event) => event.type === "tool")).toBe(true)
    expect(body.history).toContainEqual(expect.objectContaining({
      type: "tool",
      name: "po_validate",
      details: expect.objectContaining({
        kind: "validation",
        blockers: [expect.objectContaining({ code: "RC1" })],
      }),
    }))
    const log = await fs.readFile(path.join(h.outDir, "log.jsonl"), "utf-8")
    expect(log).toContain('"session_id":"history"')
    expect(log).toContain('"tool":"po_validate"')
    expect(log).not.toMatch(/api.?key|authorization|secret/i)
  })
})
