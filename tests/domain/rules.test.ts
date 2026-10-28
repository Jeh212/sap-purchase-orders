/**
 * Phase 2 rules tests.
 * Each RC is tested with happy path, negative path, and boundary conditions.
 * All six official fixtures are verified through runAllRules.
 * runAllRules never short-circuits — all rules run even after the first blocker.
 */

import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"
import {
  applyRC1,
  applyRC2,
  applyRC3,
  applyRC4,
  applyRC5,
  applyRC6,
  applyRC7,
  applyRC8,
  applyRC9,
  applyRC10,
  runAllRules,
} from "../../src/domain/rules.js"
import type {
  RC6Result,
  RC7Result,
} from "../../src/domain/rules.js"
import type {
  Supplier,
  CostCenter,
  TaxCode,
  PaymentTerm,
  MasterData,
  Package,
  Request,
} from "../../src/domain/schemas.js"

const ROOT = process.cwd()

// ── Fixture loaders ───────────────────────────────────────────────────────────

function readJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, relPath), "utf8")) as T
}

let suppliers: Supplier[]
let costCenters: CostCenter[]
let taxCodes: TaxCode[]
let paymentTerms: PaymentTerm[]
let masterData: MasterData

beforeAll(() => {
  suppliers = readJson<Supplier[]>(
    "fixtures/challenge-03/master-data/suppliers.json",
  )
  costCenters = readJson<CostCenter[]>(
    "fixtures/challenge-03/master-data/cost-centers.json",
  )
  taxCodes = readJson<TaxCode[]>(
    "fixtures/challenge-03/master-data/tax-codes.json",
  )
  paymentTerms = readJson<PaymentTerm[]>(
    "fixtures/challenge-03/master-data/payment-terms.json",
  )
  masterData = { suppliers, costCenters, taxCodes, paymentTerms }
})

function loadRequest(caseId: string): Request {
  return readJson<Request>(
    `fixtures/challenge-03/requests/${caseId}/request.json`,
  )
}

function loadApproval(caseId: string) {
  const raw = readJson<{
    from: string
    to: string
    date: string
    subject: string
    body: string
  }>(`fixtures/challenge-03/requests/${caseId}/approval.json`)
  return {
    from: raw.from,
    date: raw.date,
    approved: /approved/i.test(raw.body),
    text: raw.body,
  }
}

function buildPackage(caseId: string, overrides: Partial<Package> = {}): Package {
  const req = loadRequest(caseId)
  const approval = loadApproval(caseId)
  return {
    email: {
      id: `email-${caseId}`,
      from: "requester@periferia-fictitious.com",
      subject: "Purchase order request",
      date: req.request_date,
    },
    request: req,
    quote: null,
    approval,
    invoice: null,
    ...overrides,
  }
}

// ── RC1 — Supplier exists and is active ───────────────────────────────────────

