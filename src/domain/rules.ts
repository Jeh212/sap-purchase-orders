/**
 * Business control rules RC1–RC10.
 * Every function is pure: no file I/O, no side effects, deterministic output.
 * runAllRules runs all rules independently — it never short-circuits after a blocker.
 */

import { normalizeNit, normalizeName } from "./normalize.js"
import type {
  Request,
  Supplier,
  CostCenter,
  TaxCode,
  PaymentTerm,
  MasterData,
  Package,
  Blocker,
  ConfirmationItem,
  Derived,
  ValidationResult,
} from "./schemas.js"

// ── RC1 ────────────────────────────────────────────────────────────────────────

/**
 * RC1 (Blocker): supplier must exist in master data by normalized tax ID
 * (primary) or normalized name (fallback when tax ID is absent) and be active.
 *
 * PRD: "by tax ID; if there is no tax ID, by normalized name"
 * When a tax ID IS supplied, name matching is disabled entirely. An unknown NIT
 * cannot be bypassed by having a name that matches a different supplier.
 */
export function applyRC1(
  request: Pick<Request, "supplier_name" | "supplier_tax_id">,
  suppliers: Supplier[],
): Blocker | null {
  let match: Supplier | undefined

  if (request.supplier_tax_id) {
    // Tax ID present → match only by normalized NIT.
    // Name fallback is disabled so a wrong NIT cannot be resolved via name.
    const normalizedNit = normalizeNit(request.supplier_tax_id)
    match = suppliers.find((s) => normalizeNit(s.tax_id) === normalizedNit)
  } else {
    // No tax ID → match by normalized name only.
    const normalizedName = normalizeName(request.supplier_name)
    match = suppliers.find((s) => normalizeName(s.name) === normalizedName)
  }

  if (!match) {
    return {
      code: "RC1",
      message: `Supplier '${request.supplier_name}' (tax ID: ${
        request.supplier_tax_id ?? "not provided"
      }) was not found in the supplier master. Verify the tax ID or name and ask the requester to correct it.`,
    }
  }

  if (!match.active) {
    return {
      code: "RC1",
      message: `Supplier '${match.name}' (SAP code ${match.sap_code}, tax ID ${match.tax_id}) is marked inactive in the supplier master. Contact procurement to reactivate or select an alternative supplier.`,
    }
  }

  return null
}

// ── RC2 ────────────────────────────────────────────────────────────────────────

type ApprovalRef = { from: string; date: string; approved: boolean } | null

/**
 * RC2 (Blocker): approval must exist, contain "Approved", and come from an
 * email registered as an approver for the requested cost center.
 */
export function applyRC2(
  approval: ApprovalRef,
  requestCostCenter: string,
  costCenters: CostCenter[],
): Blocker | null {
  if (!approval) {
    return {
      code: "RC2",
      message:
        "Approval email is missing. A manager approval is required before creating a PO. Ask the requester to provide the manager's approval email.",
    }
  }

  if (!approval.approved) {
    return {
      code: "RC2",
      message: `Approval email from ${approval.from} does not contain an explicit 'Approved' statement. Obtain a clear approval from an authorized manager.`,
    }
  }

  const cc = costCenters.find((c) => c.cost_center === requestCostCenter)
  if (!cc) {
    return {
      code: "RC2",
      message: `Cost center '${requestCostCenter}' was not found in master data. Verify the cost center code.`,
    }
  }

  const authorizedApprover = cc.approvers.find(
    (a) => a.email.toLowerCase() === approval.from.toLowerCase(),
  )

  if (!authorizedApprover) {
    const authorized = cc.approvers.map((a) => a.email).join(", ")
    return {
      code: "RC2",
      message: `${approval.from} is not an authorized approver for cost center ${requestCostCenter}. Authorized approvers: ${authorized}. Obtain approval from one of them.`,
    }
  }

  return null
}

// ── RC3 ────────────────────────────────────────────────────────────────────────

/**
 * RC3 (Blocker): total_value must not exceed the actual approver's authorization
 * limit for the requested cost center.
 *
 * RC3 only evaluates when the approver IS listed for the cost center (i.e. has a
 * defined limit). If they are not listed, RC2 already fires for the authorization
 * failure — RC3 cannot be meaningfully evaluated and returns null.
 *
 * [DESIGN] This distinguishes two distinct situations:
 *   - RC2: approver is not authorized for this cost center at all
 *   - RC3: approver is authorized but the amount exceeds their defined limit
 * Documented in SOLUTION.md.
 */
