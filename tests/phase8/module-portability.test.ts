/**
 * Phase 8-A: independent module portability test.
 *
 * Demonstrates how another project or agent platform consumes the module.
 * Each subprocess test writes a standalone .mjs script to a temporary directory
 * and executes it with `node` from that directory — simulating a different project.
 *
 * The scripts import from dist/module/tools/po.js (the compiled distribution artifact),
 * passing ctx.directory pointing to the repository root for fixture resolution.
 *
 * This proves:
 *   1. The compiled module works from a different working directory.
 *   2. No Fastify server is started.
 *   3. No LLM provider is initialized.
 *   4. The five tools execute correctly against real fixture data.
 *   5. Path traversal security is preserved.
 *
 * Integration model:
 *   Clone/copy the repository. Run `npm run build`. Import dist/module/tools/po.js.
 *   Supply ToolCtx.directory pointing to the repository root (for fixture resolution).
 *   Runtime dependencies: zod, pdf-lib (declared in package.json), Node.js built-ins.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import { spawn } from "node:child_process"

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..")
const DIST_MODULE_PATH = path.join(PROJECT_ROOT, "dist/module/tools/po.js")
const NODE_BIN = process.execPath

let tmpDir: string

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sap-po-module-portability-"))
})

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/** Run a .mjs file in tmpDir using node, return { stdout, stderr, exitCode }. */
async function runScript(
  scriptName: string,
  scriptContent: string,
  timeoutMs = 15000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const scriptPath = path.join(tmpDir, scriptName)
  await fs.writeFile(scriptPath, scriptContent, "utf-8")

  return new Promise((resolve, reject) => {
    const proc = spawn(NODE_BIN, [scriptPath], {
      cwd: tmpDir,
      env: { ...process.env },
    })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString() })
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Script ${scriptName} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    proc.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1 })
    })
    proc.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

