import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { runDemo } from "../../demo.js"
import { InMemoryConfirmationStore } from "../../src/domain/confirmation.js"
import type { Package, PurchaseOrder, ValidationResult } from "../../src/domain/schemas.js"
import { FileSapMock } from "../../src/sap/mock.js"
import * as po from "../../src/tools/po.js"

const ROOT = process.cwd()
const temporaryPaths: string[] = []

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

function parse<T>(raw: string): Result<T> {
  return JSON.parse(raw) as Result<T>
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryPaths.push(directory)
  return directory
}

async function fixtureWorkspace(caseId: string): Promise<string> {
  const workspace = await temporaryDirectory("po-fixtures-")
  const challenge = path.join(workspace, "fixtures", "challenge-03")
  await fs.mkdir(path.join(challenge, "requests"), { recursive: true })
  await fs.cp(
    path.join(ROOT, "fixtures", "challenge-03", "master-data"),
    path.join(challenge, "master-data"),
    { recursive: true },
  )
  await fs.cp(
    path.join(ROOT, "fixtures", "challenge-03", "requests", caseId),
    path.join(challenge, "requests", caseId),
    { recursive: true },
  )
  return workspace
}

async function buildCase(
  caseId: string,
  ctx: po.ToolCtx,
): Promise<{ pkg: Package; validation: ValidationResult; payload: PurchaseOrder }> {
  const read = parse<Package>(await po.read_package.execute({ case_id: caseId }, ctx))
  if (!read.ok) throw new Error(read.error)
  const validation = parse<ValidationResult>(
    await po.validate.execute({ case_id: caseId, package: read.data }, ctx),
  )
  if (!validation.ok) throw new Error(validation.error)
  const evidence = parse(await po.generate_evidence.execute({ case_id: caseId }, ctx))
  if (!evidence.ok) throw new Error(evidence.error)
  const built = parse<{ payload: PurchaseOrder }>(
    await po.build_payload.execute({
      case_id: caseId,
      package: read.data,
      derived: validation.data.derived,
    }, ctx),
  )
  if (!built.ok) throw new Error(built.error)
  return { pkg: read.data, validation: validation.data, payload: built.data.payload }
}

afterEach(async () => {
  while (temporaryPaths.length > 0) {
    const target = temporaryPaths.pop()
    if (target !== undefined) await fs.rm(target, { recursive: true, force: true })
  }
})

describe("Phase 6 deterministic demo", () => {
  it("asserts all six official cases and generated artifacts without an LLM key", async () => {
    const outDir = await temporaryDirectory("po-demo-")
    const output: string[] = []
    const result = await runDemo({ rootDir: ROOT, outDir, write: (line) => output.push(line) })

    expect(result.cases.map((item) => ({
      caseId: item.caseId,
      outcome: item.outcome,
      blockers: item.blockers,
      confirmations: item.confirmations,
      retroactive: item.retroactive,
    }))).toEqual([
      { caseId: "req-001", outcome: "CREATED", blockers: [], confirmations: [], retroactive: false },
      { caseId: "req-002", outcome: "BLOCKED", blockers: ["RC1"], confirmations: [], retroactive: false },
      { caseId: "req-003", outcome: "BLOCKED", blockers: ["RC2"], confirmations: [], retroactive: false },
      { caseId: "req-004", outcome: "CREATED", blockers: [], confirmations: ["RC5"], retroactive: false },
      { caseId: "req-005", outcome: "CREATED", blockers: [], confirmations: ["RC8"], retroactive: true },
      { caseId: "req-006", outcome: "CREATED", blockers: [], confirmations: ["RC6"], retroactive: false },
    ])
    expect(result.cases[0]?.idempotentRetry).toBe(true)
    expect(output.at(-1)).toBe("Assertions: PASS")

    const lines = (await fs.readFile(path.join(outDir, "sap", "orders.jsonl"), "utf-8"))
      .trim().split("\n")
    expect(lines).toHaveLength(4)
    await expect(fs.access(path.join(outDir, "req-006", "traceability.json"))).resolves.toBeUndefined()
  })
})

describe("authoritative fixture input failures", () => {
  it("reports a missing required email with a readable typed tool error", async () => {
    const workspace = await fixtureWorkspace("req-001")
    await fs.unlink(path.join(workspace, "fixtures", "challenge-03", "requests", "req-001", "email.json"))
    const result = parse(await po.read_package.execute(
      { case_id: "req-001" },
      { directory: workspace, sessionId: "missing-email" },
    ))
    expect(result).toEqual({ ok: false, error: "missing email.json" })
  })

  it("reports malformed request JSON without crashing the tool", async () => {
    const workspace = await fixtureWorkspace("req-001")
    await fs.writeFile(
      path.join(workspace, "fixtures", "challenge-03", "requests", "req-001", "request.json"),
      "{not-json",
      "utf-8",
    )
    const result = parse(await po.read_package.execute(
      { case_id: "req-001" },
      { directory: workspace, sessionId: "malformed-request" },
    ))
    expect(result).toEqual({ ok: false, error: "malformed request.json" })
  })

  it("treats missing optional approval and quote as null, then blocks/requests confirmation", async () => {
    const workspace = await fixtureWorkspace("req-001")
    const caseDir = path.join(workspace, "fixtures", "challenge-03", "requests", "req-001")
    await Promise.all([
      fs.unlink(path.join(caseDir, "approval.json")),
      fs.unlink(path.join(caseDir, "quote.txt")),
    ])
    const outDir = await temporaryDirectory("po-missing-optional-")
    const ctx: po.ToolCtx = { directory: workspace, sessionId: "missing-optional", outDir }
    const read = parse<Package>(await po.read_package.execute({ case_id: "req-001" }, ctx))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.data.approval).toBeNull()
    expect(read.data.quote).toBeNull()
    const validation = parse<ValidationResult>(
      await po.validate.execute({ case_id: "req-001", package: read.data }, ctx),
    )
    expect(validation.ok).toBe(true)
    if (!validation.ok) return
    expect(validation.data.blockers.map((item) => item.code)).toContain("RC2")
    expect(validation.data.confirmations.map((item) => item.code)).toContain("RC5")
  })
})

