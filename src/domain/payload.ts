import type { Package, ValidationResult, PurchaseOrder, Supplier } from "./schemas.js"
import { PurchaseOrderSchema } from "./schemas.js"
import { parseQuoteRef } from "./normalize.js"
import * as fs from "node:fs/promises"
import * as path from "node:path"

export interface TraceabilitySources {
  [field: string]: string
}

/** Detects SAP unit of measure from description text. */
export function detectUnit(description: string): "EA" | "H" | "MON" {
  if (/hour/i.test(description)) return "H"
  return "EA"
}

/**
 * Builds a validated PurchaseOrder from trusted fixture data.
 * All values come from fixture/master sources — never from model-supplied args.
 */
export function buildPayload(
  pkg: Package,
  validationResult: ValidationResult,
  evidenceSha256: string,
  supplierRecord: Supplier,
): PurchaseOrder {
  const quoteRef = pkg.quote != null ? parseQuoteRef(pkg.quote.text) : null
  const taxCode =
    validationResult.derived.tax_code ?? pkg.request.tax_code ?? ""
  const paymentTerms =
    validationResult.derived.payment_terms ?? pkg.request.payment_terms ?? ""

  const exceptions = validationResult.confirmations.map((c) => ({
    code: c.code,
    detail: c.message,
    confirmed_by: pkg.approval?.from ?? null,
  }))

  const payload: PurchaseOrder = {
    reference: {
      request_id: pkg.request.request_id,
      email_id: pkg.email.id,
      quote_ref: quoteRef,
    },
    company_code: "1000",
    purchasing_org: "1000",
    supplier: {
      sap_code: supplierRecord.sap_code,
      tax_id: supplierRecord.tax_id,
      name: supplierRecord.name,
    },
    currency: pkg.request.currency as "COP" | "USD",
    payment_terms: paymentTerms,
    approver: {
      email: pkg.approval?.from ?? "",
      approval_date: pkg.approval?.date ?? "",
      evidence_sha256: evidenceSha256,
    },
    items: [
      {
        number: 10,
        description: pkg.request.description.slice(0, 40),
        quantity: pkg.request.quantity,
        unit: detectUnit(pkg.request.description),
        unit_price: pkg.request.unit_price,
        cost_center: pkg.request.cost_center,
        subarea: pkg.request.subarea,
        tax_code: taxCode,
      },
    ],
    exceptions,
  }

  return PurchaseOrderSchema.parse(payload)
}

/** Builds field-level source traceability for the PO payload. */
export function buildSources(
  pkg: Package,
  validationResult: ValidationResult,
): TraceabilitySources {
  return {
    "reference.request_id": "request",
    "reference.email_id": "email",
    "reference.quote_ref": pkg.quote !== null ? "quote" : "null",
    "company_code": "constant:1000",
    "purchasing_org": "constant:1000",
    "supplier.sap_code": "master.suppliers",
    "supplier.tax_id": "master.suppliers",
    "supplier.name": "master.suppliers",
    "currency": "request",
    "payment_terms":
      validationResult.derived.payment_terms !== undefined
        ? "derived:RC7"
        : "request",
    "approver.email": "approval",
    "approver.approval_date": "approval",
    "approver.evidence_sha256": "generated:approval.txt",
    "items[0].number": "constant:10",
    "items[0].description": "request",
    "items[0].quantity": "request",
    "items[0].unit": "derived:description-keyword",
    "items[0].unit_price": "request",
    "items[0].cost_center": "request",
    "items[0].subarea": "request",
    "items[0].tax_code":
      validationResult.derived.tax_code !== undefined
        ? "derived:RC6"
        : "request",
  }
}

/** Writes traceability.json for a case and returns a repo-relative path. */
export async function writeTraceability(
  outDir: string,
  caseId: string,
  payload: PurchaseOrder,
  sources: TraceabilitySources,
): Promise<string> {
  const dir = path.join(outDir, caseId)
  await fs.mkdir(dir, { recursive: true })
  const tracePath = path.join(dir, "traceability.json")
  await fs.writeFile(
    tracePath,
    JSON.stringify({ payload, sources }, null, 2),
    "utf-8",
  )
  return path.relative(process.cwd(), tracePath)
}