describe("RC1: supplier must exist in master data and be active", () => {
  it("req-001: no blocker (TecnoSuministros, tax ID 900555111 found + active)", () => {
    expect(applyRC1(loadRequest("req-001"), suppliers)).toBeNull()
  })

  it("req-002: BLOCKER — supplier tax ID 901999000 not in master", () => {
    const blocker = applyRC1(loadRequest("req-002"), suppliers)
    expect(blocker).not.toBeNull()
    expect(blocker?.code).toBe("RC1")
  })

  it("req-006: no blocker — resolved by normalized name (no tax_id in request)", () => {
    expect(applyRC1(loadRequest("req-006"), suppliers)).toBeNull()
  })

  it("inactive supplier (Consultores Ágiles) triggers RC1 blocker", () => {
    const req: Pick<Request, "supplier_name" | "supplier_tax_id"> = {
      supplier_name: "Consultores Ágiles S.A.S.",
      supplier_tax_id: "901777888",
    }
    const blocker = applyRC1(req, suppliers)
    expect(blocker).not.toBeNull()
    expect(blocker?.code).toBe("RC1")
    expect(blocker?.message).toContain("inactive")
  })

  it("inactive supplier resolved by name alone also triggers RC1 blocker", () => {
    const req: Pick<Request, "supplier_name" | "supplier_tax_id"> = {
      supplier_name: "Consultores Ágiles S.A.S.",
      supplier_tax_id: undefined,
    }
    const blocker = applyRC1(req, suppliers)
    expect(blocker?.code).toBe("RC1")
    expect(blocker?.message).toContain("inactive")
  })

  it("completely unknown supplier: BLOCKER", () => {
    const req: Pick<Request, "supplier_name" | "supplier_tax_id"> = {
      supplier_name: "Unknown Vendor Co.",
      supplier_tax_id: "999000000",
    }
    const blocker = applyRC1(req, suppliers)
    expect(blocker?.code).toBe("RC1")
  })

  // ── Regression: NIT-bypass prevention ────────────────────────────────────

  it("REGRESSION — unknown NIT + known supplier name: still BLOCKED (NIT takes priority)", () => {
    // An unknown tax ID must never be resolved by falling through to name matching.
    // This prevents bypassing supplier validation with a mismatched or fraudulent NIT.
    const req: Pick<Request, "supplier_name" | "supplier_tax_id"> = {
      supplier_name: "TecnoSuministros S.A.S.", // name exists in master
      supplier_tax_id: "999000000",              // but this NIT does NOT
    }
    const blocker = applyRC1(req, suppliers)
    expect(blocker).not.toBeNull()
    expect(blocker?.code).toBe("RC1")
    expect(blocker?.message).toContain("999000000")
  })

  it("REGRESSION — known NIT with mismatched name: passes on NIT match (name is not re-checked)", () => {
    // If the NIT matches a supplier, name discrepancy is irrelevant.
    const req: Pick<Request, "supplier_name" | "supplier_tax_id"> = {
      supplier_name: "Wrong Name Entirely",
      supplier_tax_id: "900555111", // correct NIT for TecnoSuministros
    }
    expect(applyRC1(req, suppliers)).toBeNull()
  })

  it("no NIT supplied + matching name → no blocker (req-006 scenario)", () => {
    const req: Pick<Request, "supplier_name" | "supplier_tax_id"> = {
      supplier_name: "Cloud Andina S.A.S.",
      supplier_tax_id: undefined,
    }
    expect(applyRC1(req, suppliers)).toBeNull()
  })

  it("no NIT supplied + unknown name → BLOCKER", () => {
    const req: Pick<Request, "supplier_name" | "supplier_tax_id"> = {
      supplier_name: "Nonexistent Supplier S.A.S.",
      supplier_tax_id: undefined,
    }
    expect(applyRC1(req, suppliers)?.code).toBe("RC1")
  })
})

// ── RC2 — Approval from authorized approver ───────────────────────────────────

describe("RC2: approval must exist, contain Approved, from authorized CC approver", () => {
  it("req-001: no blocker (mlopez is CC-1010 approver, body says Approved)", () => {
    expect(applyRC2(loadApproval("req-001"), "CC-1010", costCenters)).toBeNull()
  })

  it("req-003: BLOCKER — fvargas is CC-3030 approver, NOT CC-2020", () => {
    const blocker = applyRC2(loadApproval("req-003"), "CC-2020", costCenters)
    expect(blocker).not.toBeNull()
    expect(blocker?.code).toBe("RC2")
    expect(blocker?.message).toContain("fvargas")
  })

  it("missing approval: BLOCKER", () => {
    const blocker = applyRC2(null, "CC-1010", costCenters)
    expect(blocker?.code).toBe("RC2")
    expect(blocker?.message).toContain("missing")
  })

  it("approval body without 'Approved': BLOCKER", () => {
    const notApproved = {
      from: "mlopez@periferia-fictitious.com",
      date: "2026-08-21T10:00:00-05:00",
      approved: false,
    }
    const blocker = applyRC2(notApproved, "CC-1010", costCenters)
    expect(blocker?.code).toBe("RC2")
  })

  it("approval from valid approver but for wrong cost center: BLOCKER", () => {
    const approval = {
      from: "rtorres@periferia-fictitious.com",
      date: "2026-08-21T10:00:00-05:00",
      approved: true,
    }
    // rtorres is CC-2020 approver, not CC-1010
    const blocker = applyRC2(approval, "CC-1010", costCenters)
    expect(blocker?.code).toBe("RC2")
  })

  it("approval email matching is case-insensitive", () => {
    const approval = {
      from: "MLOPEZ@PERIFERIA-FICTITIOUS.COM",
      date: "2026-08-21T10:00:00-05:00",
      approved: true,
    }
    expect(applyRC2(approval, "CC-1010", costCenters)).toBeNull()
  })

  it("unknown cost center: BLOCKER", () => {
    const approval = { from: "mlopez@periferia-fictitious.com", date: "2026-08-21T10:00:00-05:00", approved: true }
    expect(applyRC2(approval, "CC-9999", costCenters)?.code).toBe("RC2")
  })
})

// ── RC3 — Approver's authorization limit ──────────────────────────────────────

