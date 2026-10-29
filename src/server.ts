import Fastify from "fastify"
import type { FastifyReply } from "fastify"
import cors from "@fastify/cors"
import rateLimit from "@fastify/rate-limit"
import { z } from "zod"
import * as fs from "node:fs/promises"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

// Load .env for local development. Must not overwrite variables already set in the
// environment (so Render Dashboard env vars always take priority). Silent on missing file.
try {
  for (const line of readFileSync(path.join(process.cwd(), ".env"), "utf-8").split("\n")) {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m?.[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, "")
    }
  }
} catch { /* .env is optional — no .env in production or fresh checkout */ }
import type { LlmAdapter, LlmMessage, LlmToolCall } from "./llm/adapter.js"
import { isRecord } from "./llm/adapter.js"
import { createLlmAdapterFromEnv } from "./llm/factory.js"
import { FileSapMock } from "./sap/mock.js"
import { llmTools, registeredToolsByName } from "./tools/registry.js"
import { SessionStore } from "./session.js"
import type {
  Session,
  ToolEvent,
  ToolEventDetails,
  ValidationIssueView,
} from "./session.js"

const ChatRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    message: z.string().max(2000).optional().default(""),
    confirm: z.boolean().optional().default(false),
  })
  .refine((body) => body.confirm || body.message.trim().length > 0, {
    message: "message is required unless confirm=true",
  })

export interface AgentServerOptions {
  adapter?: LlmAdapter
  rootDir?: string
  outDir?: string
  maxIterations?: number
  maxTokensPerSession?: number
  maxTokensPerResponse?: number
  providerTimeoutMs?: number
  rateLimitMax?: number
}

interface AgentConfig {
  maxIterations: number
  maxTokensPerSession: number
  maxTokensPerResponse: number
  providerTimeoutMs: number
}

export interface ChatToolCall {
  callId: string
  name: string
  arguments: Record<string, unknown>
  resultSummary: string
  isError: boolean
  cached: boolean
  details: ToolEventDetails
}

export interface PendingConfirmationView {
  requestId: string
  codes: string[]
  confirmations: ValidationIssueView[]
}

export interface ChatResponse {
  sessionId: string
  reply: string
  toolCalls: ChatToolCall[]
  needsConfirmation: boolean
  pendingConfirmation: PendingConfirmationView | null
  tokenUsage: { input: number; output: number; total: number }
}

function envInteger(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    result[key] = /api.?key|authorization|password|secret|token/i.test(key)
      ? "[REDACTED]"
      : redact(nested)
  }
  return result
}

function safeArguments(value: unknown): Record<string, unknown> {
  const redacted = redact(value)
  return isRecord(redacted) ? redacted : {}
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function issueViews(value: unknown): ValidationIssueView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item["code"] !== "string" || typeof item["message"] !== "string") {
      return []
    }
    const values = isRecord(item["values"])
      ? safeArguments(item["values"])
      : undefined
    return [{
      code: item["code"],
      message: item["message"],
      ...(values === undefined ? {} : { values }),
    }]
  })
}

interface ParsedToolResult {
  isError: boolean
  summary: string
  details: ToolEventDetails
}