export function applyRC3(
  totalValue: number,
  requestCostCenter: string,
  costCenters: CostCenter[],
  approval: ApprovalRef,
): Blocker | null {
  if (!approval) {
    // RC2 handles the missing-approval case; RC3 cannot evaluate without an approver.
    return null
  }

  const cc = costCenters.find((c) => c.cost_center === requestCostCenter)
  if (!cc) return null // RC2 handles unknown cost center

  const approverRecord = cc.approvers.find(
    (a) => a.email.toLowerCase() === approval.from.toLowerCase(),
  )

  // Approver not listed for this cost center → RC2 handles the authorization failure.
  // RC3 requires a defined limit to compare against; inventing one is not permitted.
  if (!approverRecord) return null

  if (totalValue > approverRecord.limit) {
    return {
      code: "RC3",
      message: `Total value ${totalValue.toLocaleString("en")} COP exceeds the approver's authorization limit of ${approverRecord.limit.toLocaleString("en")} COP for cost center ${requestCostCenter}. An approver with a higher limit must authorize this purchase.`,
    }
  }

  return null
}

// ── RC4 ────────────────────────────────────────────────────────────────────────

/**
 * RC4 (Blocker): the subarea must belong to the requested cost center.
 */
export function applyRC4(
  subarea: string,
  requestCostCenter: string,
  costCenters: CostCenter[],
): Blocker | null {
  const cc = costCenters.find((c) => c.cost_center === requestCostCenter)
  if (!cc) {
    return {
      code: "RC4",
      message: `Cost center '${requestCostCenter}' was not found in master data.`,
    }
  }

  if (!cc.subareas.includes(subarea)) {
    return {
      code: "RC4",
      message: `Subarea '${subarea}' does not belong to cost center ${requestCostCenter}. Valid subareas: ${cc.subareas.join(", ")}. Correct the subarea in the request.`,
    }
  }

  return null
}

// ── RC5 ────────────────────────────────────────────────────────────────────────

/**
 * RC5 (Confirmation): abs(quote.total − request.total) / request.total > 2%.
 * No quote present → confirmation required. Uses integer arithmetic to avoid
 * floating-point comparison errors.
 */
export function applyRC5(
  quoteTotal: number | null,
  requestTotal: number,
): ConfirmationItem | null {
  if (quoteTotal === null) {
    return {
      code: "RC5",
      message:
        "No supplier quote was found for this request. Confirmation is required to proceed without a quote.",
      values: { request_total: requestTotal, quote_total: null },
    }
  }

  const diff = Math.abs(quoteTotal - requestTotal)
  // Integer arithmetic: diff/requestTotal > 0.02 ↔ diff * 100 > requestTotal * 2
  if (diff * 100 > requestTotal * 2) {
    const pct = (((quoteTotal - requestTotal) / requestTotal) * 100).toFixed(2)
    return {
      code: "RC5",
      message: `Quote total (${quoteTotal.toLocaleString("en")} COP) differs from request total (${requestTotal.toLocaleString("en")} COP) by ${pct}%, which exceeds the ±2% tolerance. Confirm which amount should be used in the PO.`,
      values: {
        request_total: requestTotal,
        quote_total: quoteTotal,
        difference_pct: parseFloat(pct),
      },
    }
  }

  return null
}

// ── RC6 ────────────────────────────────────────────────────────────────────────

/**
 * RC6 result discriminated union.
 * - "confirmation": tax code derived from supplier default; user must confirm.
 * - "unresolvable": tax code missing AND the supplier's default_tax_code is not
 *   a valid master-data code. PO creation must be blocked until resolved.
 * - null: tax code was provided in the request; no action needed.
 */
export type RC6Result =
  | { kind: "confirmation"; confirmation: ConfirmationItem; derived: string }
  | { kind: "unresolvable"; blocker: Blocker }
  | null

/**
 * RC6 (Confirmation + Derived): if tax code is missing, derive it from the
 * supplier's default and request confirmation.
 * Fail-closed: if the default code is not present in master data, return a
 * blocker — never silently pass through without a valid tax code.
 */