describe("RC3: total_value must not exceed the actual approver's CC limit", () => {
  it("req-001: no blocker (11.4M ≤ mlopez CC-1010 limit 50M)", () => {
    expect(
      applyRC3(11_400_000, "CC-1010", costCenters, loadApproval("req-001")),
    ).toBeNull()
  })

  it("req-004: no blocker (25M ≤ dgarcia CC-1010 limit 200M)", () => {
    expect(
      applyRC3(25_000_000, "CC-1010", costCenters, loadApproval("req-004")),
    ).toBeNull()
  })

  it("req-005: no blocker (3.2M ≤ rtorres CC-2020 limit 30M)", () => {
    expect(
      applyRC3(3_200_000, "CC-2020", costCenters, loadApproval("req-005")),
    ).toBeNull()
  })

  it("req-003: RC3 returns null — fvargas not in CC-2020, RC2 handles authorization failure", () => {
    // fvargas has no defined limit for CC-2020; RC3 cannot be evaluated.
    // RC2 is the correct rule for an unauthorized approver.
    // RC3 only fires when the approver IS authorized but the amount exceeds their limit.
    const result = applyRC3(
      74_000_000,
      "CC-2020",
      costCenters,
      loadApproval("req-003"),
    )
    expect(result).toBeNull()
  })

  it("genuine limit exceeded: rtorres 1 COP above limit (30M+1) at CC-2020 → BLOCKER", () => {
    const blocker = applyRC3(
      30_000_001,
      "CC-2020",
      costCenters,
      { from: "rtorres@periferia-fictitious.com", date: "2026-08-28T08:20:00-05:00", approved: true },
    )
    expect(blocker?.code).toBe("RC3")
    expect(blocker?.message).toContain("30,000,001")
    expect(blocker?.message).toContain("30,000,000")
  })

  it("amount exactly at limit: no blocker (rtorres 30M at CC-2020)", () => {
    expect(
      applyRC3(
        30_000_000,
        "CC-2020",
        costCenters,
        { from: "rtorres@periferia-fictitious.com", date: "2026-08-28T08:20:00-05:00", approved: true },
      ),
    ).toBeNull()
  })

  it("mlopez at limit exactly (50M) at CC-1010: no blocker", () => {
    expect(
      applyRC3(
        50_000_000,
        "CC-1010",
        costCenters,
        { from: "mlopez@periferia-fictitious.com", date: "2026-08-21T10:00:00-05:00", approved: true },
      ),
    ).toBeNull()
  })

  it("mlopez 1 COP above limit (50M+1) at CC-1010: BLOCKER", () => {
    const blocker = applyRC3(
      50_000_001,
      "CC-1010",
      costCenters,
      { from: "mlopez@periferia-fictitious.com", date: "2026-08-21T10:00:00-05:00", approved: true },
    )
    expect(blocker?.code).toBe("RC3")
  })

  it("missing approval: returns null (RC2 handles that case)", () => {
    expect(applyRC3(1_000_000, "CC-1010", costCenters, null)).toBeNull()
  })

  it("unauthorized approver from a different CC: returns null (not a limit violation)", () => {
    // fvargas is authorized for CC-3030, not CC-1010 — RC2 covers this; RC3 stays null
    const result = applyRC3(
      5_000_000,
      "CC-1010",
      costCenters,
      { from: "fvargas@periferia-fictitious.com", date: "2026-08-21T10:00:00-05:00", approved: true },
    )
    expect(result).toBeNull()
  })
})

// ── RC4 — Subarea belongs to cost center ─────────────────────────────────────

describe("RC4: subarea must belong to cost center", () => {
  it("req-001: no blocker ('Infrastructure' in CC-1010)", () => {
    expect(applyRC4("Infrastructure", "CC-1010", costCenters)).toBeNull()
  })

  it("req-005: no blocker ('Purchasing' in CC-2020)", () => {
    expect(applyRC4("Purchasing", "CC-2020", costCenters)).toBeNull()
  })

  it("req-003: no blocker ('General Services' in CC-2020)", () => {
    expect(applyRC4("General Services", "CC-2020", costCenters)).toBeNull()
  })

  it("'Marketing' does NOT belong to CC-1010: BLOCKER", () => {
    const blocker = applyRC4("Marketing", "CC-1010", costCenters)
    expect(blocker?.code).toBe("RC4")
    expect(blocker?.message).toContain("Marketing")
  })

  it("'Infrastructure' in CC-2020: BLOCKER (belongs to CC-1010, not CC-2020)", () => {
    const blocker = applyRC4("Infrastructure", "CC-2020", costCenters)
    expect(blocker?.code).toBe("RC4")
  })

  it("unknown cost center: BLOCKER", () => {
    const blocker = applyRC4("Anywhere", "CC-9999", costCenters)
    expect(blocker?.code).toBe("RC4")
  })

  it("all three CC-1010 subareas are valid", () => {
    for (const sub of ["Infrastructure", "Support", "Development"]) {
      expect(applyRC4(sub, "CC-1010", costCenters)).toBeNull()
    }
  })
})

