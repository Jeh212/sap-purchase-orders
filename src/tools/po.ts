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
import type { ToolResult, Package, ValidationResult, PurchaseOrder, MasterData, Supplier } from "../domain/schemas.js"
import {
  EmailSchema,
  RequestSchema,
  ApprovalSchema,
  QuoteSchema,
  InvoiceSchema,
  PackageSchema,
  MasterDataSchema,
} from "../domain/schemas.js"
import { ok, err } from "../domain/schemas.js"
import type { ConfirmationStore } from "../domain/confirmation.js"
import { InMemoryConfirmationStore } from "../domain/confirmation.js"
import type { SapAdapter } from "../sap/adapter.js"
import { FileSapMock, PayloadConflictError } from "../sap/mock.js"
import { runAllRules } from "../domain/rules.js"
import { normalizeNit, normalizeName, parseQuoteTotal, parseQuoteRef, parseQuoteSupplierNit, parseQuoteValidUntil, parseInvoiceDate, parseInvoiceTotal, parseInvoiceNumber } from "../domain/normalize.js"
import {
  buildPayload,
  buildSources,
  canonicalPurchaseOrder,
  hashPurchaseOrder,
  writeTraceability,
} from "../domain/payload.js"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as crypto from "node:crypto"

// ── Tool context ───────────────────────────────────────────────────────────────

export type ToolCtx = {
  directory: string
  sessionId: string
  outDir?: string
  confirmationStore?: ConfirmationStore
  sapAdapter?: SapAdapter
}