describe("confirmation and payload authorization", () => {
  it("rejects a modified payload after confirmation and preserves authorization for the exact proposal", async () => {
    const outDir = await temporaryDirectory("po-payload-binding-")
    const confirmationStore = new InMemoryConfirmationStore()
    const ctx: po.ToolCtx = {
      directory: ROOT,
      sessionId: "payload-owner",
      outDir,
      confirmationStore,
      sapAdapter: new FileSapMock(outDir),
    }
    const built = await buildCase("req-004", ctx)
    const hash = confirmationStore.getStoredHash(built.pkg.request.request_id)
    expect(hash).toBeDefined()
    if (hash === undefined) return
    confirmationStore.confirm(built.pkg.request.request_id, hash)

    const modified = structuredClone(built.payload)
    const firstItem = modified.items[0]
    if (firstItem === undefined) throw new Error("missing item")
    firstItem.unit_price += 1
    const rejected = parse(await po.create.execute(
      { case_id: "req-004", payload: modified },
      ctx,
    ))
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error).toContain("payload mismatch")
    expect(confirmationStore.check(built.pkg.request.request_id, hash)).toBe("confirmed")

    const created = parse<{ po_number: string }>(await po.create.execute(
      { case_id: "req-004", payload: built.payload },
      ctx,
    ))
    expect(created.ok).toBe(true)
  })

  it("does not apply a confirmed req-004 authorization to req-006", async () => {
    const outDir = await temporaryDirectory("po-cross-request-")
    const confirmationStore = new InMemoryConfirmationStore()
    const ctx: po.ToolCtx = {
      directory: ROOT,
      sessionId: "cross-request",
      outDir,
      confirmationStore,
      sapAdapter: new FileSapMock(outDir),
    }
    const req004 = await buildCase("req-004", ctx)
    const req004Hash = confirmationStore.getStoredHash(req004.pkg.request.request_id)
    if (req004Hash === undefined) throw new Error("missing req-004 hash")
    confirmationStore.confirm(req004.pkg.request.request_id, req004Hash)

    const req006 = await buildCase("req-006", ctx)
    const attempt = parse(await po.create.execute(
      { case_id: "req-006", payload: req006.payload, confirmed: true },
      ctx,
    ))
    expect(attempt.ok).toBe(false)
    if (!attempt.ok) expect(attempt.error).toContain("Awaiting human confirmation")
    await expect(fs.access(path.join(outDir, "sap", "orders.jsonl"))).rejects.toThrow()
  })
})

describe("single-process persistence safety", () => {
  it("serializes concurrent creations for different requests into unique sequential PO numbers", async () => {
    const outDir = await temporaryDirectory("po-concurrent-distinct-")
    const ctx: po.ToolCtx = { directory: ROOT, sessionId: "build", outDir }
    const built = await buildCase("req-001", ctx)
    const second = structuredClone(built.payload)
    second.reference.request_id = "REQ-CONCURRENT-002"
    second.reference.email_id = "concurrent-email-002"
    const sap = new FileSapMock(outDir)

    const results = await Promise.all([
      sap.createOrder(built.payload),
      sap.createOrder(second),
    ])
    expect(results.map((item) => item.po_number).sort()).toEqual([
      "4500000001",
      "4500000002",
    ])
    const lines = (await fs.readFile(path.join(outDir, "sap", "orders.jsonl"), "utf-8"))
      .trim().split("\n")
    expect(lines).toHaveLength(2)
  })

  it("leaves no counter or order record when the authoritative order write fails", async () => {
    const outDir = await temporaryDirectory("po-write-failure-")
    const buildOut = await temporaryDirectory("po-write-failure-build-")
    const built = await buildCase("req-001", {
      directory: ROOT,
      sessionId: "write-failure-build",
      outDir: buildOut,
    })
    await fs.mkdir(path.join(outDir, "sap", "orders.jsonl"), { recursive: true })
    const sap = new FileSapMock(outDir)

    await expect(sap.createOrder(built.payload)).rejects.toThrow()
    await expect(fs.access(path.join(outDir, "sap", "counter.txt"))).rejects.toThrow()
    const sapEntries = await fs.readdir(path.join(outDir, "sap"))
    expect(sapEntries).toEqual(["orders.jsonl"])
  })
})