function parseToolResult(
  toolName: string,
  args: Record<string, unknown>,
  content: string,
): ParsedToolResult {
  try {
    const parsed = JSON.parse(content) as unknown
    if (!isRecord(parsed)) {
      return {
        isError: true,
        summary: "Invalid tool result",
        details: { kind: "error", message: "The tool returned an invalid result." },
      }
    }
    if (parsed["ok"] === false) {
      const message = String(parsed["error"] ?? "tool failed").slice(0, 500)
      return { isError: true, summary: `Error: ${message}`, details: { kind: "error", message } }
    }
    const data = parsed["data"]
    if (!isRecord(data)) {
      return { isError: false, summary: "Completed", details: { kind: "completed" } }
    }
    if (typeof data["po_number"] === "string") {
      return {
        isError: false,
        summary: `PO ${data["po_number"]}${data["idempotent"] === true ? " (idempotent)" : " created"}`,
        details: {
          kind: "creation",
          poNumber: data["po_number"],
          date: stringOrNull(data["date"]),
          idempotent: data["idempotent"] === true,
        },
      }
    }
    if (typeof data["eligible"] === "boolean") {
      const blockers = issueViews(data["blockers"])
      const confirmations = issueViews(data["confirmations"])
      const derived = isRecord(data["derived"])
        ? safeArguments(data["derived"])
        : {}
      return {
        isError: false,
        summary: `eligible=${String(data["eligible"])}, blockers=${blockers.length}, confirmations=${confirmations.length}`,
        details: {
          kind: "validation",
          caseId: stringOrNull(args["case_id"]),
          eligible: data["eligible"],
          blockers,
          confirmations,
          derived,
          retroactive: data["retroactive"] === true,
        },
      }
    }
    if (typeof data["traceability_path"] === "string") {
      const payload = isRecord(data["payload"]) ? data["payload"] : null
      const reference = payload !== null && isRecord(payload["reference"])
        ? payload["reference"]
        : null
      return {
        isError: false,
        summary: "Payload and traceability created",
        details: {
          kind: "payload",
          caseId: stringOrNull(args["case_id"]),
          requestId: reference === null ? null : stringOrNull(reference["request_id"]),
          traceabilityPath: data["traceability_path"],
        },
      }
    }
    if (typeof data["sha256"] === "string") {
      return {
        isError: false,
        summary: "Approval evidence generated",
        details: {
          kind: "evidence",
          path: stringOrNull(data["path"]),
          sha256: data["sha256"],
        },
      }
    }
    if (isRecord(data["request"]) && typeof data["request"]["request_id"] === "string") {
      return {
        isError: false,
        summary: `Package ${data["request"]["request_id"]} read`,
        details: { kind: "package", requestId: data["request"]["request_id"] },
      }
    }
    return { isError: false, summary: "Completed", details: { kind: "completed" } }
  } catch {
    return {
      isError: true,
      summary: "Invalid tool result",
      details: { kind: "error", message: `${toolName} returned malformed JSON.` },
    }
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
    .join("; ")
}

function estimateTokens(messages: LlmMessage[]): number {
  return Math.max(1, Math.ceil(JSON.stringify(messages).length / 4))
}

async function sendBuiltFile(
  reply: FastifyReply,
  filePath: string,
  contentType: string,
): Promise<FastifyReply> {
  try {
    const content = await fs.readFile(filePath)
    return reply.type(contentType).send(content)
  } catch {
    return reply.code(404).send({ ok: false, error: "not found" })
  }
}

async function appendToolLog(outDir: string, sessionId: string, event: ToolEvent): Promise<void> {
  try {
    await fs.mkdir(outDir, { recursive: true })
    const line = JSON.stringify({
      ts: event.ts,
      session_id: sessionId,
      call_id: event.callId,
      tool: event.name,
      case_id: typeof event.arguments["case_id"] === "string" ? event.arguments["case_id"] : null,
      result_summary: event.resultSummary,
      is_error: event.isError,
      cached: event.cached,
    })
    await fs.appendFile(path.join(outDir, "log.jsonl"), `${line}\n`, "utf-8")
  } catch {
    // A logging failure must not corrupt the conversation or repeat a tool call.
  }
}

function appendAssistant(session: Session, content: string): void {
  session.messages.push({ role: "assistant", content, toolCalls: [] })
  session.events.push({
    type: "message",
    ts: new Date().toISOString(),
    role: "assistant",
    content,
  })
  session.updatedAt = new Date().toISOString()
}

async function runAgentTurn(
  adapter: LlmAdapter,
  session: Session,
  rootDir: string,
  outDir: string,
  sapAdapter: FileSapMock,
  config: AgentConfig,
): Promise<{ reply: string; toolCalls: ChatToolCall[] }> {
  const turnTools: ChatToolCall[] = []
  let reply = ""
  let endedWithToolCalls = false

  for (let iteration = 0; iteration < config.maxIterations; iteration += 1) {
    const remaining = config.maxTokensPerSession - session.tokenUsage.total
    const estimatedInput = estimateTokens(session.messages)
    const outputAllowance = Math.min(
      config.maxTokensPerResponse,
      remaining - estimatedInput,
    )
    if (outputAllowance < 1) {
      reply = "This session has reached its token budget. Start a new session to continue."
      appendAssistant(session, reply)
      return { reply, toolCalls: turnTools }
    }

    const response = await adapter.send(session.messages, llmTools, {
      maxTokens: outputAllowance,
      timeoutMs: config.providerTimeoutMs,
    })
    if (response.type === "error") {
      reply = response.error.message
      appendAssistant(session, reply)
      return { reply, toolCalls: turnTools }
    }

    session.tokenUsage.input += response.usage.inputTokens
    session.tokenUsage.output += response.usage.outputTokens
    session.tokenUsage.total = session.tokenUsage.input + session.tokenUsage.output
    session.messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    })
    if (response.content.length > 0) {
      session.events.push({
        type: "message",
        ts: new Date().toISOString(),
        role: "assistant",
        content: response.content,
      })
      reply = response.content
    }
    session.updatedAt = new Date().toISOString()

    if (response.toolCalls.length === 0) {
      if (reply.length === 0) reply = "The model returned an empty response. Please try again."
      return { reply, toolCalls: turnTools }
    }

    endedWithToolCalls = true
    for (const toolCall of response.toolCalls) {
      const cached = session.toolResults.get(toolCall.id)
      let content: string
      let isError: boolean
      let summary: string
      let details: ToolEventDetails
      let wasCached = false

      if (cached !== undefined) {
        wasCached = true
        if (cached.name !== toolCall.name) {
          content = JSON.stringify({ ok: false, error: "tool_call_id was reused for a different tool" })
          isError = true
          summary = "Error: tool-call correlation conflict"
          details = { kind: "error", message: "The tool-call identifier was reused for a different tool." }
        } else {
          content = cached.content
          isError = cached.isError
          summary = cached.summary
          details = cached.details
        }
      } else {
        const registered = registeredToolsByName.get(toolCall.name)
        if (registered === undefined) {
          content = JSON.stringify({ ok: false, error: `Unknown tool: ${toolCall.name}` })
          isError = true
          summary = `Error: unknown tool ${toolCall.name}`
          details = { kind: "error", message: `Unknown tool: ${toolCall.name}` }
        } else {
          const parsed = registered.schema.safeParse(toolCall.arguments)
          if (!parsed.success) {
            content = JSON.stringify({
              ok: false,
              error: `Invalid arguments for ${toolCall.name}: ${formatZodError(parsed.error)}`,
            })
            isError = true
            summary = `Error: invalid arguments for ${toolCall.name}`
            details = { kind: "error", message: `Invalid arguments for ${toolCall.name}` }
          } else {
            try {
              content = await registered.execute(parsed.data, {
                directory: rootDir,
                sessionId: session.id,
                outDir,
                confirmationStore: session.confirmationStore,
                sapAdapter,
              })
              const result = parseToolResult(toolCall.name, safeArguments(toolCall.arguments), content)
              isError = result.isError
              summary = result.summary
              details = result.details
            } catch {
              content = JSON.stringify({ ok: false, error: "Internal tool execution error" })
              isError = true
              summary = "Error: internal tool execution error"
              details = { kind: "error", message: "Internal tool execution error" }
            }
          }
        }
        session.toolResults.set(toolCall.id, {
          name: toolCall.name,
          content,
          isError,
          summary,
          details,
        })
      }

      session.messages.push({
        role: "tool",
        content,
        toolCallId: toolCall.id,
        name: toolCall.name,
        isError,
      })
      const event: ToolEvent = {
        type: "tool",
        ts: new Date().toISOString(),
        callId: toolCall.id,
        name: toolCall.name,
        arguments: safeArguments(toolCall.arguments),
        resultSummary: summary,
        isError,
        cached: wasCached,
        details,
      }
      session.events.push(event)
      turnTools.push({
        callId: event.callId,
        name: event.name,
        arguments: event.arguments,
        resultSummary: event.resultSummary,
        isError: event.isError,
        cached: event.cached,
        details: event.details,
      })
      await appendToolLog(outDir, session.id, event)
    }

    if (session.tokenUsage.total >= config.maxTokensPerSession) {
      reply = "This session reached its token budget after completing the latest tool call."
      appendAssistant(session, reply)
      return { reply, toolCalls: turnTools }
    }
  }

  if (endedWithToolCalls) {
    reply = "I reached the tool-iteration limit. No further operations were run; review the completed tool calls before continuing."
    appendAssistant(session, reply)
  }
  return { reply, toolCalls: turnTools }
}

