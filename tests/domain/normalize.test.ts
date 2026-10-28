import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"
import {
  normalizeNit,
  normalizeName,
  parseQuoteTotal,
  parseQuoteRef,
  parseQuoteSupplierNit,
  parseQuoteValidUntil,
  parseInvoiceDate,
  parseInvoiceTotal,
  parseInvoiceNumber,
} from "../../src/domain/normalize.js"

const ROOT = process.cwd()

function readFixture(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8")
}

// ── normalizeNit ──────────────────────────────────────────────────────────────

describe("normalizeNit", () => {
  it("strips dots and verification digit suffix", () => {
    expect(normalizeNit("900.555.111-2")).toBe("900555111")
  })

  it("strips a different suffix digit", () => {
    expect(normalizeNit("830.111.222-8")).toBe("830111222")
  })

  it("is idempotent on already-normalized NIT", () => {
    expect(normalizeNit("900555111")).toBe("900555111")
  })

  it("strips the verification digit suffix from another fixture NIT", () => {
    expect(normalizeNit("901.222.333-1")).toBe("901222333")
  })

  it("handles NITs without dots but with suffix", () => {
    expect(normalizeNit("901999000-5")).toBe("901999000")
  })

  it("handles plain digit NIT with no dots or suffix", () => {
    expect(normalizeNit("800444555")).toBe("800444555")
  })
})

// ── normalizeName ─────────────────────────────────────────────────────────────

describe("normalizeName", () => {
  it("lowercases ASCII names", () => {
    expect(normalizeName("TecnoSuministros S.A.S.")).toBe(
      "tecnosuministros s.a.s.",
    )
  })

  it("produces the same result for different capitalizations", () => {
    expect(normalizeName("TecnoSuministros S.A.S.")).toBe(
      normalizeName("TECNOSUMINISTROS S.A.S."),
    )
  })

  it("strips combining diacritics (é → e)", () => {
    expect(normalizeName("Consultores Ágiles S.A.S.")).toContain(
      "consultores agiles",
    )
  })

  it("collapses multiple whitespace", () => {
    expect(normalizeName("Cloud  Andina  S.A.S.")).toBe("cloud andina s.a.s.")
  })

  it("trims leading and trailing whitespace", () => {
    expect(normalizeName("  Papelería Central Ltda.  ")).toBe(
      "papeleria central ltda.",
    )
  })
})

// ── parseQuoteTotal ───────────────────────────────────────────────────────────

describe("parseQuoteTotal", () => {
  it("req-001: extracts 11,400,000 (not the taxable base 9,579,832)", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-001/quote.txt",
    )
    expect(parseQuoteTotal(text)).toBe(11_400_000)
  })

  it("req-004: extracts 26,500,000 (not the taxable base 22,268,908)", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-004/quote.txt",
    )
    expect(parseQuoteTotal(text)).toBe(26_500_000)
  })

  it("req-002: extracts 8,500,000", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-002/quote.txt",
    )
    expect(parseQuoteTotal(text)).toBe(8_500_000)
  })

  it("req-003: extracts 74,000,000", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-003/quote.txt",
    )
    expect(parseQuoteTotal(text)).toBe(74_000_000)
  })

  it("req-005: extracts 3,200,000", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-005/quote.txt",
    )
    expect(parseQuoteTotal(text)).toBe(3_200_000)
  })

  it("req-006: extracts 5,400,000", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-006/quote.txt",
    )
    expect(parseQuoteTotal(text)).toBe(5_400_000)
  })

  it("throws a descriptive error when TOTAL line is absent", () => {
    const text = "QUOTE SDN-0099\nDate: 2026-09-01\nSome items...\nNo total here"
    expect(() => parseQuoteTotal(text)).toThrowError(/TOTAL \(VAT included\)/)
  })

  it("does NOT match 'TOTAL:' without '(VAT included)'", () => {
    const text = "QUOTE SDN-0099\nTOTAL: COP 1,000\nNo VAT-included total"
    expect(() => parseQuoteTotal(text)).toThrowError()
  })
})

// ── parseQuoteRef ─────────────────────────────────────────────────────────────

describe("parseQuoteRef", () => {
  it("req-001: returns first line 'QUOTE COT-TS-2026-0451'", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-001/quote.txt",
    )
    expect(parseQuoteRef(text)).toBe("QUOTE COT-TS-2026-0451")
  })

  it("req-004: returns 'QUOTE CA-2026-0310'", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-004/quote.txt",
    )
    expect(parseQuoteRef(text)).toBe("QUOTE CA-2026-0310")
  })

  it("returns null for text that does not start with QUOTE", () => {
    expect(parseQuoteRef("Date: 2026-08-01\nQUOTE SDN-0001")).toBeNull()
  })
})

// ── parseQuoteSupplierNit ─────────────────────────────────────────────────────

describe("parseQuoteSupplierNit", () => {
  it("req-001: returns '900555111' (not the buyer's 900123456)", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-001/quote.txt",
    )
    expect(parseQuoteSupplierNit(text)).toBe("900555111")
  })

  it("req-003: returns '830111222'", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-003/quote.txt",
    )
    expect(parseQuoteSupplierNit(text)).toBe("830111222")
  })

  it("req-006: returns '900555111' (same supplier as req-001)", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-006/quote.txt",
    )
    expect(parseQuoteSupplierNit(text)).toBe("900555111")
  })

  it("returns null when no Tax ID line is present", () => {
    expect(parseQuoteSupplierNit("QUOTE SDN-0099\nNo NIT here")).toBeNull()
  })
})

// ── parseQuoteValidUntil ──────────────────────────────────────────────────────

describe("parseQuoteValidUntil", () => {
  it("req-001: date 2026-08-18 + 30 days = 2026-09-17", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-001/quote.txt",
    )
    expect(parseQuoteValidUntil(text)).toBe("2026-09-17")
  })

  it("req-002: date 2026-08-21 + 15 days = 2026-09-05", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-002/quote.txt",
    )
    expect(parseQuoteValidUntil(text)).toBe("2026-09-05")
  })

  it("returns null when the offer validity line is absent", () => {
    expect(parseQuoteValidUntil("Date: 2026-08-01\nNo validity")).toBeNull()
  })
})

// ── parseInvoiceDate ──────────────────────────────────────────────────────────

describe("parseInvoiceDate", () => {
  it("req-005 invoice: returns '2026-08-10'", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-005/invoice.txt",
    )
    expect(parseInvoiceDate(text)).toBe("2026-08-10")
  })

  it("returns null when no Issue date line", () => {
    expect(parseInvoiceDate("INVOICE No. FC-001\nDate: not here")).toBeNull()
  })
})

// ── parseInvoiceTotal ─────────────────────────────────────────────────────────

describe("parseInvoiceTotal", () => {
  it("req-005 invoice: returns 3,200,000", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-005/invoice.txt",
    )
    expect(parseInvoiceTotal(text)).toBe(3_200_000)
  })

  it("returns null when no TOTAL line", () => {
    expect(parseInvoiceTotal("No total here")).toBeNull()
  })
})

// ── parseInvoiceNumber ────────────────────────────────────────────────────────

describe("parseInvoiceNumber", () => {
  it("req-005 invoice: returns 'FC-88231'", () => {
    const text = readFixture(
      "fixtures/challenge-03/requests/req-005/invoice.txt",
    )
    expect(parseInvoiceNumber(text)).toBe("FC-88231")
  })

  it("returns null when no Invoice No. line", () => {
    expect(parseInvoiceNumber("FACTURA 001\nNo match")).toBeNull()
  })
})