export function applyRC6(
  taxCode: string | null | undefined,
  supplier: Supplier | null,
  taxCodes: TaxCode[],
): RC6Result {
  if (taxCode !== null && taxCode !== undefined && taxCode !== "") return null

  if (!supplier) return null // RC1 fires independently; can't derive without supplier

  const derivedCode = supplier.default_tax_code
  const taxCodeRecord = taxCodes.find((tc) => tc.code === derivedCode)

  if (!taxCodeRecord) {
    // Supplier has an invalid default: fail closed — block PO creation.
    return {
      kind: "unresolvable",
      blocker: {
        code: "RC6",
        message: `Tax code was not provided and the supplier '${supplier.name}' has an invalid default tax code '${derivedCode}' (not found in master data). Contact procurement to correct the supplier's default tax code before creating the PO.`,
      },
    }
  }

  return {
    kind: "confirmation",
    confirmation: {
      code: "RC6",
      message: `Tax code was not provided. Tax code '${derivedCode}' (${taxCodeRecord.description}, ${(taxCodeRecord.rate * 100).toFixed(0)}%) has been derived from the supplier '${supplier.name}' default. Please confirm this is correct.`,
      values: {
        derived_tax_code: derivedCode,
        description: taxCodeRecord.description,
        supplier: supplier.name,
      },
    },
    derived: derivedCode,
  }
}

// ── RC7 ────────────────────────────────────────────────────────────────────────

/**
 * RC7 result discriminated union.
 * - "derived": payment terms derived from supplier default; informational only.
 * - "unresolvable": payment terms missing AND the supplier's default is not a
 *   valid master-data code. PO creation must be blocked until resolved.
 * - null: payment terms were provided; no action needed.
 */
export type RC7Result =
  | { kind: "derived"; derived: string }
  | { kind: "unresolvable"; blocker: Blocker }
  | null

/**
 * RC7 (Derived only): if payment terms are missing, derive from the supplier's
 * default. Informational — no confirmation required.
 * Fail-closed: if the default code is not present in master data, return a
 * blocker — never silently pass through without valid payment terms.
 */
export function applyRC7(
  paymentTerms: string | null | undefined,
  supplier: Supplier | null,
  paymentTermsMaster: PaymentTerm[],
): RC7Result {
  if (paymentTerms !== null && paymentTerms !== undefined && paymentTerms !== "")
    return null

  if (!supplier) return null

  const derivedTerms = supplier.default_payment_terms
  const termsRecord = paymentTermsMaster.find((pt) => pt.code === derivedTerms)

  if (!termsRecord) {
    // Fail closed: supplier has an invalid default payment terms code.
    return {
      kind: "unresolvable",
      blocker: {
        code: "RC7",
        message: `Payment terms were not provided and the supplier '${supplier.name}' has an invalid default payment terms code '${derivedTerms}' (not found in master data). Contact procurement to correct the supplier's default before creating the PO.`,
      },
    }
  }

  return { kind: "derived", derived: derivedTerms }
}

// ── RC8 ────────────────────────────────────────────────────────────────────────

/**
 * RC8 (Confirmation): if an invoice exists with a date earlier than the request
 * date, the PO is retroactive. Sets retroactive=true in the control log.
 */
export function applyRC8(
  invoice: { date: string } | null,
  requestDate: string,
): { confirmation: ConfirmationItem; retroactive: boolean } | null {
  if (!invoice) return null

  // YYYY-MM-DD strings support lexicographic comparison
  if (invoice.date < requestDate) {
    return {
      confirmation: {
        code: "RC8",
        message: `Invoice date (${invoice.date}) predates the request date (${requestDate}). This is a retroactive purchase order — the invoice arrived before the request was submitted. Confirmation required to proceed. This will be flagged in the control log.`,
        values: { invoice_date: invoice.date, request_date: requestDate },
      },
      retroactive: true,
    }
  }

  return null
}

// ── RC9 ────────────────────────────────────────────────────────────────────────

/**
 * RC9 (Confirmation): approval date must be ≥ request date.
 * Only the date portion of the approval timestamp is compared (timezone-aware
 * timestamps are sliced to YYYY-MM-DD).
 */
export function applyRC9(
  approvalDate: string | null,
  requestDate: string,
): ConfirmationItem | null {
  if (!approvalDate) return null

  const approvalDateOnly = approvalDate.slice(0, 10)

  if (approvalDateOnly < requestDate) {
    return {
      code: "RC9",
      message: `Approval date (${approvalDateOnly}) is before the request date (${requestDate}). The manager may have approved a different or earlier version of this request. Confirmation required to proceed.`,
      values: { approval_date: approvalDateOnly, request_date: requestDate },
    }
  }

  return null
}

// ── RC10 ───────────────────────────────────────────────────────────────────────

/**
 * RC10 (Blocker): quantity × unit_price must equal total_value within ±1
 * monetary unit. Uses integer arithmetic.
 */