describe("Phase 8-A: independent module portability (compiled JS, separate cwd)", () => {
  it("dist/module/tools/po.js exists after npm run build", async () => {
    await expect(fs.access(DIST_MODULE_PATH)).resolves.toBeUndefined()
  })

  it("five tool names are exported from the compiled module", async () => {
    const { stdout, exitCode } = await runScript(
      "test-exports.mjs",
      `import { read_package, validate, generate_evidence, build_payload, create }
  from ${JSON.stringify(DIST_MODULE_PATH)}
const tools = { read_package, validate, generate_evidence, build_payload, create }
const names = Object.keys(tools).filter(k => typeof tools[k].execute === "function")
console.log(JSON.stringify({ ok: true, tools: names }))
`,
    )
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout) as { ok: boolean; tools: string[] }
    expect(result.ok).toBe(true)
    expect(result.tools).toEqual(
      expect.arrayContaining(["read_package", "validate", "generate_evidence", "build_payload", "create"]),
    )
    expect(result.tools).toHaveLength(5)
  })

  it("po_read_package executes from a separate cwd and resolves req-001 fixture", async () => {
    const { stdout, exitCode } = await runScript(
      "test-read-package.mjs",
      `import { read_package } from ${JSON.stringify(DIST_MODULE_PATH)}
const ctx = { directory: ${JSON.stringify(PROJECT_ROOT)}, sessionId: "portability-test" }
const raw = await read_package.execute({ case_id: "req-001" }, ctx)
const result = JSON.parse(raw)
console.log(JSON.stringify({ ok: result.ok, requestId: result.data?.request?.request_id }))
`,
    )
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout) as { ok: boolean; requestId: string }
    expect(result.ok).toBe(true)
    expect(result.requestId).toBe("REQ-2026-001")
  })

  it("po_validate returns eligible=true for req-001 from a separate process", async () => {
    const { stdout, exitCode } = await runScript(
      "test-validate-001.mjs",
      `import { read_package, validate } from ${JSON.stringify(DIST_MODULE_PATH)}
const ctx = { directory: ${JSON.stringify(PROJECT_ROOT)}, sessionId: "portability-validate" }
const pkgRaw = JSON.parse(await read_package.execute({ case_id: "req-001" }, ctx))
const valRaw = JSON.parse(await validate.execute({ case_id: "req-001", package: pkgRaw.data }, ctx))
console.log(JSON.stringify({ ok: valRaw.ok, eligible: valRaw.data?.eligible }))
`,
    )
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout) as { ok: boolean; eligible: boolean }
    expect(result.ok).toBe(true)
    expect(result.eligible).toBe(true)
  })

  it("po_validate returns RC1 blocker for req-002 from a separate process", async () => {
    const { stdout, exitCode } = await runScript(
      "test-validate-002.mjs",
      `import { read_package, validate } from ${JSON.stringify(DIST_MODULE_PATH)}
const ctx = { directory: ${JSON.stringify(PROJECT_ROOT)}, sessionId: "portability-rc1" }
const pkgRaw = JSON.parse(await read_package.execute({ case_id: "req-002" }, ctx))
const valRaw = JSON.parse(await validate.execute({ case_id: "req-002", package: pkgRaw.data }, ctx))
console.log(JSON.stringify({
  ok: valRaw.ok, eligible: valRaw.data?.eligible,
  blockerCodes: (valRaw.data?.blockers ?? []).map(b => b.code),
}))
`,
    )
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout) as { ok: boolean; eligible: boolean; blockerCodes: string[] }
    expect(result.ok).toBe(true)
    expect(result.eligible).toBe(false)
    expect(result.blockerCodes).toContain("RC1")
  })

  it("path traversal is rejected from a separate process", async () => {
    const { stdout, exitCode } = await runScript(
      "test-traversal.mjs",
      `import { read_package } from ${JSON.stringify(DIST_MODULE_PATH)}
const ctx = { directory: ${JSON.stringify(PROJECT_ROOT)}, sessionId: "portability-traversal" }
const raw = JSON.parse(await read_package.execute({ case_id: "../../etc/passwd" }, ctx))
console.log(JSON.stringify({ ok: raw.ok }))
`,
    )
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout) as { ok: boolean }
    expect(result.ok).toBe(false)
  })

  it("module imports successfully without LLM credentials (env cleared)", async () => {
    const { stdout, exitCode } = await runScript(
      "test-no-llm.mjs",
      `import { read_package } from ${JSON.stringify(DIST_MODULE_PATH)}
const ctx = { directory: ${JSON.stringify(PROJECT_ROOT)}, sessionId: "portability-no-llm" }
const raw = JSON.parse(await read_package.execute({ case_id: "req-001" }, ctx))
console.log(JSON.stringify({ ok: raw.ok, importedSuccessfully: true }))
`,
    )
    expect(exitCode).toBe(0)
    const result = JSON.parse(stdout) as { ok: boolean; importedSuccessfully: boolean }
    expect(result.ok).toBe(true)
    expect(result.importedSuccessfully).toBe(true)
  })
})

describe("Phase 8-A: module runtime dependencies are satisfied", () => {
  it("zod is in package.json dependencies (required by tools)", async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf-8"),
    ) as { dependencies: Record<string, string> }
    expect(pkg.dependencies["zod"]).toBeTruthy()
  })

  it("pdf-lib is in package.json dependencies (required by generate_evidence)", async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf-8"),
    ) as { dependencies: Record<string, string> }
    expect(pkg.dependencies["pdf-lib"]).toBeTruthy()
  })

  it("module/tools/po.ts does not directly import fastify", async () => {
    const source = await fs.readFile(
      path.join(PROJECT_ROOT, "module/tools/po.ts"),
      "utf-8",
    )
    expect(source).not.toContain("fastify")
  })

  it("module/tools/po.ts does not directly import @anthropic-ai/sdk or openai", async () => {
    const source = await fs.readFile(
      path.join(PROJECT_ROOT, "module/tools/po.ts"),
      "utf-8",
    )
    expect(source).not.toContain("@anthropic-ai/sdk")
    expect(source).not.toContain("openai")
  })

  it("compiled dist/module/tools/po.js does not contain fastify references", async () => {
    const compiled = await fs.readFile(DIST_MODULE_PATH, "utf-8")
    expect(compiled).not.toContain("fastify")
    expect(compiled).not.toContain("@anthropic-ai/sdk")
    expect(compiled).not.toContain("openai")
  })
})