// ── RC5 — Quote total within ±2% of request total ────────────────────────────

describe("RC5: quote total within ±2% of request total", () => {
  it("req-001: no confirmation (0% difference)", () => {
    expect(applyRC5(11_400_000, 11_400_000)).toBeNull()
  })

  it("req-004: confirmation (quote +6% above request)", () => {
    const item = applyRC5(26_500_000, 25_000_000)
    expect(item).not.toBeNull()
    expect(item?.code).toBe("RC5")
    expect(item?.values).toMatchObject({ request_total: 25_000_000, quote_total: 26_500_000 })
  })

  it("req-005: no confirmation (quote = request = 3,200,000)", () => {
    expect(applyRC5(3_200_000, 3_200_000)).toBeNull()
  })

  it("null quote: confirmation required", () => {
    const item = applyRC5(null, 25_000_000)
    expect(item?.code).toBe("RC5")
    expect(item?.values).toMatchObject({ quote_total: null })
  })

  it("boundary: exactly 2% above — no confirmation (integer arithmetic)", () => {
    expect(applyRC5(1_020_000, 1_000_000)).toBeNull()
  })

  it("boundary: exactly 2% below — no confirmation", () => {
    expect(applyRC5(980_000, 1_000_000)).toBeNull()
  })

  it("boundary: 1 COP above 2% — confirmation required", () => {
    expect(applyRC5(1_020_001, 1_000_000)).not.toBeNull()
    expect(applyRC5(1_020_001, 1_000_000)?.code).toBe("RC5")
  })

  it("boundary: 1 COP below 2% threshold — confirmation required", () => {
    expect(applyRC5(979_999, 1_000_000)?.code).toBe("RC5")
  })

  it("large amounts: exactly 2% boundary (100M × 2% = 2M)", () => {
    expect(applyRC5(102_000_000, 100_000_000)).toBeNull()
    expect(applyRC5(102_000_001, 100_000_000)?.code).toBe("RC5")
  })

  it("confirmation message shows both amounts and percentage", () => {
    const item = applyRC5(26_500_000, 25_000_000)
    expect(item?.message).toContain("26,500,000")
    expect(item?.message).toContain("25,000,000")
    expect(item?.message).toMatch(/\d+\.\d+%/)
  })
})

// ── RC6 — Missing tax code derived from supplier ──────────────────────────────

describe("RC6: missing tax code → derive from supplier + confirmation (fail-closed)", () => {
  const techno: Supplier = {
    sap_code: "100234",
    tax_id: "900555111",
    name: "TecnoSuministros S.A.S.",
    default_payment_terms: "Z030",
    default_tax_code: "C1",
    active: true,
  }

  it("req-006: kind='confirmation', derived='C1'", () => {
    const result = applyRC6(undefined, techno, taxCodes)
    expect(result?.kind).toBe("confirmation")
    if (result?.kind === "confirmation") {
      expect(result.confirmation.code).toBe("RC6")
      expect(result.derived).toBe("C1")
    }
  })

  it("null tax code: same result as undefined", () => {
    const result = applyRC6(null, techno, taxCodes)
    expect(result?.kind).toBe("confirmation")
    if (result?.kind === "confirmation") {
      expect(result.derived).toBe("C1")
    }
  })

  it("empty string tax code: treated as missing", () => {
    const result = applyRC6("", techno, taxCodes)
    expect(result?.kind).toBe("confirmation")
  })

  it("tax code provided: returns null (no action)", () => {
    expect(applyRC6("C1", techno, taxCodes)).toBeNull()
  })

  it("different valid tax codes also return null when provided", () => {
    expect(applyRC6("C0", techno, taxCodes)).toBeNull()
    expect(applyRC6("C2", techno, taxCodes)).toBeNull()
  })

  it("null supplier with missing tax code: returns null (RC1 fires independently)", () => {
    expect(applyRC6(undefined, null, taxCodes)).toBeNull()
  })

  it("confirmation message mentions supplier name and derived code", () => {
    const result = applyRC6(undefined, techno, taxCodes)
    if (result?.kind === "confirmation") {
      expect(result.confirmation.message).toContain("C1")
      expect(result.confirmation.message).toContain("TecnoSuministros")
    }
  })

  it("FAIL-CLOSED: invalid default_tax_code in supplier → kind='unresolvable' blocker", () => {
    const badSupplier: Supplier = {
      ...techno,
      default_tax_code: "X9", // not in master
    }
    const result = applyRC6(undefined, badSupplier, taxCodes)
    expect(result?.kind).toBe("unresolvable")
    if (result?.kind === "unresolvable") {
      expect(result.blocker.code).toBe("RC6")
      expect(result.blocker.message).toContain("X9")
    }
  })

  it("FAIL-CLOSED: unresolvable result is not treated as null (PO creation would be blocked)", () => {
    const badSupplier: Supplier = { ...techno, default_tax_code: "Z9" }
    const result = applyRC6(undefined, badSupplier, taxCodes)
    expect(result).not.toBeNull()
    expect(result?.kind).toBe("unresolvable")
  })
})

