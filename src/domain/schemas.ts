import { z } from "zod"

// ── Raw fixture types ──────────────────────────────────────────────────────────

export const RequestSchema = z.object({
  request_id: z.string(),
  requester: z.string(),
  supplier_name: z.string(),
  supplier_tax_id: z.string().optional(),
  description: z.string(),
  cost_center: z.string(),
  subarea: z.string(),
  quantity: z.number(),
  unit_price: z.number(),
  total_value: z.number(),
  currency: z.string(),
  tax_code: z.string().optional(),
  payment_terms: z.string().optional(),
  request_date: z.string(),
})

export type Request = z.infer<typeof RequestSchema>

// ── Normalized package (PRD 7.2) ──────────────────────────────────────────────

export const EmailSchema = z.object({
  id: z.string(),
  from: z.string(),
  subject: z.string(),
  date: z.string(),
})

export const QuoteSchema = z.object({
  supplier: z.string(),
  tax_id: z.string().nullable(),
  total: z.number(),
  currency: z.string(),
  valid_until: z.string().nullable(),
  text: z.string(),
})

export const ApprovalSchema = z.object({
  from: z.string(),
  date: z.string(),
  approved: z.boolean(),
  text: z.string(),
})

export const InvoiceSchema = z.object({
  number: z.string(),
  date: z.string(),
  total: z.number(),
})

export const PackageSchema = z.object({
  email: EmailSchema,
  request: RequestSchema,
  quote: QuoteSchema.nullable(),
  approval: ApprovalSchema.nullable(),
  invoice: InvoiceSchema.nullable(),
})

export type Package = z.infer<typeof PackageSchema>
export type Email = z.infer<typeof EmailSchema>
export type Quote = z.infer<typeof QuoteSchema>
export type Approval = z.infer<typeof ApprovalSchema>
export type Invoice = z.infer<typeof InvoiceSchema>

// ── Master data types ─────────────────────────────────────────────────────────

export const SupplierSchema = z.object({
  sap_code: z.string(),
  tax_id: z.string(),
  name: z.string(),
  default_payment_terms: z.string(),
  default_tax_code: z.string(),
  active: z.boolean(),
})

export type Supplier = z.infer<typeof SupplierSchema>

export const CostCenterApproverSchema = z.object({
  email: z.string(),
  limit: z.number(),
})

export const CostCenterSchema = z.object({
  cost_center: z.string(),
  subareas: z.array(z.string()),
  approvers: z.array(CostCenterApproverSchema),
})

export type CostCenter = z.infer<typeof CostCenterSchema>
export type CostCenterApprover = z.infer<typeof CostCenterApproverSchema>

export const TaxCodeSchema = z.object({
  code: z.string(),
  description: z.string(),
  rate: z.number(),
})

export type TaxCode = z.infer<typeof TaxCodeSchema>

export const PaymentTermSchema = z.object({
  code: z.string(),
  description: z.string(),
  days: z.number(),
})

export type PaymentTerm = z.infer<typeof PaymentTermSchema>

export const MasterDataSchema = z.object({
  suppliers: z.array(SupplierSchema),
  costCenters: z.array(CostCenterSchema),
  taxCodes: z.array(TaxCodeSchema),
  paymentTerms: z.array(PaymentTermSchema),
})

export type MasterData = z.infer<typeof MasterDataSchema>

// ── Validation result types ───────────────────────────────────────────────────

export const BlockerSchema = z.object({
  code: z.string().describe("RC rule code, e.g. RC1"),
  message: z.string(),
})

export type Blocker = z.infer<typeof BlockerSchema>

export const ConfirmationItemSchema = z.object({
  code: z.string().describe("RC rule code, e.g. RC5"),
  message: z.string(),
  values: z.record(z.unknown()).optional(),
})

export type ConfirmationItem = z.infer<typeof ConfirmationItemSchema>

export const DerivedSchema = z.object({
  tax_code: z.string().optional(),
  payment_terms: z.string().optional(),
})

export type Derived = z.infer<typeof DerivedSchema>

export const ValidationResultSchema = z.object({
  eligible: z.boolean(),
  blockers: z.array(BlockerSchema),
  confirmations: z.array(ConfirmationItemSchema),
  derived: DerivedSchema,
  retroactive: z.boolean(),
})

export type ValidationResult = z.infer<typeof ValidationResultSchema>

// ── PO payload (PRD 7.4) ──────────────────────────────────────────────────────

export const PurchaseOrderItemSchema = z.object({
  number: z.number().int().positive(),
  description: z.string().max(40),
  quantity: z.number().positive(),
  unit: z.enum(["EA", "H", "MON"]),
  unit_price: z.number().nonnegative(),
  cost_center: z.string(),
  subarea: z.string(),
  tax_code: z.string(),
})

export const ExceptionSchema = z.object({
  code: z.string(),
  detail: z.string(),
  confirmed_by: z.string().nullable(),
})

export const PurchaseOrderSchema = z.object({
  reference: z.object({
    request_id: z.string(),
    email_id: z.string(),
    quote_ref: z.string().nullable(),
  }),
  company_code: z.literal("1000"),
  purchasing_org: z.literal("1000"),
  supplier: z.object({
    sap_code: z.string(),
    tax_id: z.string(),
    name: z.string(),
  }),
  currency: z.enum(["COP", "USD"]),
  payment_terms: z.string(),
  approver: z.object({
    email: z.string(),
    approval_date: z.string(),
    evidence_sha256: z.string(),
  }),
  items: z.array(PurchaseOrderItemSchema).min(1),
  exceptions: z.array(ExceptionSchema),
})

export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>
export type PurchaseOrderItem = z.infer<typeof PurchaseOrderItemSchema>
export type Exception = z.infer<typeof ExceptionSchema>

// ── Tool result wrapper ───────────────────────────────────────────────────────

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string }

export function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data }
}

export function err(error: string): ToolResult<never> {
  return { ok: false, error }
}
