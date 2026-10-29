/**
 * Model-free verification of all six official fixture cases.
 *
 * This calls the same public tools, confirmation state machine and SAP adapter
 * used by the HTTP agent. Any failed business or artifact assertion rejects the
 * run, and the CLI exits non-zero.
 */

import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { InMemoryConfirmationStore } from "./src/domain/confirmation.js"
import type {
  Package,
  PurchaseOrder,
  ToolResult,
  ValidationResult,
} from "./src/domain/schemas.js"
import { FileSapMock } from "./src/sap/mock.js"
import * as po from "./src/tools/po.js"

const CASE_IDS = [
  "req-001",
  "req-002",
  "req-003",
  "req-004",
  "req-005",
  "req-006",
] as const

type CaseId = (typeof CASE_IDS)[number]

interface CreationData {
  po_number: string
  date: string
  idempotent: boolean
}

interface BuildData {
  payload: PurchaseOrder
  traceability_path: string
}

export interface DemoCaseResult {
  caseId: CaseId
  eligible: boolean
  blockers: string[]
  confirmations: string[]
  derived: Record<string, string>
  retroactive: boolean
  poNumber: string | null
  idempotentRetry: boolean | null
  outcome: "CREATED" | "BLOCKED"
}

export interface DemoRunResult {
  outDir: string
  cases: DemoCaseResult[]
}

