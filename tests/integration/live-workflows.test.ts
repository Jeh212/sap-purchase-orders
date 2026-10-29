import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { FastifyInstance } from "fastify"
import { createLlmAdapterFromEnv } from "../../src/llm/factory.js"
import { buildServer } from "../../src/server.js"

const liveEnabled = process.env["RUN_LIVE_LLM_TESTS"] === "true"
const ROOT = process.cwd()

interface LiveHarness {
  app: FastifyInstance
  outDir: string
}

interface ChatBody {
  needsConfirmation: boolean
  reply: string
  tokenUsage: { input: number; output: number; total: number }
}

const harnesses: LiveHarness[] = []

async function harness(): Promise<LiveHarness> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "po-live-"))
  const app = await buildServer({
    adapter: createLlmAdapterFromEnv(process.env),
    rootDir: ROOT,
    outDir,
    maxIterations: 25,
  })
  const value = { app, outDir }
  harnesses.push(value)
  return value
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const item = harnesses.pop()
    if (item === undefined) continue
    await item.app.close()
    await fs.rm(item.outDir, { recursive: true, force: true })
  }
})

async function post(
  app: FastifyInstance,
  sessionId: string,
  message: string,
  confirm = false,
): Promise<ChatBody> {
  const response = await app.inject({
    method: "POST",
    url: "/api/chat",
    payload: { sessionId, message, confirm },
  })
  expect(response.statusCode).toBe(200)
  return response.json() as ChatBody
}

async function sessionEvents(app: FastifyInstance, sessionId: string): Promise<Array<Record<string, unknown>>> {
  const response = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { history: Array<Record<string, unknown>> }
  return body.history
}

function logMetrics(caseId: string, started: number, body: ChatBody): void {
  process.stdout.write(
    `[live-workflow] case=${caseId} input_tokens=${body.tokenUsage.input} output_tokens=${body.tokenUsage.output} total_tokens=${body.tokenUsage.total} latency_ms=${Date.now() - started}\n`,
  )
}

describe.skipIf(!liveEnabled)("real provider official workflows", () => {
  it.each([
    ["req-001", null],
    ["req-002", "RC1"],
    ["req-003", "RC2"],
  ] as const)("processes %s with its deterministic authorization outcome", async (caseId, blocker) => {
    const h = await harness()
    const started = Date.now()
    const body = await post(h.app, `live-${caseId}`, `Process ${caseId}. Follow the required tool workflow exactly.`)
    logMetrics(caseId, started, body)
    const events = await sessionEvents(h.app, `live-${caseId}`)
    const serialized = JSON.stringify(events)
    if (blocker === null) {
      expect(serialized).toContain('"kind":"creation"')
      const orders = await fs.readFile(path.join(h.outDir, "sap", "orders.jsonl"), "utf-8")
      expect(orders.trim().split("\n")).toHaveLength(1)
    } else {
      expect(serialized).toContain(`"code":"${blocker}"`)
      await expect(fs.access(path.join(h.outDir, "sap", "orders.jsonl"))).rejects.toThrow()
    }
  }, 120_000)

  it.each([
    ["req-004", "RC5"],
    ["req-005", "RC8"],
    ["req-006", "RC6"],
  ] as const)("pauses %s for %s and creates exactly one PO after explicit confirmation", async (caseId, code) => {
    const h = await harness()
    const sessionId = `live-${caseId}`
    const started = Date.now()
    const first = await post(
      h.app,
      sessionId,
      `Process ${caseId}. Show every exception and stop for explicit confirmation when required.`,
    )
    expect(first.needsConfirmation).toBe(true)
    await expect(fs.access(path.join(h.outDir, "sap", "orders.jsonl"))).rejects.toThrow()

    const second = await post(h.app, sessionId, `I explicitly confirm ${code} for ${caseId}.`, true)
    expect(second.needsConfirmation).toBe(false)
    logMetrics(caseId, started, second)
    const events = await sessionEvents(h.app, sessionId)
    expect(JSON.stringify(events)).toContain(`"code":"${code}"`)
    expect(JSON.stringify(events)).toContain('"kind":"creation"')
    const orders = (await fs.readFile(path.join(h.outDir, "sap", "orders.jsonl"), "utf-8"))
      .trim().split("\n")
    expect(orders).toHaveLength(1)
  }, 180_000)
})
