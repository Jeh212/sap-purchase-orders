import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as po from "../../src/tools/po.js"
import { InMemoryConfirmationStore } from "../../src/domain/confirmation.js"
import { FileSapMock } from "../../src/sap/mock.js"
import type { PurchaseOrder, ValidationResult } from "../../src/domain/schemas.js"
import type { SapAdapter } from "../../src/sap/adapter.js"
import { PayloadConflictError } from "../../src/sap/mock.js"
import { hashPurchaseOrder } from "../../src/domain/payload.js"

const CWD = process.cwd()

// ── Test context factory ───────────────────────────────────────────────────────

type TestCtx = {
  directory: string
  sessionId: string
  outDir: string
  confirmationStore: InMemoryConfirmationStore
  sapAdapter: FileSapMock
}

async function loadSuppliers(): Promise<Array<{ sap_code: string; tax_id: string; active: boolean }>> {
  const raw = JSON.parse(
    await fs.readFile(
      path.join(CWD, "fixtures/challenge-03/master-data/suppliers.json"),
      "utf-8",
    ),
  ) as Array<{ sap_code: string; tax_id: string; active: boolean }>
  return raw
}

async function makeCtx(sessionId = "test"): Promise<[TestCtx, () => Promise<void>]> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "po-test-"))
  const suppliers = await loadSuppliers()
  const store = new InMemoryConfirmationStore()
  const sap = new FileSapMock(tmpDir, suppliers)
  const ctx: TestCtx = {
    directory: CWD,
    sessionId,
    outDir: tmpDir,
    confirmationStore: store,
    sapAdapter: sap,
  }
  const cleanup = (): Promise<void> =>
    fs.rm(tmpDir, { recursive: true, force: true })
  return [ctx, cleanup]
}

// ── Parse helpers ──────────────────────────────────────────────────────────────

type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string }

function parseResult<T>(raw: string): ToolResult<T> {
  return JSON.parse(raw) as ToolResult<T>
}

// Minimal valid PurchaseOrder for passing to po_create in blocked cases
const MINIMAL_PO: PurchaseOrder = {
  reference: { request_id: "req-001", email_id: "email-001", quote_ref: null },
  company_code: "1000",
  purchasing_org: "1000",
  supplier: { sap_code: "100234", tax_id: "900555111", name: "TecnoSuministros S.A.S." },
  currency: "COP",
  payment_terms: "Z030",
  approver: {
    email: "mlopez@periferia-fictitious.com",
    approval_date: "2026-08-21T10:02:00-05:00",
    evidence_sha256: "a".repeat(64),
  },
  items: [{
    number: 10,
    description: "Antivirus license renewal",
    quantity: 120,
    unit: "EA",
    unit_price: 95000,
    cost_center: "CC-1010",
    subarea: "Infrastructure",
    tax_code: "C1",
  }],
  exceptions: [],
}

// ── req-001: happy path + idempotency ─────────────────────────────────────────

