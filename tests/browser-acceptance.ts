import * as fs from "node:fs/promises"
import * as path from "node:path"
import { chromium } from "playwright-core"
import type {
  LlmAdapter,
  LlmMessage,
  LlmOptions,
  LlmResponse,
  LlmTool,
} from "../src/llm/adapter.js"
import { buildServer } from "../src/server.js"

const ROOT = process.cwd()
const CONTEXT_DIR = path.join(ROOT, ".context")

function modelResponse(
  content: string,
  toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [],
): LlmResponse {
  return {
    type: "message",
    content,
    toolCalls,
    usage: { inputTokens: 20, outputTokens: 10 },
    stopReason: toolCalls.length > 0 ? "tool_calls" : "complete",
  }
}

function lastSuccessfulTool(messages: LlmMessage[], name: string): Record<string, unknown> | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "tool" || message.name !== name) continue
    const parsed = JSON.parse(message.content) as {
      ok?: boolean
      data?: Record<string, unknown>
    }
    if (parsed.ok === true && parsed.data !== undefined) return parsed.data
  }
  return null
}

class DeterministicBrowserAdapter implements LlmAdapter {
  readonly provider = "deterministic-browser-acceptance"
  readonly model = "fixture-workflow-v1"
  private sequence = 0

  send(messages: LlmMessage[], _tools: LlmTool[], _options: LlmOptions): Promise<LlmResponse> {
    const userText = messages
      .filter((message): message is Extract<LlmMessage, { role: "user" }> => message.role === "user")
      .map((message) => message.content)
      .join(" ")
    const caseId = userText.match(/req-00[1-6]/i)?.[0]?.toLowerCase() ?? "req-001"
    const call = (name: string, args: Record<string, unknown>): LlmResponse => {
      this.sequence += 1
      return modelResponse("", [{ id: `browser-${this.sequence}`, name, arguments: args }])
    }

    const pkg = lastSuccessfulTool(messages, "po_read_package")
    if (pkg === null) return Promise.resolve(call("po_read_package", { case_id: caseId }))
    const validation = lastSuccessfulTool(messages, "po_validate")
    if (validation === null) {
      return Promise.resolve(call("po_validate", { case_id: caseId, package: pkg }))
    }
    if (validation["eligible"] === false) {
      return Promise.resolve(modelResponse(`${caseId} is blocked by deterministic backend controls.`))
    }
    if (lastSuccessfulTool(messages, "po_generate_evidence") === null) {
      return Promise.resolve(call("po_generate_evidence", { case_id: caseId }))
    }
    const built = lastSuccessfulTool(messages, "po_build_payload")
    if (built === null) {
      return Promise.resolve(call("po_build_payload", {
        case_id: caseId,
        package: pkg,
        derived: validation["derived"] ?? {},
      }))
    }

    const confirmations = Array.isArray(validation["confirmations"])
      ? validation["confirmations"]
      : []
    const confirmed = messages.some((message) =>
      message.role === "user" && /explicitly confirm/i.test(message.content),
    )
    if (confirmations.length > 0 && !confirmed) {
      return Promise.resolve(modelResponse(`${caseId} requires the explicit human confirmation shown below.`))
    }
    if (lastSuccessfulTool(messages, "po_create") === null) {
      return Promise.resolve(call("po_create", {
        case_id: caseId,
        payload: built["payload"],
        confirmed,
      }))
    }
    return Promise.resolve(modelResponse(`${caseId} workflow complete.`))
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Browser acceptance failed: ${message}`)
}

async function run(): Promise<void> {
  await fs.mkdir(CONTEXT_DIR, { recursive: true })
  const outDir = path.join(CONTEXT_DIR, `browser-acceptance-out-${Date.now()}`)
  const app = await buildServer({
    adapter: new DeterministicBrowserAdapter(),
    rootDir: ROOT,
    outDir,
    rateLimitMax: 1_000,
  })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const browser = await chromium.launch({ channel: "chrome", headless: true })
  const passed: string[] = []

  try {
    for (const caseId of ["req-001", "req-002", "req-003", "req-004", "req-005", "req-006"] as const) {
      const context = await browser.newContext({
        viewport: caseId === "req-006"
          ? { width: 390, height: 844 }
          : { width: 1440, height: 960 },
      })
      const page = await context.newPage()
      await page.goto(app.listeningOrigin)
      await page.getByLabel("Message the purchase order agent").fill(`Process ${caseId}`)
      await page.getByRole("button", { name: "Send request" }).click()

      if (caseId === "req-001") {
        await page.getByLabel("Purchase order result").waitFor()
        assert(await page.locator("details.tool-card").count() === 5, "req-001 did not show all five tool calls")
        assert(await page.getByText("4500000001", { exact: true }).isVisible(), "req-001 PO number is not visible")
      } else if (caseId === "req-002" || caseId === "req-003") {
        await page.getByText("Blocked", { exact: true }).waitFor()
        const code = caseId === "req-002" ? "RC1" : "RC2"
        assert(await page.getByText(code, { exact: true }).isVisible(), `${caseId} ${code} is not visible`)
        assert(await page.getByLabel("Purchase order result").count() === 0, `${caseId} displayed a PO result despite its blocker`)
      } else {
        await page.getByText("Review exceptions before creating the PO", { exact: true }).waitFor()
        const code = caseId === "req-004" ? "RC5" : caseId === "req-005" ? "RC8" : "RC6"
        assert(await page.getByText(code, { exact: true }).first().isVisible(), `${caseId} ${code} is not visible`)
        assert(await page.getByLabel("Purchase order result").count() === 0, `${caseId} created before confirmation`)

        if (caseId === "req-004") {
          assert(await page.getByText("25,000,000", { exact: true }).first().isVisible(), "req-004 request value is missing")
          assert(await page.getByText("26,500,000", { exact: true }).first().isVisible(), "req-004 quote value is missing")
          await page.screenshot({ path: path.join(CONTEXT_DIR, "browser-acceptance-req004.png"), fullPage: true })
          await page.reload()
          await page.getByText("Review exceptions before creating the PO", { exact: true }).waitFor()
          assert(await page.getByText("26,500,000", { exact: true }).first().isVisible(), "req-004 pending state did not restore after reload")
        }

        await page.getByRole("button", { name: new RegExp(`Confirm ${code}`) }).click()
        await page.getByLabel("Purchase order result").waitFor()
        assert(await page.getByText("Review exceptions before creating the PO", { exact: true }).count() === 0, `${caseId} confirmation banner remained after creation`)
        if (caseId === "req-005") {
          assert(await page.getByText("Retroactive", { exact: true }).isVisible(), "req-005 retroactive flag is missing")
        }
        if (caseId === "req-006") {
          assert(await page.getByText("C1", { exact: true }).first().isVisible(), "req-006 derived tax code is missing")
          assert(await page.getByText("Z030", { exact: true }).first().isVisible(), "req-006 derived payment terms are missing")
          const dimensions = await page.evaluate(() => ({
            viewport: window.innerWidth,
            document: document.documentElement.scrollWidth,
          }))
          assert(dimensions.document <= dimensions.viewport + 1, "mobile viewport has horizontal overflow")
          await page.screenshot({ path: path.join(CONTEXT_DIR, "browser-acceptance-mobile.png"), fullPage: true })
        }
      }

      passed.push(caseId)
      process.stdout.write(`[browser] PASS ${caseId}\n`)
      await context.close()
    }

    await fs.writeFile(
      path.join(CONTEXT_DIR, "browser-acceptance.json"),
      JSON.stringify({ mode: "deterministic", passed, failed: [], outDir }, null, 2),
      "utf-8",
    )
    process.stdout.write(`Browser acceptance: ${passed.length} passed, 0 failed (deterministic adapter)\n`)
  } finally {
    await browser.close()
    await app.close()
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown browser acceptance failure"
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