// ── RC7 — Missing payment terms derived from supplier ─────────────────────────

describe("RC7: missing payment terms → derive from supplier (informational, fail-closed)", () => {
  const techno: Supplier = {
    sap_code: "100234",
    tax_id: "900555111",
    name: "TecnoSuministros S.A.S.",
    default_payment_terms: "Z030",
    default_tax_code: "C1",
    active: true,
  }

  it("req-006: kind='derived', derived='Z030'", () => {
    const result = applyRC7(undefined, techno, paymentTerms)
    expect(result?.kind).toBe("derived")
    if (result?.kind === "derived") {
      expect(result.derived).toBe("Z030")
    }
  })

  it("null payment terms: same as undefined", () => {
    const result = applyRC7(null, techno, paymentTerms)
    expect(result?.kind).toBe("derived")
    if (result?.kind === "derived") {
      expect(result.derived).toBe("Z030")
    }
  })

  it("empty string payment terms: treated as missing", () => {
    const result = applyRC7("", techno, paymentTerms)
    expect(result?.kind).toBe("derived")
  })

  it("payment terms provided: returns null (no action)", () => {
    expect(applyRC7("Z030", techno, paymentTerms)).toBeNull()
    expect(applyRC7("Z000", techno, paymentTerms)).toBeNull()
  })

  it("null supplier: returns null", () => {
    expect(applyRC7(undefined, null, paymentTerms)).toBeNull()
  })

  it("RC7 never produces a ConfirmationItem (informational only)", () => {
    const result = applyRC7(undefined, techno, paymentTerms)
    if (result) {
      expect("confirmation" in result).toBe(false)
    }
  })

  it("FAIL-CLOSED: invalid default_payment_terms → kind='unresolvable' blocker", () => {
    const badSupplier: Supplier = { ...techno, default_payment_terms: "Z999" }
    const result = applyRC7(undefined, badSupplier, paymentTerms)
    expect(result?.kind).toBe("unresolvable")
    if (result?.kind === "unresolvable") {
      expect(result.blocker.code).toBe("RC7")
      expect(result.blocker.message).toContain("Z999")
    }
  })

  it("FAIL-CLOSED: unresolvable result is not null (would be added to blockers by runAllRules)", () => {
    const badSupplier: Supplier = { ...techno, default_payment_terms: "Z9" }
    expect(applyRC7(undefined, badSupplier, paymentTerms)).not.toBeNull()
  })
})

// ── RC8 — Invoice predates request (retroactive) ──────────────────────────────

describe("RC8: invoice date before request date → retroactive + confirmation", () => {
  it("req-005: retroactive=true, confirmation RC8 (invoice 2026-08-10 < request 2026-08-27)", () => {
    const result = applyRC8({ date: "2026-08-10" }, "2026-08-27")
    expect(result).not.toBeNull()
    expect(result?.confirmation.code).toBe("RC8")
    expect(result?.retroactive).toBe(true)
  })

  it("no invoice: returns null", () => {
    expect(applyRC8(null, "2026-08-27")).toBeNull()
  })

  it("invoice same day as request: NOT retroactive (returns null)", () => {
    expect(applyRC8({ date: "2026-08-27" }, "2026-08-27")).toBeNull()
  })

  it("invoice after request date: NOT retroactive", () => {
    expect(applyRC8({ date: "2026-08-28" }, "2026-08-27")).toBeNull()
  })

  it("confirmation message mentions both dates", () => {
    const result = applyRC8({ date: "2026-08-10" }, "2026-08-27")
    expect(result?.confirmation.message).toContain("2026-08-10")
    expect(result?.confirmation.message).toContain("2026-08-27")
  })

  it("invoice one day before request: retroactive", () => {
    const result = applyRC8({ date: "2026-08-26" }, "2026-08-27")
    expect(result?.retroactive).toBe(true)
    expect(result?.confirmation.code).toBe("RC8")
  })
})

// ── RC9 — Approval date ≥ request date ───────────────────────────────────────

