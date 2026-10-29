/**
 * module/tools/po.ts — re-export the five canonical purchase-order tools.
 *
 * Integration: import { read_package, validate, generate_evidence, build_payload, create }
 * from this file and supply a ToolCtx (directory, sessionId, and optionally outDir,
 * confirmationStore, sapAdapter).  No HTTP server or LLM provider is required.
 *
 * Portability note: this module re-exports from src/tools/po.ts and therefore depends
 * on src/domain/* and src/sap/*.  Those files contain only Node.js built-ins and the
 * `zod` package — no Fastify, no LLM SDK, and no HTTP server are initialized on import.
 *
 * Canonical source: ../../src/tools/po.ts
 * Run `npm run module:check` to verify this file and module/agent.md have not diverged.
 */

export {
  read_package,
  validate,
  generate_evidence,
  build_payload,
  create,
} from "../../src/tools/po.js"

export type { ToolCtx } from "../../src/tools/po.js"