export interface DemoOptions {
  rootDir?: string
  outDir?: string
  write?: (line: string) => void
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Demo assertion failed: ${message}`)
}

function parseResult<T>(raw: string, label: string): ToolResult<T> {
  try {
    const parsed = JSON.parse(raw) as ToolResult<T>
    assert(typeof parsed === "object" && parsed !== null && "ok" in parsed, `${label} returned an invalid result`)
    return parsed
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Demo assertion failed")) throw error
    throw new Error(`${label} returned malformed JSON`)
  }
}

function successful<T>(raw: string, label: string): T {
  const result = parseResult<T>(raw, label)
  if (!result.ok) throw new Error(`${label} failed: ${result.error}`)
  return result.data
}

function expectedCodes(caseId: CaseId): { blockers: string[]; confirmations: string[] } {
  if (caseId === "req-002") return { blockers: ["RC1"], confirmations: [] }
  if (caseId === "req-003") return { blockers: ["RC2"], confirmations: [] }
  if (caseId === "req-004") return { blockers: [], confirmations: ["RC5"] }
  if (caseId === "req-005") return { blockers: [], confirmations: ["RC8"] }
  if (caseId === "req-006") return { blockers: [], confirmations: ["RC6"] }
  return { blockers: [], confirmations: [] }
}

async function verifyEvidence(outDir: string, caseId: CaseId, payload: PurchaseOrder): Promise<void> {
  const text = await fs.readFile(path.join(outDir, caseId, "approval.txt"), "utf-8")
  const separator = "\n---\nSHA256: "
  const index = text.lastIndexOf(separator)
  assert(index > 0, `${caseId} approval.txt is missing its SHA256 annotation`)
  const canonical = text.slice(0, index)
  const annotated = text.slice(index + separator.length).trim()
  const actual = createHash("sha256").update(canonical, "utf-8").digest("hex")
  assert(annotated === actual, `${caseId} evidence annotation does not match canonical content`)
  assert(payload.approver.evidence_sha256 === actual, `${caseId} payload evidence hash does not match approval.txt`)
}

async function verifyTraceability(outDir: string, caseId: CaseId): Promise<void> {
  const raw = JSON.parse(
    await fs.readFile(path.join(outDir, caseId, "traceability.json"), "utf-8"),
  ) as unknown
  assert(typeof raw === "object" && raw !== null, `${caseId} traceability is not an object`)
  const record = raw as Record<string, unknown>
  assert(typeof record["payload"] === "object" && record["payload"] !== null, `${caseId} traceability has no payload`)
  assert(typeof record["sources"] === "object" && record["sources"] !== null, `${caseId} traceability has no sources`)
  const sources = record["sources"] as Record<string, unknown>
  const mandatory = [
    "reference.request_id",
    "reference.email_id",
    "reference.quote_ref",
    "company_code",
    "purchasing_org",
    "supplier.sap_code",
    "supplier.tax_id",
    "supplier.name",
    "currency",
    "payment_terms",
    "approver.email",
    "approver.approval_date",
    "approver.evidence_sha256",
    "items[0].number",
    "items[0].description",
    "items[0].quantity",
    "items[0].unit",
    "items[0].unit_price",
    "items[0].cost_center",
    "items[0].subarea",
    "items[0].tax_code",
  ]
  for (const field of mandatory) {
    assert(typeof sources[field] === "string", `${caseId} traceability is missing ${field}`)
  }
}

async function processCase(
  rootDir: string,
  outDir: string,
  sapAdapter: FileSapMock,
  caseId: CaseId,
): Promise<DemoCaseResult> {
  const confirmationStore = new InMemoryConfirmationStore()
  const ctx: po.ToolCtx = {
    directory: rootDir,
    sessionId: `demo-${caseId}`,
    outDir,
    confirmationStore,
    sapAdapter,
  }

  const pkg = successful<Package>(
    await po.read_package.execute({ case_id: caseId }, ctx),
    `${caseId} po_read_package`,
  )
  const validation = successful<ValidationResult>(
    await po.validate.execute({ case_id: caseId, package: pkg }, ctx),
    `${caseId} po_validate`,
  )
  const expected = expectedCodes(caseId)
  const blockers = validation.blockers.map((item) => item.code)
  const confirmations = validation.confirmations.map((item) => item.code)
  for (const code of expected.blockers) assert(blockers.includes(code), `${caseId} must include blocker ${code}`)
  assert(
    JSON.stringify(confirmations) === JSON.stringify(expected.confirmations),
    `${caseId} confirmations expected ${expected.confirmations.join("|") || "none"}, got ${confirmations.join("|") || "none"}`,
  )

  if (!validation.eligible) {
    assert(expected.blockers.length > 0, `${caseId} was unexpectedly blocked`)
    return {
      caseId,
      eligible: false,
      blockers,
      confirmations,
      derived: validation.derived,
      retroactive: validation.retroactive,
      poNumber: null,
      idempotentRetry: null,
      outcome: "BLOCKED",
    }
  }

  successful<{ path: string; sha256: string }>(
    await po.generate_evidence.execute({ case_id: caseId }, ctx),
    `${caseId} po_generate_evidence`,
  )
  const built = successful<BuildData>(
    await po.build_payload.execute({ case_id: caseId, package: pkg, derived: validation.derived }, ctx),
    `${caseId} po_build_payload`,
  )

  if (confirmations.length > 0) {
    const pendingAttempt = parseResult<CreationData>(
      await po.create.execute({ case_id: caseId, payload: built.payload, confirmed: true }, ctx),
      `${caseId} pending po_create`,
    )
    assert(!pendingAttempt.ok, `${caseId} forged confirmed=true bypassed human confirmation`)
    assert(
      pendingAttempt.error.toLowerCase().includes("confirmation"),
      `${caseId} pending creation did not explain the confirmation requirement`,
    )
    const hash = confirmationStore.getStoredHash(pkg.request.request_id)
    assert(hash !== undefined, `${caseId} did not register a pending payload hash`)
    confirmationStore.confirm(pkg.request.request_id, hash)
  }

  const created = successful<CreationData>(
    await po.create.execute({ case_id: caseId, payload: built.payload }, ctx),
    `${caseId} authorized po_create`,
  )
  assert(created.idempotent === false, `${caseId} first creation was unexpectedly idempotent`)
  await verifyEvidence(outDir, caseId, built.payload)
  await verifyTraceability(outDir, caseId)

  let idempotentRetry: boolean | null = null
  if (caseId === "req-001") {
    const retry = successful<CreationData>(
      await po.create.execute({ case_id: caseId, payload: built.payload }, ctx),
      "req-001 idempotent retry",
    )
    assert(retry.po_number === created.po_number, "req-001 retry returned a different PO number")
    assert(retry.idempotent, "req-001 retry was not marked idempotent")
    idempotentRetry = retry.idempotent
  }

  if (caseId === "req-004") {
    assert(built.payload.items[0]?.unit_price === 250_000, "req-004 payload did not preserve request unit price")
    assert(built.payload.items[0]?.unit === "H", "req-004 unit must be H")
  }
  if (caseId === "req-005") assert(validation.retroactive, "req-005 must be retroactive")
  if (caseId === "req-006") {
    assert(validation.derived.tax_code === "C1", "req-006 tax code must derive to C1")
    assert(validation.derived.payment_terms === "Z030", "req-006 payment terms must derive to Z030")
    assert(built.payload.items[0]?.tax_code === "C1", "req-006 payload tax code must be C1")
    assert(built.payload.payment_terms === "Z030", "req-006 payload payment terms must be Z030")
  }

  return {
    caseId,
    eligible: true,
    blockers,
    confirmations,
    derived: validation.derived,
    retroactive: validation.retroactive,
    poNumber: created.po_number,
    idempotentRetry,
    outcome: "CREATED",
  }
}

async function verifyRunArtifacts(outDir: string, results: DemoCaseResult[]): Promise<void> {
  const ordersText = await fs.readFile(path.join(outDir, "sap", "orders.jsonl"), "utf-8")
  const orders = ordersText.trim().split("\n").map((line) => JSON.parse(line) as {
    request_id: string
    po_number: string
  })
  assert(orders.length === 4, `expected 4 created orders, found ${orders.length}`)
  assert(new Set(orders.map((order) => order.request_id)).size === 4, "orders.jsonl contains duplicate request IDs")
  assert(new Set(orders.map((order) => order.po_number)).size === 4, "orders.jsonl contains duplicate PO numbers")
  assert(orders.filter((order) => order.request_id === "REQ-2026-001").length === 1, "req-001 idempotency produced a duplicate row")
  assert(!orders.some((order) => ["REQ-2026-002", "REQ-2026-003"].includes(order.request_id)), "a blocked request created a PO")

  const control = await fs.readFile(path.join(outDir, "control.csv"), "utf-8")
  for (const result of results) assert(control.includes(`REQ-2026-${result.caseId.slice(-3)}`), `${result.caseId} is absent from control.csv`)
  assert(control.includes("REQ-2026-002,BLOCKED"), "req-002 BLOCKED audit row missing")
  assert(control.includes("REQ-2026-003,BLOCKED"), "req-003 BLOCKED audit row missing")
  assert(control.includes("REQ-2026-005,CREATED") && control.includes(",true,,RC8,"), "req-005 retroactive audit evidence missing")
}

function formatResult(result: DemoCaseResult): string {
  const blockers = result.blockers.join("|") || "-"
  const confirmations = result.confirmations.join("|") || "-"
  const poNumber = result.poNumber ?? "-"
  const retry = result.idempotentRetry === null ? "-" : String(result.idempotentRetry)
  return `${result.caseId.padEnd(7)} ${String(result.eligible).padEnd(8)} ${blockers.padEnd(10)} ${confirmations.padEnd(14)} ${String(result.retroactive).padEnd(12)} ${poNumber.padEnd(12)} ${retry}`
}

export async function runDemo(options: DemoOptions = {}): Promise<DemoRunResult> {
  const rootDir = options.rootDir ?? process.cwd()
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const outDir = options.outDir ?? path.join(rootDir, "out", `demo-${timestamp}`)
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  await fs.mkdir(outDir, { recursive: true })

  const sapAdapter = new FileSapMock(outDir)
  const results: DemoCaseResult[] = []
  for (const caseId of CASE_IDS) {
    results.push(await processCase(rootDir, outDir, sapAdapter, caseId))
  }
  await verifyRunArtifacts(outDir, results)

  write("SAP Purchase Orders deterministic demo")
  write("case    eligible blockers   confirmations  retroactive  po_number    idempotent_retry")
  for (const result of results) write(formatResult(result))
  write(`Artifacts: ${path.relative(rootDir, outDir)}`)
  write("Assertions: PASS")
  return { outDir, cases: results }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  runDemo().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown demo failure"
    process.stderr.write(`Demo failed: ${message}\n`)
    process.exitCode = 1
  })
}