describe("RC9: approval date must be >= request date", () => {
  it("req-001: no confirmation (approval 2026-08-21 ≥ request 2026-08-20)", () => {
    expect(applyRC9("2026-08-21T10:02:00-05:00", "2026-08-20")).toBeNull()
  })

  it("req-004: no confirmation (approval 2026-08-26 = request 2026-08-26 same day)", () => {
    expect(applyRC9("2026-08-26T18:45:00-05:00", "2026-08-26")).toBeNull()
  })

  it("approval one day before request: confirmation RC9", () => {
    const item = applyRC9("2026-08-19T10:00:00-05:00", "2026-08-20")
    expect(item?.code).toBe("RC9")
    expect(item?.message).toContain("2026-08-19")
    expect(item?.message).toContain("2026-08-20")
  })

  it("approval two weeks before request: confirmation RC9", () => {
    const item = applyRC9("2026-08-05T10:00:00-05:00", "2026-08-20")
    expect(item?.code).toBe("RC9")
  })

  it("null approval date: returns null (RC2 handles missing approval)", () => {
    expect(applyRC9(null, "2026-08-20")).toBeNull()
  })
})

// ── RC10 — Quantity × unit price = total ─────────────────────────────────────

describe("RC10: quantity × unit_price must equal total_value within ±1", () => {
  it("req-001: no blocker (120 × 95,000 = 11,400,000)", () => {
    expect(applyRC10(120, 95_000, 11_400_000)).toBeNull()
  })

  it("req-004: no blocker (100 × 250,000 = 25,000,000)", () => {
    expect(applyRC10(100, 250_000, 25_000_000)).toBeNull()
  })

  it("req-006: no blocker (30 × 180,000 = 5,400,000)", () => {
    expect(applyRC10(30, 180_000, 5_400_000)).toBeNull()
  })

  it("req-005: no blocker (1 × 3,200,000 = 3,200,000)", () => {
    expect(applyRC10(1, 3_200_000, 3_200_000)).toBeNull()
  })

  it("off by exactly ±1: no blocker (at tolerance limit)", () => {
    expect(applyRC10(3, 333_334, 1_000_001)).toBeNull() // diff = |1000002-1000001| = 1
    expect(applyRC10(3, 333_333, 1_000_000)).toBeNull() // diff = |999999-1000000| = 1
  })

  it("off by 2: BLOCKER (exceeds ±1 tolerance)", () => {
    const blocker = applyRC10(120, 95_000, 11_400_002)
    expect(blocker?.code).toBe("RC10")
  })

  it("off by large amount: BLOCKER with difference in message", () => {
    const blocker = applyRC10(120, 95_000, 10_000_000)
    expect(blocker?.code).toBe("RC10")
    expect(blocker?.message).toContain("1,400,000")
  })

  it("quantity=0 with non-zero total: BLOCKER", () => {
    expect(applyRC10(0, 95_000, 1_000)?.code).toBe("RC10")
  })
})

// ── runAllRules — full fixture oracle tests ───────────────────────────────────

