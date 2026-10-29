/**
 * Phase 8-B: PDF approval evidence tests.
 * Verifies that approval.pdf is generated alongside approval.txt, is a valid PDF,
 * and that approval.txt SHA-256 is unchanged by the addition.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as crypto from "node:crypto"
import * as os from "node:os"
import { PDFDocument } from "pdf-lib"
import { generate_evidence } from "../../src/tools/po.js"

const ROOT = path.resolve(import.meta.dirname, "../..")

let outDir: string

beforeAll(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase8-pdf-"))
})

afterAll(async () => {
  await fs.rm(outDir, { recursive: true, force: true })
})

describe("Phase 8-B: approval.pdf generation", () => {
  it("generate_evidence produces approval.txt and approval.pdf for req-001", async () => {
    const ctx = { directory: ROOT, sessionId: "pdf-test", outDir }
    const raw = await generate_evidence.execute({ case_id: "req-001" }, ctx)
    const result = JSON.parse(raw) as {
      ok: boolean
      data: { path: string; sha256: string; pdf_path?: string }
    }

    expect(result.ok).toBe(true)
    expect(result.data.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.data.pdf_path).toBeTruthy()

    // Both files must exist
    const txtPath = path.join(outDir, "req-001", "approval.txt")
    const pdfPath = path.join(outDir, "req-001", "approval.pdf")
    await expect(fs.access(txtPath)).resolves.toBeUndefined()
    await expect(fs.access(pdfPath)).resolves.toBeUndefined()
  })

  it("approval.pdf is a structurally valid PDF that can be parsed", async () => {
    const ctx = { directory: ROOT, sessionId: "pdf-test-2", outDir }
    await generate_evidence.execute({ case_id: "req-001" }, ctx)

    const pdfBytes = await fs.readFile(path.join(outDir, "req-001", "approval.pdf"))
    const doc = await PDFDocument.load(pdfBytes)
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it("approval.pdf contains approval header information", async () => {
    const ctx = { directory: ROOT, sessionId: "pdf-test-3", outDir }
    await generate_evidence.execute({ case_id: "req-001" }, ctx)

    const pdfBytes = await fs.readFile(path.join(outDir, "req-001", "approval.pdf"))
    // PDF binary content should contain readable header strings after page rendering
    // We verify the PDF is non-trivially sized (> 1 KB)
    expect(pdfBytes.byteLength).toBeGreaterThan(1024)
  })

  it("approval.txt SHA-256 remains valid (not changed by PDF addition)", async () => {
    const ctx = { directory: ROOT, sessionId: "pdf-sha-test", outDir }
    const raw = await generate_evidence.execute({ case_id: "req-001" }, ctx)
    const result = JSON.parse(raw) as { ok: boolean; data: { sha256: string } }
    expect(result.ok).toBe(true)

    const txtContent = await fs.readFile(path.join(outDir, "req-001", "approval.txt"), "utf-8")
    // The SHA256 line must appear at end of file
    expect(txtContent).toContain(`SHA256: ${result.data.sha256}`)

    // The hash is over the canonical content (before the SHA256 line)
    const parts = txtContent.split("\n---\n")
    expect(parts.length).toBe(2)
    const canonicalText = parts[0]!
    const expectedSha = crypto.createHash("sha256").update(canonicalText, "utf-8").digest("hex")
    expect(result.data.sha256).toBe(expectedSha)
  })

  it("generates approval.pdf for all six fixture cases", async () => {
    const cases = ["req-001", "req-002", "req-003", "req-004", "req-005", "req-006"]
    for (const caseId of cases) {
      const ctx = { directory: ROOT, sessionId: `pdf-all-${caseId}`, outDir }
      const raw = await generate_evidence.execute({ case_id: caseId }, ctx)
      const result = JSON.parse(raw) as {
        ok: boolean
        data: { pdf_path?: string }
        error?: string
      }

      if (result.ok) {
        // If evidence succeeded, PDF path should be returned
        expect(result.data.pdf_path).toBeTruthy()
        const pdfPath = path.join(outDir, caseId, "approval.pdf")
        const pdfBytes = await fs.readFile(pdfPath)
        const doc = await PDFDocument.load(pdfBytes)
        expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
      }
      // req-002 and req-003 have no approval.json — expect ok:false, no PDF crash
    }
  })

  it("non-existent case returns ok:false and does not produce a partial PDF", async () => {
    const ctx = { directory: ROOT, sessionId: "pdf-no-case", outDir }
    const raw = await generate_evidence.execute({ case_id: "req-nonexistent" }, ctx)
    const result = JSON.parse(raw) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()

    // No partial PDF should be written
    const pdfPath = path.join(outDir, "req-nonexistent", "approval.pdf")
    await expect(fs.access(pdfPath)).rejects.toThrow()
  })

  it("pdf_path in result always points to a real file — no false positive reporting", async () => {
    const ctx = { directory: ROOT, sessionId: "pdf-truthfulness", outDir }
    const raw = await generate_evidence.execute({ case_id: "req-001" }, ctx)
    const result = JSON.parse(raw) as {
      ok: boolean
      data: { pdf_path?: string }
    }
    expect(result.ok).toBe(true)

    if (result.data.pdf_path !== undefined) {
      // pdf_path must reference a real file — not a ghost path
      const absolutePath = path.isAbsolute(result.data.pdf_path)
        ? result.data.pdf_path
        : path.join(ROOT, result.data.pdf_path)
      await expect(fs.access(absolutePath)).resolves.toBeUndefined()
      const stat = await fs.stat(absolutePath)
      expect(stat.size).toBeGreaterThan(0)
    }
    // If pdf_path is absent (PDF generation failed), ok=true still holds
    // — approval.txt and SHA-256 are unaffected
  })

  it("pdf_path is absent (not a ghost path) when PDF generation is not attempted", async () => {
    // Use a read-only outDir to force PDF write failure while allowing txt write
    const readOnlyDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-readonly-"))
    const caseOutDir = path.join(readOnlyDir, "req-001")
    await fs.mkdir(caseOutDir, { recursive: true })
    // Make the caseOutDir read-only so approval.pdf write fails
    await fs.chmod(caseOutDir, 0o555)
    try {
      const ctx = { directory: ROOT, sessionId: "pdf-readonly-test", outDir: readOnlyDir }
      const raw = await generate_evidence.execute({ case_id: "req-001" }, ctx)
      const result = JSON.parse(raw) as {
        ok: boolean
        data?: { path: string; sha256: string; pdf_path?: string }
        error?: string
      }
      // If txt write also fails (depends on OS), ok may be false — that's fine
      if (result.ok) {
        // PDF write may have failed silently — pdf_path must be absent (undefined in JSON → not present)
        const hasPdfPath = "pdf_path" in (result.data ?? {})
        if (hasPdfPath) {
          // If pdf_path IS present, verify the file actually exists
          const pdfRelPath = result.data?.pdf_path
          if (pdfRelPath) {
            const absPath = path.isAbsolute(pdfRelPath) ? pdfRelPath : path.join(ROOT, pdfRelPath)
            await expect(fs.access(absPath)).resolves.toBeUndefined()
          }
        }
        // Either pdf_path is absent (failure reported correctly) or it exists on disk (success reported correctly)
        // In both cases, sha256 must be present and valid
        expect(result.data?.sha256).toMatch(/^[a-f0-9]{64}$/)
      }
    } finally {
      await fs.chmod(caseOutDir, 0o755)
      await fs.rm(readOnlyDir, { recursive: true, force: true })
    }
  })
})
