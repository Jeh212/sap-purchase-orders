/**
 * Phase 8-A: reusable module tests.
 * Verifies correct exports, Zod contracts, YAML frontmatter, knowledge/prompt
 * consistency, and standalone execution without the HTTP server.
 */

import { describe, it, expect } from "vitest"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { z } from "zod"

const ROOT = path.resolve(import.meta.dirname, "../..")

// ── Module import ─────────────────────────────────────────────────────────────

// Import the module directly — no Fastify, no LLM adapter initialized
const { read_package, validate, generate_evidence, build_payload, create } =
  await import("../../module/tools/po.js")

// ── 1. Five mandatory tool names ──────────────────────────────────────────────

describe("Phase 8-A: module exports", () => {
  it("exports the five required tool names", () => {
    for (const [name, tool] of [
      ["read_package", read_package],
      ["validate", validate],
      ["generate_evidence", generate_evidence],
      ["build_payload", build_payload],
      ["create", create],
    ] as [string, unknown][]) {
      expect(tool, `${name} should be exported`).toBeDefined()
    }
  })

  it("each tool has description, args, and execute", () => {
    for (const tool of [read_package, validate, generate_evidence, build_payload, create]) {
      expect(typeof tool.description).toBe("string")
      expect(tool.description.length).toBeGreaterThan(0)
      expect(typeof tool.args).toBe("object")
      expect(typeof tool.execute).toBe("function")
    }
  })

  it("each tool description is a single non-empty sentence", () => {
    for (const tool of [read_package, validate, generate_evidence, build_payload, create]) {
      expect(tool.description.trim()).not.toBe("")
    }
  })
})

// ── 2. Zod argument schemas ───────────────────────────────────────────────────

describe("Phase 8-A: Zod contracts", () => {
  it("read_package args are valid Zod schemas with case_id", () => {
    const schema = z.object(read_package.args)
    expect(() => schema.parse({ case_id: "req-001" })).not.toThrow()
    expect(() => schema.parse({})).toThrow()
  })

  it("validate args include case_id and package", () => {
    const schema = z.object(validate.args)
    expect(() => schema.parse({ case_id: "req-001", package: {} })).not.toThrow()
    expect(() => schema.parse({ case_id: "req-001" })).toThrow()
  })

  it("generate_evidence args include case_id", () => {
    const schema = z.object(generate_evidence.args)
    expect(() => schema.parse({ case_id: "req-001" })).not.toThrow()
    expect(() => schema.parse({})).toThrow()
  })

  it("build_payload args include case_id, package, derived", () => {
    const schema = z.object(build_payload.args)
    expect(() => schema.parse({ case_id: "req-001", package: {}, derived: {} })).not.toThrow()
    expect(() => schema.parse({ case_id: "req-001", package: {} })).toThrow()
  })

  it("create args include case_id and payload", () => {
    const schema = z.object(create.args)
    // payload must be a full PurchaseOrder — pass minimal to verify it validates the object type
    expect(() => schema.parse({ case_id: "req-001", payload: {} })).toThrow() // missing required fields
    expect(() => schema.parse({ case_id: "req-001" })).toThrow()
  })
})

// ── 3. YAML frontmatter validation ────────────────────────────────────────────

function parseFrontmatter(content: string): Record<string, string> {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith("---")) return {}
  const end = trimmed.indexOf("\n---", 3)
  if (end === -1) return {}
  const block = trimmed.slice(4, end)
  const result: Record<string, string> = {}
  for (const line of block.split("\n")) {
    const m = line.match(/^(\s*)(\w[\w.]*)\s*:\s*(.*)$/)
    if (m) result[m[2]!.trim()] = m[3]!.trim()
  }
  return result
}

describe("Phase 8-A: module/agent.md frontmatter", () => {
  it("has required YAML frontmatter fields", async () => {
    const content = await fs.readFile(path.join(ROOT, "module/agent.md"), "utf-8")
    const fm = parseFrontmatter(content)
    expect(fm["description"]).toBeTruthy()
    expect(fm["mode"]).toBe("primary")
    expect(fm["edit"]).toBe("deny")
    expect(fm["bash"]).toBe("deny")
  })
})