export function applyRC10(
  quantity: number,
  unitPrice: number,
  total: number,
): Blocker | null {
  const computed = quantity * unitPrice
  const diff = Math.abs(computed - total)

  if (diff > 1) {
    return {
      code: "RC10",
      message: `Mathematical inconsistency: ${quantity} × ${unitPrice.toLocaleString("en")} = ${computed.toLocaleString("en")} but total_value is ${total.toLocaleString("en")} (difference: ${diff}). Correct the quantity, unit price or total in the request.`,
    }
  }

  return null
}

// ── runAllRules ────────────────────────────────────────────────────────────────

/**
 * Run all 10 control rules against the package + master data.
 * ALL rules run independently — this function never short-circuits after finding
 * a blocker. Missing or invalid dependencies are handled safely without
 * fabricating data.
 */
export function runAllRules(
  pkg: Package,
  masterData: MasterData,
): ValidationResult {
  const blockers: Blocker[] = []
  const confirmations: ConfirmationItem[] = []
  const derived: Derived = {}
  let retroactive = false

  const { request } = pkg

  // Resolve supplier record for RC6/RC7 derived-value lookups.
  // Uses the same if/else logic as RC1: NIT takes priority; name only when absent.
  let supplierRecord: Supplier | null = null
  if (request.supplier_tax_id) {
    const normalizedNit = normalizeNit(request.supplier_tax_id)
    supplierRecord =
      masterData.suppliers.find(
        (s) => normalizeNit(s.tax_id) === normalizedNit,
      ) ?? null
  } else {
    const normalizedName = normalizeName(request.supplier_name)
    supplierRecord =
      masterData.suppliers.find(
        (s) => normalizeName(s.name) === normalizedName,
      ) ?? null
  }

  // RC1: supplier exists and is active
  const rc1 = applyRC1(request, masterData.suppliers)
  if (rc1) blockers.push(rc1)

  // RC2: approval exists, contains "Approved", from authorized CC approver
  const rc2 = applyRC2(pkg.approval, request.cost_center, masterData.costCenters)
  if (rc2) blockers.push(rc2)

  // RC3: total_value ≤ actual approver's defined limit (only when approver is
  //       listed for this cost center; returns null otherwise — RC2 covers that)
  const rc3 = applyRC3(
    request.total_value,
    request.cost_center,
    masterData.costCenters,
    pkg.approval,
  )
  if (rc3) blockers.push(rc3)

  // RC4: subarea belongs to cost center
  const rc4 = applyRC4(
    request.subarea,
    request.cost_center,
    masterData.costCenters,
  )
  if (rc4) blockers.push(rc4)

  // RC5: quote total within ±2% of request total
  const quoteTotal = pkg.quote ? pkg.quote.total : null
  const rc5 = applyRC5(quoteTotal, request.total_value)
  if (rc5) confirmations.push(rc5)

  // RC6: missing tax code → derive from supplier (fail-closed on invalid default)
  const rc6 = applyRC6(
    request.tax_code ?? null,
    supplierRecord,
    masterData.taxCodes,
  )
  if (rc6) {
    if (rc6.kind === "confirmation") {
      confirmations.push(rc6.confirmation)
      derived.tax_code = rc6.derived
    } else {
      blockers.push(rc6.blocker)
    }
  }

  // RC7: missing payment terms → derive from supplier (fail-closed on invalid default)
  const rc7 = applyRC7(
    request.payment_terms ?? null,
    supplierRecord,
    masterData.paymentTerms,
  )
  if (rc7) {
    if (rc7.kind === "derived") {
      derived.payment_terms = rc7.derived
    } else {
      blockers.push(rc7.blocker)
    }
  }

  // RC8: invoice predates request → retroactive
  const rc8 = applyRC8(pkg.invoice, request.request_date)
  if (rc8) {
    confirmations.push(rc8.confirmation)
    retroactive = rc8.retroactive
  }

  // RC9: approval date ≥ request date
  const rc9 = applyRC9(pkg.approval?.date ?? null, request.request_date)
  if (rc9) confirmations.push(rc9)

  // RC10: quantity × unit_price = total_value (±1 monetary unit)
  const rc10 = applyRC10(
    request.quantity,
    request.unit_price,
    request.total_value,
  )
  if (rc10) blockers.push(rc10)

  return {
    eligible: blockers.length === 0,
    blockers,
    confirmations,
    derived,
    retroactive,
  }
}
