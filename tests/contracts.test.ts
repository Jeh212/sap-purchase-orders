/**
 * Phase 1 contract tests.
 * Verifies: tool names, argument schemas, serialized JSON result format.
 * Does NOT test business logic (Phase 2/3).
 */

import { describe, it, expect } from "vitest"
import * as po from "../src/tools/po.js"
import type { PurchaseOrder } from "../src/domain/schemas.js"

const CTX = { directory: process.cwd(), sessionId: "test-session-001" }

// Minimal valid PurchaseOrder for contract-level tests (stubs ignore content).
const MINIMAL_PO: PurchaseOrder = {
  reference: { request_id: "req-001", email_id: "email-001", quote_ref: null },
  company_code: "1000",
  purchasing_org: "1000",
  supplier: {
    sap_code: "100234",
    tax_id: "900555111",
    name: "TecnoSuministros S.A.S.",
  },
  currency: "COP",
  payment_terms: "Z030",
  approver: {
    email: "mlopez@periferia-fictitious.com",
    approval_date: "2026-08-21T10:02:00-05:00",
    evidence_sha256: "abc123def456",
  },
  items: [
    {
      number: 10,
      description: "Antivirus license renewal",
      quantity: 120,
      unit: "EA",
      unit_price: 95000,
      cost_center: "CC-1010",
      subarea: "Infrastructure",
      tax_code: "C1",
    },
  ],
  exceptions: [],
}

// ── Tool name contract ────────────────────────────────────────────────────────

describe("tool name contract (PRD 6.2: name seen by model = po_<export>)", () => {
  it("all five required exports are present", () => {
    const required = [
      "read_package",
      "validate",
      "generate_evidence",
      "build_payload",
      "create",
    ]
    const actual = Object.keys(po)
    for (const name of required) {
      expect(actual, `export '${name}' is missing`).toContain(name)
    }
  })

  it("no unexpected exports (each maps to po_<name>)", () => {
    const allowed = new Set([
      "read_package",
      "validate",
      "generate_evidence",
      "build_payload",
      "create",
    ])
    for (const key of Object.keys(po)) {
      expect(allowed.has(key), `unexpected export '${key}'`).toBe(true)
    }
  })
})

// ── Tool structure contract ───────────────────────────────────────────────────

describe("tool structure contract (PRD 6.2: description, args, execute)", () => {
  const tools = [
    po.read_package,
    po.validate,
    po.generate_evidence,
    po.build_payload,
    po.create,
  ] as const

  for (const tool of tools) {
    it(`po_${getExportName(tool)} has description (non-empty string)`, () => {
      expect(typeof tool.description).toBe("string")
      expect(tool.description.length).toBeGreaterThan(0)
    })

    it(`po_${getExportName(tool)} has args object`, () => {
      expect(typeof tool.args).toBe("object")
      expect(tool.args).not.toBeNull()
    })

    it(`po_${getExportName(tool)} has execute function`, () => {
      expect(typeof tool.execute).toBe("function")
    })
  }
})

// ── Argument schema contract (PRD 6.2 exact inputs) ──────────────────────────