function confirmationView(session: Session): PendingConfirmationView | null {
  const pending = session.confirmationStore.getPending()
  if (pending.length !== 1) return null
  const item = pending[0]
  if (item === undefined) return null

  const payloadEvent = [...session.events].reverse().find((event) =>
    event.type === "tool" &&
    event.details.kind === "payload" &&
    event.details.requestId === item.requestId,
  )
  const caseId = payloadEvent?.type === "tool" && payloadEvent.details.kind === "payload"
    ? payloadEvent.details.caseId
    : null
  const validationEvent = [...session.events].reverse().find((event) =>
    event.type === "tool" &&
    event.details.kind === "validation" &&
    (caseId === null || event.details.caseId === caseId),
  )
  const confirmations = validationEvent?.type === "tool" && validationEvent.details.kind === "validation"
    ? validationEvent.details.confirmations.filter((confirmation) => item.codes.includes(confirmation.code))
    : []
  return { requestId: item.requestId, codes: item.codes, confirmations }
}

export async function buildServer(options: AgentServerOptions = {}) {
  const rootDir = options.rootDir ?? process.cwd()
  const configuredOutDir = options.outDir ?? process.env["OUT_DIR"] ?? "out"
  const outDir = path.isAbsolute(configuredOutDir)
    ? configuredOutDir
    : path.join(rootDir, configuredOutDir)
  const [prompt, knowledge] = await Promise.all([
    fs.readFile(path.join(rootDir, "agent", "prompt.md"), "utf-8"),
    fs.readFile(path.join(rootDir, "src", "knowledge", "purchase-orders.md"), "utf-8"),
  ])
  let adapter: LlmAdapter | null = options.adapter ?? null
  if (adapter === null) {
    try {
      adapter = createLlmAdapterFromEnv(process.env)
    } catch {
      // Server starts without credentials; /api/chat returns HTTP 503 until configured.
    }
  }
  const sessions = new SessionStore(`${prompt}\n\n${knowledge}`)
  const sapAdapter = new FileSapMock(outDir)
  await sapAdapter.repairCounter()
  const config: AgentConfig = {
    maxIterations: options.maxIterations ?? envInteger("MAX_ITERATIONS", 25),
    maxTokensPerSession: options.maxTokensPerSession ?? envInteger("MAX_TOKENS_PER_SESSION", 50_000),
    maxTokensPerResponse: options.maxTokensPerResponse ?? envInteger("MAX_TOKENS_PER_RESPONSE", 4_096),
    providerTimeoutMs: options.providerTimeoutMs ?? envInteger("LLM_TIMEOUT_MS", 30_000),
  }

  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 })
  await app.register(cors, { origin: false })
  await app.register(rateLimit, {
    max: options.rateLimitMax ?? envInteger("RATE_LIMIT_PER_MINUTE", 30),
    timeWindow: "1 minute",
  })

  app.get("/api/health", async () => ({
    ok: true,
    provider: adapter?.provider ?? "none",
    model: adapter?.model ?? "none",
    llmConfigured: adapter !== null,
  }))

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    const session = sessions.get(request.params.id)
    if (session === undefined) return reply.code(404).send({ ok: false, error: "session not found" })
    return {
      id: session.id,
      history: session.events,
      tokenUsage: session.tokenUsage,
      pendingConfirmation: confirmationView(session),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }
  })

  app.post("/api/chat", async (request, reply): Promise<ChatResponse | unknown> => {
    if (adapter === null) {
      return reply.code(503).send({
        ok: false,
        error: "LLM provider not configured. Set LLM_PROVIDER, LLM_MODEL, and the corresponding API key environment variable.",
      })
    }
    const parsed = ChatRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: formatZodError(parsed.error) })
    }
    return sessions.runExclusive(parsed.data.sessionId, async () => {
      const session = sessions.getOrCreate(parsed.data.sessionId)
      let userMessage = parsed.data.message.trim()

      if (parsed.data.confirm) {
        const pending = session.confirmationStore.getPending()
        if (pending.length !== 1) {
          const reason = pending.length === 0
            ? "There is no pending confirmation in this session."
            : "More than one request is pending; process and confirm one case at a time."
          return {
            sessionId: session.id,
            reply: reason,
            toolCalls: [],
            needsConfirmation: pending.length > 0,
            pendingConfirmation: null,
            tokenUsage: session.tokenUsage,
          }
        }
        const item = pending[0]
        if (item === undefined) throw new Error("pending confirmation state is inconsistent")
        session.confirmationStore.confirm(item.requestId, item.payloadHash)
        if (userMessage.length === 0) {
          userMessage = `I explicitly confirm the pending exceptions for ${item.requestId}.`
        }
      }

      session.messages.push({ role: "user", content: userMessage })
      session.events.push({
        type: "message",
        ts: new Date().toISOString(),
        role: "user",
        content: userMessage,
      })
      session.updatedAt = new Date().toISOString()

      const result = await runAgentTurn(
        // adapter is non-null: the null guard at the top of this handler returns early
        adapter!,
        session,
        rootDir,
        outDir,
        sapAdapter,
        config,
      )
      const pendingConfirmation = confirmationView(session)
      const needsConfirmation = session.confirmationStore.getPending().length > 0
      return {
        sessionId: session.id,
        reply: result.reply,
        toolCalls: result.toolCalls,
        needsConfirmation,
        pendingConfirmation,
        tokenUsage: session.tokenUsage,
      }
    })
  })

  const webRoot = path.join(rootDir, "dist", "web")
  try {
    await fs.access(path.join(webRoot, "index.html"))
    app.get("/", async (_request, reply) =>
      sendBuiltFile(reply, path.join(webRoot, "index.html"), "text/html; charset=utf-8"))
    app.get<{ Params: { file: string } }>("/assets/:file", async (request, reply) => {
      if (!/^[A-Za-z0-9._-]+$/.test(request.params.file)) {
        return reply.code(404).send({ ok: false, error: "not found" })
      }
      const extension = path.extname(request.params.file)
      const contentType = extension === ".css"
        ? "text/css; charset=utf-8"
        : extension === ".js"
          ? "text/javascript; charset=utf-8"
          : "application/octet-stream"
      return sendBuiltFile(
        reply,
        path.join(webRoot, "assets", request.params.file),
        contentType,
      )
    })
  } catch {
    // The development server and backend-only tests do not require a built UI.
  }

  return app
}

async function start(): Promise<void> {
  const app = await buildServer()
  const port = envInteger("PORT", 3000)
  await app.listen({ host: "0.0.0.0", port })
  process.stdout.write(`SAP PO agent listening on port ${port}\n`)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "startup failed"
    process.stderr.write(`Unable to start server: ${message}\n`)
    process.exitCode = 1
  })
}