describe("runAllRules — official fixture cases", () => {
  it("req-001: eligible, no blockers, no confirmations, not retroactive", () => {
    const quote = {
      supplier: "TecnoSuministros S.A.S.",
      tax_id: "900555111",
      total: 11_400_000,
      currency: "COP",
      valid_until: "2026-09-17",
      text: readFileSync(resolve(ROOT, "fixtures/challenge-03/requests/req-001/quote.txt"), "utf8"),
    }
    const pkg = buildPackage("req-001", { quote })
    const result = runAllRules(pkg, masterData)

    expect(result.eligible).toBe(true)
    expect(result.blockers).toHaveLength(0)
    expect(result.confirmations).toHaveLength(0)
    expect(result.retroactive).toBe(false)
    expect(result.derived).toEqual({})
  })

  it("req-002: NOT eligible — RC1 blocker (unknown supplier tax ID 901999000)", () => {
    const pkg = buildPackage("req-002", { quote: null })
    const result = runAllRules(pkg, masterData)

    expect(result.eligible).toBe(false)
    const codes = result.blockers.map((b) => b.code)
    expect(codes).toContain("RC1")
    expect(codes).not.toContain("RC4") // Development is valid in CC-1010
  })

  it("req-003: NOT eligible — RC2 blocker only (fvargas not in CC-2020); RC3 is null (not a limit violation)", () => {
    // fvargas is the CC-3030 approver; they have no defined limit for CC-2020.
    // RC2 fires for the authorization failure.
    // RC3 returns null because the approver is not listed for CC-2020 — inventing
    // a limit would be incorrect. There is no independent RC3 violation for this case.
    const pkg = buildPackage("req-003")
    const result = runAllRules(pkg, masterData)

    expect(result.eligible).toBe(false)
    const codes = result.blockers.map((b) => b.code)
    expect(codes).toContain("RC2")
    expect(codes).not.toContain("RC3") // RC3 is N/A: no defined limit to compare
    expect(codes).not.toContain("RC1") // Mobiliario Andino IS in master and active
    expect(codes).not.toContain("RC4") // General Services IS in CC-2020
  })

  it("req-004: eligible=true, no blockers, confirmations=[RC5] (+6% quote divergence)", () => {
    const quote = {
      supplier: "Cloud Andina S.A.S.",
      tax_id: "901222333",
      total: 26_500_000,
      currency: "COP",
      valid_until: null,
      text: readFileSync(resolve(ROOT, "fixtures/challenge-03/requests/req-004/quote.txt"), "utf8"),
    }
    const pkg = buildPackage("req-004", { quote })
    const result = runAllRules(pkg, masterData)

    expect(result.eligible).toBe(true)
    expect(result.blockers).toHaveLength(0)
    expect(result.confirmations.map((c) => c.code)).toContain("RC5")
    expect(result.retroactive).toBe(false)
  })

  it("req-005: eligible=true, RC8 confirmation, retroactive=true; RC5 must NOT fire (quote=request)", () => {
    const quote = {
      supplier: "Papelería Central Ltda.",
      tax_id: "800444555",
      total: 3_200_000,
      currency: "COP",
      valid_until: null,
      text: readFileSync(resolve(ROOT, "fixtures/challenge-03/requests/req-005/quote.txt"), "utf8"),
    }
    const invoice = { number: "FC-88231", date: "2026-08-10", total: 3_200_000 }
    const pkg = buildPackage("req-005", { quote, invoice })
    const result = runAllRules(pkg, masterData)

    expect(result.eligible).toBe(true)
    expect(result.blockers).toHaveLength(0)
    expect(result.retroactive).toBe(true)
    const confCodes = result.confirmations.map((c) => c.code)
    expect(confCodes).toContain("RC8")
    expect(confCodes).not.toContain("RC5") // quote total = request total → no RC5
  })

  it("req-006: eligible=true, confirmations=[RC6], derived={tax_code:C1, payment_terms:Z030}", () => {
    const quote = {
      supplier: "TecnoSuministros S.A.S.",
      tax_id: "900555111",
      total: 5_400_000,
      currency: "COP",
      valid_until: null,
      text: readFileSync(resolve(ROOT, "fixtures/challenge-03/requests/req-006/quote.txt"), "utf8"),
    }
    const pkg = buildPackage("req-006", { quote })
    const result = runAllRules(pkg, masterData)

    expect(result.eligible).toBe(true)
    expect(result.blockers).toHaveLength(0)
    const confCodes = result.confirmations.map((c) => c.code)
    expect(confCodes).toContain("RC6")
    expect(confCodes).not.toContain("RC7") // RC7 is informational only, never a confirmation
    expect(result.derived.tax_code).toBe("C1")
    expect(result.derived.payment_terms).toBe("Z030")
    expect(result.retroactive).toBe(false)
  })
})

// ── runAllRules — no short-circuit guarantee ──────────────────────────────────

describe("runAllRules: all rules run even after the first blocker", () => {
  it("req-003: RC2 fires; RC3 returns null; runAllRules still processes all 10 rules", () => {
    const pkg = buildPackage("req-003")
    const result = runAllRules(pkg, masterData)
    // RC2 fires
    expect(result.blockers.map((b) => b.code)).toContain("RC2")
    // eligible is false because of RC2
    expect(result.eligible).toBe(false)
  })

  it("a package with multiple independent rule failures includes all of them", () => {
    // RC1: invalid supplier  RC4: invalid subarea  RC10: bad arithmetic
    const badReq: Request = {
      request_id: "REQ-TEST",
      requester: "Test User",
      supplier_name: "Ghost Supplier",
      supplier_tax_id: "999999999",
      description: "Something",
      cost_center: "CC-1010",
      subarea: "Finance", // not in CC-1010
      quantity: 10,
      unit_price: 1000,
      total_value: 99999, // wrong: 10 × 1000 = 10000, not 99999
      currency: "COP",
      tax_code: "C1",
      payment_terms: "Z030",
      request_date: "2026-09-01",
    }
    const pkg: Package = {
      email: { id: "email-test", from: "test@x.com", subject: "Test", date: "2026-09-01" },
      request: badReq,
      quote: null,
      approval: {
        from: "mlopez@periferia-fictitious.com",
        date: "2026-09-01T10:00:00-05:00",
        approved: true,
        text: "Approved",
      },
      invoice: null,
    }

    const result = runAllRules(pkg, masterData)
    const codes = result.blockers.map((b) => b.code)
    expect(codes).toContain("RC1")  // unknown supplier
    expect(codes).toContain("RC4")  // invalid subarea
    expect(codes).toContain("RC10") // arithmetic mismatch
    expect(codes.length).toBeGreaterThanOrEqual(3)
  })

  it("eligible is false when ANY blocker fires, regardless of confirmations", () => {
    const pkg = buildPackage("req-002")
    const result = runAllRules(pkg, masterData)
    expect(result.eligible).toBe(false)
    expect(result.blockers.length).toBeGreaterThan(0)
  })
})