function serialize<T>(result: ToolResult<T>): string {
  return JSON.stringify(result)
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function resolveOutDir(ctx: ToolCtx): string {
  return ctx.outDir ?? path.join(ctx.directory, "out")
}

function resolveFixturesRoot(ctx: ToolCtx): string {
  return path.join(ctx.directory, "fixtures")
}

async function loadMasterData(fixturesRoot: string): Promise<MasterData> {
  const mdRoot = path.join(fixturesRoot, "challenge-03", "master-data")
  const [suppliersRaw, costCentersRaw, taxCodesRaw, paymentTermsRaw] =
    await Promise.all([
      fs.readFile(path.join(mdRoot, "suppliers.json"), "utf-8").then((t) => JSON.parse(t) as unknown),
      fs.readFile(path.join(mdRoot, "cost-centers.json"), "utf-8").then((t) => JSON.parse(t) as unknown),
      fs.readFile(path.join(mdRoot, "tax-codes.json"), "utf-8").then((t) => JSON.parse(t) as unknown),
      fs.readFile(path.join(mdRoot, "payment-terms.json"), "utf-8").then((t) => JSON.parse(t) as unknown),
    ])
  return MasterDataSchema.parse({
    suppliers: suppliersRaw,
    costCenters: costCentersRaw,
    taxCodes: taxCodesRaw,
    paymentTerms: paymentTermsRaw,
  })
}

async function readRequiredJson(
  caseDir: string,
  fileName: "email.json" | "request.json",
): Promise<unknown> {
  let text: string
  try {
    text = await fs.readFile(path.join(caseDir, fileName), "utf-8")
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String(error.code)
      : ""
    if (code === "ENOENT") throw new Error(`missing ${fileName}`)
    throw new Error(`unable to read ${fileName}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`malformed ${fileName}`)
  }
}

function resolveSupplier(
  request: Pick<Package["request"], "supplier_name" | "supplier_tax_id">,
  suppliers: Supplier[],
): Supplier | null {
  if (request.supplier_tax_id) {
    const n = normalizeNit(request.supplier_tax_id)
    return suppliers.find((s) => normalizeNit(s.tax_id) === n) ?? null
  }
  const n = normalizeName(request.supplier_name)
  return suppliers.find((s) => normalizeName(s.name) === n) ?? null
}

async function readPackageFromFixture(
  case_id: string,
  fixturesRoot: string,
): Promise<Package> {
  const caseDir = path.join(fixturesRoot, "challenge-03", "requests", case_id)

  // Defense-in-depth path check
  const resolved = path.resolve(caseDir)
  const resolvedRoot = path.resolve(fixturesRoot)
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    throw new Error("path traversal detected")
  }

  try {
    await fs.access(caseDir)
  } catch {
    throw new Error("case not found")
  }

  // email.json (required)
  const emailValue = await readRequiredJson(caseDir, "email.json")
  if (emailValue === null || typeof emailValue !== "object" || Array.isArray(emailValue)) {
    throw new Error("malformed email.json")
  }
  const emailRaw = emailValue as Record<string, unknown>
  const email = EmailSchema.parse({
    id: emailRaw["id"],
    from: emailRaw["from"],
    subject: emailRaw["subject"],
    date: emailRaw["date"],
  })

  // request.json (required)
  const request = RequestSchema.parse(await readRequiredJson(caseDir, "request.json"))

  // approval.json (optional)
  let approval = null
  try {
    const approvalRaw = JSON.parse(
      await fs.readFile(path.join(caseDir, "approval.json"), "utf-8"),
    ) as Record<string, unknown>
    const body = typeof approvalRaw["body"] === "string" ? approvalRaw["body"] : ""
    approval = ApprovalSchema.parse({
      from: approvalRaw["from"],
      date: approvalRaw["date"],
      approved: body.includes("Approved"),
      text: body,
    })
  } catch {
    // approval.json missing
  }

  // quote.txt (optional)
  let quote = null
  try {
    const quoteText = await fs.readFile(path.join(caseDir, "quote.txt"), "utf-8")
    let total = 0
    try {
      total = parseQuoteTotal(quoteText)
    } catch {
      // malformed quote — total stays 0, RC5 will fire
    }
    quote = QuoteSchema.parse({
      supplier: parseQuoteRef(quoteText) ?? "",
      tax_id: parseQuoteSupplierNit(quoteText),
      total,
      currency: "COP",
      valid_until: parseQuoteValidUntil(quoteText),
      text: quoteText,
    })
  } catch {
    // quote.txt missing
  }

  // invoice.txt — only if email lists "invoice.pdf" in attachments
  let invoice = null
  const attachments = Array.isArray(emailRaw["attachments"])
    ? (emailRaw["attachments"] as unknown[]).map(String)
    : []
  if (attachments.includes("invoice.pdf")) {
    try {
      const invoiceText = await fs.readFile(
        path.join(caseDir, "invoice.txt"),
        "utf-8",
      )
      const invoiceDate = parseInvoiceDate(invoiceText)
      const invoiceTotal = parseInvoiceTotal(invoiceText)
      const invoiceNumber = parseInvoiceNumber(invoiceText)
      if (invoiceDate && invoiceTotal !== null && invoiceNumber) {
        invoice = InvoiceSchema.parse({
          number: invoiceNumber,
          date: invoiceDate,
          total: invoiceTotal,
        })
      }
    } catch {
      // invoice.txt missing or malformed
    }
  }

  return PackageSchema.parse({ email, request, quote, approval, invoice })
}

// ── Deterministic payload hash (used by ConfirmationStore) ────────────────────

/** Hash of the final authoritative payload, including its evidence digest. */
async function readEvidenceSha(outDir: string, caseId: string): Promise<string> {
  const approvalTxt = await fs.readFile(
    path.join(outDir, caseId, "approval.txt"),
    "utf-8",
  )
  const shaMatch = approvalTxt.match(/^SHA256:\s*([a-f0-9]{64})$/m)
  if (!shaMatch?.[1]) throw new Error("SHA256 line not found in approval.txt")
  return shaMatch[1]
}

// ── Audit logging ──────────────────────────────────────────────────────────────

type ControlRow = {
  request_id: string
  result: string
  po_number: string
  retroactive: boolean
  blockers: string
  confirmations: string
  ts: string
}

const CONTROL_HEADER = "request_id,result,po_number,retroactive,blockers,confirmations,ts\n"

async function appendControlCsv(
  outDir: string,
  row: ControlRow,
): Promise<void> {
  try {
    await fs.mkdir(outDir, { recursive: true })
    const csvPath = path.join(outDir, "control.csv")

    try {
      await fs.access(csvPath)
    } catch {
      await fs.writeFile(csvPath, CONTROL_HEADER, "utf-8")
    }

    const escape = (s: string): string =>
      s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s

    const line =
      [
        escape(row.request_id),
        escape(row.result),
        escape(row.po_number),
        row.retroactive ? "true" : "false",
        escape(row.blockers),
        escape(row.confirmations),
        escape(row.ts),
      ].join(",") + "\n"

    await fs.appendFile(csvPath, line, "utf-8")
  } catch {
    // audit log failures must not crash the tool
  }
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
    args: { case_id: string },
    ctx: ToolCtx,
  ): Promise<string> {
    try {
      if (!/^[a-z0-9-]+$/.test(args.case_id)) {
        return serialize(err("invalid case_id"))
      }
      const fixturesRoot = resolveFixturesRoot(ctx)
      const pkg = await readPackageFromFixture(args.case_id, fixturesRoot)
      return serialize(ok(pkg))
    } catch (e) {
      return serialize(err(e instanceof Error ? e.message : "unknown error"))
    }
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
      .record(z.string(), z.unknown())
      .describe("Normalized package returned by po_read_package"),
  },
  async execute(
    args: { case_id: string; package: Record<string, unknown> },
    ctx: ToolCtx,
  ): Promise<string> {
    try {
      if (!/^[a-z0-9-]+$/.test(args.case_id)) {
        return serialize(err("invalid case_id"))
      }
      const fixturesRoot = resolveFixturesRoot(ctx)
      const outDir = resolveOutDir(ctx)

      // Re-read from fixture — never trust model-supplied package for validation
      const pkg = await readPackageFromFixture(args.case_id, fixturesRoot)
      const masterData = await loadMasterData(fixturesRoot)
      const result = runAllRules(pkg, masterData)

      // Write VALIDATION row to control.csv
      await appendControlCsv(outDir, {
        request_id: pkg.request.request_id,
        result: "VALIDATION",
        po_number: "",
        retroactive: result.retroactive,
        blockers: result.blockers.map((b) => b.code).join("|"),
        confirmations: result.confirmations.map((c) => c.code).join("|"),
        ts: new Date().toISOString(),
      })

      // Write BLOCKED row immediately so the outcome is recorded even when po_create is never called
      if (!result.eligible) {
        await appendControlCsv(outDir, {
          request_id: pkg.request.request_id,
          result: "BLOCKED",
          po_number: "",
          retroactive: result.retroactive,
          blockers: result.blockers.map((b) => b.code).join("|"),
          confirmations: "",
          ts: new Date().toISOString(),
        })
      }

      return serialize(ok(result))
    } catch (e) {
      return serialize(err(e instanceof Error ? e.message : "unknown error"))
    }
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
    args: { case_id: string },
    ctx: ToolCtx,
  ): Promise<string> {
    try {
      if (!/^[a-z0-9-]+$/.test(args.case_id)) {
        return serialize(err("invalid case_id"))
      }
      const fixturesRoot = resolveFixturesRoot(ctx)
      const outDir = resolveOutDir(ctx)
      const caseDir = path.join(
        fixturesRoot,
        "challenge-03",
        "requests",
        args.case_id,
      )

      try {
        await fs.access(caseDir)
      } catch {
        return serialize(err("case not found"))
      }

      let approvalRaw: Record<string, unknown>
      try {
        approvalRaw = JSON.parse(
          await fs.readFile(path.join(caseDir, "approval.json"), "utf-8"),
        ) as Record<string, unknown>
      } catch {
        return serialize(err("approval.json not found — cannot generate evidence"))
      }

      const from = String(approvalRaw["from"] ?? "")
      const to = String(approvalRaw["to"] ?? "")
      const date = String(approvalRaw["date"] ?? "")
      const subject = String(approvalRaw["subject"] ?? "")
      const body = String(approvalRaw["body"] ?? "")

      // Canonical text format — deterministic, no trailing whitespace per line
      const canonicalText = `From: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${subject}\n\n${body}`
      const sha256 = crypto
        .createHash("sha256")
        .update(canonicalText, "utf-8")
        .digest("hex")

      const caseOutDir = path.join(outDir, args.case_id)
      await fs.mkdir(caseOutDir, { recursive: true })

      const outPath = path.join(caseOutDir, "approval.txt")
      // Hash is over canonicalText only — the SHA256 line is not included in the hash
      await fs.writeFile(
        outPath,
        `${canonicalText}\n---\nSHA256: ${sha256}`,
        "utf-8",
      )

      const relPath = path.relative(ctx.directory, outPath)
      return serialize(ok({ path: relPath, sha256 }))
    } catch (e) {
      return serialize(err(e instanceof Error ? e.message : "unknown error"))
    }
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
      .record(z.string(), z.unknown())
      .describe("Normalized package returned by po_read_package"),
    derived: z
      .record(z.string(), z.unknown())
      .describe("Derived values from po_validate (tax_code, payment_terms)"),
  },
  async execute(
    args: {
      case_id: string
      package: Record<string, unknown>
      derived: Record<string, unknown>
    },
    ctx: ToolCtx,
  ): Promise<string> {
    try {
      if (!/^[a-z0-9-]+$/.test(args.case_id)) {
        return serialize(err("invalid case_id"))
      }
      const fixturesRoot = resolveFixturesRoot(ctx)
      const outDir = resolveOutDir(ctx)

      // Re-read from fixture for authoritative data
      const pkg = await readPackageFromFixture(args.case_id, fixturesRoot)
      const masterData = await loadMasterData(fixturesRoot)
      const validationResult = runAllRules(pkg, masterData)

      // Read evidence SHA from previously generated approval.txt
      let evidenceSha256: string
      try {
        evidenceSha256 = await readEvidenceSha(outDir, args.case_id)
      } catch (e) {
        return serialize(
          err(
            `Cannot read approval SHA: ${e instanceof Error ? e.message : "unknown"} — call po_generate_evidence first`,
          ),
        )
      }

      const supplierRecord = resolveSupplier(pkg.request, masterData.suppliers)
      if (!supplierRecord) {
        return serialize(err("Supplier not found in master data"))
      }

      let payload: PurchaseOrder
      try {
        payload = buildPayload(
          pkg,
          validationResult,
          evidenceSha256,
          supplierRecord,
          null,
        )
      } catch (e) {
        return serialize(
          err(
            `Payload validation failed: ${e instanceof Error ? e.message : "unknown"}`,
          ),
        )
      }

      const sources = buildSources(pkg, validationResult)
      const tracePath = await writeTraceability(outDir, args.case_id, payload, sources)

      // A confirmation becomes pending only after evidence generation and final
      // authoritative payload construction. The authorization is therefore bound
      // to the exact payload that po_create will reconstruct and persist.
      if (validationResult.confirmations.length > 0 && ctx.confirmationStore) {
        const payloadHash = hashPurchaseOrder(payload)
        const priorStatus = ctx.confirmationStore.check(
          pkg.request.request_id,
          payloadHash,
        )
        if (priorStatus === "none" || priorStatus === "expired") {
          ctx.confirmationStore.setPending(
            pkg.request.request_id,
            payloadHash,
            validationResult.confirmations.map((confirmation) => confirmation.code),
          )
          await appendControlCsv(outDir, {
            request_id: pkg.request.request_id,
            result: "PENDING",
            po_number: "",
            retroactive: validationResult.retroactive,
            blockers: "",
            confirmations: validationResult.confirmations
              .map((confirmation) => confirmation.code)
              .join("|"),
            ts: new Date().toISOString(),
          })
        }
      }

      return serialize(ok({ payload, traceability_path: tracePath }))
    } catch (e) {
      return serialize(err(e instanceof Error ? e.message : "unknown error"))
    }
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
    ctx: ToolCtx,
  ): Promise<string> {
    try {
      if (!/^[a-z0-9-]+$/.test(_args.case_id)) {
        return serialize(err("invalid case_id"))
      }
      const fixturesRoot = resolveFixturesRoot(ctx)
      const outDir = resolveOutDir(ctx)

      // Server-side re-validation from fixture — model-supplied payload is ignored
      const pkg = await readPackageFromFixture(_args.case_id, fixturesRoot)
      const masterData = await loadMasterData(fixturesRoot)
      const validationResult = runAllRules(pkg, masterData)

      const requestId = pkg.request.request_id

      // Blockers take absolute priority
      if (!validationResult.eligible) {
        await appendControlCsv(outDir, {
          request_id: requestId,
          result: "BLOCKED",
          po_number: "",
          retroactive: validationResult.retroactive,
          blockers: validationResult.blockers.map((b) => b.code).join("|"),
          confirmations: "",
          ts: new Date().toISOString(),
        })
        const msgs = validationResult.blockers
          .map((b) => `${b.code}: ${b.message}`)
          .join("; ")
        return serialize(err(`PO creation blocked: ${msgs}`))
      }

      const supplierRecord = resolveSupplier(pkg.request, masterData.suppliers)
      if (!supplierRecord) {
        return serialize(err("Supplier not found in master data"))
      }

      let evidenceSha256: string
      try {
        evidenceSha256 = await readEvidenceSha(outDir, _args.case_id)
      } catch (e) {
        return serialize(
          err(
            `Approval evidence not found: ${e instanceof Error ? e.message : "unknown"} — call po_generate_evidence first`,
          ),
        )
      }

      let proposedPayload: PurchaseOrder
      try {
        proposedPayload = buildPayload(
          pkg,
          validationResult,
          evidenceSha256,
          supplierRecord,
          null,
        )
      } catch (e) {
        return serialize(
          err(
            `Payload construction failed: ${e instanceof Error ? e.message : "unknown"}`,
          ),
        )
      }

      if (
        canonicalPurchaseOrder(_args.payload) !==
        canonicalPurchaseOrder(proposedPayload)
      ) {
        return serialize(
          err(
            "payload mismatch: the supplied payload differs from the authoritative proposal; rebuild and review the PO before creating it",
          ),
        )
      }

      const payloadHash = hashPurchaseOrder(proposedPayload)
      const authoritativePayload = validationResult.confirmations.length > 0
        ? buildPayload(
            pkg,
            validationResult,
            evidenceSha256,
            supplierRecord,
            "administrative-analyst",
          )
        : proposedPayload
      const sap: SapAdapter =
        ctx.sapAdapter ??
        new FileSapMock(
          outDir,
          masterData.suppliers.map((s) => ({
            sap_code: s.sap_code,
            tax_id: s.tax_id,
            active: s.active,
          })),
        )

      // An already-created order is returned idempotently, but createOrder still
      // receives the authoritative payload so FileSapMock can reject a canonical
      // payload conflict instead of silently accepting a reused request_id.
      const existing = await sap.findOrderByReference(requestId)
      if (existing !== null) {
        let persisted: { po_number: string; date: string }
        try {
          persisted = await sap.createOrder(authoritativePayload)
        } catch (e) {
          if (e instanceof PayloadConflictError) {
            return serialize(
              err(
                `conflict: request_id already exists with different payload (PO ${e.existingPoNumber})`,
              ),
            )
          }
          throw e
        }
        await appendControlCsv(outDir, {
          request_id: requestId,
          result: "IDEMPOTENT",
          po_number: persisted.po_number,
          retroactive: validationResult.retroactive,
          blockers: "",
          confirmations: validationResult.confirmations
            .map((c) => c.code)
            .join("|"),
          ts: new Date().toISOString(),
        })
        return serialize(
          ok({
            po_number: persisted.po_number,
            date: persisted.date,
            idempotent: true,
          }),
        )
      }

      // Confirmations must be explicitly obtained from the analyst
      if (validationResult.confirmations.length > 0) {
        const confirmationStore =
          ctx.confirmationStore ?? new InMemoryConfirmationStore()
        const status = confirmationStore.check(requestId, payloadHash)

        if (status !== "confirmed") {
          if (status === "none" || status === "expired") {
            confirmationStore.setPending(
              requestId,
              payloadHash,
              validationResult.confirmations.map((c) => c.code),
            )
            await appendControlCsv(outDir, {
              request_id: requestId,
              result: "PENDING",
              po_number: "",
              retroactive: validationResult.retroactive,
              blockers: "",
              confirmations: validationResult.confirmations
                .map((c) => c.code)
                .join("|"),
              ts: new Date().toISOString(),
            })
          }
          if (status === "consumed") {
            return serialize(
              err("Confirmation already used. Request a new confirmation."),
            )
          }
          if (status === "expired") {
            return serialize(
              err("Confirmation expired. Please confirm again."),
            )
          }
          return serialize(
            err(
              "Awaiting human confirmation. The analyst must explicitly confirm before the PO can be created.",
            ),
          )
        }
      }

      let persisted: { po_number: string; date: string }
      try {
        persisted = await sap.createOrder(authoritativePayload)
      } catch (e) {
        if (e instanceof PayloadConflictError) {
          return serialize(
            err(
              `conflict: request_id already exists with different payload (PO ${e.existingPoNumber})`,
            ),
          )
        }
        throw e
      }

      // Consume only after durable persistence succeeds. Provider/tool retries can
      // safely reuse a confirmed authorization after a transient SAP failure.
      if (validationResult.confirmations.length > 0 && ctx.confirmationStore) {
        ctx.confirmationStore.consume(requestId, payloadHash)
      }

      await appendControlCsv(outDir, {
        request_id: requestId,
        result: "CREATED",
        po_number: persisted.po_number,
        retroactive: validationResult.retroactive,
        blockers: "",
        confirmations: validationResult.confirmations
          .map((confirmation) => confirmation.code)
          .join("|"),
        ts: new Date().toISOString(),
      })

      return serialize(
        ok({
          po_number: persisted.po_number,
          date: persisted.date,
          idempotent: false,
        }),
      )
    } catch (e) {
      return serialize(err(e instanceof Error ? e.message : "unknown error"))
    }
  },
}
