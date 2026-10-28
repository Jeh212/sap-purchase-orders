/**
 * Pure text normalization functions.
 * No file I/O, no side effects, no imports beyond built-ins.
 */

/**
 * Normalize a Colombian NIT (tax ID) to a plain digit string.
 * Strips grouping dots and the verification digit suffix.
 * "900.555.111-2" → "900555111"
 * "900555111"     → "900555111" (idempotent)
 */
export function normalizeNit(raw: string): string {
  return raw.replace(/\./g, "").replace(/-\d+$/, "")
}

/**
 * Normalize a company name for fuzzy matching.
 * NFD-decomposes, strips combining diacritics, lowercases, collapses whitespace.
 * "TecnoSuministros S.A.S." ≡ "TECNOSUMINISTROS S.A.S."
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Extract the VAT-included total from a supplier quote.
 * Matches "TOTAL (VAT included): COP N,NNN,NNN" — NOT the taxable base or VAT amount.
 * Throws a descriptive error if the line is absent.
 */
export function parseQuoteTotal(text: string): number {
  const match = text.match(/TOTAL\s+\(VAT included\)\s*:\s*COP\s+([\d,]+)/)
  if (!match?.[1]) {
    throw new Error(
      'Quote total not found: expected a line matching "TOTAL (VAT included): COP <amount>"',
    )
  }
  return parseInt(match[1].replace(/,/g, ""), 10)
}

/**
 * Extract the quote reference from the first line (e.g. "QUOTE COT-TS-2026-0451").
 * Returns null if the first line does not start with "QUOTE ".
 */
export function parseQuoteRef(text: string): string | null {
  const firstLine = text.split("\n")[0]?.trim() ?? ""
  return firstLine.startsWith("QUOTE ") ? firstLine : null
}

/**
 * Extract and normalize the supplier's NIT from a quote text.
 * Only matches the "Tax ID (NIT):" line; the buyer's NIT on the Client line
 * uses a different format ("NIT XXXXXXXXX") and is never matched.
 */
export function parseQuoteSupplierNit(text: string): string | null {
  const match = text.match(/Tax ID \(NIT\):\s*([\d.,\-]+)/)
  if (!match?.[1]) return null
  return normalizeNit(match[1])
}

/**
 * Compute the quote validity expiry date from the "Date:" and "Offer validity: N days" lines.
 * Returns an ISO date string (YYYY-MM-DD) or null if either line is absent.
 */
export function parseQuoteValidUntil(text: string): string | null {
  const dateMatch = text.match(/^Date:\s*(\d{4}-\d{2}-\d{2})/m)
  const validityMatch = text.match(/Offer validity:\s*(\d+)\s*days/i)
  if (!dateMatch?.[1] || !validityMatch?.[1]) return null
  const d = new Date(dateMatch[1] + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + parseInt(validityMatch[1], 10))
  return d.toISOString().slice(0, 10)
}

/**
 * Extract the issue date from an invoice text ("Issue date: YYYY-MM-DD").
 */
export function parseInvoiceDate(text: string): string | null {
  const match = text.match(/Issue date:\s*(\d{4}-\d{2}-\d{2})/)
  return match?.[1] ?? null
}

/**
 * Extract the total amount from an invoice text ("TOTAL: COP N,NNN,NNN").
 */
export function parseInvoiceTotal(text: string): number | null {
  const match = text.match(/^TOTAL:\s*COP\s+([\d,]+)/m)
  if (!match?.[1]) return null
  return parseInt(match[1].replace(/,/g, ""), 10)
}

/**
 * Extract the invoice number from an invoice text ("Invoice No. XXXXXXX").
 */
export function parseInvoiceNumber(text: string): string | null {
  const match = text.match(/Invoice No\.\s*([A-Z0-9\-]+)/i)
  return match?.[1] ?? null
}