describe("req-001 — happy path (no blockers, no confirmations)", () => {
  let ctx: TestCtx
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;[ctx, cleanup] = await makeCtx("session-001")
  })
  afterEach(() => cleanup())

  it("read_package returns ok:true with valid Package", async () => {
    const r = parseResult<{ request: { request_id: string } }>(
      await po.read_package.execute({ case_id: "req-001" }, ctx),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.request.request_id).toBe("REQ-2026-001")
  })

  it("validate returns eligible:true, no blockers, no confirmations", async () => {
    const r = parseResult<ValidationResult>(
      await po.validate.execute({ case_id: "req-001", package: {} }, ctx),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.eligible).toBe(true)
    expect(r.data.blockers).toHaveLength(0)
    expect(r.data.confirmations).toHaveLength(0)
    expect(r.data.retroactive).toBe(false)
  })

  it("generate_evidence returns ok:true with sha256", async () => {
    const r = parseResult<{ path: string; sha256: string }>(
      await po.generate_evidence.execute({ case_id: "req-001" }, ctx),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.sha256).toMatch(/^[a-f0-9]{64}$/)
    // File must exist and contain the SHA256 line
    const approvalTxt = await fs.readFile(
      path.join(ctx.outDir, "req-001", "approval.txt"),
      "utf-8",
    )
    expect(approvalTxt).toContain(`SHA256: ${r.data.sha256}`)
  })

  it("generate_evidence SHA256 is deterministic (same content → same hash)", async () => {
    const r1 = parseResult<{ sha256: string }>(
      await po.generate_evidence.execute({ case_id: "req-001" }, ctx),
    )
    const r2 = parseResult<{ sha256: string }>(
      await po.generate_evidence.execute({ case_id: "req-001" }, ctx),
    )
    expect(r1.ok && r2.ok && r1.data.sha256 === r2.data.sha256).toBe(true)
  })

  it("build_payload returns ok:true with valid PO payload", async () => {
    await po.generate_evidence.execute({ case_id: "req-001" }, ctx)
    const r = parseResult<{ payload: PurchaseOrder; traceability_path: string }>(
      await po.build_payload.execute({ case_id: "req-001", package: {}, derived: {} }, ctx),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.payload.reference.request_id).toBe("REQ-2026-001")
    expect(r.data.payload.supplier.sap_code).toBe("100234")
    expect(r.data.payload.items[0]?.unit).toBe("EA")
    expect(r.data.payload.items[0]?.unit_price).toBe(95000)
    expect(r.data.payload.approver.evidence_sha256).toMatch(/^[a-f0-9]{64}$/)
    // traceability file must exist
    await expect(
      fs.access(path.join(CWD, r.data.traceability_path)),
    ).resolves.toBeUndefined()
  })

  it("create returns ok:true with po_number and idempotent:false", async () => {
    await po.generate_evidence.execute({ case_id: "req-001" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-001", package: {}, derived: {} }, ctx),
    )
    expect(buildR.ok).toBe(true)
    if (!buildR.ok) return

    const r = parseResult<{ po_number: string; date: string; idempotent: boolean }>(
      await po.create.execute({ case_id: "req-001", payload: buildR.data.payload }, ctx),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.po_number).toMatch(/^450\d{7}$/)
    expect(r.data.idempotent).toBe(false)
  })

  it("second create returns same po_number and idempotent:true", async () => {
    await po.generate_evidence.execute({ case_id: "req-001" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-001", package: {}, derived: {} }, ctx),
    )
    if (!buildR.ok) throw new Error("build failed")

    const r1 = parseResult<{ po_number: string; idempotent: boolean }>(
      await po.create.execute({ case_id: "req-001", payload: buildR.data.payload }, ctx),
    )
    const r2 = parseResult<{ po_number: string; idempotent: boolean }>(
      await po.create.execute({ case_id: "req-001", payload: buildR.data.payload }, ctx),
    )

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return
    expect(r1.data.po_number).toBe(r2.data.po_number)
    expect(r2.data.idempotent).toBe(true)
  })

  it("orders.jsonl has exactly one line after two creates for the same request", async () => {
    await po.generate_evidence.execute({ case_id: "req-001" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-001", package: {}, derived: {} }, ctx),
    )
    if (!buildR.ok) throw new Error("build failed")
    await po.create.execute({ case_id: "req-001", payload: buildR.data.payload }, ctx)
    await po.create.execute({ case_id: "req-001", payload: buildR.data.payload }, ctx)

    const ordersText = await fs.readFile(
      path.join(ctx.outDir, "sap", "orders.jsonl"),
      "utf-8",
    )
    const lines = ordersText
      .split("\n")
      .filter((l) => l.trim().length > 0)
    expect(lines).toHaveLength(1)
  })

  it("payload.approver.evidence_sha256 matches the SHA256 in approval.txt", async () => {
    const evR = parseResult<{ sha256: string }>(
      await po.generate_evidence.execute({ case_id: "req-001" }, ctx),
    )
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-001", package: {}, derived: {} }, ctx),
    )
    expect(evR.ok && buildR.ok).toBe(true)
    if (!evR.ok || !buildR.ok) return
    expect(buildR.data.payload.approver.evidence_sha256).toBe(evR.data.sha256)
  })

  it("control.csv contains VALIDATION and CREATED rows", async () => {
    await po.validate.execute({ case_id: "req-001", package: {} }, ctx)
    await po.generate_evidence.execute({ case_id: "req-001" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-001", package: {}, derived: {} }, ctx),
    )
    if (!buildR.ok) throw new Error("build failed")
    await po.create.execute({ case_id: "req-001", payload: buildR.data.payload }, ctx)

    const csv = await fs.readFile(path.join(ctx.outDir, "control.csv"), "utf-8")
    expect(csv).toContain("VALIDATION")
    expect(csv).toContain("CREATED")
  })

  it("build_payload returns ok:false if generate_evidence has not been called", async () => {
    const r = parseResult<unknown>(
      await po.build_payload.execute({ case_id: "req-001", package: {}, derived: {} }, ctx),
    )
    expect(r.ok).toBe(false)
  })
})

// ── req-002: RC1 blocked (supplier not in master) ─────────────────────────────

describe("req-002 — RC1 blocked (supplier not in master data)", () => {
  let ctx: TestCtx
  let cleanup: () => Promise<void>

  beforeEach(async () => { ;[ctx, cleanup] = await makeCtx("session-002") })
  afterEach(() => cleanup())

  it("validate returns eligible:false with RC1 blocker", async () => {
    const r = parseResult<ValidationResult>(
      await po.validate.execute({ case_id: "req-002", package: {} }, ctx),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.eligible).toBe(false)
    expect(r.data.blockers.map((b) => b.code)).toContain("RC1")
  })

  it("create returns ok:false and logs BLOCKED in control.csv", async () => {
    const r = parseResult<unknown>(
      await po.create.execute({ case_id: "req-002", payload: MINIMAL_PO }, ctx),
    )
    expect(r.ok).toBe(false)

    const csv = await fs.readFile(path.join(ctx.outDir, "control.csv"), "utf-8")
    expect(csv).toContain("BLOCKED")
    expect(csv).toContain("RC1")
  })
})

// ── req-003: RC2 blocked (wrong approver) ─────────────────────────────────────

describe("req-003 — RC2 blocked (approver not authorized for CC-2020)", () => {
  let ctx: TestCtx
  let cleanup: () => Promise<void>

  beforeEach(async () => { ;[ctx, cleanup] = await makeCtx("session-003") })
  afterEach(() => cleanup())

  it("validate returns eligible:false with RC2 blocker", async () => {
    const r = parseResult<ValidationResult>(
      await po.validate.execute({ case_id: "req-003", package: {} }, ctx),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.eligible).toBe(false)
    expect(r.data.blockers.map((b) => b.code)).toContain("RC2")
  })

  it("create returns ok:false (BLOCKED)", async () => {
    const r = parseResult<unknown>(
      await po.create.execute({ case_id: "req-003", payload: MINIMAL_PO }, ctx),
    )
    expect(r.ok).toBe(false)
  })
})

// ── req-004: RC5 confirmation (quote 6% over request) ─────────────────────────

describe("req-004 — RC5 confirmation required (quote differs > 2%)", () => {
  let ctx: TestCtx
  let cleanup: () => Promise<void>

  beforeEach(async () => { ;[ctx, cleanup] = await makeCtx("session-004") })
  afterEach(() => cleanup())

  it("binds pending confirmation only after final evidence-backed payload construction", async () => {
    const r = parseResult<ValidationResult>(
      await po.validate.execute({ case_id: "req-004", package: {} }, ctx),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.eligible).toBe(true)
    expect(r.data.confirmations.map((c) => c.code)).toContain("RC5")
    expect(ctx.confirmationStore.getStoredHash("REQ-2026-004")).toBeUndefined()

    await po.generate_evidence.execute({ case_id: "req-004" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute(
        { case_id: "req-004", package: {}, derived: {} },
        ctx,
      ),
    )
    if (!buildR.ok) throw new Error("build failed")

    const hash = ctx.confirmationStore.getStoredHash("REQ-2026-004")
    expect(hash).toBe(hashPurchaseOrder(buildR.data.payload))

    const csv = await fs.readFile(path.join(ctx.outDir, "control.csv"), "utf-8")
    expect(csv).toContain("PENDING")
  })

  it("create WITHOUT confirmation returns ok:false (PENDING) and logs PENDING", async () => {
    await po.validate.execute({ case_id: "req-004", package: {} }, ctx)
    await po.generate_evidence.execute({ case_id: "req-004" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-004", package: {}, derived: {} }, ctx),
    )
    if (!buildR.ok) throw new Error("build failed")

    const r = parseResult<unknown>(
      await po.create.execute({ case_id: "req-004", payload: buildR.data.payload }, ctx),
    )
    expect(r.ok).toBe(false)

    const csv = await fs.readFile(path.join(ctx.outDir, "control.csv"), "utf-8")
    expect(csv).toContain("PENDING")
  })

  it("create AFTER confirmation returns ok:true with po_number", async () => {
    await po.validate.execute({ case_id: "req-004", package: {} }, ctx)
    await po.generate_evidence.execute({ case_id: "req-004" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-004", package: {}, derived: {} }, ctx),
    )
    if (!buildR.ok) throw new Error("build failed")

    // Simulate human confirmation
    const hash = ctx.confirmationStore.getStoredHash("REQ-2026-004")
    if (!hash) throw new Error("no hash in store")
    ctx.confirmationStore.confirm("REQ-2026-004", hash)

    const r = parseResult<{ po_number: string; idempotent: boolean }>(
      await po.create.execute({ case_id: "req-004", payload: buildR.data.payload }, ctx),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.po_number).toMatch(/^450\d{7}$/)
    expect(r.data.idempotent).toBe(false)
  })

  it("control.csv shows PENDING then CREATED rows", async () => {
    await po.validate.execute({ case_id: "req-004", package: {} }, ctx)
    await po.generate_evidence.execute({ case_id: "req-004" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-004", package: {}, derived: {} }, ctx),
    )
    if (!buildR.ok) throw new Error("build failed")

    // First attempt — pending
    await po.create.execute({ case_id: "req-004", payload: buildR.data.payload }, ctx)

    // Confirm
    const hash = ctx.confirmationStore.getStoredHash("REQ-2026-004")!
    ctx.confirmationStore.confirm("REQ-2026-004", hash)

    // Second attempt — created
    await po.create.execute({ case_id: "req-004", payload: buildR.data.payload }, ctx)

    const csv = await fs.readFile(path.join(ctx.outDir, "control.csv"), "utf-8")
    expect(csv).toContain("PENDING")
    expect(csv).toContain("CREATED")
  })

  it("payload.approver.evidence_sha256 matches out/req-004/approval.txt SHA256 field", async () => {
    await po.validate.execute({ case_id: "req-004", package: {} }, ctx)
    const evR = parseResult<{ sha256: string }>(
      await po.generate_evidence.execute({ case_id: "req-004" }, ctx),
    )
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-004", package: {}, derived: {} }, ctx),
    )
    expect(evR.ok && buildR.ok).toBe(true)
    if (!evR.ok || !buildR.ok) return
    expect(buildR.data.payload.approver.evidence_sha256).toBe(evR.data.sha256)
  })
})

// ── req-005: RC8 retroactive (invoice predates request) ───────────────────────

describe("req-005 — RC8 retroactive (invoice date < request date)", () => {
  let ctx: TestCtx
  let cleanup: () => Promise<void>

  beforeEach(async () => { ;[ctx, cleanup] = await makeCtx("session-005") })
  afterEach(() => cleanup())

  it("validate returns retroactive:true and confirmations:[RC8]", async () => {
    const r = parseResult<ValidationResult>(
      await po.validate.execute({ case_id: "req-005", package: {} }, ctx),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.retroactive).toBe(true)
    expect(r.data.confirmations.map((c) => c.code)).toContain("RC8")
  })

  it("create after confirmation sets retroactive:true in control.csv", async () => {
    await po.validate.execute({ case_id: "req-005", package: {} }, ctx)
    await po.generate_evidence.execute({ case_id: "req-005" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-005", package: {}, derived: {} }, ctx),
    )
    if (!buildR.ok) throw new Error("build failed")

    const hash = ctx.confirmationStore.getStoredHash("REQ-2026-005")!
    ctx.confirmationStore.confirm("REQ-2026-005", hash)

    const r = parseResult<{ po_number: string }>(
      await po.create.execute({ case_id: "req-005", payload: buildR.data.payload }, ctx),
    )
    expect(r.ok).toBe(true)

    const csv = await fs.readFile(path.join(ctx.outDir, "control.csv"), "utf-8")
    expect(csv).toContain("true") // retroactive column
    expect(csv).toContain("CREATED")
  })
})

// ── req-006: RC6 derived tax code + RC7 derived payment terms ─────────────────

describe("req-006 — RC6 derived tax_code, RC7 derived payment_terms", () => {
  let ctx: TestCtx
  let cleanup: () => Promise<void>

  beforeEach(async () => { ;[ctx, cleanup] = await makeCtx("session-006") })
  afterEach(() => cleanup())

  it("validate returns eligible:true, confirmations:[RC6], derived:{tax_code:C1, payment_terms:Z030}", async () => {
    const r = parseResult<ValidationResult>(
      await po.validate.execute({ case_id: "req-006", package: {} }, ctx),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.eligible).toBe(true)
    expect(r.data.confirmations.map((c) => c.code)).toContain("RC6")
    expect(r.data.derived.tax_code).toBe("C1")
    expect(r.data.derived.payment_terms).toBe("Z030")
  })

  it("create after confirmation returns ok:true; payload has derived tax_code C1", async () => {
    await po.validate.execute({ case_id: "req-006", package: {} }, ctx)
    await po.generate_evidence.execute({ case_id: "req-006" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-006", package: {}, derived: {} }, ctx),
    )
    if (!buildR.ok) throw new Error(`build failed: ${(buildR as { error: string }).error}`)

    const hash = ctx.confirmationStore.getStoredHash("REQ-2026-006")!
    ctx.confirmationStore.confirm("REQ-2026-006", hash)

    const r = parseResult<{ po_number: string }>(
      await po.create.execute({ case_id: "req-006", payload: buildR.data.payload }, ctx),
    )
    expect(r.ok).toBe(true)
    expect(buildR.data.payload.items[0]?.tax_code).toBe("C1")
    expect(buildR.data.payload.payment_terms).toBe("Z030")
    expect(buildR.data.payload.items[0]?.unit).toBe("EA") // "Headsets" — no "hour"
  })
})

// ── Unit detection ─────────────────────────────────────────────────────────────

describe("unit detection in payload", () => {
  let ctx: TestCtx
  let cleanup: () => Promise<void>

  beforeEach(async () => { ;[ctx, cleanup] = await makeCtx("session-unit") })
  afterEach(() => cleanup())

  it("req-004 description contains 'hours' → unit = H", async () => {
    await po.generate_evidence.execute({ case_id: "req-004" }, ctx)
    const r = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-004", package: {}, derived: {} }, ctx),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.payload.items[0]?.unit).toBe("H")
  })

  it("req-001 description has no 'hour' → unit = EA", async () => {
    await po.generate_evidence.execute({ case_id: "req-001" }, ctx)
    const r = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-001", package: {}, derived: {} }, ctx),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.payload.items[0]?.unit).toBe("EA")
  })
})

// ── Edge cases ─────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  let ctx: TestCtx
  let cleanup: () => Promise<void>

  beforeEach(async () => { ;[ctx, cleanup] = await makeCtx("session-edge") })
  afterEach(() => cleanup())

  it("path traversal case_id '../.env' → ok:false", async () => {
    const r = parseResult<unknown>(
      await po.read_package.execute({ case_id: "../.env" }, ctx),
    )
    expect(r.ok).toBe(false)
  })

  it("invalid case_id with special chars → ok:false", async () => {
    const r = parseResult<unknown>(
      await po.read_package.execute({ case_id: "req-001; ls" }, ctx),
    )
    expect(r.ok).toBe(false)
  })

  it("unknown case_id → ok:false 'case not found'", async () => {
    const r = parseResult<unknown>(
      await po.read_package.execute({ case_id: "req-999" }, ctx),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("not found")
  })

  it("generate_evidence for unknown case → ok:false", async () => {
    const r = parseResult<unknown>(
      await po.generate_evidence.execute({ case_id: "req-999" }, ctx),
    )
    expect(r.ok).toBe(false)
  })

  it("create called without generate_evidence → ok:false for valid case", async () => {
    // req-001 is eligible but approval.txt doesn't exist yet
    const r = parseResult<unknown>(
      await po.create.execute({ case_id: "req-001", payload: MINIMAL_PO }, ctx),
    )
    expect(r.ok).toBe(false)
  })

  it("confirmation consumed → second create returns IDEMPOTENT (idempotency beats consumed)", async () => {
    await po.validate.execute({ case_id: "req-004", package: {} }, ctx)
    await po.generate_evidence.execute({ case_id: "req-004" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-004", package: {}, derived: {} }, ctx),
    )
    if (!buildR.ok) throw new Error("build failed")

    const hash = ctx.confirmationStore.getStoredHash("REQ-2026-004")!
    ctx.confirmationStore.confirm("REQ-2026-004", hash)

    // First create — succeeds and consumes confirmation
    const r1 = parseResult<{ po_number: string; idempotent: boolean }>(
      await po.create.execute({ case_id: "req-004", payload: buildR.data.payload }, ctx),
    )
    expect(r1.ok).toBe(true)

    // Second create — same requestId hits idempotency, same PO returned
    const r2 = parseResult<{ po_number: string; idempotent: boolean }>(
      await po.create.execute({ case_id: "req-004", payload: buildR.data.payload }, ctx),
    )
    // Idempotency wins: the PO already exists in orders.jsonl
    expect(r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return
    expect(r2.data.po_number).toBe(r1.data.po_number)
    expect(r2.data.idempotent).toBe(true)
  })
})

// ── SAP mock — counter repair ──────────────────────────────────────────────────

describe("FileSapMock — counter repair", () => {
  it("repairCounter sets counter to max(existing)+1 after creating orders", async () => {
    const [ctx2, cleanup2] = await makeCtx("session-repair")
    try {
      await po.generate_evidence.execute({ case_id: "req-001" }, ctx2)
      const buildR = parseResult<{ payload: PurchaseOrder }>(
        await po.build_payload.execute({ case_id: "req-001", package: {}, derived: {} }, ctx2),
      )
      if (!buildR.ok) throw new Error("build failed")
      await po.create.execute({ case_id: "req-001", payload: buildR.data.payload }, ctx2)

      // Delete the counter file to simulate a restart
      await fs.unlink(path.join(ctx2.outDir, "sap", "counter.txt")).catch(() => {/* ignore */})

      // repairCounter should reconstruct it
      await ctx2.sapAdapter.repairCounter()

      const counterTxt = await fs.readFile(
        path.join(ctx2.outDir, "sap", "counter.txt"),
        "utf-8",
      )
      const counter = parseInt(counterTxt.trim(), 10)
      expect(counter).toBeGreaterThan(1)
    } finally {
      await cleanup2()
    }
  })
})

// ── Regression: consume-after-write-failure ────────────────────────────────────

describe("regression: consume() is called AFTER successful persistence", () => {
  let ctx: TestCtx
  let cleanup: () => Promise<void>

  beforeEach(async () => { ;[ctx, cleanup] = await makeCtx("session-consume-regress") })
  afterEach(() => cleanup())

  it("if SAP write throws, confirmation remains available for retry", async () => {
    // Set up a failing SAP adapter
    let callCount = 0
    const failingAdapter: SapAdapter = {
      createOrder: async () => {
        callCount++
        if (callCount === 1) throw new Error("simulated SAP write failure")
        return { po_number: "4500000001", date: "2026-01-01" }
      },
      lookupSupplier: (tax_id: string) => ctx.sapAdapter.lookupSupplier(tax_id),
      findOrderByReference: () => Promise.resolve(null),
    }
    const failCtx = { ...ctx, sapAdapter: failingAdapter }

    await po.validate.execute({ case_id: "req-004", package: {} }, failCtx)
    await po.generate_evidence.execute({ case_id: "req-004" }, failCtx)
    await po.build_payload.execute({ case_id: "req-004", package: {}, derived: {} }, failCtx)

    const hash = ctx.confirmationStore.getStoredHash("REQ-2026-004")!
    ctx.confirmationStore.confirm("REQ-2026-004", hash)

    // First create — SAP write fails
    const r1 = parseResult<unknown>(
      await po.create.execute({ case_id: "req-004", payload: MINIMAL_PO }, failCtx),
    )
    expect(r1.ok).toBe(false) // first attempt fails

    // Confirmation must still be in 'confirmed' state (not consumed) so a retry is possible
    const statusAfterFailure = ctx.confirmationStore.check("REQ-2026-004", hash)
    expect(statusAfterFailure).toBe("confirmed")
  })
})

// ── Regression: BLOCKED logged via po_validate ────────────────────────────────

describe("regression: BLOCKED row written by po_validate, not only by po_create", () => {
  it("req-002 (RC1 blocked) — BLOCKED row in control.csv after validate, no po_create called", async () => {
    const [ctx2, cleanup2] = await makeCtx("session-blocked-csv")
    try {
      const r = parseResult<ValidationResult>(
        await po.validate.execute({ case_id: "req-002", package: {} }, ctx2),
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.data.eligible).toBe(false)

      const csv = await fs.readFile(path.join(ctx2.outDir, "control.csv"), "utf-8")
      expect(csv).toContain("BLOCKED")
      expect(csv).toContain("RC1")
    } finally {
      await cleanup2()
    }
  })
})

// ── Regression: payload conflict detection ────────────────────────────────────

describe("regression: same request_id with different payload returns conflict error", () => {
  let ctx: TestCtx
  let cleanup: () => Promise<void>

  beforeEach(async () => { ;[ctx, cleanup] = await makeCtx("session-conflict") })
  afterEach(() => cleanup())

  it("FileSapMock.createOrder throws PayloadConflictError when same request_id has different supplier", async () => {
    await po.generate_evidence.execute({ case_id: "req-001" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-001", package: {}, derived: {} }, ctx),
    )
    if (!buildR.ok) throw new Error("build failed")

    // First create — succeeds
    await po.create.execute({ case_id: "req-001", payload: buildR.data.payload }, ctx)

    // Second create — tamper with supplier tax_id to simulate conflicting payload
    const tampered = {
      ...buildR.data.payload,
      supplier: { ...buildR.data.payload.supplier, tax_id: "DIFFERENT-TAX-ID" },
    }
    await expect(
      ctx.sapAdapter.createOrder(tampered),
    ).rejects.toBeInstanceOf(PayloadConflictError)
  })

  it("canonical comparison detects conflicts in every payload section, not only financial fields", async () => {
    await po.generate_evidence.execute({ case_id: "req-001" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-001", package: {}, derived: {} }, ctx),
    )
    if (!buildR.ok) throw new Error("build failed")
    await ctx.sapAdapter.createOrder(buildR.data.payload)

    const mutations: PurchaseOrder[] = [
      { ...buildR.data.payload, payment_terms: "Z060" },
      {
        ...buildR.data.payload,
        reference: { ...buildR.data.payload.reference, quote_ref: "QUOTE OTHER" },
      },
      {
        ...buildR.data.payload,
        approver: {
          ...buildR.data.payload.approver,
          evidence_sha256: "b".repeat(64),
        },
      },
      {
        ...buildR.data.payload,
        items: buildR.data.payload.items.map((item) => ({
          ...item,
          description: "Different description",
        })),
      },
      {
        ...buildR.data.payload,
        items: buildR.data.payload.items.map((item) => ({
          ...item,
          tax_code: "C2",
        })),
      },
      {
        ...buildR.data.payload,
        exceptions: [{ code: "RC5", detail: "Different", confirmed_by: "session:x" }],
      },
    ]

    for (const mutation of mutations) {
      await expect(ctx.sapAdapter.createOrder(mutation)).rejects.toBeInstanceOf(
        PayloadConflictError,
      )
    }
  })

  it("po_create returns ok:false with conflict message when payload conflicts", async () => {
    await po.generate_evidence.execute({ case_id: "req-001" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-001", package: {}, derived: {} }, ctx),
    )
    if (!buildR.ok) throw new Error("build failed")

    // First create — succeeds
    await po.create.execute({ case_id: "req-001", payload: buildR.data.payload }, ctx)

    // Inject a conflicting adapter for the second call
    const conflictAdapter: SapAdapter = {
      createOrder: async (order) => {
        throw new PayloadConflictError("4500000001", `request_id=${order.reference.request_id} already created PO 4500000001 with different financial data`)
      },
      lookupSupplier: (tax_id: string) => ctx.sapAdapter.lookupSupplier(tax_id),
      findOrderByReference: () => Promise.resolve(null), // pretend PO doesn't exist yet to reach conflict
    }
    const conflictCtx = { ...ctx, sapAdapter: conflictAdapter }

    const r = parseResult<unknown>(
      await po.create.execute({ case_id: "req-001", payload: buildR.data.payload }, conflictCtx),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("conflict")
  })
})

// ── Concurrent duplicate creates ───────────────────────────────────────────────

describe("concurrent creates — idempotency under parallel calls", () => {
  let ctx: TestCtx
  let cleanup: () => Promise<void>

  beforeEach(async () => { ;[ctx, cleanup] = await makeCtx("session-concurrent") })
  afterEach(() => cleanup())

  it("two concurrent creates for req-001 produce same po_number, one row in orders.jsonl", async () => {
    await po.generate_evidence.execute({ case_id: "req-001" }, ctx)
    const buildR = parseResult<{ payload: PurchaseOrder }>(
      await po.build_payload.execute({ case_id: "req-001", package: {}, derived: {} }, ctx),
    )
    if (!buildR.ok) throw new Error("build failed")

    const [r1, r2] = await Promise.all([
      po.create.execute({ case_id: "req-001", payload: buildR.data.payload }, ctx).then((raw) =>
        parseResult<{ po_number: string; idempotent: boolean }>(raw),
      ),
      po.create.execute({ case_id: "req-001", payload: buildR.data.payload }, ctx).then((raw) =>
        parseResult<{ po_number: string; idempotent: boolean }>(raw),
      ),
    ])

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return
    expect(r1.data.po_number).toBe(r2.data.po_number)

    const ordersText = await fs.readFile(
      path.join(ctx.outDir, "sap", "orders.jsonl"),
      "utf-8",
    )
    const lines = ordersText.split("\n").filter((l) => l.trim().length > 0)
    expect(lines).toHaveLength(1)
  })
})