describe("argument schema contract (PRD 6.2 exact inputs)", () => {
  describe("po_read_package args: { case_id }", () => {
    it("accepts valid case_id string", () => {
      expect(po.read_package.args.case_id.safeParse("req-001").success).toBe(
        true,
      )
    })
    it("rejects non-string case_id", () => {
      expect(po.read_package.args.case_id.safeParse(42).success).toBe(false)
    })
    it("has exactly { case_id }", () => {
      expect(Object.keys(po.read_package.args)).toEqual(["case_id"])
    })
  })

  describe("po_validate args: { case_id, package }", () => {
    it("has exactly { case_id, package }", () => {
      expect(Object.keys(po.validate.args)).toEqual(
        expect.arrayContaining(["case_id", "package"]),
      )
      expect(Object.keys(po.validate.args)).toHaveLength(2)
    })
    it("package accepts a record", () => {
      expect(
        po.validate.args.package.safeParse({ key: "value" }).success,
      ).toBe(true)
    })
  })

  describe("po_generate_evidence args: { case_id }", () => {
    it("has exactly { case_id }", () => {
      expect(Object.keys(po.generate_evidence.args)).toEqual(["case_id"])
    })
  })

  describe("po_build_payload args: { case_id, package, derived }", () => {
    it("has exactly { case_id, package, derived } — no evidence_sha256", () => {
      const keys = Object.keys(po.build_payload.args)
      expect(keys).toEqual(expect.arrayContaining(["case_id", "package", "derived"]))
      expect(keys).toHaveLength(3)
      expect(keys).not.toContain("evidence_sha256")
    })
    it("derived accepts a record", () => {
      expect(
        po.build_payload.args.derived.safeParse({ tax_code: "C1" }).success,
      ).toBe(true)
    })
  })

  describe("po_create args: { case_id, payload, confirmed? } (PRD 6.2)", () => {
    it("has exactly { case_id, payload, confirmed }", () => {
      const keys = Object.keys(po.create.args)
      expect(keys).toEqual(
        expect.arrayContaining(["case_id", "payload", "confirmed"]),
      )
      expect(keys).toHaveLength(3)
    })
    it("does NOT have payload_hash (internal mechanism only)", () => {
      expect(Object.keys(po.create.args)).not.toContain("payload_hash")
    })
    it("payload accepts a valid PurchaseOrder", () => {
      expect(po.create.args.payload.safeParse(MINIMAL_PO).success).toBe(true)
    })
    it("payload rejects an empty object", () => {
      expect(po.create.args.payload.safeParse({}).success).toBe(false)
    })
    it("confirmed is optional — accepts undefined", () => {
      expect(po.create.args.confirmed.safeParse(undefined).success).toBe(true)
    })
    it("confirmed accepts boolean true", () => {
      expect(po.create.args.confirmed.safeParse(true).success).toBe(true)
    })
    it("confirmed accepts boolean false", () => {
      expect(po.create.args.confirmed.safeParse(false).success).toBe(true)
    })
    it("confirmed rejects a string", () => {
      expect(po.create.args.confirmed.safeParse("yes").success).toBe(false)
    })
  })
})

// ── Serialized JSON result format contract ────────────────────────────────────

describe("execute() result format: JSON string with { ok: boolean }", () => {
  it("po_read_package returns a parseable JSON string with ok field", async () => {
    const raw = await po.read_package.execute({ case_id: "req-001" }, CTX)
    assertToolResult(raw, "po_read_package")
  })

  it("po_validate returns a parseable JSON string with ok field", async () => {
    const raw = await po.validate.execute(
      { case_id: "req-001", package: {} },
      CTX,
    )
    assertToolResult(raw, "po_validate")
  })

  it("po_generate_evidence returns a parseable JSON string with ok field", async () => {
    const raw = await po.generate_evidence.execute({ case_id: "req-001" }, CTX)
    assertToolResult(raw, "po_generate_evidence")
  })

  it("po_build_payload returns a parseable JSON string with ok field", async () => {
    const raw = await po.build_payload.execute(
      { case_id: "req-001", package: {}, derived: {} },
      CTX,
    )
    assertToolResult(raw, "po_build_payload")
  })

  it("po_create returns a parseable JSON string with ok field", async () => {
    const raw = await po.create.execute(
      { case_id: "req-001", payload: MINIMAL_PO, confirmed: false },
      CTX,
    )
    assertToolResult(raw, "po_create")
  })

  it("returns { ok: false, error: string } when case_id does not exist", async () => {
    const raw = await po.read_package.execute({ case_id: "does-not-exist-xyz" }, CTX)
    const result = JSON.parse(raw) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe("string")
    expect(result.error!.length).toBeGreaterThan(0)
  })
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function assertToolResult(raw: string, name: string): void {
  expect(typeof raw, `${name}: execute must return a string`).toBe("string")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${name}: execute returned non-JSON string: ${raw}`)
  }
  expect(
    parsed !== null && typeof parsed === "object" && "ok" in parsed,
    `${name}: result must have an 'ok' field`,
  ).toBe(true)
  const result = parsed as { ok: unknown }
  expect(
    typeof result.ok,
    `${name}: 'ok' must be a boolean`,
  ).toBe("boolean")
}

function getExportName(
  tool: typeof po.read_package | typeof po.validate | typeof po.generate_evidence | typeof po.build_payload | typeof po.create,
): string {
  const entries = Object.entries(po) as [string, unknown][]
  return entries.find(([, v]) => v === tool)?.[0] ?? "unknown"
}