// ── RC6/RC7 fail-closed in runAllRules ────────────────────────────────────────

describe("runAllRules: RC6/RC7 unresolvable defaults produce blockers", () => {
  it("request with missing tax code + supplier with invalid default_tax_code → RC6 blocker in result", () => {
    // Patch the suppliers master to have an invalid default
    const badSuppliers: Supplier[] = suppliers.map((s) =>
      s.tax_id === "900555111" ? { ...s, default_tax_code: "INVALID" } : s,
    )
    const badMaster: MasterData = { ...masterData, suppliers: badSuppliers }
    const req = loadRequest("req-006") // has no tax_code
    const pkg: Package = {
      ...buildPackage("req-006"),
      request: req,
    }

    const result = runAllRules(pkg, badMaster)
    const codes = result.blockers.map((b) => b.code)
    expect(codes).toContain("RC6")
    expect(result.eligible).toBe(false)
  })

  it("request with missing payment_terms + supplier with invalid default_payment_terms → RC7 blocker in result", () => {
    const badSuppliers: Supplier[] = suppliers.map((s) =>
      s.tax_id === "900555111" ? { ...s, default_payment_terms: "ZXXX" } : s,
    )
    const badMaster: MasterData = { ...masterData, suppliers: badSuppliers }
    const pkg = buildPackage("req-006")

    const result = runAllRules(pkg, badMaster)
    const codes = result.blockers.map((b) => b.code)
    expect(codes).toContain("RC7")
    expect(result.eligible).toBe(false)
  })
})

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("RC1: name normalization handles accented characters (Ágiles → agiles)", () => {
    const req: Pick<Request, "supplier_name" | "supplier_tax_id"> = {
      supplier_name: "CONSULTORES ÁGILES S.A.S.",
      supplier_tax_id: undefined,
    }
    const blocker = applyRC1(req, suppliers)
    expect(blocker?.code).toBe("RC1")
    expect(blocker?.message).toContain("inactive")
  })

  it("RC1: NIT bypass — providing unknown NIT blocks even if name matches a known supplier", () => {
    const req: Pick<Request, "supplier_name" | "supplier_tax_id"> = {
      supplier_name: "TecnoSuministros S.A.S.",
      supplier_tax_id: "111000000", // unknown NIT, but name would match
    }
    const blocker = applyRC1(req, suppliers)
    expect(blocker).not.toBeNull()
    expect(blocker?.code).toBe("RC1")
  })

  it("RC5: very large amounts with exact 2% boundary", () => {
    expect(applyRC5(102_000_000, 100_000_000)).toBeNull()    // exactly 2%
    expect(applyRC5(102_000_001, 100_000_000)).not.toBeNull() // 1 COP above
  })

  it("RC10: ±1 monetary unit tolerance boundary", () => {
    expect(applyRC10(3, 333_334, 1_000_001)).toBeNull() // diff = 1 ≤ 1 → no blocker
    expect(applyRC10(3, 333_334, 1_000_000)).not.toBeNull() // diff = 2 > 1 → blocker
  })

  it("RC8: invoice same date as request is NOT retroactive", () => {
    expect(applyRC8({ date: "2026-08-27" }, "2026-08-27")).toBeNull()
  })

  it("RC9: approval on same day as request is valid (no confirmation)", () => {
    expect(applyRC9("2026-08-26T18:45:00-05:00", "2026-08-26")).toBeNull()
  })

  it("RC3: unauthorized approver from a completely different org: null (not a limit exceeded)", () => {
    // Someone with no CC record at all: RC2 handles this; RC3 stays null
    const result = applyRC3(
      1_000,
      "CC-1010",
      costCenters,
      { from: "outsider@elsewhere.com", date: "2026-09-01T10:00:00Z", approved: true },
    )
    expect(result).toBeNull()
  })

  it("RC6 and RC7 derivation both correct for req-006 via runAllRules (no NIT in request)", () => {
    const quote = {
      supplier: "TecnoSuministros S.A.S.",
      tax_id: "900555111",
      total: 5_400_000,
      currency: "COP",
      valid_until: null,
      text: readFileSync(resolve(ROOT, "fixtures/challenge-03/requests/req-006/quote.txt"), "utf8"),
    }
    const pkg = buildPackage("req-006", { quote })
    const result = runAllRules(pkg, masterData)
    expect(result.derived.tax_code).toBe("C1")
    expect(result.derived.payment_terms).toBe("Z030")
    expect(result.blockers).toHaveLength(0)
  })
})
