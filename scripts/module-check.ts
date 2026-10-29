/**
 * Verifies that module/agent.md and module/skill/purchase-orders/SKILL.md
 * have not diverged from their canonical sources.
 *
 * Canonical sources:
 *   agent/prompt.md              → module/agent.md (body after YAML frontmatter)
 *   src/knowledge/purchase-orders.md → module/skill/purchase-orders/SKILL.md (body)
 *
 * Exits with code 1 and a diff-style message if any content divergence is found.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function stripFrontmatter(content: string): string {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith("---")) return content
  const end = trimmed.indexOf("\n---", 3)
  if (end === -1) return content
  return trimmed.slice(end + 4).trimStart()
}

async function readFile(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), "utf-8")
}

let failed = false

function check(label: string, canonical: string, derived: string): void {
  if (canonical.trim() !== derived.trim()) {
    console.error(`DIVERGENCE: ${label}`)
    console.error("  Canonical and module copies do not match.")
    console.error("  Run: diff <(cat canonical) <(cat module) to inspect.")
    failed = true
  } else {
    console.log(`OK: ${label}`)
  }
}

const [agentPrompt, agentMd, knowledgeMd, skillMd] = await Promise.all([
  readFile("agent/prompt.md"),
  readFile("module/agent.md"),
  readFile("src/knowledge/purchase-orders.md"),
  readFile("module/skill/purchase-orders/SKILL.md"),
])

check("agent/prompt.md ↔ module/agent.md body", agentPrompt, stripFrontmatter(agentMd))
check(
  "src/knowledge/purchase-orders.md ↔ module/skill/purchase-orders/SKILL.md body",
  knowledgeMd,
  stripFrontmatter(skillMd),
)

if (failed) {
  process.exit(1)
}
console.log("module:check passed — no divergence detected")
