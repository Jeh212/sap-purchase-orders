/**
 * po.ts — purchase-order tools.
 * Each export becomes po_<export> as seen by the model (PRD 6.2).
 * Every execute() returns a JSON string encoding { ok: true, data } | { ok: false, error }.
 * execute() never throws uncaught errors.
 *
 * Tool call order enforced by the agent prompt:
 *   read_package → validate → generate_evidence → build_payload → create
 *
 * generate_evidence MUST precede build_payload because PurchaseOrder.approver.evidence_sha256
 * is mandatory. build_payload reads the SHA from the approval.txt written by generate_evidence
 * (it is NOT passed as a tool argument — PRD 6.2 specifies only { case_id, package, derived }).
 *
 * Security note for po_create: the backend IGNORES both the model-supplied payload content and
 * the confirmed flag as authorization proofs. Instead, the server independently re-validates
 * RC1–RC10 from fixture sources and checks its own per-session ConfirmationStore for explicit
 * human confirmation bound to an immutable server-computed payload hash.
 */

import { z } from "zod"
import { PurchaseOrderSchema } from "../domain/schemas.js"
import type { ToolResult } from "../domain/schemas.js"
import type {
  Package,
  ValidationResult,
  PurchaseOrder,
} from "../domain/schemas.js"

type ToolCtx = { directory: string; sessionId: string }

function serialize<T>(result: ToolResult<T>): string {
  return JSON.stringify(result)
}

// ── po_read_package ────────────────────────────────────────────────────────────

export const read_package = {
  description:
    "Reads and normalizes the purchase-order request package (email, request, quote, approval, invoice) from the fixture folder identified by case_id.",
  args: {
    case_id: z
      .string()
      .describe(
        "Name of the case folder inside fixtures/challenge-03/requests/, e.g. 'req-001'",
      ),
  },
  async execute(
    _args: { case_id: string },
    _ctx: ToolCtx,
  ): Promise<string> {
    const result: ToolResult<Package> = {
      ok: false,
      error: "not implemented — Phase 3",
    }
    return serialize(result)
  },
}

// ── po_validate ────────────────────────────────────────────────────────────────

export const validate = {
  description:
    "Validates the purchase-order package against master data and all 10 business controls (RC1–RC10). Returns eligible flag, blockers, confirmations required, derived values and retroactive flag.",
  args: {
    case_id: z
      .string()
      .describe("Case folder name, e.g. 'req-001'"),
    package: z
      .record(z.unknown())
      .describe("Normalized package returned by po_read_package"),
  },
  async execute(
    _args: { case_id: string; package: Record<string, unknown> },
    _ctx: ToolCtx,
  ): Promise<string> {
    const result: ToolResult<ValidationResult> = {
      ok: false,
      error: "not implemented — Phase 3",
    }
    return serialize(result)
  },
}

// ── po_generate_evidence ───────────────────────────────────────────────────────

export const generate_evidence = {
  description:
    "Generates the approval evidence artifact (approval.txt with canonical email headers, body and SHA-256 digest) and returns its file path and hash. Must be called before po_build_payload.",
  args: {
    case_id: z
      .string()
      .describe("Case folder name, e.g. 'req-001'"),
  },
  async execute(
    _args: { case_id: string },
    _ctx: ToolCtx,
  ): Promise<string> {
    const result: ToolResult<{ path: string; sha256: string }> = {
      ok: false,
      error: "not implemented — Phase 3",
    }
    return serialize(result)
  },
}

// ── po_build_payload ───────────────────────────────────────────────────────────

export const build_payload = {
  description:
    "Builds and validates the complete SAP PO payload from trusted fixture data and writes out/<case>/traceability.json. po_generate_evidence must be called first; this tool reads the approval SHA from the generated file internally.",
  args: {
    case_id: z
      .string()
      .describe("Case folder name, e.g. 'req-001'"),
    package: z
      .record(z.unknown())
      .describe("Normalized package returned by po_read_package"),
    derived: z
      .record(z.unknown())
      .describe("Derived values from po_validate (tax_code, payment_terms)"),
  },
  async execute(
    _args: {
      case_id: string
      package: Record<string, unknown>
      derived: Record<string, unknown>
    },
    _ctx: ToolCtx,
  ): Promise<string> {
    const result: ToolResult<{
      payload: PurchaseOrder
      traceability_path: string
    }> = {
      ok: false,
      error: "not implemented — Phase 3",
    }
    return serialize(result)
  },
}

// ── po_create ──────────────────────────────────────────────────────────────────

export const create = {
  description:
    "Creates the purchase order in the simulated SAP. The backend re-validates RC1–RC10 from authoritative fixture data and checks its own per-session confirmation store — the payload and confirmed flag supplied here are NOT trusted as authorization proof.",
  args: {
    case_id: z
      .string()
      .describe("Case folder name, e.g. 'req-001'"),
    payload: PurchaseOrderSchema.describe(
      "The complete PO payload returned by po_build_payload. The backend re-validates this independently from fixture sources.",
    ),
    confirmed: z
      .boolean()
      .optional()
      .describe(
        "Informational only — ignored by the backend. Real authorization requires explicit human confirmation via the chat confirm flow.",
      ),
  },
  async execute(
    _args: { case_id: string; payload: PurchaseOrder; confirmed?: boolean },
    _ctx: ToolCtx,
  ): Promise<string> {
    const result: ToolResult<{
      po_number: string
      date: string
      idempotent: boolean
    }> = {
      ok: false,
      error: "not implemented — Phase 3",
    }
    return serialize(result)
  },
}