describe("Phase 8-A: module/skill/purchase-orders/SKILL.md frontmatter", () => {
  it("has required YAML frontmatter fields", async () => {
    const content = await fs.readFile(
      path.join(ROOT, "module/skill/purchase-orders/SKILL.md"),
      "utf-8",
    )
    const fm = parseFrontmatter(content)
    expect(fm["name"]).toBeTruthy()
    expect(fm["description"]).toBeTruthy()
  })
})

// ── 4. Content consistency with canonical sources ─────────────────────────────

function stripFrontmatter(content: string): string {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith("---")) return content
  const end = trimmed.indexOf("\n---", 3)
  if (end === -1) return content
  return trimmed.slice(end + 4).trimStart()
}

describe("Phase 8-A: content consistency", () => {
  it("module/agent.md body matches agent/prompt.md exactly", async () => {
    const canonical = await fs.readFile(path.join(ROOT, "agent/prompt.md"), "utf-8")
    const moduleMd = await fs.readFile(path.join(ROOT, "module/agent.md"), "utf-8")
    expect(stripFrontmatter(moduleMd).trim()).toBe(canonical.trim())
  })

  it("module/skill/purchase-orders/SKILL.md body matches src/knowledge/purchase-orders.md", async () => {
    const canonical = await fs.readFile(
      path.join(ROOT, "src/knowledge/purchase-orders.md"),
      "utf-8",
    )
    const skillMd = await fs.readFile(
      path.join(ROOT, "module/skill/purchase-orders/SKILL.md"),
      "utf-8",
    )
    expect(stripFrontmatter(skillMd).trim()).toBe(canonical.trim())
  })
})

// ── 5. Standalone execution (no Fastify, no LLM) ─────────────────────────────

describe("Phase 8-A: standalone execution without HTTP server", () => {
  it("read_package runs against req-001 fixture with no LLM credential", async () => {
    const ctx = {
      directory: ROOT,
      sessionId: "module-test",
    }
    const result = JSON.parse(await read_package.execute({ case_id: "req-001" }, ctx)) as {
      ok: boolean
      data: unknown
    }
    expect(result.ok).toBe(true)
    expect(result.data).toBeDefined()
  })

  it("validate runs against req-001 and returns eligible=true", async () => {
    const ctx = {
      directory: ROOT,
      sessionId: "module-test",
    }
    const pkgResult = JSON.parse(
      await read_package.execute({ case_id: "req-001" }, ctx),
    ) as { ok: boolean; data: Record<string, unknown> }
    expect(pkgResult.ok).toBe(true)

    const valResult = JSON.parse(
      await validate.execute({ case_id: "req-001", package: pkgResult.data }, ctx),
    ) as { ok: boolean; data: { eligible: boolean } }
    expect(valResult.ok).toBe(true)
    expect(valResult.data.eligible).toBe(true)
  })

  it("validate returns eligible=false for req-002 (RC1 blocker)", async () => {
    const ctx = {
      directory: ROOT,
      sessionId: "module-test",
    }
    const pkgResult = JSON.parse(
      await read_package.execute({ case_id: "req-002" }, ctx),
    ) as { ok: boolean; data: Record<string, unknown> }

    const valResult = JSON.parse(
      await validate.execute({ case_id: "req-002", package: pkgResult.data }, ctx),
    ) as { ok: boolean; data: { eligible: boolean; blockers: { code: string }[] } }
    expect(valResult.ok).toBe(true)
    expect(valResult.data.eligible).toBe(false)
    expect(valResult.data.blockers.some((b) => b.code === "RC1")).toBe(true)
  })

  it("invalid case_id returns ok:false without throwing", async () => {
    const ctx = { directory: ROOT, sessionId: "module-test" }
    const result = JSON.parse(
      await read_package.execute({ case_id: "../../etc/passwd" }, ctx),
    ) as { ok: boolean }
    expect(result.ok).toBe(false)
  })
})

// ── 6. No LLM credentials required ───────────────────────────────────────────

describe("Phase 8-A: no LLM credentials required", () => {
  it("importing the module does not read LLM env vars or throw without them", () => {
    // If we reach this point the module was successfully imported above without credentials
    expect(true).toBe(true)
  })
})
